package cli

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

func TestHistoryIncludesCurrentCommittedJob(t *testing.T) {
	configPath := historyTestConfig(t)
	store := historyTestStore(t, configPath)
	base := time.Now().UTC().Add(-time.Hour)
	archived := historyTerminalJob(t, "archived-job", "4.1.0", "4.1.1", base, false)
	if err := store.Archive(archived); err != nil {
		t.Fatal(err)
	}
	current := historyTerminalJob(t, "current-job", "4.1.1", "5.0.0", base.Add(30*time.Minute), false)
	if err := store.Save(current); err != nil {
		t.Fatal(err)
	}

	history := readHistory(t, configPath)
	if len(history) != 2 || history[0].RequestID != current.RequestID || history[0].Phase != state.PhaseCommitted {
		t.Fatalf("current committed job was not merged into history: %+v", history)
	}
}

func TestHistoryUsesCurrentRolledBackJobWithoutDuplicate(t *testing.T) {
	configPath := historyTestConfig(t)
	store := historyTestStore(t, configPath)
	committed := historyTerminalJob(t, "rollback-job", "4.1.1", "5.0.0", time.Now().UTC().Add(-time.Hour), false)
	if err := store.Archive(committed); err != nil {
		t.Fatal(err)
	}
	rolledBack := historyTerminalJob(t, committed.RequestID, committed.CurrentVersion, committed.TargetVersion, committed.CreatedAt, true)
	if err := store.Save(rolledBack); err != nil {
		t.Fatal(err)
	}

	history := readHistory(t, configPath)
	if len(history) != 2 {
		t.Fatalf("current rolled back job and rollback record were not returned: %+v", history)
	}
	var foundRollback bool
	for _, item := range history {
		if item.CurrentVersion == "5.0.0" && item.TargetVersion == "4.1.1" && item.Phase == state.PhaseRolledBack {
			foundRollback = true
		}
	}
	if !foundRollback {
		t.Fatalf("separate rollback direction was not returned: %+v", history)
	}
}

func TestHistoryContainsSeparateRollbackDirection(t *testing.T) {
	configPath := historyTestConfig(t)
	store := historyTestStore(t, configPath)
	job := historyTerminalJob(t, "rollback-direction", "4.2.0", "5.0.0", time.Now().UTC().Add(-time.Hour), true)
	rollback, err := job.RollbackRecord(time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Archive(rollback); err != nil {
		t.Fatal(err)
	}
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}

	history := readHistory(t, configPath)
	if len(history) != 2 {
		t.Fatalf("expected original and rollback history records, got %+v", history)
	}
	var found bool
	for _, item := range history {
		if item.RequestID == rollback.RequestID && item.CurrentVersion == "5.0.0" && item.TargetVersion == "4.2.0" && item.Phase == state.PhaseRolledBack {
			found = true
		}
	}
	if !found {
		t.Fatalf("separate rollback direction was not returned: %+v", history)
	}
}

func TestHistoryExcludesCurrentNonTerminalJob(t *testing.T) {
	configPath := historyTestConfig(t)
	store := historyTestStore(t, configPath)
	job, err := state.NewJob("active-job", "4.1.1", "5.0.0", time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	if history := readHistory(t, configPath); len(history) != 0 {
		t.Fatalf("non-terminal current job leaked into history: %+v", history)
	}
}

func historyTestConfig(t *testing.T) string {
	t.Helper()
	return writeUpdaterConfig(t, "https://updates.example.invalid/", map[string]string{
		"runtime-test": base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize)),
	})
}

func historyTestStore(t *testing.T, configPath string) *state.Store {
	t.Helper()
	config, err := updaterconfig.Load(configPath)
	if err != nil {
		t.Fatal(err)
	}
	store, err := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func historyTerminalJob(t *testing.T, requestID, currentVersion, targetVersion string, startedAt time.Time, rolledBack bool) state.Job {
	t.Helper()
	job, err := state.NewJob(requestID, currentVersion, targetVersion, startedAt)
	if err != nil {
		t.Fatal(err)
	}
	phases := []state.Phase{
		state.PhaseDownloading, state.PhaseVerified, state.PhasePrechecked, state.PhaseBackingUp,
		state.PhaseBackedUp, state.PhaseDraining, state.PhaseMigrating, state.PhaseDeploying,
		state.PhaseVerifying, state.PhaseCommitted,
	}
	if rolledBack {
		phases = append(phases, state.PhaseRollbackRequired, state.PhaseRolledBack)
	}
	for index, phase := range phases {
		job, err = job.Transition(phase, string(phase), startedAt.Add(time.Duration(index+1)*time.Second))
		if err != nil {
			t.Fatalf("transition to %s: %v", phase, err)
		}
	}
	return job
}

func readHistory(t *testing.T, configPath string) []state.Job {
	t.Helper()
	var stdout, stderr bytes.Buffer
	if code := runHistory([]string{"--config", configPath}, &stdout, &stderr); code != 0 {
		t.Fatalf("history code = %d, stderr = %q", code, stderr.String())
	}
	var history []state.Job
	if err := json.Unmarshal(stdout.Bytes(), &history); err != nil {
		t.Fatal(err)
	}
	return history
}
