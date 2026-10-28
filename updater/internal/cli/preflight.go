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
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/preflight"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/singlelock"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/updatecheck"
)

func runPreflight(args []string, stdout, stderr io.Writer, deps dependencies) int {
	flags := flag.NewFlagSet("preflight", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	currentVersion := flags.String("current-version", "", "installed product version")
	targetVersion := flags.String("version", "", "target release version")
	requestID := flags.String("request-id", "", "idempotency key from download")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || *currentVersion == "" || *targetVersion == "" || !backupIDPattern.MatchString(*requestID) {
		fmt.Fprintln(stderr, "usage: compdfctl preflight --config <path> --current-version <version> --version <target> --request-id <id>")
		return 2
	}
	if _, err := release.CompareVersions(*targetVersion, *currentVersion); err != nil {
		fmt.Fprintln(stderr, "preflight requires valid semantic versions")
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
	timeout := deps.timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	client, err := configuredHTTPClient(config, deps.httpClient, timeout)
	if err != nil {
		fmt.Fprintf(stderr, "initialize release transport: %v\n", err)
		return 1
	}
	checker, err := updatecheck.New(client, config.ReleaseBaseURL, config.Channel, keys)
	if err != nil {
		fmt.Fprintf(stderr, "initialize release check: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	manifest, err := checker.Check(ctx, updatecheck.Input{CurrentVersion: *currentVersion, UpdaterVersion: buildinfo.Version})
	if err != nil {
		fmt.Fprintf(stderr, "verify target release: %v\n", err)
		return 1
	}
	if manifest.Version != *targetVersion {
		fmt.Fprintf(stderr, "target version %s is not the signed current %s release\n", *targetVersion, config.Channel)
		return 1
	}
	store, err := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	if err != nil {
		fmt.Fprintf(stderr, "initialize state store: %v\n", err)
		return 1
	}
	job, err := store.Load()
	if err != nil || job.RequestID != *requestID || job.CurrentVersion != *currentVersion || job.TargetVersion != *targetVersion {
		fmt.Fprintln(stderr, "preflight requires the matching verified download job")
		return 1
	}
	if job.Phase != state.PhaseVerified && job.Phase != state.PhasePrechecked {
		fmt.Fprintf(stderr, "preflight cannot run while job is in %s\n", job.Phase)
		return 1
	}
	probe := deps.preflightProbe
	if probe == nil {
		probe = preflight.OSProbe{}
	}
	report := preflight.NewChecker(probe).Check(ctx, preflight.Input{
		Config: config, Manifest: manifest, CurrentVersion: *currentVersion,
		UpdaterVersion: buildinfo.Version,
	})
	if err := json.NewEncoder(stdout).Encode(report); err != nil {
		fmt.Fprintf(stderr, "write preflight report: %v\n", err)
		return 1
	}
	if report.Blocked() {
		return 3
	}
	if job.Phase == state.PhaseVerified {
		job, err = job.Transition(state.PhasePrechecked, "environment preflight passed", time.Now().UTC())
		if err != nil {
			fmt.Fprintf(stderr, "advance preflight state: %v\n", err)
			return 1
		}
		if err := store.Save(job); err != nil {
			fmt.Fprintf(stderr, "persist preflight state: %v\n", err)
			return 1
		}
	}
	return 0
}
