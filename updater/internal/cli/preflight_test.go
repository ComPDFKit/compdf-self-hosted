package cli

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/preflight"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

type cliPreflightProbe struct {
	free  uint64
	calls int
}

func (probe *cliPreflightProbe) Run(_ context.Context, _ string, args ...string) ([]byte, error) {
	probe.calls++
	switch {
	case len(args) >= 2 && args[0] == "version":
		return []byte("27.0.0"), nil
	case len(args) >= 3 && args[0] == "compose" && args[1] == "version":
		return []byte("2.29.0"), nil
	case len(args) >= 2 && args[0] == "image" && args[1] == "inspect":
		return []byte("sha256:image"), nil
	case len(args) >= 2 && args[0] == "compose" && strings.Contains(strings.Join(args, " "), " ps --format json"):
		return []byte(`[{"Service":"compdf-infra","State":"running","Health":"healthy"},{"Service":"compdf-app","State":"running","Health":"healthy"},{"Service":"compdf-server","State":"running","Health":"healthy"}]`), nil
	case len(args) >= 2 && args[0] == "compose" && strings.Contains(strings.Join(args, " "), "mysqldump --version"):
		return []byte("mysqldump 10"), nil
	case len(args) >= 2 && args[0] == "compose" && strings.Contains(strings.Join(args, " "), "tar --version"):
		return []byte("tar 1.35"), nil
	default:
		return nil, errors.New("unexpected preflight command")
	}
}

func (probe *cliPreflightProbe) FreeBytes(string) (uint64, error) { return probe.free, nil }

func (probe *cliPreflightProbe) Get(_ context.Context, _ string) (int, []byte, error) {
	return 200, []byte(`{"data":{"status":"valid","present":true}}`), nil
}

func TestPreflightUsesSignedCurrentReleaseAndBlocksOnDisk(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := signedReleaseServer(t, privateKey, "release-test")
	defer server.Close()
	configPath := writeUpdaterConfig(t, server.URL, map[string]string{"release-test": base64.StdEncoding.EncodeToString(publicKey)})
	config, err := updaterconfig.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(config.WorkingDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.ComposeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config.DatabasePasswordFile, []byte("test-password\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	seedVerifiedJob(t, config, "preflight-1", "4.1.0", "4.2.0")
	original := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = original })
	probe := &cliPreflightProbe{free: config.MinimumFreeBytes + 1}
	args := []string{"preflight", "--config", configPath, "--current-version", "4.1.0", "--version", "4.2.0", "--request-id", "preflight-1"}
	var stdout, stderr bytes.Buffer
	code := run(args, &stdout, &stderr, dependencies{httpClient: server.Client(), timeout: time.Second, preflightProbe: probe})
	if code != 0 {
		t.Fatalf("preflight code=%d stderr=%q report=%q", code, stderr.String(), stdout.String())
	}
	var report preflight.Report
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Overall != preflight.LevelPass || len(report.Checks) != 15 || probe.calls == 0 {
		t.Fatalf("unexpected preflight report: %+v", report)
	}
	probe.free = 1
	stdout.Reset()
	stderr.Reset()
	code = run(args, &stdout, &stderr, dependencies{httpClient: server.Client(), timeout: time.Second, preflightProbe: probe})
	if code != 3 {
		t.Fatalf("blocked preflight code=%d stderr=%q", code, stderr.String())
	}
	if err := json.Unmarshal(stdout.Bytes(), &report); err != nil || report.Overall != preflight.LevelBlock {
		t.Fatalf("blocked report invalid: %+v, %v", report, err)
	}
}

func TestPreflightRejectsUnlistedVersionBeforeHostProbes(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := signedReleaseServer(t, privateKey, "release-test")
	defer server.Close()
	configPath := writeUpdaterConfig(t, server.URL, map[string]string{"release-test": base64.StdEncoding.EncodeToString(publicKey)})
	original := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = original })
	probe := &cliPreflightProbe{free: 20 * 1024 * 1024 * 1024}
	var stdout, stderr bytes.Buffer
	code := run([]string{"preflight", "--config", configPath, "--current-version", "4.1.0", "--version", "4.3.0", "--request-id", "preflight-2"},
		&stdout, &stderr, dependencies{httpClient: server.Client(), timeout: time.Second, preflightProbe: probe})
	if code != 1 || probe.calls != 0 || stdout.Len() != 0 {
		t.Fatalf("unlisted version accepted: %d %q", code, stderr.String())
	}
}

func TestPreflightRejectsUnsafeVersionBeforeNetwork(t *testing.T) {
	probe := &cliPreflightProbe{}
	var stdout, stderr bytes.Buffer
	code := run([]string{"preflight", "--config", filepath.Join(t.TempDir(), "missing.json"), "--current-version", "4.1.0", "--version", "4.2.0+../outside", "--request-id", "preflight-3"},
		&stdout, &stderr, dependencies{preflightProbe: probe})
	if code != 2 || probe.calls != 0 {
		t.Fatalf("unsafe version accepted: %d %q", code, stderr.String())
	}
}

func seedVerifiedJob(t *testing.T, config updaterconfig.Config, requestID, currentVersion, targetVersion string) {
	t.Helper()
	store, err := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	job, err := state.NewJob(requestID, currentVersion, targetVersion, time.Now().UTC().Add(-time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	job, _ = job.Transition(state.PhaseDownloading, "download", time.Now().UTC().Add(-30*time.Second))
	job, _ = job.Transition(state.PhaseVerified, "verified", time.Now().UTC().Add(-20*time.Second))
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
}
