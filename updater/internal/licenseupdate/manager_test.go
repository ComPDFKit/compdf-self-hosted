package licenseupdate

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/singlelock"
)

const testID = "license-11111111-1111-1111-1111-111111111111"

func TestDesktopMountSource(t *testing.T) {
	if got := mountSource(`C:\Users\user\project\configs\app-license`); filepath.ToSlash(got) != "/run/desktop/mnt/host/c/Users/user/project/configs/app-license" {
		t.Fatal(got)
	}
}

func TestXMLValidation(t *testing.T) {
	for _, v := range []string{"", "<license/>", "<license><key/></license>", "<!DOCTYPE license><license><key>x</key></license>", "<a><key>x</key></a><b/>", "<a><key>x</key><key>y</key></a>", strings.Repeat("x", 65537), "<a><key>&unknown;</key></a>"} {
		if ValidateXML([]byte(v)) == nil {
			t.Fatalf("accepted invalid XML")
		}
	}
	if err := ValidateXML([]byte("<?xml version=\"1.0\"?><license><key>secret</key></license>")); err != nil {
		t.Fatal(err)
	}
}

func fixture(t *testing.T) *Manager {
	t.Helper()
	root := t.TempDir()
	cfg := config.Config{WorkingDirectory: root, StateDirectory: filepath.Join(root, "state"), ComposeProject: "test"}
	if err := os.MkdirAll(filepath.Join(root, "configs", "app-license"), 0700); err != nil {
		t.Fatal(err)
	}
	m, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	m.run = func(ctx context.Context, input []byte, args ...string) ([]byte, error) {
		switch args[0] {
		case "ps":
			return []byte("abcdef123456"), nil
		case "inspect":
			b, _ := json.Marshal([]map[string]any{{"Type": "bind", "Source": m.directory(), "Destination": "/opt/compdf_sdk/license", "RW": false}})
			return b, nil
		default:
			return nil, nil
		}
	}
	return m
}
func done(t *testing.T, m *Manager) Status {
	t.Helper()
	until := time.Now().Add(5 * time.Second)
	for time.Now().Before(until) {
		m.mu.Lock()
		running := m.running
		s := m.job.Status
		m.mu.Unlock()
		if !running {
			return s
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("license worker did not finish")
	return Status{}
}
func TestInstallPersistsAndBacksUp(t *testing.T) {
	m := fixture(t)
	old := []byte("<license><key>old</key></license>")
	new := []byte("<license><key>new</key></license>")
	if err := os.WriteFile(m.target(), old, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Start(testID, new); err != nil {
		t.Fatal(err)
	}
	if s := done(t, m); s.Phase != "SUCCEEDED" {
		t.Fatal(s)
	}
	got, _ := os.ReadFile(m.target())
	backup, _ := os.ReadFile(m.backup())
	if string(got) != string(new) || string(backup) != string(old) {
		t.Fatal("license or backup differs")
	}
	data, _ := os.ReadFile(m.statePath())
	if strings.Contains(string(data), "<key>") {
		t.Fatal("journal leaked key")
	}
	restored, err := New(m.cfg)
	if err != nil || restored.Status().Phase != "SUCCEEDED" {
		t.Fatal("terminal state not durable", err)
	}
}

func TestInstallThroughWorkingDirectoryAlias(t *testing.T) {
	for _, rollback := range []bool{false, true} {
		t.Run(map[bool]string{false: "install", true: "rollback"}[rollback], func(t *testing.T) {
			m := fixture(t)
			alias := filepath.Join(t.TempDir(), "installation")
			if err := os.Symlink(m.cfg.WorkingDirectory, alias); err != nil {
				t.Skipf("directory symlinks unavailable: %v", err)
			}
			m.cfg.WorkingDirectory = alias
			old := []byte("<license><key>old</key></license>")
			new := []byte("<license><key>new</key></license>")
			if err := os.WriteFile(m.target(), old, 0600); err != nil {
				t.Fatal(err)
			}
			original := m.run
			restarts := 0
			m.run = func(ctx context.Context, input []byte, args ...string) ([]byte, error) {
				if args[0] == "restart" {
					restarts++
					if rollback && restarts == 1 {
						return nil, errors.New("restart failed")
					}
				}
				return original(ctx, input, args...)
			}
			if _, err := m.Start(testID, new); err != nil {
				t.Fatal(err)
			}
			wantPhase, wantFile, wantRestarts := "SUCCEEDED", new, 1
			if rollback {
				wantPhase, wantFile, wantRestarts = "ROLLED_BACK", old, 2
			}
			if s := done(t, m); s.Phase != wantPhase || restarts != wantRestarts {
				t.Fatal(s, restarts)
			}
			got, err := os.ReadFile(m.target())
			if err != nil || string(got) != string(wantFile) {
				t.Fatal("unexpected runtime license", err)
			}
			backup, err := os.ReadFile(m.backup())
			if err != nil || string(backup) != string(old) {
				t.Fatal("previous license backup differs", err)
			}
		})
	}
}

func TestContainerRejectsSymlinkBelowWorkingDirectory(t *testing.T) {
	for _, child := range []string{"configs", filepath.Join("configs", "app-license")} {
		t.Run(child, func(t *testing.T) {
			m := fixture(t)
			path := filepath.Join(m.cfg.WorkingDirectory, child)
			target := filepath.Join(t.TempDir(), "redirected")
			if err := os.Rename(path, target); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(target, path); err != nil {
				t.Skipf("directory symlinks unavailable: %v", err)
			}
			if _, err := m.container(context.Background()); err == nil {
				t.Fatal("accepted a symlink below the configured installation root")
			}
		})
	}
}

func TestContainerRejectsInvalidWorkingDirectory(t *testing.T) {
	for _, kind := range []string{"missing", "file", "dangling-symlink"} {
		t.Run(kind, func(t *testing.T) {
			m := fixture(t)
			path := filepath.Join(t.TempDir(), "installation")
			switch kind {
			case "file":
				if err := os.WriteFile(path, []byte("not a directory"), 0600); err != nil {
					t.Fatal(err)
				}
			case "dangling-symlink":
				if err := os.Symlink(filepath.Join(t.TempDir(), "missing"), path); err != nil {
					t.Skipf("directory symlinks unavailable: %v", err)
				}
			}
			m.cfg.WorkingDirectory = path
			if _, err := m.container(context.Background()); err == nil {
				t.Fatal("accepted an invalid installation root")
			}
		})
	}
}

func TestValidationFailureDoesNotReplaceOrRestart(t *testing.T) {
	m := fixture(t)
	original := m.run
	restarts := 0
	m.run = func(ctx context.Context, input []byte, args ...string) ([]byte, error) {
		if args[0] == "restart" {
			restarts++
		}
		if len(input) > 0 {
			return nil, errors.New("secret vendor error")
		}
		return original(ctx, input, args...)
	}
	os.WriteFile(m.target(), []byte("old"), 0600)
	m.Start(testID, []byte("<license><key>bad</key></license>"))
	s := done(t, m)
	got, _ := os.ReadFile(m.target())
	if s.Phase != "FAILED" || restarts != 0 || string(got) != "old" || strings.Contains(s.Error, "secret") {
		t.Fatal(s, restarts)
	}
}
func TestRestartFailureRestoresFileOrEnvironment(t *testing.T) {
	for _, had := range []bool{false, true} {
		t.Run(map[bool]string{false: "environment", true: "file"}[had], func(t *testing.T) {
			m := fixture(t)
			original := m.run
			restarts := 0
			if had {
				os.WriteFile(m.target(), []byte("old"), 0600)
			}
			m.run = func(ctx context.Context, input []byte, args ...string) ([]byte, error) {
				if args[0] == "restart" {
					restarts++
					if restarts == 1 {
						return nil, errors.New("restart failed")
					}
				}
				return original(ctx, input, args...)
			}
			m.Start(testID, []byte("<license><key>new</key></license>"))
			s := done(t, m)
			if s.Phase != "ROLLED_BACK" || restarts != 2 {
				t.Fatal(s, restarts)
			}
			got, err := os.ReadFile(m.target())
			if had && string(got) != "old" {
				t.Fatal("old license not restored")
			}
			if !had && !os.IsNotExist(err) {
				t.Fatal("environment fallback not restored")
			}
		})
	}
}
func TestSharedLockAndInterruptedRecovery(t *testing.T) {
	m := fixture(t)
	lock, err := singlelock.Acquire(filepath.Join(m.cfg.StateDirectory, "updater.lock"), time.Minute, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Start(testID, []byte("<license><key>new</key></license>")); err == nil {
		t.Fatal("bypassed upgrade lock")
	}
	lock.Release()
	m.job = journal{Status: Status{RequestID: testID, Phase: "RESTARTING"}, Container: "abcdef123456", HadFile: true}
	atomicWrite(m.backup(), []byte("old"))
	atomicWrite(m.target(), []byte("new"))
	m.save()
	recovered, err := New(m.cfg)
	if err != nil {
		t.Fatal(err)
	}
	recovered.run = m.run
	if recovered.Status().Phase != "RECOVERY_REQUIRED" {
		t.Fatal("interrupted operation not fenced")
	}
	if _, err = recovered.Recover(testID); err != nil {
		t.Fatal(err)
	}
	if s := done(t, recovered); s.Phase != "ROLLED_BACK" {
		t.Fatal(s)
	}
}
