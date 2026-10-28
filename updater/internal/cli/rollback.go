package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/backup"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/singlelock"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/verification"
)

type rollbackResult struct {
	Status       string              `json:"status"`
	Job          state.Job           `json:"job"`
	Verification verification.Report `json:"verification"`
}

func runRollback(args []string, stdout, stderr io.Writer, deps dependencies) int {
	flags := flag.NewFlagSet("rollback", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	requestID := flags.String("request-id", "", "update request ID")
	approved := flags.Bool("approve", false, "approve application rollback")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || !backupIDPattern.MatchString(*requestID) {
		fmt.Fprintln(stderr, "usage: compdfctl rollback --config <path> --request-id <id> --approve")
		return 2
	}
	if !*approved {
		fmt.Fprintln(stderr, "rollback requires --approve; no rollback action was taken")
		return 2
	}
	config, err := updaterconfig.Load(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "load updater config: %v\n", err)
		return 1
	}
	lock, err := singlelock.Acquire(filepath.Join(config.StateDirectory, "updater.lock"), 5*time.Minute, time.Now().UTC())
	if err != nil {
		fmt.Fprintf(stderr, "acquire updater lock: %v\n", err)
		return 1
	}
	defer lock.Release()
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	job, err := store.Load()
	if err != nil || job.RequestID != *requestID || (job.Phase != state.PhaseCommitted && job.Phase != state.PhaseRollbackRequired) || job.BackupID == "" {
		fmt.Fprintln(stderr, "rollback requires the matching COMMITTED or ROLLBACK_REQUIRED update job")
		return 1
	}
	bundle, _, err := loadVerifiedStagedBundle(config, job)
	if err != nil {
		fmt.Fprintf(stderr, "verify failed target release: %v\n", err)
		return 1
	}
	if !bundle.Manifest.Rollback.Application {
		fmt.Fprintln(stderr, "release manifest does not allow application rollback")
		return 3
	}
	if bundle.Manifest.Rollback.RequiresBackupRestore {
		fmt.Fprintln(stderr, "release requires database backup restoration before application rollback; automatic database restore is not allowed")
		return 3
	}
	if job.Phase == state.PhaseCommitted {
		job, err = advanceJob(store, job, state.PhaseRollbackRequired, "approved application rollback started")
		if err != nil {
			fmt.Fprintf(stderr, "persist rollback state: %v\n", err)
			return 1
		}
	}
	backupDirectory := filepath.Join(config.BackupDirectory, job.BackupID)
	backupManifest, err := backup.Verify(backupDirectory)
	if err != nil || !backupManifest.Complete() || backupManifest.RequestID != job.RequestID {
		fmt.Fprintln(stderr, "rollback requires the complete verified backup for this job")
		return 1
	}
	environment, err := backup.ReadFileSource(backupDirectory, "environment", 4*1024*1024)
	if err != nil {
		fmt.Fprintf(stderr, "read previous environment: %v\n", err)
		return 1
	}
	temporary, err := writeTemporaryEnvironment(config.WorkingDirectory, environment)
	if err != nil {
		fmt.Fprintf(stderr, "prepare rollback environment: %v\n", err)
		return 1
	}
	defer os.Remove(temporary)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	executor := deps.deploymentExecutor()
	if err := executor.Activate(ctx, config, temporary); err != nil {
		fmt.Fprintf(stderr, "rollback activation failed: %v\n", err)
		return 1
	}
	report, err := deps.releaseVerifier().Verify(ctx, config)
	if err != nil {
		fmt.Fprintf(stderr, "rollback verification failed: %v\n", err)
		return 1
	}
	if err := executor.CommitEnvironment(config, temporary); err != nil {
		fmt.Fprintf(stderr, "commit rollback environment: %v\n", err)
		return 1
	}
	restorePreviousReleaseMetadata(config.StateDirectory, backupDirectory)
	job, err = advanceJob(store, job, state.PhaseRolledBack, "previous application release restored and verified")
	if err != nil {
		fmt.Fprintf(stderr, "persist rollback state: %v\n", err)
		return 1
	}
	rollbackRecord, err := job.RollbackRecord(time.Now().UTC())
	if err != nil {
		fmt.Fprintf(stderr, "create rollback history record: %v\n", err)
		return 1
	}
	if err := store.Archive(rollbackRecord); err != nil {
		fmt.Fprintf(stderr, "persist rollback history record: %v\n", err)
		return 1
	}
	if err := json.NewEncoder(stdout).Encode(rollbackResult{Status: "rolled_back", Job: job, Verification: report}); err != nil {
		fmt.Fprintf(stderr, "write rollback result: %v\n", err)
		return 1
	}
	return 0
}

func writeTemporaryEnvironment(directory string, data []byte) (string, error) {
	file, err := os.CreateTemp(directory, ".env.rollback-*.tmp")
	if err != nil {
		return "", err
	}
	path := file.Name()
	if err := file.Chmod(0o600); err != nil {
		file.Close()
		os.Remove(path)
		return "", err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		os.Remove(path)
		return "", err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(path)
		return "", err
	}
	if err := file.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

func restorePreviousReleaseMetadata(stateDirectory, backupDirectory string) {
	for source, name := range map[string]string{
		"current-manifest": release.ManifestFilename, "current-signature": release.SignatureFilename,
	} {
		data, err := backup.ReadFileSource(backupDirectory, source, 2*1024*1024)
		if err != nil {
			continue
		}
		_ = replaceAtomic(filepath.Join(stateDirectory, "current", name), data)
	}
}
