package cli

import (
	"bytes"
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
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

type fakeImagePuller struct {
	calls int
	err   error
}

type blockingImagePuller struct {
	started chan struct{}
}

func (puller *blockingImagePuller) Pull(ctx context.Context, _ release.Manifest) error {
	close(puller.started)
	<-ctx.Done()
	return ctx.Err()
}

func (puller *fakeImagePuller) Pull(_ context.Context, _ release.Manifest) error {
	puller.calls++
	return puller.err
}

func TestDownloadPersistsVerifiedBundleAndIsIdempotent(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	artifactBytes := []byte("services:\n  compdf-app: {}\n")
	artifactDigest := sha256.Sum256(artifactBytes)
	now := time.Now().UTC()
	manifestBytes, err := json.Marshal(release.Manifest{
		SchemaVersion: 1, Version: "4.2.0", Channel: "stable", MinimumVersion: "4.1.0", MinimumUpdaterVersion: "0.1.0",
		ReleasedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour),
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
		Migration: release.Migration{From: "4.1.0", To: "4.2.0"}, Rollback: release.Rollback{Application: true},
		Compose:      &release.Artifact{Path: "compose.release.yml", SHA256: hex.EncodeToString(artifactDigest[:]), Size: int64(len(artifactBytes))},
		ReleaseNotes: "Test release", KnownIssues: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifestDigest := sha256.Sum256(manifestBytes)
	signatureBytes, _ := json.Marshal(release.Signature{
		SchemaVersion: 1, Algorithm: "Ed25519", KeyID: "release-test",
		ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
		Value:          base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestBytes)),
	})
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/stable/release.json":
			response.Write(manifestBytes)
		case "/stable/release.json.sig":
			response.Write(signatureBytes)
		case "/stable/compose.release.yml":
			response.Write(artifactBytes)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	configPath := writeUpdaterConfig(t, server.URL, map[string]string{
		"release-test": base64.StdEncoding.EncodeToString(publicKey),
	})
	originalVersion := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = originalVersion })

	args := []string{"download", "--config", configPath, "--current-version", "4.1.0", "--version", "4.2.0", "--request-id", "request-download-1"}
	puller := &fakeImagePuller{}
	var stdout, stderr bytes.Buffer
	code := run(args, &stdout, &stderr, dependencies{httpClient: server.Client(), timeout: 5 * time.Second, imagePuller: puller})
	if code != 0 {
		t.Fatalf("download code = %d, stderr = %q", code, stderr.String())
	}
	var result downloadResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "verified" || result.Job.Phase != state.PhaseVerified {
		t.Fatalf("unexpected result: %+v", result)
	}
	for _, name := range []string{release.ManifestFilename, release.SignatureFilename, "compose.release.yml"} {
		if _, err := os.Stat(filepath.Join(result.Directory, name)); err != nil {
			t.Fatalf("release file %s missing: %v", name, err)
		}
	}

	stdout.Reset()
	stderr.Reset()
	code = run(args, &stdout, &stderr, dependencies{httpClient: server.Client(), timeout: 5 * time.Second, imagePuller: puller})
	if code != 0 {
		t.Fatalf("idempotent download code = %d, stderr = %q", code, stderr.String())
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || result.Status != "already_verified" {
		t.Fatalf("idempotent result = %+v, error = %v", result, err)
	}
	if puller.calls != 1 {
		t.Fatalf("image pull count = %d, want 1", puller.calls)
	}
}

