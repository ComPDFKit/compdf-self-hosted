// Package licenseupdate replaces the mounted runtime license, never the display JWT.
package licenseupdate

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/singlelock"
)

type Status struct {
	RequestID string    `json:"requestId"`
	Phase     string    `json:"phase"`
	SHA256    string    `json:"sha256"`
	UpdatedAt time.Time `json:"updatedAt"`
	Error     string    `json:"error,omitempty"`
}
type journal struct {
	Status
	Container string `json:"container"`
	HadFile   bool   `json:"hadFile"`
}
type command func(context.Context, []byte, ...string) ([]byte, error)
type Manager struct {
	mu      sync.Mutex
	cfg     config.Config
	job     journal
	running bool
	run     command
	ctx     context.Context
}

func New(cfg config.Config) (*Manager, error) {
	m := &Manager{cfg: cfg, run: docker}
	data, err := os.ReadFile(m.statePath())
	if err == nil {
		if json.Unmarshal(data, &m.job) != nil {
			return nil, errors.New("invalid license update journal")
		}
		if !terminal(m.job.Phase) {
			if m.job.Phase == "VALIDATING" {
				m.job.Phase = "FAILED"
				m.job.Error = "License validation interrupted; runtime license was not changed"
			} else {
				m.job.Phase = "RECOVERY_REQUIRED"
				m.job.Error = "License update interrupted; restore the previous license before resuming work"
			}
			if err = m.save(); err != nil {
				return nil, err
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return m, nil
}
func (m *Manager) statePath() string {
	return filepath.Join(m.cfg.StateDirectory, "license-update.json")
}
func (m *Manager) directory() string {
	return filepath.Join(m.cfg.WorkingDirectory, "configs", "app-license")
}
func (m *Manager) target() string { return filepath.Join(m.directory(), "license.xml") }
func (m *Manager) backup() string {
	return filepath.Join(m.cfg.StateDirectory, "license-backups", m.job.RequestID+".xml")
}
func terminal(p string) bool {
	return p == "" || p == "SUCCEEDED" || p == "FAILED" || p == "ROLLED_BACK"
}
func (m *Manager) Status() Status { m.mu.Lock(); defer m.mu.Unlock(); return m.job.Status }

func ValidateXML(data []byte) error {
	if len(data) == 0 || len(data) > 65536 {
		return errors.New("license.xml must contain 1 to 65536 bytes")
	}
	d := xml.NewDecoder(bytes.NewReader(data))
	depth, roots, keys := 0, 0, 0
	for {
		token, err := d.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return errors.New("license.xml is not valid XML")
		}
		switch v := token.(type) {
		case xml.Directive:
			return errors.New("XML directives and DTDs are not allowed")
		case xml.StartElement:
			if depth == 0 {
				roots++
			}
			depth++
			if v.Name.Local == "key" {
				var key string
				if d.DecodeElement(&key, &v) != nil || strings.TrimSpace(key) == "" {
					return errors.New("license.xml requires a nonempty key")
				}
				keys++
				depth--
			}
		case xml.EndElement:
			depth--
		case xml.CharData:
			if depth == 0 && strings.TrimSpace(string(v)) != "" {
				return errors.New("unexpected data outside XML root")
			}
		}
	}
	if roots != 1 || depth != 0 || keys != 1 {
		return errors.New("license.xml requires one root and one nonempty key")
	}
	return nil
}

func (m *Manager) Start(id string, data []byte) (Status, error) {
	if !regexp.MustCompile(`^license-[a-f0-9-]{36}$`).MatchString(id) {
		return Status{}, errors.New("invalid license request ID")
	}
	if err := ValidateXML(data); err != nil {
		return Status{}, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	sum := sha256.Sum256(data)
	digest := hex.EncodeToString(sum[:])
	if m.job.RequestID == id {
		if m.job.SHA256 != digest {
			return Status{}, errors.New("license request ID was already used with different contents")
		}
		return m.job.Status, nil
	}
	if m.running || !terminal(m.job.Phase) {
		return Status{}, errors.New("a license operation is active or requires recovery")
	}
	lock, err := singlelock.Acquire(filepath.Join(m.cfg.StateDirectory, "updater.lock"), 5*time.Minute, time.Now())
	if err != nil {
		return Status{}, err
	}
	m.job = journal{Status: Status{RequestID: id, Phase: "VALIDATING", SHA256: digest}}
	if err = m.save(); err != nil {
		lock.Release()
		return Status{}, err
	}
	m.running = true
	go m.withLock(lock, func() { m.apply(append([]byte(nil), data...)) })
	return m.job.Status, nil
}

func (m *Manager) Recover(id string) (Status, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.running || m.job.Phase != "RECOVERY_REQUIRED" || id != m.job.RequestID {
		return Status{}, errors.New("no matching license recovery is available")
	}
	lock, err := singlelock.Acquire(filepath.Join(m.cfg.StateDirectory, "updater.lock"), 5*time.Minute, time.Now())
	if err != nil {
		return Status{}, err
	}
	m.running = true
	go m.withLock(lock, m.restore)
	return m.job.Status, nil
}

func (m *Manager) withLock(lock *singlelock.Lock, work func()) {
	ctx, cancel := context.WithCancel(context.Background())
	m.ctx = ctx
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if lock.Refresh(time.Now()) != nil {
					cancel()
					return
				}
			}
		}
	}()
	work()
	if ctx.Err() != nil {
		m.phase("RECOVERY_REQUIRED", "License operation lost its updater lock; manual recovery is required")
	}
	cancel()
	<-done
	lock.Release()
	m.mu.Lock()
	m.running = false
	m.mu.Unlock()
}
func (m *Manager) save() error {
	m.job.UpdatedAt = time.Now().UTC()
	data, err := json.Marshal(m.job)
	if err != nil {
		return err
	}
	return atomicWrite(m.statePath(), data)
}
func (m *Manager) phase(p, message string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.job.Phase = p
	m.job.Error = message
	if err := m.save(); err != nil {
		m.job.Phase = "RECOVERY_REQUIRED"
		m.job.Error = "Could not persist license operation state; keep maintenance mode and recover the previous license"
		return err
	}
	return nil
}

