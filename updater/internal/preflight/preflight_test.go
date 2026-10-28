package preflight

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

type fakeProbe struct {
	freeBytes uint64
	license   string
	commands  map[string][]byte
	errors    map[string]error
}

func (probe fakeProbe) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	key := strings.Join(append([]string{name}, args...), " ")
	if err := probe.errors[key]; err != nil {
		return nil, err
	}
	output, ok := probe.commands[key]
	if !ok {
		return nil, fmt.Errorf("unexpected command: %s", key)
	}
	return output, nil
}

func (probe fakeProbe) FreeBytes(string) (uint64, error) {
	return probe.freeBytes, nil
}

func (probe fakeProbe) Get(_ context.Context, _ string) (int, []byte, error) {
	return 200, []byte(probe.license), nil
}

func TestCheckPassesReadyEnvironment(t *testing.T) {
	input, probe := readyInput(t)
	report := NewChecker(probe).Check(context.Background(), input)
	if report.Blocked() {
		t.Fatalf("ready environment was blocked: %+v", report.Checks)
	}
	if report.Overall != LevelPass {
		t.Fatalf("unexpected overall result: %s", report.Overall)
	}
	if len(report.Checks) != 15 {
		t.Fatalf("unexpected check count: %d", len(report.Checks))
	}
}

func TestCheckCollectsBlockingResults(t *testing.T) {
	input, probe := readyInput(t)
	probe.freeBytes = 1
	delete(probe.commands, dockerVersionCommand())
	probe.errors[dockerVersionCommand()] = fmt.Errorf("daemon unavailable")
	report := NewChecker(probe).Check(context.Background(), input)
	if report.Overall != LevelBlock {
		t.Fatalf("unexpected overall result: %s", report.Overall)
	}
	if !report.Blocked() {
		t.Fatal("unsafe environment was not blocked")
	}
	ids := strings.Join(SortedBlockingIDs(report), ",")
	if !strings.Contains(ids, "disk-space") || !strings.Contains(ids, "docker") {
		t.Fatalf("expected disk and docker blocks, got %s", ids)
	}
}

func TestCheckWarnsForExpiringLicense(t *testing.T) {
	input, probe := readyInput(t)
	probe.license = `{"code":200,"msg":"success","data":{"status":"expiring","present":true}}`
	report := NewChecker(probe).Check(context.Background(), input)
	if report.Overall != LevelWarn {
		t.Fatalf("unexpected overall result: %s", report.Overall)
	}
	for _, check := range report.Checks {
		if check.ID == "license" && check.Level == LevelWarn {
			return
		}
	}
	t.Fatal("expiring license did not produce a warning")
}

func TestDecodeContainersSupportsArrayAndJSONLines(t *testing.T) {
	array := []byte(`[{"Service":"compdf-app","State":"running","Health":"healthy"}]`)
	lines := []byte("{\"Service\":\"compdf-app\",\"State\":\"running\",\"Health\":\"healthy\"}\n{\"Service\":\"compdf-server\",\"State\":\"running\",\"Health\":\"healthy\"}\n")
	for _, input := range [][]byte{array, lines} {
		containers, err := decodeContainers(input)
		if err != nil || len(containers) == 0 {
			t.Fatalf("failed to decode %q: %v", input, err)
		}
	}
}

