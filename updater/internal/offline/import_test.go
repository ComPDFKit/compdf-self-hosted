package offline

import (
	"archive/tar"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/klauspost/compress/zstd"
)

func TestImportVerifiesSignedClosedOfflinePackage(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	files := offlineFiles(t, privateKey)
	packagePath := writePackage(t, files)
	stateDirectory := filepath.Join(t.TempDir(), "state")
	result, err := Import(context.Background(), packagePath, stateDirectory, map[string]ed25519.PublicKey{"offline-test": publicKey})
	if err != nil {
		t.Fatal(err)
	}
	if result.Manifest.Version != "4.2.0" || result.Directory != filepath.Join(stateDirectory, "releases", "4.2.0") {
		t.Fatalf("unexpected import result: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(result.Directory, "images", "compdf-app.tar")); err != nil {
		t.Fatal(err)
	}
}

func TestImportRejectsTraversalAndExtraFiles(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	for _, test := range []struct {
		name string
		path string
		want string
	}{
		{name: "traversal", path: "../escape", want: "escapes"},
		{name: "extra", path: "extra.txt", want: "undeclared"},
	} {
		t.Run(test.name, func(t *testing.T) {
			files := offlineFiles(t, privateKey)
			files[test.path] = []byte("unexpected")
			_, err := Import(context.Background(), writePackage(t, files), filepath.Join(t.TempDir(), "state"), map[string]ed25519.PublicKey{"offline-test": publicKey})
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("Import() error = %v, want %q", err, test.want)
			}
		})
	}
}

func offlineFiles(t *testing.T, privateKey ed25519.PrivateKey) map[string][]byte {
	t.Helper()
	app := []byte("app image archive")
	server := []byte("server image archive")
	artifact := func(path string, data []byte) release.Artifact {
		digest := sha256.Sum256(data)
		return release.Artifact{Path: path, SHA256: hex.EncodeToString(digest[:]), Size: int64(len(data))}
	}
	now := time.Now().UTC()
	manifest, err := json.Marshal(release.Manifest{
		SchemaVersion: 1, Version: "4.2.0", Channel: "stable", MinimumVersion: "4.1.0", MinimumUpdaterVersion: "0.1.0",
		ReleasedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour),
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
		OfflineImages: map[string]release.Artifact{"app": artifact("images/compdf-app.tar", app), "server": artifact("images/compdf-server.tar", server)},
		Migration:     release.Migration{From: "4.1.0", To: "4.2.0"}, Rollback: release.Rollback{Application: true},
		ReleaseNotes: "Offline test", KnownIssues: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(manifest)
	signature, _ := json.Marshal(release.Signature{
		SchemaVersion: 1, Algorithm: "Ed25519", KeyID: "offline-test", ManifestSHA256: hex.EncodeToString(digest[:]),
		Value: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifest)),
	})
	return map[string][]byte{
		release.ManifestFilename: manifest, release.SignatureFilename: signature,
		"images/compdf-app.tar": app, "images/compdf-server.tar": server,
	}
}

func writePackage(t *testing.T, files map[string][]byte) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "compdf-update.tar.zst")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	encoder, err := zstd.NewWriter(file)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(encoder)
	for name, data := range files {
		if err := writer.WriteHeader(&tar.Header{Name: name, Mode: 0o600, Size: int64(len(data)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := encoder.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}
