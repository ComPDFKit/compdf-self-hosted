package scheduler

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

type Runner func(args []string, stdout, stderr io.Writer) int

type Status struct {
	SchemaVersion     int       `json:"schemaVersion"`
	LastAttemptAt     time.Time `json:"lastAttemptAt,omitempty"`
	LastSuccessAt     time.Time `json:"lastSuccessAt,omitempty"`
	NextAttemptAt     time.Time `json:"nextAttemptAt,omitempty"`
	ConsecutiveErrors int       `json:"consecutiveErrors"`
	LastError         string    `json:"lastError,omitempty"`
	AvailableVersion  string    `json:"availableVersion,omitempty"`
	Downloaded        bool      `json:"downloaded"`
}

type Scheduler struct {
	configPath string
	statusPath string
	run        Runner
	now        func() time.Time
	random     func() float64
	mu         sync.Mutex
	status     Status
}

func New(configPath string, runner Runner) (*Scheduler, error) {
	if !filepath.IsAbs(configPath) || runner == nil {
		return nil, errors.New("scheduler requires an absolute config path and runner")
	}
	config, err := updaterconfig.Load(configPath)
	if err != nil {
		return nil, err
	}
	scheduler := &Scheduler{
		configPath: filepath.Clean(configPath),
		statusPath: filepath.Join(config.StateDirectory, "automation-status.json"),
		run:        runner,
		now:        func() time.Time { return time.Now().UTC() },
		random:     rand.Float64,
		status:     Status{SchemaVersion: 1},
	}
	if data, err := os.ReadFile(scheduler.statusPath); err == nil {
		var persisted Status
		if json.Unmarshal(data, &persisted) == nil && persisted.SchemaVersion == 1 {
			scheduler.status = persisted
		}
	}
	return scheduler, nil
}

func (scheduler *Scheduler) Run(ctx context.Context) {
	for {
		config, err := updaterconfig.Load(scheduler.configPath)
		if err != nil {
			scheduler.recordFailure(updaterconfig.Automation{CheckIntervalMinutes: 15, MaximumBackoffMinutes: 60}, err)
		} else if config.Automation.CheckIntervalMinutes == 0 {
			if !wait(ctx, time.Minute) {
				return
			}
			continue
		} else if err := scheduler.RunOnce(ctx); err != nil {
			scheduler.recordFailure(config.Automation, err)
		} else {
			scheduler.recordSuccess(config.Automation)
		}
		delay := time.Until(scheduler.Status().NextAttemptAt)
		if delay < time.Second {
			delay = time.Second
		}
		if !wait(ctx, delay) {
			return
		}
	}
}

