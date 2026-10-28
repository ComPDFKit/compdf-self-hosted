package cli

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

type cancelResult struct {
	Status string    `json:"status"`
	Job    state.Job `json:"job"`
}

func runCancel(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("cancel", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	requestID := flags.String("request-id", "", "update request ID")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || !backupIDPattern.MatchString(*requestID) {
		fmt.Fprintln(stderr, "usage: compdfctl cancel --config <path> --request-id <id>")
		return 2
	}
	config, err := updaterconfig.Load(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "load updater config: %v\n", err)
		return 1
	}
	store, err := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	if err != nil {
		fmt.Fprintf(stderr, "initialize state store: %v\n", err)
		return 1
	}
	job, err := store.Load()
	if errors.Is(err, os.ErrNotExist) {
		fmt.Fprintln(stderr, "no active update job")
		return 1
	}
	if err != nil {
		fmt.Fprintf(stderr, "load updater state: %v\n", err)
		return 1
	}
	if job.RequestID != *requestID {
		fmt.Fprintln(stderr, "request ID does not own the active update job")
		return 1
	}
	if job.Phase == state.PhasePaused && job.ResumePhase == state.PhaseDownloading {
		return writeCancelResult(stdout, stderr, "already_paused", job)
	}
	if job.Phase != state.PhaseDownloading {
		fmt.Fprintf(stderr, "update cancellation is allowed only while downloading, current phase is %s\n", job.Phase)
		return 1
	}
	cancelPath := cancellationPath(config.StateDirectory, *requestID)
	if err := os.MkdirAll(filepath.Dir(cancelPath), 0o700); err != nil {
		fmt.Fprintf(stderr, "create cancellation directory: %v\n", err)
		return 1
	}
	if err := writeAtomic(cancelPath, []byte("cancel\n")); err != nil {
		fmt.Fprintf(stderr, "request download cancellation: %v\n", err)
		return 1
	}
	return writeCancelResult(stdout, stderr, "cancel_requested", job)
}

func writeCancelResult(stdout, stderr io.Writer, status string, job state.Job) int {
	if err := json.NewEncoder(stdout).Encode(cancelResult{Status: status, Job: job}); err != nil {
		fmt.Fprintf(stderr, "write cancellation result: %v\n", err)
		return 1
	}
	return 0
}

func cancellationPath(stateDirectory, requestID string) string {
	return filepath.Join(stateDirectory, "cancellations", requestID+".cancel")
}

func clearCancellation(path string) error {
	err := os.Remove(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func cancellationRequested(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func watchCancellation(parent context.Context, path string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			if cancellationRequested(path) {
				cancel()
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-done:
				return
			case <-ticker.C:
			}
		}
	}()
	return ctx, func() {
		close(done)
		cancel()
	}
}
