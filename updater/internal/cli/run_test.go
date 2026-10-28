package cli

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

func TestHelp(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run(nil, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("Run() code = %d, want 0", code)
	}
	if !strings.Contains(stdout.String(), "Usage:") {
		t.Fatalf("help output missing Usage: %q", stdout.String())
	}
	if stderr.Len() != 0 {
		t.Fatalf("unexpected stderr: %q", stderr.String())
	}
}

func TestVersionJSON(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"version", "--json"}, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("Run() code = %d, want 0", code)
	}
	var got buildinfo.Info
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil {
		t.Fatalf("version output is not JSON: %v", err)
	}
	if got.Version != buildinfo.Version {
		t.Fatalf("version = %q, want %q", got.Version, buildinfo.Version)
	}
}

func TestUnknownCommand(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"destroy"}, &stdout, &stderr)
	if code == 0 {
		t.Fatal("unknown command returned success")
	}
	if !strings.Contains(stderr.String(), "unknown command") {
		t.Fatalf("unexpected stderr: %q", stderr.String())
	}
}

func TestCheckReleaseJSON(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := signedReleaseServer(t, privateKey, "release-test")
	defer server.Close()
	configPath := writeUpdaterConfig(t, server.URL, map[string]string{
		"release-test": base64.StdEncoding.EncodeToString(publicKey),
	})

	originalVersion := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = originalVersion })

	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"check", "--config", configPath, "--current-version", "4.1.0", "--json"},
		&stdout,
		&stderr,
		dependencies{httpClient: server.Client(), timeout: time.Second},
	)
	if code != 0 {
		t.Fatalf("check code = %d, stderr = %q", code, stderr.String())
	}
	var result checkResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("check output is not JSON: %v", err)
	}
	if !result.UpdateAvailable || result.AvailableVersion != "4.2.0" || result.Channel != "stable" {
		t.Fatalf("unexpected check result: %+v", result)
	}
	if result.KnownIssues == nil {
		t.Fatal("empty known issues must be returned as an array")
	}
}

func TestCheckRejectsUntrustedSigningKey(t *testing.T) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	trustedKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	server := signedReleaseServer(t, privateKey, "untrusted-key")
	defer server.Close()
	configPath := writeUpdaterConfig(t, server.URL, map[string]string{
		"release-test": base64.StdEncoding.EncodeToString(trustedKey),
	})

	originalVersion := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = originalVersion })

	var stdout, stderr bytes.Buffer
	code := run(
		[]string{"check", "--config", configPath, "--current-version", "4.1.0"},
		&stdout,
		&stderr,
		dependencies{httpClient: server.Client(), timeout: time.Second},
	)
	if code != 1 || !strings.Contains(stderr.String(), "is not trusted") {
		t.Fatalf("check code = %d, stderr = %q", code, stderr.String())
	}
}

func TestCheckRequiresProtectedInputs(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := Run([]string{"check", "--current-version", "4.1.0"}, &stdout, &stderr)
	if code != 2 || !strings.Contains(stderr.String(), "--config") {
		t.Fatalf("check code = %d, stderr = %q", code, stderr.String())
	}
}

func TestStatusWithoutStateReturnsNull(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	configPath := writeUpdaterConfig(t, "https://updates.example.invalid/", map[string]string{
		"runtime-test": base64.StdEncoding.EncodeToString(publicKey),
	})
	var stdout, stderr bytes.Buffer
	if code := Run([]string{"status", "--config", configPath}, &stdout, &stderr); code != 0 {
		t.Fatalf("status code = %d, stderr = %q", code, stderr.String())
	}
	if strings.TrimSpace(stdout.String()) != "null" {
		t.Fatalf("status output = %q, want null", stdout.String())
	}
}

func TestCancelWithoutStateReportsNoActiveJob(t *testing.T) {
	publicKey, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	configPath := writeUpdaterConfig(t, "https://updates.example.invalid/", map[string]string{
		"runtime-test": base64.StdEncoding.EncodeToString(publicKey),
	})
	var stdout, stderr bytes.Buffer
	if code := Run([]string{"cancel", "--config", configPath, "--request-id", "missing-job"}, &stdout, &stderr); code != 1 {
		t.Fatalf("cancel code = %d, stderr = %q", code, stderr.String())
	}
	if !strings.Contains(stderr.String(), "no active update job") {
		t.Fatalf("cancel stderr = %q", stderr.String())
	}
}

func signedReleaseServer(t *testing.T, privateKey ed25519.PrivateKey, keyID string) *httptest.Server {
	t.Helper()
	now := time.Now().UTC()
	manifestBytes, err := json.Marshal(release.Manifest{
		SchemaVersion:         1,
		Version:               "4.2.0",
		Channel:               "stable",
		MinimumVersion:        "4.1.0",
		MinimumUpdaterVersion: "0.1.0",
		ReleasedAt:            now.Add(-time.Hour),
		ExpiresAt:             now.Add(time.Hour),
		MaintenanceRequired:   true,
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
		Migration:    release.Migration{From: "4.1.0", To: "4.2.0"},
		Rollback:     release.Rollback{Application: true},
		ReleaseNotes: "Test release",
		KnownIssues:  []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(manifestBytes)
	signatureBytes, err := json.Marshal(release.Signature{
		SchemaVersion:  1,
		Algorithm:      "Ed25519",
		KeyID:          keyID,
		ManifestSHA256: hex.EncodeToString(digest[:]),
		Value:          base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestBytes)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/stable/release.json":
			_, _ = response.Write(manifestBytes)
		case "/stable/release.json.sig":
			_, _ = response.Write(signatureBytes)
		default:
			http.NotFound(response, request)
		}
	}))
}

func writeUpdaterConfig(t *testing.T, releaseURL string, trustedKeys map[string]string) string {
	t.Helper()
	root := t.TempDir()
	workingDirectory := filepath.Join(root, "install")
	config := updaterconfig.Config{
		SchemaVersion:        1,
		ComposeProject:       "compdf-self-hosted",
		WorkingDirectory:     workingDirectory,
		ComposeFile:          filepath.Join(workingDirectory, "docker-compose.yml"),
		StateDirectory:       filepath.Join(root, "state"),
		BackupDirectory:      filepath.Join(root, "backups"),
		DatabasePasswordFile: filepath.Join(root, "mysql-password"),
		ReleaseBaseURL:       releaseURL,
		ServerBaseURL:        "http://127.0.0.1:8080",
		MinimumFreeBytes:     5 * 1024 * 1024 * 1024,
		Channel:              "stable",
		AllowedServices:      []string{"compdf-app", "compdf-server"},
		TrustedKeys:          trustedKeys,
	}
	data, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "config.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}