func (scheduler *Scheduler) RunOnce(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	default:
	}
	config, err := updaterconfig.Load(scheduler.configPath)
	if err != nil {
		return err
	}
	if config.Automation.CheckIntervalMinutes == 0 {
		return nil
	}
	currentVersion, err := currentVersion(config)
	if err != nil {
		return err
	}
	var stdout, stderr bytes.Buffer
	exit := scheduler.run([]string{"check", "--config", scheduler.configPath, "--current-version", currentVersion, "--json"}, &stdout, &stderr)
	if exit != 0 {
		return commandError("automatic update check", exit, stderr.String())
	}
	var result struct {
		UpdateAvailable  bool   `json:"updateAvailable"`
		AvailableVersion string `json:"availableVersion"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return fmt.Errorf("decode automatic check result: %w", err)
	}
	scheduler.mu.Lock()
	scheduler.status.AvailableVersion = result.AvailableVersion
	scheduler.status.Downloaded = false
	scheduler.mu.Unlock()
	if result.UpdateAvailable && config.Automation.AutoDownload {
		stdout.Reset()
		stderr.Reset()
		requestID := "automatic-" + strings.ReplaceAll(result.AvailableVersion, "+", "-")
		exit = scheduler.run([]string{"download", "--config", scheduler.configPath, "--current-version", currentVersion, "--version", result.AvailableVersion, "--request-id", requestID}, &stdout, &stderr)
		if exit != 0 {
			return commandError("automatic release download", exit, stderr.String())
		}
		scheduler.mu.Lock()
		scheduler.status.Downloaded = true
		scheduler.mu.Unlock()
	}
	if config.Automation.RetainReleases > 0 {
		if _, err := PruneReleases(config, config.Automation.RetainReleases); err != nil {
			return err
		}
	}
	return nil
}

func (scheduler *Scheduler) Status() Status {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	return scheduler.status
}

func (scheduler *Scheduler) recordFailure(policy updaterconfig.Automation, cause error) {
	scheduler.mu.Lock()
	now := scheduler.now()
	scheduler.status.LastAttemptAt = now
	scheduler.status.ConsecutiveErrors++
	scheduler.status.LastError = cause.Error()
	scheduler.status.NextAttemptAt = now.Add(nextDelay(policy, scheduler.status.ConsecutiveErrors, scheduler.random()))
	status := scheduler.status
	scheduler.mu.Unlock()
	_ = saveStatus(scheduler.statusPath, status)
}

func (scheduler *Scheduler) recordSuccess(policy updaterconfig.Automation) {
	scheduler.mu.Lock()
	now := scheduler.now()
	scheduler.status.LastAttemptAt = now
	scheduler.status.LastSuccessAt = now
	scheduler.status.ConsecutiveErrors = 0
	scheduler.status.LastError = ""
	scheduler.status.NextAttemptAt = now.Add(nextDelay(policy, 0, scheduler.random()))
	status := scheduler.status
	scheduler.mu.Unlock()
	_ = saveStatus(scheduler.statusPath, status)
}

func saveStatus(path string, status Status) error {
	data, err := json.MarshalIndent(status, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".automation-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(temporaryPath, path)
}

func nextDelay(policy updaterconfig.Automation, failures int, random float64) time.Duration {
	minutes := policy.CheckIntervalMinutes
	if minutes < 1 {
		minutes = 15
	}
	if failures > 0 {
		for index := 0; index < failures && index < 10; index++ {
			minutes *= 2
		}
		maximum := policy.MaximumBackoffMinutes
		if maximum == 0 {
			maximum = 1440
		}
		if minutes > maximum {
			minutes = maximum
		}
	}
	factor := 1.0
	if policy.JitterPercent > 0 {
		factor += ((random * 2) - 1) * float64(policy.JitterPercent) / 100
	}
	return time.Duration(float64(time.Duration(minutes)*time.Minute) * factor)
}

func currentVersion(config updaterconfig.Config) (string, error) {
	if data, err := os.ReadFile(filepath.Join(config.StateDirectory, "current", release.ManifestFilename)); err == nil {
		manifest, parseErr := release.ParseManifest(data)
		if parseErr == nil {
			return manifest.Version, nil
		}
	}
	data, err := os.ReadFile(filepath.Join(config.WorkingDirectory, "release", "version.json"))
	if err != nil {
		return "", fmt.Errorf("read installed version: %w", err)
	}
	var version struct {
		ProductVersion string `json:"productVersion"`
	}
	if err := json.Unmarshal(data, &version); err != nil || version.ProductVersion == "" {
		return "", errors.New("installed product version is invalid")
	}
	return version.ProductVersion, nil
}

func commandError(operation string, exit int, stderr string) error {
	message := strings.TrimSpace(stderr)
	if message == "" {
		message = "command failed"
	}
	return fmt.Errorf("%s exited %d: %s", operation, exit, message)
}

func wait(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

type PruneResult struct{ Removed, Kept []string }

func PruneReleases(config updaterconfig.Config, keep int) (PruneResult, error) {
	if keep < 1 {
		return PruneResult{}, errors.New("release retention must keep at least one release")
	}
	root := filepath.Join(config.StateDirectory, "releases")
	entries, err := os.ReadDir(root)
	if errors.Is(err, os.ErrNotExist) {
		return PruneResult{}, nil
	}
	if err != nil {
		return PruneResult{}, err
	}
	trusted, err := config.TrustedPublicKeys()
	if err != nil {
		return PruneResult{}, err
	}
	protected := map[string]struct{}{}
	if current, err := currentVersion(config); err == nil {
		protected[current] = struct{}{}
	}
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	if job, err := store.Load(); err == nil {
		protected[job.CurrentVersion] = struct{}{}
		protected[job.TargetVersion] = struct{}{}
	}
	if history, err := store.History(); err == nil && len(history) > 0 {
		protected[history[0].CurrentVersion] = struct{}{}
	}
	type candidate struct {
		version  string
		released time.Time
	}
	var candidates []candidate
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		directory := filepath.Join(root, entry.Name())
		manifestBytes, readErr := os.ReadFile(filepath.Join(directory, release.ManifestFilename))
		if readErr != nil {
			continue
		}
		signatureBytes, readErr := os.ReadFile(filepath.Join(directory, release.SignatureFilename))
		if readErr != nil {
			continue
		}
		signature, parseErr := release.ParseSignature(signatureBytes)
		if parseErr != nil || release.VerifySignature(manifestBytes, signature, trusted) != nil {
			continue
		}
		manifest, parseErr := release.ParseManifest(manifestBytes)
		if parseErr != nil || manifest.Version != entry.Name() {
			continue
		}
		candidates = append(candidates, candidate{manifest.Version, manifest.ReleasedAt})
	}
	for left := 0; left < len(candidates); left++ {
		for right := left + 1; right < len(candidates); right++ {
			if candidates[right].released.After(candidates[left].released) {
				candidates[left], candidates[right] = candidates[right], candidates[left]
			}
		}
	}
	result := PruneResult{}
	for index, candidate := range candidates {
		_, required := protected[candidate.version]
		if index < keep || required {
			result.Kept = append(result.Kept, candidate.version)
			continue
		}
		path := filepath.Join(root, candidate.version)
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil || relative != candidate.version {
			return result, errors.New("refusing to prune release outside cache root")
		}
		if err := os.RemoveAll(path); err != nil {
			return result, err
		}
		result.Removed = append(result.Removed, candidate.version)
	}
	return result, nil
}
