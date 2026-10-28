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
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/backup"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/verification"
)

type applyDumper struct{}

func (applyDumper) Dump(_ context.Context, writer io.Writer) error {
	_, err := io.WriteString(writer, "database\n")
	return err
}

type applyVolumeDumper struct{}

func (applyVolumeDumper) Dump(_ context.Context, source backup.VolumeSource, writer io.Writer) error {
	_, err := io.WriteString(writer, source.Name+"\n")
	return err
}

type fakeApplyExecutor struct {
	root      string
	migrated  bool
	activated bool
	committed bool
}

func (executor *fakeApplyExecutor) PrepareEnvironment(_ updaterconfig.Config, _ release.Manifest, _ string) (string, error) {
	path := filepath.Join(executor.root, ".env.next")
	return path, os.WriteFile(path, []byte("COMPDF_VERSION=4.2.0\n"), 0o600)
}
func (executor *fakeApplyExecutor) Migrate(context.Context, updaterconfig.Config, release.Manifest, string, string) error {
	executor.migrated = true
	return nil
}
func (executor *fakeApplyExecutor) Activate(context.Context, updaterconfig.Config, string) error {
	executor.activated = true
	return nil
}
func (executor *fakeApplyExecutor) CommitEnvironment(_ updaterconfig.Config, path string) error {
	executor.committed = true
	return os.Remove(path)
}

type fakeReleaseVerifier struct{}

type fakeReleaseAuthorizer struct{}

func (fakeReleaseAuthorizer) Authorize(context.Context, updaterconfig.Config, state.Job, releaseBundle) error {
	return nil
}

func (fakeReleaseVerifier) Verify(context.Context, updaterconfig.Config) (verification.Report, error) {
	return verification.Report{HealthPassed: true, SmokePassed: true, OutputBytes: 512}, nil
}

func TestApplyCommitsOnlyMatchingVerifiedBackupAndRelease(t *testing.T) {
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	configPath := writeUpdaterConfig(t, "https://updates.example.com", map[string]string{
		"release-test": base64.StdEncoding.EncodeToString(publicKey),
	})
	config, err := updaterconfig.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestBytes, signatureBytes := writeApplyRelease(t, config, privateKey)
	backupManifest, _, err := backup.NewExecutor().Create(context.Background(), backup.Request{
		RequestID: "apply-1", CurrentVersion: "4.1.0", BackupRoot: config.BackupDirectory,
		Dumper: applyDumper{}, Volumes: applicationVolumes(), VolumeDumper: applyVolumeDumper{},
	})
	if err != nil {
		t.Fatal(err)
	}
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	job, _ := state.NewJob("apply-1", "4.1.0", "4.2.0", time.Now().UTC().Add(-time.Minute))
	for _, phase := range []state.Phase{state.PhaseDownloading, state.PhaseVerified, state.PhasePrechecked, state.PhaseBackingUp, state.PhaseBackedUp} {
		job, err = job.Transition(phase, string(phase), time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
	}
	job.BackupID = backupManifest.BackupID
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	originalVersion := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = originalVersion })
	executor := &fakeApplyExecutor{root: filepath.Dir(configPath)}
	var stdout, stderr bytes.Buffer
	code := run([]string{
		"apply", "--config", configPath, "--current-version", "4.1.0", "--version", "4.2.0", "--request-id", "apply-1", "--approve", "--maintenance-confirmed",
	}, &stdout, &stderr, dependencies{applyExecutor: executor, verifier: fakeReleaseVerifier{}, releaseAuthorizer: fakeReleaseAuthorizer{}})
	if code != 0 {
		t.Fatalf("apply code = %d, stderr = %q", code, stderr.String())
	}
	var result applyResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Job.Phase != state.PhaseCommitted || !executor.migrated || !executor.activated || !executor.committed {
		t.Fatalf("apply did not commit all stages: %+v", result)
	}
	if result.Job.Recovery == nil || !result.Job.Recovery.ApplicationRollbackAllowed || result.Job.Recovery.DatabaseRestoreRequired {
		t.Fatalf("committed rollback policy was not persisted: %+v", result.Job.Recovery)
	}
	currentDirectory := filepath.Join(config.StateDirectory, "current")
	if got, _ := os.ReadFile(filepath.Join(currentDirectory, release.ManifestFilename)); string(got) != string(manifestBytes) {
		t.Fatal("current manifest was not persisted")
	}
	if got, _ := os.ReadFile(filepath.Join(currentDirectory, release.SignatureFilename)); string(got) != string(signatureBytes) {
		t.Fatal("current signature was not persisted")
	}
}

