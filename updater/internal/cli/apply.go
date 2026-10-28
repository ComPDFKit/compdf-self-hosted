package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/backup"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/singlelock"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/updatecheck"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/verification"
)

type applyResult struct {
	Status       string              `json:"status"`
	Job          state.Job           `json:"job"`
	Verification verification.Report `json:"verification"`
}

func runApply(args []string, stdout, stderr io.Writer, deps dependencies) int {
	flags := flag.NewFlagSet("apply", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	currentVersion := flags.String("current-version", "", "installed product version")
	targetVersion := flags.String("version", "", "target release version")
	requestID := flags.String("request-id", "", "idempotency key")
	approved := flags.Bool("approve", false, "approve installation")
	maintenanceConfirmed := flags.Bool("maintenance-confirmed", false, "confirm new work is blocked and active tasks are drained")
	offlineRiskConfirmed := flags.Bool("offline-risk-confirmed", false, "confirm that an offline release cannot be checked for a later withdrawal")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || *currentVersion == "" || *targetVersion == "" || !backupIDPattern.MatchString(*requestID) {
		fmt.Fprintln(stderr, "usage: compdfctl apply --config <path> --current-version <version> --version <target> --request-id <id> --approve --maintenance-confirmed [--offline-risk-confirmed]")
		return 2
	}
	if !*approved || !*maintenanceConfirmed {
		fmt.Fprintln(stderr, "apply requires --approve and --maintenance-confirmed; no installation action was taken")
		return 2
	}
	config, err := updaterconfig.Load(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "load updater config: %v\n", err)
		return 1
	}
	if deps.httpClient == nil {
		deps.httpClient, err = config.HTTPClient(2 * time.Minute)
		if err != nil {
			fmt.Fprintf(stderr, "initialize release transport: %v\n", err)
			return 1
		}
	}
	lock, err := singlelock.Acquire(filepath.Join(config.StateDirectory, "updater.lock"), 5*time.Minute, time.Now().UTC())
	if err != nil {
		fmt.Fprintf(stderr, "acquire updater lock: %v\n", err)
		return 1
	}
	defer lock.Release()
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	job, err := store.Load()
	if err != nil || job.RequestID != *requestID || job.CurrentVersion != *currentVersion || job.TargetVersion != *targetVersion || job.Phase != state.PhaseBackedUp || job.BackupID == "" {
		fmt.Fprintln(stderr, "apply requires the matching backed-up update job")
		return 1
	}
	backupManifest, err := backup.Verify(filepath.Join(config.BackupDirectory, job.BackupID))
	if err != nil || !backupManifest.Complete() || backupManifest.RequestID != job.RequestID || backupManifest.CurrentVersion != job.CurrentVersion {
		fmt.Fprintln(stderr, "apply requires a complete verified backup for this update job")
		return 1
	}
	bundle, releaseDirectory, err := loadStagedBundle(config, job)
	if err != nil {
		fmt.Fprintf(stderr, "load staged release: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	if job.Delivery == "offline" {
		if !*offlineRiskConfirmed {
			fmt.Fprintln(stderr, "offline apply requires --offline-risk-confirmed because release withdrawal cannot be checked without network access")
			return 3
		}
	} else if err := deps.authorizer().Authorize(ctx, config, job, bundle); err != nil {
		fmt.Fprintf(stderr, "re-authorize online release before apply: %v\n", err)
		return 3
	}
	executor := deps.deploymentExecutor()
	targetEnvironment, err := executor.PrepareEnvironment(config, bundle.Manifest, job.RequestID)
	if err != nil {
		fmt.Fprintf(stderr, "prepare target environment: %v\n", err)
		return 1
	}
	defer os.Remove(targetEnvironment)
	job, err = advanceJob(store, job, state.PhaseDraining, "maintenance and task drain confirmed by operator")
	if err != nil {
		fmt.Fprintf(stderr, "persist draining state: %v\n", err)
		return 1
	}
	job, err = advanceJob(store, job, state.PhaseMigrating, "database migration started")
	if err != nil {
		fmt.Fprintf(stderr, "persist migration state: %v\n", err)
		return 1
	}
	if err := executor.Migrate(ctx, config, bundle.Manifest, releaseDirectory, targetEnvironment); err != nil {
		return failApply(store, job, bundle.Manifest, stderr, err, true)
	}
	job, err = advanceJob(store, job, state.PhaseDeploying, "application deployment started")
	if err != nil {
		fmt.Fprintf(stderr, "persist deployment state: %v\n", err)
		return 1
	}
	if err := executor.Activate(ctx, config, targetEnvironment); err != nil {
		return failApply(store, job, bundle.Manifest, stderr, err, false)
	}
	job, err = advanceJob(store, job, state.PhaseVerifying, "health and business verification started")
	if err != nil {
		fmt.Fprintf(stderr, "persist verification state: %v\n", err)
		return 1
	}
	report, err := deps.releaseVerifier().Verify(ctx, config)
	if err != nil {
		return failApply(store, job, bundle.Manifest, stderr, err, false)
	}
	if err := executor.CommitEnvironment(config, targetEnvironment); err != nil {
		return failApply(store, job, bundle.Manifest, stderr, err, false)
	}
	if err := persistCurrentRelease(config.StateDirectory, bundle); err != nil {
		return failApply(store, job, bundle.Manifest, stderr, err, false)
	}
	job.Recovery = &state.Recovery{
		ApplicationRollbackAllowed: bundle.Manifest.Rollback.Application,
		DatabaseRestoreRequired:    bundle.Manifest.Rollback.RequiresBackupRestore,
	}
	job, err = advanceJob(store, job, state.PhaseCommitted, "release committed after health and PDF smoke verification")
	if err != nil {
		fmt.Fprintf(stderr, "persist committed state: %v\n", err)
		return 1
	}
	if err := json.NewEncoder(stdout).Encode(applyResult{Status: "committed", Job: job, Verification: report}); err != nil {
		fmt.Fprintf(stderr, "write apply result: %v\n", err)
		return 1
	}
	return 0
}

type onlineReleaseAuthorizer struct {
	client *http.Client
}

func (authorizer onlineReleaseAuthorizer) Authorize(ctx context.Context, config updaterconfig.Config, job state.Job, staged releaseBundle) error {
	keys, err := config.TrustedPublicKeys()
	if err != nil {
		return err
	}
	checker, err := updatecheck.New(authorizer.client, config.ReleaseBaseURL, config.Channel, keys)
	if err != nil {
		return err
	}
	current, err := checker.CheckBundle(ctx, updatecheck.Input{CurrentVersion: job.CurrentVersion, UpdaterVersion: buildinfo.Version})
	if err != nil {
		return err
	}
	if current.Manifest.Version != job.TargetVersion {
		return fmt.Errorf("channel now publishes %s instead of staged %s", current.Manifest.Version, job.TargetVersion)
	}
	if !bytes.Equal(current.ManifestBytes, staged.ManifestBytes) || !bytes.Equal(current.SignatureBytes, staged.SignatureBytes) {
		return errors.New("published release metadata changed after download")
	}
	return nil
}

func loadStagedBundle(config updaterconfig.Config, job state.Job) (releaseBundle, string, error) {
	bundle, directory, err := loadVerifiedStagedBundle(config, job)
	if err != nil {
		return releaseBundle{}, "", err
	}
	if err := bundle.Manifest.CheckCompatibility(release.Compatibility{CurrentVersion: job.CurrentVersion, UpdaterVersion: buildinfo.Version, Channel: config.Channel}); err != nil {
		return releaseBundle{}, "", err
	}
	return bundle, directory, nil
}

func loadVerifiedStagedBundle(config updaterconfig.Config, job state.Job) (releaseBundle, string, error) {
	directory := filepath.Join(config.StateDirectory, "releases", job.TargetVersion)
	manifestBytes, err := os.ReadFile(filepath.Join(directory, release.ManifestFilename))
	if err != nil {
		return releaseBundle{}, "", err
	}
	signatureBytes, err := os.ReadFile(filepath.Join(directory, release.SignatureFilename))
	if err != nil {
		return releaseBundle{}, "", err
	}
	signature, err := release.ParseSignature(signatureBytes)
	if err != nil {
		return releaseBundle{}, "", err
	}
	keys, err := config.TrustedPublicKeys()
	if err != nil {
		return releaseBundle{}, "", err
	}
	if err := release.VerifySignature(manifestBytes, signature, keys); err != nil {
		return releaseBundle{}, "", err
	}
	manifest, err := release.ParseManifest(manifestBytes)
	if err != nil {
		return releaseBundle{}, "", err
	}
	if manifest.Version != job.TargetVersion {
		return releaseBundle{}, "", errors.New("staged release version does not match update job")
	}
	if err := release.VerifyBundle(directory, manifest, manifestBytes, signatureBytes); err != nil {
		return releaseBundle{}, "", err
	}
	return releaseBundle{Manifest: manifest, ManifestBytes: manifestBytes, SignatureBytes: signatureBytes}, directory, nil
}

type releaseBundle struct {
	Manifest       release.Manifest
	ManifestBytes  []byte
	SignatureBytes []byte
}

func advanceJob(store *state.Store, job state.Job, phase state.Phase, message string) (state.Job, error) {
	next, err := job.Transition(phase, message, time.Now().UTC())
	if err != nil {
		return state.Job{}, err
	}
	if err := store.Save(next); err != nil {
		return state.Job{}, err
	}
	return next, nil
}

func failApply(store *state.Store, job state.Job, manifest release.Manifest, stderr io.Writer, cause error, databaseUncertain bool) int {
	failed, err := advanceJob(store, job, state.PhaseFailed, cause.Error())
	if err == nil && (databaseUncertain || manifest.Rollback.Application) {
		reason := "application rollback is required"
		databaseRestoreRequired := databaseUncertain || manifest.Rollback.RequiresBackupRestore
		if databaseRestoreRequired {
			reason = "database restore review and application rollback are required"
		}
		if recovery, transitionErr := failed.Transition(state.PhaseRollbackRequired, reason, time.Now().UTC()); transitionErr == nil {
			recovery.Recovery = &state.Recovery{
				ApplicationRollbackAllowed: manifest.Rollback.Application,
				DatabaseRestoreRequired:    databaseRestoreRequired,
			}
			_ = store.Save(recovery)
		}
	}
	fmt.Fprintf(stderr, "apply failed: %v\n", cause)
	return 1
}

func persistCurrentRelease(stateDirectory string, bundle releaseBundle) error {
	directory := filepath.Join(stateDirectory, "current")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if err := replaceAtomic(filepath.Join(directory, release.ManifestFilename), bundle.ManifestBytes); err != nil {
		return err
	}
	return replaceAtomic(filepath.Join(directory, release.SignatureFilename), bundle.SignatureBytes)
}

func replaceAtomic(destination string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".current-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, destination); err == nil {
		return nil
	}
	previous := destination + ".previous"
	_ = os.Remove(previous)
	if err := os.Rename(destination, previous); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		_ = os.Rename(previous, destination)
		return err
	}
	_ = os.Remove(previous)
	return nil
}
