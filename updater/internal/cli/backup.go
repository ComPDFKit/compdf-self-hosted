package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"regexp"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/backup"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/singlelock"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

var backupIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$`)

type backupResult struct {
	Status    string          `json:"status"`
	Directory string          `json:"directory"`
	Manifest  backup.Manifest `json:"manifest"`
}

func runBackup(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: compdfctl backup create|verify [options]")
		return 2
	}
	switch args[0] {
	case "create":
		return createBackup(args[1:], stdout, stderr)
	case "verify":
		return verifyBackup(args[1:], stdout, stderr)
	default:
		fmt.Fprintln(stderr, "usage: compdfctl backup create|verify [options]")
		return 2
	}
}

func createBackup(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("backup create", flag.ContinueOnError)
	flags.SetOutput(stderr)
	configPath := flags.String("file", "", "protected updater config")
	requestID := flags.String("request-id", "", "unique backup request ID")
	currentVersion := flags.String("current-version", "", "installed product version")
	approved := flags.Bool("approve", false, "approve writing backup artifacts")
	maintenanceConfirmed := flags.Bool("maintenance-confirmed", false, "confirm work has drained and writes are paused")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || *requestID == "" || *currentVersion == "" {
		fmt.Fprintln(stderr, "usage: compdfctl backup create --file <path> --request-id <id> --current-version <version> --approve --maintenance-confirmed")
		return 2
	}
	if !*approved || !*maintenanceConfirmed {
		fmt.Fprintln(stderr, "backup requires --approve and --maintenance-confirmed; no files were written")
		return 2
	}
	if _, err := release.CompareVersions(*currentVersion, *currentVersion); err != nil {
		fmt.Fprintln(stderr, "current-version must be a semantic version")
		return 2
	}
	config, err := updaterconfig.Load(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "invalid updater config: %v\n", err)
		return 1
	}
	lock, err := singlelock.Acquire(filepath.Join(config.StateDirectory, "updater.lock"), 5*time.Minute, time.Now().UTC())
	if err != nil {
		fmt.Fprintf(stderr, "acquire updater lock: %v\n", err)
		return 1
	}
	defer lock.Release()
	store, err := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	if err != nil {
		fmt.Fprintf(stderr, "initialize state store: %v\n", err)
		return 1
	}
	job, err := store.Load()
	if err != nil || job.RequestID != *requestID || job.CurrentVersion != *currentVersion {
		fmt.Fprintln(stderr, "backup requires the matching prechecked update job")
		return 1
	}
	job, err = prepareBackupJob(store, job)
	if err != nil {
		fmt.Fprintf(stderr, "prepare backup job: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	manifest, directory, err := backup.NewExecutor().Create(ctx, backup.Request{
		RequestID:      *requestID,
		CurrentVersion: *currentVersion,
		BackupRoot:     config.BackupDirectory,
		Dumper:         backup.NewDockerDumper(config, nil),
		Sources:        installationSources(config),
		Volumes:        applicationVolumes(),
		VolumeDumper:   backup.NewDockerVolumeDumper(config, nil),
	})
	if err != nil {
		markBackupFailure(store, job, err)
		fmt.Fprintf(stderr, "backup failed: %v\n", err)
		return 1
	}
	if _, err := backup.Verify(directory); err != nil {
		markBackupFailure(store, job, err)
		fmt.Fprintf(stderr, "backup verification failed: %v\n", err)
		return 1
	}
	status := "complete"
	exitCode := 0
	if !manifest.Complete() {
		status = "partial"
		exitCode = 3
		markBackupFailure(store, job, fmt.Errorf("backup coverage is incomplete"))
	} else {
		job.BackupID = manifest.BackupID
		job, err = job.Transition(state.PhaseBackedUp, "complete backup created and verified", time.Now().UTC())
		if err != nil {
			fmt.Fprintf(stderr, "advance backup state: %v\n", err)
			return 1
		}
		if err := store.Save(job); err != nil {
			fmt.Fprintf(stderr, "persist backup state: %v\n", err)
			return 1
		}
	}
	if err := json.NewEncoder(stdout).Encode(backupResult{Status: status, Directory: directory, Manifest: manifest}); err != nil {
		fmt.Fprintf(stderr, "write backup result: %v\n", err)
		return 1
	}
	return exitCode
}

func prepareBackupJob(store *state.Store, job state.Job) (state.Job, error) {
	var err error
	switch job.Phase {
	case state.PhasePrechecked:
		job, err = job.Transition(state.PhaseBackingUp, "upgrade backup started", time.Now().UTC())
	case state.PhaseBackingUp:
		return job, nil
	case state.PhaseFailed:
		if job.ResumePhase != state.PhaseBackingUp {
			return state.Job{}, fmt.Errorf("failed job cannot resume backup from %s", job.ResumePhase)
		}
		job, err = job.Transition(state.PhasePaused, "backup retry requested", time.Now().UTC())
		if err == nil {
			if err = store.Save(job); err == nil {
				job, err = job.Transition(state.PhaseBackingUp, "upgrade backup resumed", time.Now().UTC())
			}
		}
	case state.PhasePaused:
		if job.ResumePhase != state.PhaseBackingUp {
			return state.Job{}, fmt.Errorf("paused job cannot resume backup from %s", job.ResumePhase)
		}
		job, err = job.Transition(state.PhaseBackingUp, "upgrade backup resumed", time.Now().UTC())
	default:
		return state.Job{}, fmt.Errorf("backup cannot run while job is in %s", job.Phase)
	}
	if err != nil {
		return state.Job{}, err
	}
	return job, store.Save(job)
}

func markBackupFailure(store *state.Store, job state.Job, cause error) {
	failed, err := job.Transition(state.PhaseFailed, cause.Error(), time.Now().UTC())
	if err == nil {
		_ = store.Save(failed)
	}
}

func verifyBackup(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("backup verify", flag.ContinueOnError)
	flags.SetOutput(stderr)
	configPath := flags.String("file", "", "protected updater config")
	backupID := flags.String("backup-id", "", "backup ID")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || !backupIDPattern.MatchString(*backupID) {
		fmt.Fprintln(stderr, "usage: compdfctl backup verify --file <path> --backup-id <id>")
		return 2
	}
	config, err := updaterconfig.Load(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "invalid updater config: %v\n", err)
		return 1
	}
	directory := filepath.Join(config.BackupDirectory, *backupID)
	manifest, err := backup.Verify(directory)
	if err != nil || manifest.BackupID != *backupID {
		fmt.Fprintln(stderr, "backup verification failed: missing, corrupted, or mismatched backup")
		return 1
	}
	status := "complete"
	exitCode := 0
	if !manifest.Complete() {
		status = "partial"
		exitCode = 3
	}
	if err := json.NewEncoder(stdout).Encode(backupResult{Status: status, Directory: directory, Manifest: manifest}); err != nil {
		fmt.Fprintf(stderr, "write backup result: %v\n", err)
		return 1
	}
	return exitCode
}

func applicationVolumes() []backup.VolumeSource {
	return []backup.VolumeSource{
		{Name: "rustfs-data", Service: "compdf-infra", ContainerPath: "/data"},
		{Name: "pdf-data", Service: "compdf-app", ContainerPath: "/data"},
		{Name: "output", Service: "compdf-app", ContainerPath: "/tmp/compdf_output"},
	}
}

func installationSources(config updaterconfig.Config) []backup.Source {
	return []backup.Source{
		{Name: "compose", Path: config.ComposeFile, Required: true},
		{Name: "environment", Path: filepath.Join(config.WorkingDirectory, ".env")},
		{Name: "configs", Path: filepath.Join(config.WorkingDirectory, "configs"), Required: true},
		{Name: "server-storage", Path: filepath.Join(config.WorkingDirectory, "data", "server-storage"), Required: true},
		{Name: "customer-fonts", Path: filepath.Join(config.WorkingDirectory, "fonts", "windows")},
		{Name: "version", Path: filepath.Join(config.WorkingDirectory, "release", "version.json")},
		{Name: "current-manifest", Path: filepath.Join(config.StateDirectory, "current", "release.json")},
		{Name: "current-signature", Path: filepath.Join(config.StateDirectory, "current", "release.json.sig")},
	}
}
