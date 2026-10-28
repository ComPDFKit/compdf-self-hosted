package release

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestVerifyBundleAcceptsClosedArtifactSet(t *testing.T) {
	root := t.TempDir()
	manifestBytes := []byte("manifest bytes\n")
	signatureBytes := []byte("signature bytes\n")
	artifactBytes := []byte("compose")
	manifest := bundleManifest(artifactBytes)
	writeBundleFile(t, root, ManifestFilename, manifestBytes)
	writeBundleFile(t, root, SignatureFilename, signatureBytes)
	writeBundleFile(t, root, manifest.Compose.Path, artifactBytes)

	if err := VerifyBundle(root, manifest, manifestBytes, signatureBytes); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyBundleRejectsUndeclaredAndTamperedFiles(t *testing.T) {
	for _, test := range []struct {
		name string
		path string
		data []byte
		want string
	}{
		{name: "undeclared", path: "extra.txt", data: []byte("extra"), want: "undeclared"},
		{name: "tampered", path: "compose.release.yml", data: []byte("tampered"), want: "size does not match"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			manifestBytes := []byte("manifest")
			signatureBytes := []byte("signature")
			artifactBytes := []byte("compose")
			manifest := bundleManifest(artifactBytes)
			writeBundleFile(t, root, ManifestFilename, manifestBytes)
			writeBundleFile(t, root, SignatureFilename, signatureBytes)
			writeBundleFile(t, root, manifest.Compose.Path, artifactBytes)
			writeBundleFile(t, root, test.path, test.data)
			if err := VerifyBundle(root, manifest, manifestBytes, signatureBytes); err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("VerifyBundle() error = %v, want %q", err, test.want)
			}
		})
	}
}

func bundleManifest(artifact []byte) Manifest {
	digest := sha256.Sum256(artifact)
	return Manifest{
		Compose: &Artifact{Path: "compose.release.yml", SHA256: hex.EncodeToString(digest[:]), Size: int64(len(artifact))},
	}
}

func writeBundleFile(t *testing.T, root, name string, data []byte) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
