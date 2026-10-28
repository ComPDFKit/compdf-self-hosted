package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/download"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/singlelock"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/updatecheck"
)

type downloadResult struct {
	Status    string    `json:"status"`
	Directory string    `json:"directory"`
	Job       state.Job `json:"job"`
}

func runDownload(args []string, stdout, stderr io.Writer, deps dependencies) int {
	flags := flag.NewFlagSet("download", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	currentVersion := flags.String("current-version", "", "installed product version")
	targetVersion := flags.String("version", "", "target release version")
	requestID := flags.String("request-id", "", "idempotency key")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || *currentVersion == "" || *targetVersion == "" || *requestID == "" {
		fmt.Fprintln(stderr, "usage: compdfctl download --config <path> --current-version <version> --version <target> --request-id <id>")
		return 2
	}
	if !backupIDPattern.MatchString(*requestID) {
		fmt.Fprintln(stderr, "request-id contains unsupported characters or is too long")
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

	trustedKeys, err := config.TrustedPublicKeys()
	if err != nil {
		fmt.Fprintf(stderr, "load trusted release keys: %v\n", err)
		return 1
	}
	timeout := deps.timeout
	if timeout <= 0 {
		timeout = 30 * time.Minute
	}
	client, err := configuredHTTPClient(config, deps.httpClient, timeout)
	if err != nil {
		fmt.Fprintf(stderr, "initialize release transport: %v\n", err)
		return 1
	}
	checker, err := updatecheck.New(client, config.ReleaseBaseURL, config.Channel, trustedKeys)
	if err != nil {
		fmt.Fprintf(stderr, "initialize release check: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	bundle, err := checker.CheckBundle(ctx, updatecheck.Input{CurrentVersion: *currentVersion, UpdaterVersion: buildinfo.Version})
	if err != nil {
		fmt.Fprintf(stderr, "verify target release: %v\n", err)
		return 1
	}
	if bundle.Manifest.Version != *targetVersion {
		fmt.Fprintf(stderr, "target version %s is not the signed current %s release\n", *targetVersion, config.Channel)
		return 1
	}

	store, err := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	if err != nil {
		fmt.Fprintf(stderr, "initialize state store: %v\n", err)
		return 1
	}
	cancelPath := cancellationPath(config.StateDirectory, *requestID)
	if err := clearCancellation(cancelPath); err != nil {
		fmt.Fprintf(stderr, "clear stale cancellation request: %v\n", err)
		return 1
	}
	job, err := prepareDownloadJob(store, *requestID, *currentVersion, *targetVersion)
	if err != nil {
		fmt.Fprintf(stderr, "prepare download job: %v\n", err)
		return 1
	}
	releaseDirectory := filepath.Join(config.StateDirectory, "releases", bundle.Manifest.Version)
	if job.Phase == state.PhaseVerified {
		if err := release.VerifyBundle(releaseDirectory, bundle.Manifest, bundle.ManifestBytes, bundle.SignatureBytes); err != nil {
			fmt.Fprintf(stderr, "verify existing release: %v\n", err)
			return 1
		}
		return writeDownloadResult(stdout, stderr, "already_verified", releaseDirectory, job)
	}
	operationContext, stopCancellationWatch := watchCancellation(ctx, cancelPath)
	defer stopCancellationWatch()

	if err := os.MkdirAll(releaseDirectory, 0o700); err != nil {
		return failDownload(store, job, stderr, fmt.Errorf("create release directory: %w", err))
	}
	if err := writeAtomic(filepath.Join(releaseDirectory, release.ManifestFilename), bundle.ManifestBytes); err != nil {
		return failDownload(store, job, stderr, err)
	}
	if err := writeAtomic(filepath.Join(releaseDirectory, release.SignatureFilename), bundle.SignatureBytes); err != nil {
		return failDownload(store, job, stderr, err)
	}
	baseURL, err := channelURL(config.ReleaseBaseURL, config.Channel)
	if err != nil {
		return failDownload(store, job, stderr, err)
	}
	downloader, err := download.New(client, baseURL, releaseDirectory)
	if err != nil {
		return failDownload(store, job, stderr, err)
	}
	downloader.SetBandwidthLimit(config.Automation.DownloadBytesPerSecond)
	artifacts, err := bundle.Manifest.Artifacts()
	if err != nil {
		return failDownload(store, job, stderr, err)
	}
	var totalBytes int64
	for _, artifact := range artifacts {
		totalBytes += artifact.Size
	}
	var completedBefore int64
	lastPercent := -1
	for _, artifact := range artifacts {
		progress := func(downloaded, _ int64) error {
			if cancellationRequested(cancelPath) {
				return context.Canceled
			}
			completed := completedBefore + downloaded
			percent := 100
			if totalBytes > 0 {
				percent = int(completed * 100 / totalBytes)
			}
			if percent == lastPercent {
				return nil
			}
			updated, progressErr := job.ReportProgress(state.Progress{
				Stage: "artifacts", Item: artifact.Path, CompletedBytes: completed, TotalBytes: totalBytes, Percent: percent,
			}, time.Now().UTC())
			if progressErr != nil {
				return progressErr
			}
			if progressErr = store.Save(updated); progressErr != nil {
				return progressErr
			}
			job = updated
			lastPercent = percent
			return nil
		}
		if _, err := downloader.Download(operationContext, artifact, progress); err != nil {
			if errors.Is(err, context.Canceled) && cancellationRequested(cancelPath) {
				return pauseDownload(store, job, cancelPath, stdout, stderr)
			}
			return failDownload(store, job, stderr, fmt.Errorf("download %s: %w", artifact.Path, err))
		}
		completedBefore += artifact.Size
	}
	if err := release.VerifyBundle(releaseDirectory, bundle.Manifest, bundle.ManifestBytes, bundle.SignatureBytes); err != nil {
		return failDownload(store, job, stderr, fmt.Errorf("verify release bundle: %w", err))
	}
	job, err = job.ReportProgress(state.Progress{
		Stage: "images", CompletedBytes: totalBytes, TotalBytes: totalBytes, Percent: 100, Indeterminate: true,
	}, time.Now().UTC())
	if err != nil {
		return failDownload(store, job, stderr, err)
	}
	if err := store.Save(job); err != nil {
		return failDownload(store, job, stderr, fmt.Errorf("persist image pull progress: %w", err))
	}
	if err := deps.releaseImagePuller().Pull(operationContext, bundle.Manifest); err != nil {
		if errors.Is(err, context.Canceled) && cancellationRequested(cancelPath) {
			return pauseDownload(store, job, cancelPath, stdout, stderr)
		}
		return failDownload(store, job, stderr, fmt.Errorf("pull release images: %w", err))
	}
	job, err = job.Transition(state.PhaseVerified, "release artifacts downloaded and verified", time.Now().UTC())
	if err != nil {
		return failDownload(store, job, stderr, err)
	}
	if err := store.Save(job); err != nil {
		fmt.Fprintf(stderr, "persist verified download state: %v\n", err)
		return 1
	}
	_ = clearCancellation(cancelPath)
	return writeDownloadResult(stdout, stderr, "verified", releaseDirectory, job)
}

func pauseDownload(store *state.Store, job state.Job, cancelPath string, stdout, stderr io.Writer) int {
	paused, err := job.Transition(state.PhasePaused, "release download cancelled by administrator", time.Now().UTC())
	if err != nil {
		fmt.Fprintf(stderr, "pause cancelled download: %v\n", err)
		return 1
	}
	if err := store.Save(paused); err != nil {
		fmt.Fprintf(stderr, "persist cancelled download: %v\n", err)
		return 1
	}
	_ = clearCancellation(cancelPath)
	return writeDownloadResult(stdout, stderr, "paused", "", paused)
}

func prepareDownloadJob(store *state.Store, requestID, currentVersion, targetVersion string) (state.Job, error) {
	job, err := store.Load()
	if errors.Is(err, os.ErrNotExist) {
		job, err = state.NewJob(requestID, currentVersion, targetVersion, time.Now().UTC())
		if err != nil {
			return state.Job{}, err
		}
		if err := store.Save(job); err != nil {
			return state.Job{}, err
		}
		job, err = job.Transition(state.PhaseDownloading, "release download started", time.Now().UTC())
		if err != nil {
			return state.Job{}, err
		}
		return job, store.Save(job)
	}
	if err != nil {
		return state.Job{}, err
	}
	if job.RequestID != requestID || job.CurrentVersion != currentVersion || job.TargetVersion != targetVersion {
		if job.Phase != state.PhaseCommitted && job.Phase != state.PhaseRolledBack {
			return state.Job{}, errors.New("another update job already owns the updater state")
		}
		if err := store.Archive(job); err != nil {
			return state.Job{}, fmt.Errorf("archive completed update job: %w", err)
		}
		job, err = state.NewJob(requestID, currentVersion, targetVersion, time.Now().UTC())
		if err != nil {
			return state.Job{}, err
		}
		if err := store.Save(job); err != nil {
			return state.Job{}, err
		}
		job, err = job.Transition(state.PhaseDownloading, "release download started", time.Now().UTC())
		if err != nil {
			return state.Job{}, err
		}
		return job, store.Save(job)
	}
	switch job.Phase {
	case state.PhaseDownloading, state.PhaseVerified:
		return job, nil
	case state.PhaseFailed:
		if job.ResumePhase != state.PhaseDownloading {
			return state.Job{}, fmt.Errorf("failed job cannot resume download from %s", job.ResumePhase)
		}
		job, err = job.Transition(state.PhasePaused, "download retry requested", time.Now().UTC())
		if err != nil {
			return state.Job{}, err
		}
		if err := store.Save(job); err != nil {
			return state.Job{}, err
		}
		fallthrough
	case state.PhasePaused:
		if job.ResumePhase != state.PhaseDownloading {
			return state.Job{}, fmt.Errorf("paused job cannot resume download from %s", job.ResumePhase)
		}
		job, err = job.Transition(state.PhaseDownloading, "release download resumed", time.Now().UTC())
		if err != nil {
			return state.Job{}, err
		}
		return job, store.Save(job)
	default:
		return state.Job{}, fmt.Errorf("download cannot run while job is in %s", job.Phase)
	}
}

func failDownload(store *state.Store, job state.Job, stderr io.Writer, cause error) int {
	failed, transitionErr := job.Transition(state.PhaseFailed, cause.Error(), time.Now().UTC())
	if transitionErr == nil {
		if saveErr := store.Save(failed); saveErr != nil {
			fmt.Fprintf(stderr, "download failed: %v; persist failure: %v\n", cause, saveErr)
			return 1
		}
	}
	fmt.Fprintf(stderr, "download failed: %v\n", cause)
	return 1
}

func writeDownloadResult(stdout, stderr io.Writer, status, directory string, job state.Job) int {
	if err := json.NewEncoder(stdout).Encode(downloadResult{Status: status, Directory: directory, Job: job}); err != nil {
		fmt.Fprintf(stderr, "write download result: %v\n", err)
		return 1
	}
	return 0
}

func channelURL(base, channel string) (string, error) {
	parsed, err := url.Parse(base)
	if err != nil {
		return "", err
	}
	parsed.Path = path.Join(parsed.Path, channel) + "/"
	return parsed.String(), nil
}

func writeAtomic(destination string, data []byte) error {
	if existing, err := os.ReadFile(destination); err == nil {
		if string(existing) == string(data) {
			return nil
		}
		return fmt.Errorf("refusing to replace existing release metadata %s with different bytes", filepath.Base(destination))
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".release-*.tmp")
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
	return os.Rename(temporaryPath, destination)
}
