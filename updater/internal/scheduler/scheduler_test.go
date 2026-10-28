package scheduler

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
)

func TestNextDelayBackoffAndJitter(t *testing.T) {
	policy := updaterconfig.Automation{CheckIntervalMinutes: 60, MaximumBackoffMinutes: 240, JitterPercent: 20}
	if got := nextDelay(policy, 0, .5); got != time.Hour {
		t.Fatalf("unexpected base delay: %v", got)
	}
	if got := nextDelay(policy, 3, .5); got != 4*time.Hour {
		t.Fatalf("backoff was not capped: %v", got)
	}
	if got := nextDelay(policy, 0, 0); got != 48*time.Minute {
		t.Fatalf("unexpected low jitter: %v", got)
	}
}

func TestRunOnceChecksAndDownloadsWithStableRequestID(t *testing.T) {
	root := t.TempDir()
	configPath := writeConfig(t, root, updaterconfig.Automation{CheckIntervalMinutes: 60, AutoDownload: true})
	var calls [][]string
	runner := func(args []string, stdout, stderr io.Writer) int {
		calls = append(calls, append([]string(nil), args...))
		if args[0] == "check" {
			_, _ = io.WriteString(stdout, `{"updateAvailable":true,"availableVersion":"4.2.0"}`)
		}
		return 0
	}
	scheduler, err := New(configPath, runner)
	if err != nil {
		t.Fatal(err)
	}
	if err := scheduler.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || calls[1][0] != "download" || calls[1][len(calls[1])-1] != "automatic-4.2.0" {
		t.Fatalf("unexpected calls: %#v", calls)
	}
	if !scheduler.Status().Downloaded {
		t.Fatal("download was not reflected in scheduler status")
	}
}

func TestSchedulerStatusIsPersistedAndReloaded(t *testing.T) {
	root := t.TempDir()
	configPath := writeConfig(t, root, updaterconfig.Automation{CheckIntervalMinutes: 60})
	runner := func(args []string, stdout, stderr io.Writer) int {
		_, _ = io.WriteString(stdout, `{"updateAvailable":false,"availableVersion":"4.1.0"}`)
		return 0
	}
	scheduler, _ := New(configPath, runner)
	scheduler.recordSuccess(updaterconfig.Automation{CheckIntervalMinutes: 60})
	reloaded, err := New(configPath, runner)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.Status().LastSuccessAt.IsZero() || reloaded.Status().NextAttemptAt.IsZero() {
		t.Fatalf("status was not reloaded: %+v", reloaded.Status())
	}
}

func writeConfig(t *testing.T, root string, automation updaterconfig.Automation) string {
	t.Helper()
	working := filepath.Join(root, "install")
	if err := os.MkdirAll(filepath.Join(working, "release"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(working, "release", "version.json"), []byte(`{"productVersion":"4.1.0"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	public, _, _ := ed25519.GenerateKey(nil)
	config := updaterconfig.Config{SchemaVersion: 1, ComposeProject: "compdf-self-hosted", WorkingDirectory: working, ComposeFile: filepath.Join(working, "docker-compose.yml"), StateDirectory: filepath.Join(root, "state"), BackupDirectory: filepath.Join(root, "backups"), DatabasePasswordFile: filepath.Join(root, "password"), ReleaseBaseURL: "https://updates.example.com/compdf/", ServerBaseURL: "http://127.0.0.1:8080", MinimumFreeBytes: 1024 * 1024 * 1024, Channel: "stable", AllowedServices: []string{"compdf-app", "compdf-server"}, TrustedKeys: map[string]string{"test": base64.StdEncoding.EncodeToString(public)}, Automation: automation}
	data, _ := json.Marshal(config)
	path := filepath.Join(root, "config.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