func (m *Manager) apply(data []byte) {
	ctx, cancel := context.WithTimeout(m.ctx, 60*time.Second)
	defer cancel()
	id, err := m.container(ctx)
	if err == nil {
		_, err = m.run(ctx, data, "exec", "-i", id, "python", "-c", validateScript)
		if err != nil {
			var exit *exec.ExitError
			if errors.As(err, &exit) && exit.ExitCode() == 12 {
				err = errors.New("PDF SDK cannot validate this XML key format. Use a PDF SDK compatible license or update the compdf-app engine; runtime license was not changed")
			} else {
				err = errors.New("SDK rejected the uploaded license or license validation is unavailable")
			}
		}
	}
	if err != nil {
		m.phase("FAILED", err.Error())
		return
	}
	// Validate and back up before recording the write-ahead transaction.
	old, err := safeRead(m.target())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		m.phase("FAILED", "Cannot safely read existing license")
		return
	}
	had := err == nil
	m.mu.Lock()
	m.job.Container = id
	m.job.HadFile = had
	m.mu.Unlock()
	if had {
		if err = atomicWrite(m.backup(), old); err != nil {
			m.phase("FAILED", "Cannot back up existing license")
			return
		}
	}
	if err = m.phase("REPLACING", ""); err != nil {
		return
	}
	if err = atomicWrite(m.target(), data); err != nil {
		m.restore()
		return
	}
	if err = m.phase("RESTARTING", ""); err != nil {
		m.restore()
		return
	}
	if err = m.restartAndVerify(id); err != nil {
		if m.ctx.Err() != nil {
			return
		}
		m.restore()
		return
	}
	m.phase("SUCCEEDED", "")
}

func (m *Manager) restore() {
	if m.phase("RESTORING", "New license did not complete verification; restoring previous license") != nil {
		return
	}
	ctx, cancel := context.WithTimeout(m.ctx, 15*time.Second)
	defer cancel()
	id, err := m.container(ctx)
	if err == nil && id != m.job.Container {
		err = errors.New("application container changed; manual recovery required")
	}
	if err == nil {
		if m.job.HadFile {
			var data []byte
			data, err = safeRead(m.backup())
			if err == nil {
				err = atomicWrite(m.target(), data)
			}
		} else {
			_, err = safeRead(m.target())
			if err == nil {
				err = os.Remove(m.target())
			}
			if errors.Is(err, os.ErrNotExist) {
				err = nil
			}
		}
	}
	if err == nil {
		err = m.restartAndVerify(id)
	}
	if err != nil {
		m.phase("RECOVERY_REQUIRED", "Previous license could not be restored and verified; keep maintenance mode and retry recovery")
		return
	}
	m.phase("ROLLED_BACK", "License update failed; previous license restored and verified")
}

