package diagnostics

import (
	"archive/zip"
	"crypto/ed25519"
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
)

func TestCreateExcludesSecretsAndCustomerFiles(t *testing.T) {
	root := t.TempDir()
	public, _, _ := ed25519.GenerateKey(nil)
	config := updaterconfig.Config{SchemaVersion: 1, ComposeProject: "compdf-self-hosted", StateDirectory: filepath.Join(root, "state"), Channel: "stable", AllowedServices: []string{"compdf-app", "compdf-server"}, TrustedKeys: map[string]string{"root-2026": base64.StdEncoding.EncodeToString(public)}, DatabasePasswordFile: filepath.Join(root, "secret-password")}
	if err := os.WriteFile(config.DatabasePasswordFile, []byte("do-not-leak"), 0o600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "support.zip")
	if err := Create(config, destination, time.Date(2026, 9, 17, 1, 2, 3, 0, time.UTC)); err != nil {
		t.Fatal(err)
	}
	archive, err := zip.OpenReader(destination)
	if err != nil {
		t.Fatal(err)
	}
	defer archive.Close()
	var all strings.Builder
	for _, file := range archive.File {
		reader, _ := file.Open()
		data, _ := io.ReadAll(reader)
		reader.Close()
		all.Write(data)
	}
	if strings.Contains(all.String(), "do-not-leak") || strings.Contains(all.String(), config.TrustedKeys["root-2026"]) {
		t.Fatal("diagnostic bundle leaked protected data")
	}
	if !strings.Contains(all.String(), "root-2026") {
		t.Fatal("diagnostic bundle omitted non-secret key ID")
	}
}