func TestApplyRequiresExplicitApproval(t *testing.T) {
	var stdout, stderr bytes.Buffer
	code := runApply([]string{"--config", "config.json", "--current-version", "4.1.0", "--version", "4.2.0", "--request-id", "apply-2"}, &stdout, &stderr, dependencies{})
	if code != 2 || !strings.Contains(stderr.String(), "--approve") {
		t.Fatalf("unapproved apply result = %d, %q", code, stderr.String())
	}
}

func TestApplyRequiresOfflineWithdrawalRiskConfirmation(t *testing.T) {
	originalVersion := buildinfo.Version
	buildinfo.Version = "0.1.0"
	t.Cleanup(func() { buildinfo.Version = originalVersion })
	publicKey, privateKey, _ := ed25519.GenerateKey(rand.Reader)
	configPath := writeUpdaterConfig(t, "https://updates.example.com", map[string]string{"release-test": base64.StdEncoding.EncodeToString(publicKey)})
	config, _ := updaterconfig.Load(configPath)
	writeApplyRelease(t, config, privateKey)
	backupManifest, _, err := backup.NewExecutor().Create(context.Background(), backup.Request{RequestID: "offline-apply", CurrentVersion: "4.1.0", BackupRoot: config.BackupDirectory, Dumper: applyDumper{}, Volumes: applicationVolumes(), VolumeDumper: applyVolumeDumper{}})
	if err != nil {
		t.Fatal(err)
	}
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	job, _ := state.NewJob("offline-apply", "4.1.0", "4.2.0", time.Now().UTC().Add(-time.Minute))
	job.Delivery = "offline"
	for _, phase := range []state.Phase{state.PhaseDownloading, state.PhaseVerified, state.PhasePrechecked, state.PhaseBackingUp, state.PhaseBackedUp} {
		job, _ = job.Transition(phase, string(phase), time.Now().UTC())
	}
	job.BackupID = backupManifest.BackupID
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	code := run([]string{"apply", "--config", configPath, "--current-version", "4.1.0", "--version", "4.2.0", "--request-id", "offline-apply", "--approve", "--maintenance-confirmed"}, &stdout, &stderr, dependencies{})
	if code != 3 || !strings.Contains(stderr.String(), "--offline-risk-confirmed") {
		t.Fatalf("offline apply = %d, %q", code, stderr.String())
	}
}

func TestApplyFailurePersistsDatabaseRecoveryBoundary(t *testing.T) {
	root := t.TempDir()
	store, _ := state.NewStore(filepath.Join(root, "state.json"))
	job, _ := state.NewJob("recovery-boundary", "4.1.0", "4.2.0", time.Now().UTC())
	for _, phase := range []state.Phase{state.PhaseDownloading, state.PhaseVerified, state.PhasePrechecked, state.PhaseBackingUp, state.PhaseBackedUp, state.PhaseDraining, state.PhaseMigrating} {
		job, _ = job.Transition(phase, string(phase), time.Now().UTC())
	}
	job.BackupID = "backup-1"
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	manifest := release.Manifest{Rollback: release.Rollback{Application: true, RequiresBackupRestore: true}}
	if code := failApply(store, job, manifest, &stderr, errors.New("migration outcome is uncertain"), true); code != 1 {
		t.Fatalf("failure code = %d", code)
	}
	got, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if got.Phase != state.PhaseRollbackRequired || got.Recovery == nil || !got.Recovery.ApplicationRollbackAllowed || !got.Recovery.DatabaseRestoreRequired {
		t.Fatalf("recovery boundary = %+v", got)
	}
}

func writeApplyRelease(t *testing.T, config updaterconfig.Config, privateKey ed25519.PrivateKey) ([]byte, []byte) {
	t.Helper()
	now := time.Now().UTC()
	manifestBytes, err := json.Marshal(release.Manifest{
		SchemaVersion: 1, Version: "4.2.0", Channel: "stable", MinimumVersion: "4.1.0", MinimumUpdaterVersion: "0.1.0",
		ReleasedAt: now.Add(-time.Hour), ExpiresAt: now.Add(time.Hour),
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
		Migration: release.Migration{From: "4.1.0", To: "4.2.0"}, Rollback: release.Rollback{Application: true},
		ReleaseNotes: "Apply test", KnownIssues: []string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(manifestBytes)
	signatureBytes, _ := json.Marshal(release.Signature{
		SchemaVersion: 1, Algorithm: "Ed25519", KeyID: "release-test",
		ManifestSHA256: hex.EncodeToString(digest[:]), Value: base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestBytes)),
	})
	directory := filepath.Join(config.StateDirectory, "releases", "4.2.0")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, release.ManifestFilename), manifestBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, release.SignatureFilename), signatureBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	return manifestBytes, signatureBytes
}
