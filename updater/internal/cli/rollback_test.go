package cli

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/backup"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

func TestRollbackRestoresCommittedApplicationRelease(t *testing.T) {
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
	if err := os.MkdirAll(config.WorkingDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	previousEnvironment := []byte("COMPDF_VERSION=4.1.0\nCOMPDF_DB_SCHEMA_VERSION=4.1.0\n")
	environmentPath := filepath.Join(config.WorkingDirectory, ".env")
	if err := os.WriteFile(environmentPath, previousEnvironment, 0o600); err != nil {
		t.Fatal(err)
	}
	writeApplyRelease(t, config, privateKey)
	backupManifest, _, err := backup.NewExecutor().Create(context.Background(), backup.Request{
		RequestID: "committed-rollback", CurrentVersion: "4.1.0", BackupRoot: config.BackupDirectory,
		Dumper: applyDumper{}, Sources: []backup.Source{{Name: "environment", Path: environmentPath, Required: true}},
		Volumes: applicationVolumes(), VolumeDumper: applyVolumeDumper{},
	})
	if err != nil {
		t.Fatal(err)
	}
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	job, _ := state.NewJob("committed-rollback", "4.1.0", "4.2.0", time.Now().UTC().Add(-time.Minute))
	for _, phase := range []state.Phase{state.PhaseDownloading, state.PhaseVerified, state.PhasePrechecked, state.PhaseBackingUp, state.PhaseBackedUp, state.PhaseDraining, state.PhaseMigrating, state.PhaseDeploying, state.PhaseVerifying, state.PhaseCommitted} {
		job, err = job.Transition(phase, string(phase), time.Now().UTC())
		if err != nil {
			t.Fatal(err)
		}
	}
	job.BackupID = backupManifest.BackupID
	job.Recovery = &state.Recovery{ApplicationRollbackAllowed: true}
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}

	executor := &fakeApplyExecutor{root: filepath.Dir(configPath)}
	var stdout, stderr bytes.Buffer
	code := runRollback([]string{
		"--config", configPath, "--request-id", "committed-rollback", "--approve",
	}, &stdout, &stderr, dependencies{applyExecutor: executor, verifier: fakeReleaseVerifier{}})
	if code != 0 {
		t.Fatalf("rollback code = %d, stderr = %q", code, stderr.String())
	}
	var result rollbackResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Job.Phase != state.PhaseRolledBack || !executor.activated || !executor.committed {
		t.Fatalf("rollback did not restore and commit the previous release: %+v", result)
	}
	loaded, err := store.Load()
	if err != nil || loaded.Phase != state.PhaseRolledBack {
		t.Fatalf("persisted rollback state = %+v, error = %v", loaded, err)
	}
	history, err := store.History()
	if err != nil || len(history) != 1 || history[0].RequestID != "committed-rollback-rollback" || history[0].CurrentVersion != "4.2.0" || history[0].TargetVersion != "4.1.0" {
		t.Fatalf("separate rollback history record = %+v, error = %v", history, err)
	}
}
