package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadValidConfig(t *testing.T) {
	root := t.TempDir()
	config := validConfig(root)
	path := filepath.Join(root, "config.json")
	data, _ := json.Marshal(config)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ComposeProject != "compdf-self-hosted" {
		t.Fatalf("unexpected config: %+v", loaded)
	}
}

func TestHTTPClientTrustsConfiguredPrivateCA(t *testing.T) {
	server := httptest.NewTLSServer(nil)
	defer server.Close()
	certificate := server.Certificate()
	caPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate.Raw})
	caPath := filepath.Join(t.TempDir(), "private-ca.pem")
	if err := os.WriteFile(caPath, caPEM, 0o600); err != nil {
		t.Fatal(err)
	}
	config := validConfig(t.TempDir())
	config.TrustedCACertificateFile = caPath
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	client, err := config.HTTPClient(5 * time.Second)
	if err != nil {
		t.Fatal(err)
	}
	response, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("configured private CA was not trusted: %v", err)
	}
	response.Body.Close()
}

func TestRejectsRelativeTrustedCAPath(t *testing.T) {
	config := validConfig(t.TempDir())
	config.TrustedCACertificateFile = "private-ca.pem"
	if err := config.Validate(); err == nil {
		t.Fatal("relative trusted CA path was accepted")
	}
}

func TestRejectsComposeOutsideWorkingDirectory(t *testing.T) {
	root := t.TempDir()
	config := validConfig(root)
	config.ComposeFile = filepath.Join(filepath.Dir(root), "other", "compose.yml")
	if err := config.Validate(); err == nil {
		t.Fatal("outside compose file was accepted")
	}
}

func TestRejectsAdditionalService(t *testing.T) {
	config := validConfig(t.TempDir())
	config.AllowedServices = append(config.AllowedServices, "compdf-infra")
	if err := config.Validate(); err == nil {
		t.Fatal("infrastructure service was accepted")
	}
}

func validConfig(root string) Config {
	working := filepath.Join(root, "install")
	return Config{
		SchemaVersion:        1,
		ComposeProject:       "compdf-self-hosted",
		WorkingDirectory:     working,
		ComposeFile:          filepath.Join(working, "docker-compose.yml"),
		StateDirectory:       filepath.Join(root, "state"),
		BackupDirectory:      filepath.Join(root, "backups"),
		DatabasePasswordFile: filepath.Join(root, "mysql-password"),
		ReleaseBaseURL:       "https://updates.example.com/compdf/",
		ServerBaseURL:        "http://127.0.0.1:8080",
		MinimumFreeBytes:     5 * 1024 * 1024 * 1024,
		Channel:              "stable",
		AllowedServices:      []string{"compdf-app", "compdf-server"},
		TrustedKeys:          map[string]string{"release-test": base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))},
	}
}

func TestRejectsRemoteServerBaseURL(t *testing.T) {
	config := validConfig(t.TempDir())
	config.ServerBaseURL = "https://customer.example.com"
	if err := config.Validate(); err == nil {
		t.Fatal("remote server base URL was accepted")
	}
}

func TestRejectsInsufficientMinimumDiskRequirement(t *testing.T) {
	config := validConfig(t.TempDir())
	config.MinimumFreeBytes = 1024
	if err := config.Validate(); err == nil {
		t.Fatal("unsafe disk requirement was accepted")
	}
}

func TestRejectsMissingTrustedKeys(t *testing.T) {
	config := validConfig(t.TempDir())
	config.TrustedKeys = nil
	if err := config.Validate(); err == nil {
		t.Fatal("missing trusted release keys were accepted")
	}
}

func TestRejectsMalformedTrustedKey(t *testing.T) {
	config := validConfig(t.TempDir())
	config.TrustedKeys = map[string]string{"release-test": "not-base64"}
	if err := config.Validate(); err == nil {
		t.Fatal("malformed trusted release key was accepted")
	}
}

func TestAutomationPolicyValidation(t *testing.T) {
	config := validConfig(t.TempDir())
	config.Automation = Automation{CheckIntervalMinutes: 360, JitterPercent: 20, MaximumBackoffMinutes: 1440, AutoDownload: true, RetainReleases: 2, DownloadBytesPerSecond: 8 * 1024 * 1024}
	if err := config.Validate(); err != nil {
		t.Fatal(err)
	}
	config.Automation.CheckIntervalMinutes = 5
	if err := config.Validate(); err == nil {
		t.Fatal("unsafe automatic check interval was accepted")
	}
	config.Automation = Automation{AutoDownload: true}
	if err := config.Validate(); err == nil {
		t.Fatal("automatic download without automatic checks was accepted")
	}
	config.Automation = Automation{DownloadBytesPerSecond: -1}
	if err := config.Validate(); err == nil {
		t.Fatal("negative download bandwidth limit was accepted")
	}
}
