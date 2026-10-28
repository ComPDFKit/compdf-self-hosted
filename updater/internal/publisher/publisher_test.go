package publisher

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/offline"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

func TestBuildGeneratesSignedOnlineAndOfflineArtifacts(t *testing.T) {
	root := t.TempDir()
	for name, data := range map[string]string{
		"compose.yml": "services: {}\n", "app.tar": "app image", "server.tar": "server image",
	} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(data), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	keyPath := filepath.Join(root, "release.key")
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(privateKey)), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	spec := Spec{
		SchemaVersion: 1, Version: "4.2.0", Channel: "stable", MinimumVersion: "4.1.0", MinimumUpdaterVersion: "0.1.0",
		ReleasedAt: now.Add(-time.Hour), ExpiresAt: now.Add(24 * time.Hour), MaintenanceRequired: true,
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
		Migration: MigrationInput{From: "4.1.0", To: "4.2.0"}, Rollback: release.Rollback{Application: true},
		Compose: &ArtifactInput{Path: "compose.release.yml", Source: "compose.yml"},
		OfflineImages: map[string]ArtifactInput{
			"app": {Path: "images/compdf-app.tar", Source: "app.tar"}, "server": {Path: "images/compdf-server.tar", Source: "server.tar"},
		},
		ReleaseNotes: "Publisher test", KnownIssues: []string{},
	}
	specBytes, _ := json.Marshal(spec)
	specPath := filepath.Join(root, "release-spec.json")
	if err := os.WriteFile(specPath, specBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(root, "published", "4.2.0")
	packagePath := filepath.Join(root, "published", "compdf-update-4.2.0.tar.zst")
	result, err := Build(specPath, keyPath, "release-test", output, packagePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := release.VerifySignature(result.ManifestBytes, mustSignature(t, result.SignatureBytes), map[string]ed25519.PublicKey{"release-test": publicKey}); err != nil {
		t.Fatal(err)
	}
	if err := release.VerifyBundle(output, result.Manifest, result.ManifestBytes, result.SignatureBytes); err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(result.ManifestBytes, []byte(`"knownIssues": []`)) {
		t.Fatalf("empty known issues must be published as an array: %s", result.ManifestBytes)
	}
	imported, err := offline.Import(context.Background(), packagePath, filepath.Join(root, "import-state"), map[string]ed25519.PublicKey{"release-test": publicKey})
	if err != nil || imported.Manifest.Version != "4.2.0" {
		t.Fatalf("generated offline package did not import: %+v, %v", imported, err)
	}
}

func TestBuildRefusesToOverwritePublishedVersion(t *testing.T) {
	root := t.TempDir()
	specPath := filepath.Join(root, "missing.json")
	keyPath := filepath.Join(root, "missing.key")
	output := filepath.Join(root, "release")
	if err := os.MkdirAll(output, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, err := Build(specPath, keyPath, "key", output, ""); err == nil {
		t.Fatal("existing release output was overwritten")
	}
}

func TestBuildAllowsImageOnlyOnlineRelease(t *testing.T) {
	root := t.TempDir()
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	keyPath := filepath.Join(root, "release.key")
	if err := os.WriteFile(keyPath, []byte(base64.StdEncoding.EncodeToString(privateKey)), 0o600); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	spec := Spec{
		SchemaVersion: 1, Version: "1.1.0", Channel: "stable", MinimumVersion: "1.1.0", MinimumUpdaterVersion: "1.1.0",
		ReleasedAt: now.Add(-time.Hour), ExpiresAt: now.Add(24 * time.Hour),
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "1.0.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "1.1.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
		Migration: MigrationInput{From: "1.1.0", To: "1.1.0"},
		Rollback:  release.Rollback{Application: true},
		ReleaseNotes: "Image-only publisher test", KnownIssues: []string{},
	}
	specBytes, _ := json.Marshal(spec)
	specPath := filepath.Join(root, "release-spec.json")
	if err := os.WriteFile(specPath, specBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(root, "published", "1.1.0")
	result, err := Build(specPath, keyPath, "release-test", output, "")
	if err != nil {
		t.Fatal(err)
	}
	if result.Manifest.Checksums != nil {
		t.Fatal("image-only online release should not publish an empty checksums artifact")
	}
	if err := release.VerifySignature(result.ManifestBytes, mustSignature(t, result.SignatureBytes), map[string]ed25519.PublicKey{"release-test": publicKey}); err != nil {
		t.Fatal(err)
	}
	if err := release.VerifyBundle(output, result.Manifest, result.ManifestBytes, result.SignatureBytes); err != nil {
		t.Fatal(err)
	}
}

func mustSignature(t *testing.T, data []byte) release.Signature {
	t.Helper()
	signature, err := release.ParseSignature(data)
	if err != nil {
		t.Fatal(err)
	}
	return signature
}
