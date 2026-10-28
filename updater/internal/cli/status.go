package cli

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

func runStatus(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" {
		fmt.Fprintln(stderr, "usage: compdfctl status --config <path>")
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
		if err := json.NewEncoder(stdout).Encode(nil); err != nil {
			fmt.Fprintf(stderr, "write empty updater state: %v\n", err)
			return 1
		}
		return 0
	}
	if err != nil {
		fmt.Fprintf(stderr, "load updater state: %v\n", err)
		return 1
	}
	if err := json.NewEncoder(stdout).Encode(job); err != nil {
		fmt.Fprintf(stderr, "write updater state: %v\n", err)
		return 1
	}
	return 0
}

func runHistory(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("history", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" {
		fmt.Fprintln(stderr, "usage: compdfctl history --config <path>")
		return 2
	}
	config, err := updaterconfig.Load(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "load updater config: %v\n", err)
		return 1
	}
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	history, err := store.History()
	if err != nil {
		fmt.Fprintf(stderr, "load updater history: %v\n", err)
		return 1
	}
	current, err := store.Load()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(stderr, "load updater state: %v\n", err)
		return 1
	}
	if err == nil && current.Phase == state.PhaseRolledBack {
		rollbackRequestID := current.RequestID + "-rollback"
		hasRollbackRecord := false
		for _, item := range history {
			if item.RequestID == rollbackRequestID {
				hasRollbackRecord = true
				break
			}
		}
		if !hasRollbackRecord {
			rollbackRecord, recordErr := current.RollbackRecord(current.UpdatedAt)
			if recordErr != nil {
				fmt.Fprintf(stderr, "create rollback history record: %v\n", recordErr)
				return 1
			}
			if recordErr := store.Archive(rollbackRecord); recordErr != nil {
				fmt.Fprintf(stderr, "persist rollback history record: %v\n", recordErr)
				return 1
			}
			history = append(history, rollbackRecord)
		}
	}
	if err == nil && (current.Phase == state.PhaseCommitted || current.Phase == state.PhaseRolledBack) {
		merged := make([]state.Job, 0, len(history)+1)
		for _, job := range history {
			if job.RequestID != current.RequestID {
				merged = append(merged, job)
			}
		}
		history = append(merged, current)
		sort.Slice(history, func(left, right int) bool {
			return history[left].UpdatedAt.After(history[right].UpdatedAt)
		})
	}
	if err := json.NewEncoder(stdout).Encode(history); err != nil {
		fmt.Fprintf(stderr, "write updater history: %v\n", err)
		return 1
	}
	return 0
}