func TestStatusReadsPersistedJob(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(rand.Reader)
	configPath := writeUpdaterConfig(t, "https://updates.example.com", map[string]string{
		"release-test": base64.StdEncoding.EncodeToString(publicKey),
	})
	stateDirectory := filepath.Join(filepath.Dir(configPath), "state")
	store, err := state.NewStore(filepath.Join(stateDirectory, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	job, _ := state.NewJob("request-status-1", "4.1.0", "4.2.0", time.Now().UTC())
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if code := runStatus([]string{"--config", configPath}, &stdout, &stderr); code != 0 {
		t.Fatalf("status code = %d, stderr = %q", code, stderr.String())
	}
	var got state.Job
	if err := json.Unmarshal(stdout.Bytes(), &got); err != nil || got.RequestID != job.RequestID {
		t.Fatalf("status result = %+v, error = %v", got, err)
	}
}

func TestCancelRequestsOnlyPauseActiveDownloads(t *testing.T) {
	publicKey, _, _ := ed25519.GenerateKey(rand.Reader)
	configPath := writeUpdaterConfig(t, "https://updates.example.com", map[string]string{
		"release-test": base64.StdEncoding.EncodeToString(publicKey),
	})
	stateDirectory := filepath.Join(filepath.Dir(configPath), "state")
	store, _ := state.NewStore(filepath.Join(stateDirectory, "state.json"))
	job, _ := state.NewJob("request-cancel-1", "4.1.0", "4.2.0", time.Now().UTC())
	job, _ = job.Transition(state.PhaseDownloading, "start", time.Now().UTC())
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	if code := runCancel([]string{"--config", configPath, "--request-id", job.RequestID}, &stdout, &stderr); code != 0 {
		t.Fatalf("cancel code = %d, stderr = %q", code, stderr.String())
	}
	if !cancellationRequested(cancellationPath(stateDirectory, job.RequestID)) {
		t.Fatal("cancellation signal was not persisted")
	}
	var result cancelResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil || result.Status != "cancel_requested" {
		t.Fatalf("cancel result = %+v, error = %v", result, err)
	}

	job, _ = job.Transition(state.PhasePaused, "paused", time.Now().UTC())
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	stderr.Reset()
	if code := runCancel([]string{"--config", configPath, "--request-id", job.RequestID}, &stdout, &stderr); code != 0 {
		t.Fatalf("idempotent cancel code = %d, stderr = %q", code, stderr.String())
	}
}

func TestDownloadCancellationPausesRunningJob(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	manifestBytes, err := json.Marshal(release.Manifest{
		SchemaVersion: 1, Version: "4.2.0", Channel: "stable", MinimumVersion: "4.1.0", MinimumUpdaterVersion: "0.1.0",
		ReleasedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour),
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
		Migration: release.Migration{From: "4.1.0", To: "4.2.0"}, Rollback: release.Rollback{Application: true},
		ReleaseNotes: "Cancellation test", KnownIssues: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	manifestDigest := sha256.Sum256(manifestBytes)
	signatureBytes, _ := json.Marshal(release.Signature{
		SchemaVersion: 1, Algorithm: "Ed25519", KeyID: "release-test",
		ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
		Value:          base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestBytes)),
	})
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/stable/release.json":
			response.Write(manifestBytes)
		case "/stable/release.json.sig":
			response.Write(signatureBytes)
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	configPath := writeUpdaterConfig(t, server.URL, map[string]string{
		"release-test": base64.StdEncoding.EncodeToString(publicKey),
	})
	originalVersion := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = originalVersion })

	puller := &blockingImagePuller{started: make(chan struct{})}
	var downloadOut, downloadErr bytes.Buffer
	done := make(chan int, 1)
	go func() {
		done <- run([]string{"download", "--config", configPath, "--current-version", "4.1.0", "--version", "4.2.0", "--request-id", "request-cancel-running"}, &downloadOut, &downloadErr, dependencies{
			httpClient: server.Client(), timeout: 5 * time.Second, imagePuller: puller,
		})
	}()
	select {
	case <-puller.started:
	case <-time.After(3 * time.Second):
		t.Fatal("download did not reach the cancellable image pull stage")
	}

	var cancelOut, cancelErr bytes.Buffer
	if code := runCancel([]string{"--config", configPath, "--request-id", "request-cancel-running"}, &cancelOut, &cancelErr); code != 0 {
		t.Fatalf("cancel code = %d, stderr = %q", code, cancelErr.String())
	}
	select {
	case code := <-done:
		if code != 0 {
			t.Fatalf("cancelled download code = %d, stderr = %q", code, downloadErr.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("download did not stop after cancellation")
	}
	var result downloadResult
	if err := json.Unmarshal(downloadOut.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != "paused" || result.Job.Phase != state.PhasePaused || result.Job.ResumePhase != state.PhaseDownloading {
		t.Fatalf("cancelled download result = %+v", result)
	}
}