func readyInput(t *testing.T) (Input, fakeProbe) {
	t.Helper()
	root := t.TempDir()
	working := filepath.Join(root, "install")
	stateDirectory := filepath.Join(root, "state")
	backupDirectory := filepath.Join(root, "backups")
	if err := os.MkdirAll(working, 0o700); err != nil {
		t.Fatal(err)
	}
	composeFile := filepath.Join(working, "docker-compose.yml")
	if err := os.WriteFile(composeFile, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	migration := []byte("SELECT 1;\n")
	sum := sha256.Sum256(migration)
	migrationPath := filepath.Join(stateDirectory, "releases", "4.2.0", "migrations", "4.1.0-to-4.2.0.sql")
	if err := os.MkdirAll(filepath.Dir(migrationPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(migrationPath, migration, 0o600); err != nil {
		t.Fatal(err)
	}
	config := updaterconfig.Config{
		SchemaVersion:        1,
		ComposeProject:       "compdf-self-hosted",
		WorkingDirectory:     working,
		ComposeFile:          composeFile,
		StateDirectory:       stateDirectory,
		BackupDirectory:      backupDirectory,
		DatabasePasswordFile: filepath.Join(root, "mysql-password"),
		ReleaseBaseURL:       "https://updates.example.com/compdf/",
		ServerBaseURL:        "http://127.0.0.1:8080",
		MinimumFreeBytes:     1024 * 1024 * 1024,
		Channel:              "stable",
		AllowedServices:      []string{"compdf-app", "compdf-server"},
	}
	if err := os.WriteFile(config.DatabasePasswordFile, []byte("fixture-password\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)
	manifest := release.Manifest{
		SchemaVersion:         1,
		Version:               "4.2.0",
		Channel:               "stable",
		MinimumVersion:        "4.1.0",
		MinimumUpdaterVersion: "0.1.0",
		ReleasedAt:            now.Add(-time.Hour),
		ExpiresAt:             now.Add(24 * time.Hour),
		MaintenanceRequired:   true,
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
		Migration: release.Migration{
			From:     "4.1.0",
			To:       "4.2.0",
			Required: true,
			Artifact: &release.Artifact{Path: "migrations/4.1.0-to-4.2.0.sql", SHA256: hex.EncodeToString(sum[:]), Size: int64(len(migration))},
		},
		Rollback:     release.Rollback{Application: true},
		ReleaseNotes: "test release",
	}
	containerJSON := []byte(`[
        {"Service":"compdf-infra","State":"running","Health":"healthy"},
        {"Service":"compdf-app","State":"running","Health":"healthy"},
        {"Service":"compdf-server","State":"running","Health":"healthy"}
    ]`)
	probe := fakeProbe{
		freeBytes: 10 * 1024 * 1024 * 1024,
		license:   `{"code":200,"msg":"success","data":{"status":"valid","present":true}}`,
		commands: map[string][]byte{
			dockerVersionCommand():                                                                                 []byte("27.0.0\n"),
			"docker compose version --short":                                                                       []byte("2.29.0\n"),
			composeCommand(config, "ps", "--format", "json"):                                                       containerJSON,
			composeCommand(config, "exec", "-T", "compdf-infra", "mysqldump", "--version"):                         []byte("mysqldump  Ver 10.13\n"),
			composeCommand(config, "exec", "-T", "compdf-infra", "tar", "--version"):                               []byte("tar 1.35\n"),
			composeCommand(config, "exec", "-T", "compdf-app", "tar", "--version"):                                 []byte("tar 1.35\n"),
			"docker image inspect compdfkit/compdf-app@sha256:" + strings.Repeat("a", 64) + " --format {{.Id}}":    []byte("sha256:app\n"),
			"docker image inspect compdfkit/compdf-server@sha256:" + strings.Repeat("b", 64) + " --format {{.Id}}": []byte("sha256:server\n"),
		},
		errors: map[string]error{},
	}
	return Input{Config: config, Manifest: manifest, CurrentVersion: "4.1.0", UpdaterVersion: "0.1.0", Now: now}, probe
}

func dockerVersionCommand() string {
	return "docker version --format {{.Server.Version}}"
}

func composeCommand(config updaterconfig.Config, args ...string) string {
	prefix := []string{"docker", "compose", "--project-name", config.ComposeProject, "--file", config.ComposeFile}
	return strings.Join(append(prefix, args...), " ")
}

func TestComposeCheckAcceptsNewerMajorVersions(t *testing.T) {
	checker := NewChecker(fakeProbe{commands: map[string][]byte{
		"docker compose version --short": []byte("5.1.4\n"),
	}, errors: map[string]error{}})
	result := checker.checkCompose(context.Background())
	if result.Level != LevelPass {
		t.Fatalf("Compose 5 should be accepted: %+v", result)
	}
}