func (m *Manager) restartAndVerify(id string) error {
	ctx, cancel := context.WithTimeout(m.ctx, 5*time.Minute)
	defer cancel()
	if _, err := m.run(ctx, nil, "restart", "--time", "20", id); err != nil {
		return errors.New("app restart failed")
	}
	for ctx.Err() == nil {
		probe, cancelProbe := context.WithTimeout(ctx, 25*time.Second)
		_, err := m.run(probe, nil, "exec", id, "python", "-c", verifyScript)
		cancelProbe()
		if err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
		case <-time.After(2 * time.Second):
		}
	}
	return errors.New("runtime license verification failed")
}

func (m *Manager) container(ctx context.Context) (string, error) {
	// Only a single container in the configured Compose project may be touched.
	output, err := m.run(ctx, nil, "ps", "-q", "--filter", "label=com.docker.compose.project="+m.cfg.ComposeProject, "--filter", "label=com.docker.compose.service=compdf-app")
	ids := strings.Fields(string(output))
	if err != nil || len(ids) != 1 {
		return "", errors.New("exactly one running compdf-app is required")
	}
	id := ids[0]
	if !regexp.MustCompile(`^[a-f0-9]{12,64}$`).MatchString(id) {
		return "", errors.New("invalid container identity")
	}
	raw, err := m.run(ctx, nil, "inspect", "--format", "{{json .Mounts}}", id)
	if err != nil {
		return "", errors.New("cannot inspect application mounts")
	}
	var mounts []struct {
		Type, Source, Destination string
		RW                        bool
	}
	if json.Unmarshal(raw, &mounts) != nil {
		return "", errors.New("invalid application mounts")
	}
	found := false
	for _, v := range mounts {
		if v.Destination == "/opt/compdf_sdk/license" && v.Type == "bind" && (filepath.Clean(v.Source) == m.directory() || mountSource(v.Source) == m.directory()) && !v.RW {
			found = true
		}
	}
	if !found {
		return "", errors.New("compdf-app needs read-only directory mount configs/app-license:/opt/compdf_sdk/license")
	}
	// The configured installation root is trusted and may be the bootstrap's
	// host-path alias to /workspace. Follow that alias, but reject symlinks in
	// the managed subdirectories so license writes cannot be redirected.
	root, err := os.Stat(m.cfg.WorkingDirectory)
	if err != nil || !root.IsDir() {
		return "", errors.New("license directory is missing or unsafe")
	}
	for _, p := range []string{filepath.Join(m.cfg.WorkingDirectory, "configs"), m.directory()} {
		info, e := os.Lstat(p)
		if e != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("license directory is missing or unsafe")
		}
	}
	entries, err := os.ReadDir(m.directory())
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "license") && strings.HasSuffix(e.Name(), ".xml") && e.Name() != "license.xml" {
			return "", errors.New("remove conflicting license*.xml files from the managed directory first")
		}
	}
	return id, nil
}

// Docker Desktop may report a Windows host path even to a Linux Docker client.
func mountSource(source string) string {
	if regexp.MustCompile(`^[A-Za-z]:[\\/]`).MatchString(source) {
		return filepath.Clean("/run/desktop/mnt/host/" + strings.ToLower(source[:1]) + "/" + strings.ReplaceAll(source[3:], `\`, "/"))
	}
	return filepath.Clean(source)
}

func safeRead(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > 65536 {
		return nil, errors.New("unsafe license file")
	}
	return os.ReadFile(path)
}
func atomicWrite(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".license-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}
func docker(ctx context.Context, input []byte, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Stdin = bytes.NewReader(input)
	// Exec output can include vendor SDK license diagnostics. Never return it.
	if len(args) > 0 && args[0] == "exec" {
		err := cmd.Run()
		return nil, err
	}
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("docker %s failed", args[0])
	}
	return output, nil
}
