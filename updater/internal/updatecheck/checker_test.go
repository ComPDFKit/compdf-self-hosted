package updatecheck

import (
	"context"
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
	"runtime"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

func TestCheckVerifiesBeforeReturningManifest(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := fixture(t, "release.valid.json")
	digest := sha256.Sum256(manifest)
	signature, _ := json.Marshal(release.Signature{
		SchemaVersion:  1,
		Algorithm:      "Ed25519",
		KeyID:          "release-test",
		ManifestSHA256: hex.EncodeToString(digest[:]),
		Value:          base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifest)),
	})
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/stable/release.json":
			response.Write(manifest)
		case "/stable/release.json.sig":
			response.Write(signature)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()

	checker, err := New(server.Client(), server.URL, "stable", map[string]ed25519.PublicKey{"release-test": publicKey})
	if err != nil {
		t.Fatal(err)
	}
	checker.now = func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	got, err := checker.Check(context.Background(), Input{CurrentVersion: "4.1.0", UpdaterVersion: "0.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != "4.2.0" {
		t.Fatalf("version = %s", got.Version)
	}
}

func TestCheckBundlePreservesSignedBytes(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest := fixture(t, "release.valid.json")
	digest := sha256.Sum256(manifest)
	signature, _ := json.Marshal(release.Signature{
		SchemaVersion: 1, Algorithm: "Ed25519", KeyID: "release-test",
		ManifestSHA256: hex.EncodeToString(digest[:]),
		Value:          base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifest)),
	})
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if filepath.Ext(request.URL.Path) == ".sig" {
			response.Write(signature)
			return
		}
		response.Write(manifest)
	}))
	defer server.Close()

	checker, _ := New(server.Client(), server.URL, "stable", map[string]ed25519.PublicKey{"release-test": publicKey})
	checker.now = func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	bundle, err := checker.CheckBundle(context.Background(), Input{CurrentVersion: "4.1.0", UpdaterVersion: "0.1.0"})
	if err != nil {
		t.Fatal(err)
	}
	if string(bundle.ManifestBytes) != string(manifest) || string(bundle.SignatureBytes) != string(signature) {
		t.Fatal("bundle did not preserve exact signed bytes")
	}
}

func TestCheckRejectsTamperedManifest(t *testing.T) {
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	original := fixture(t, "release.valid.json")
	digest := sha256.Sum256(original)
	signature, _ := json.Marshal(release.Signature{
		SchemaVersion: 1, Algorithm: "Ed25519", KeyID: "release-test",
		ManifestSHA256: hex.EncodeToString(digest[:]),
		Value:          base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, original)),
	})
	tampered := append([]byte(nil), original...)
	tampered[len(tampered)-2] = ' '
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if filepath.Ext(request.URL.Path) == ".sig" {
			response.Write(signature)
			return
		}
		response.Write(tampered)
	}))
	defer server.Close()

	checker, _ := New(server.Client(), server.URL, "stable", map[string]ed25519.PublicKey{"release-test": publicKey})
	if _, err := checker.Check(context.Background(), Input{CurrentVersion: "4.1.0", UpdaterVersion: "0.1.0"}); err == nil {
		t.Fatal("tampered manifest passed check")
	}
}

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "tests", "fixtures", "release", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}
