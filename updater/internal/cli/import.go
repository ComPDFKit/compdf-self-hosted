package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/offline"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/singlelock"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

func runImport(args []string, stdout, stderr io.Writer, deps dependencies) int {
	flags := flag.NewFlagSet("import", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	packagePath := flags.String("file", "", "offline .tar.zst package")
	currentVersion := flags.String("current-version", "", "installed product version")
	requestID := flags.String("request-id", "", "idempotency key")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || !filepath.IsAbs(*packagePath) || *currentVersion == "" || !backupIDPattern.MatchString(*requestID) {
		fmt.Fprintln(stderr, "usage: compdfctl import --config <path> --file <absolute-package.tar.zst> --current-version <version> --request-id <id>")
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
	keys, err := config.TrustedPublicKeys()
	if err != nil {
		fmt.Fprintf(stderr, "load trusted release keys: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	result, err := offline.Import(ctx, *packagePath, config.StateDirectory, keys)
	if err != nil {
		fmt.Fprintf(stderr, "import offline release: %v\n", err)
		return 1
	}
	if err := result.Manifest.CheckCompatibility(release.Compatibility{
		CurrentVersion: *currentVersion, UpdaterVersion: buildinfo.Version, Channel: config.Channel,
	}); err != nil {
		fmt.Fprintf(stderr, "offline release is incompatible: %v\n", err)
		return 1
	}
	comparison, err := release.CompareVersions(*currentVersion, result.Manifest.Version)
	if err != nil || comparison >= 0 {
		fmt.Fprintln(stderr, "offline release target must be newer than the installed version")
		return 1
	}
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	job, err := prepareDownloadJob(store, *requestID, *currentVersion, result.Manifest.Version)
	if err != nil {
		fmt.Fprintf(stderr, "prepare offline import job: %v\n", err)
		return 1
	}
	job.Delivery = "offline"
	if err := store.Save(job); err != nil {
		fmt.Fprintf(stderr, "persist offline delivery source: %v\n", err)
		return 1
	}
	if job.Phase == state.PhaseVerified {
		return writeDownloadResult(stdout, stderr, "already_verified", result.Directory, job)
	}
	if err := deps.releaseImageLoader().Load(ctx, result.Manifest, result.Directory); err != nil {
		return failDownload(store, job, stderr, fmt.Errorf("load offline images: %w", err))
	}
	job, err = job.Transition(state.PhaseVerified, "offline release and image digests imported and verified", time.Now().UTC())
	if err != nil {
		return failDownload(store, job, stderr, err)
	}
	if err := store.Save(job); err != nil {
		fmt.Fprintf(stderr, "persist offline import state: %v\n", err)
		return 1
	}
	if err := json.NewEncoder(stdout).Encode(downloadResult{Status: "verified", Directory: result.Directory, Job: job}); err != nil {
		fmt.Fprintf(stderr, "write import result: %v\n", err)
		return 1
	}
	return 0
}
