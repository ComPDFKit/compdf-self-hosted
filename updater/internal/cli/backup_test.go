package cli

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/backup"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
)

type testDumper struct{}

func (testDumper) Dump(_ context.Context, writer io.Writer) error {
	_, err := io.WriteString(writer, "-- fixture dump --\n")
	return err
}

func TestBackupCreateRequiresExplicitApproval(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"backup", "create", "--file", "missing.json", "--request-id", "test-1", "--current-version", "4.1.0"}, &stdout, &stderr)
	if code != 2 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "--maintenance-confirmed") {
		t.Fatalf("unexpected result: code=%d stdout=%q stderr=%q", code, stdout.String(), stderr.String())
	}
}

func TestBackupVerifyReportsPartialCoverage(t *testing.T) {
	config, configPath := testBackupConfig(t)
	request := backup.Request{
		RequestID: "test-1", CurrentVersion: "4.1.0", BackupRoot: config.BackupDirectory,
		Dumper: testDumper{}, Now: time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC),
		Sources: installationSources(config),
	}
	manifest, _, err := backup.NewExecutor().Create(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := Run([]string{"backup", "verify", "--file", configPath, "--backup-id", manifest.BackupID}, &stdout, &stderr)
	if code != 3 || stderr.Len() != 0 {
		t.Fatalf("unexpected result: code=%d stderr=%q", code, stderr.String())
	}
	var result backupResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "partial" || len(result.Manifest.NotCovered) != 3 {
		t.Fatalf("incomplete coverage was not reported: %+v", result)
	}
}

func TestBackupVerifyRejectsTraversal(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"backup", "verify", "--file", "ignored", "--backup-id", "../outside"}, &stdout, &stderr)
	if code != 2 || stdout.Len() != 0 {
		t.Fatalf("unexpected result: %d %q", code, stdout.String())
	}
}

func testBackupConfig(t *testing.T) (updaterconfig.Config, string) {
	t.Helper()
	root := t.TempDir()
	working := filepath.Join(root, "install")
	for _, name := range []string{"configs", filepath.Join("data", "server-storage")} {
		if err := os.MkdirAll(filepath.Join(working, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	compose := filepath.Join(working, "docker-compose.yml")
	if err := os.WriteFile(compose, []byte("services: {}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := updaterconfig.Config{
		SchemaVersion: 1, ComposeProject: "compdf-self-hosted", WorkingDirectory: working,
		ComposeFile: compose, StateDirectory: filepath.Join(root, "state"), BackupDirectory: filepath.Join(root, "backups"),
		DatabasePasswordFile: filepath.Join(root, "password"), ReleaseBaseURL: "https://updates.example.com/compdf/",
		ServerBaseURL: "http://127.0.0.1:8080", MinimumFreeBytes: 5 * 1024 * 1024 * 1024,
		Channel: "stable", AllowedServices: []string{"compdf-app", "compdf-server"},
		TrustedKeys: map[string]string{"release-test": base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))},
	}
	configPath := filepath.Join(root, "updater.json")
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return config, configPath
}
