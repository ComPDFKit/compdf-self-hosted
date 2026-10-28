package state

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStateTransitionsAndPersistence(t *testing.T) {
	now := time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)
	job, err := NewJob("request-1", "4.1.0", "4.2.0", now)
	if err != nil {
		t.Fatal(err)
	}
	job, err = job.Transition(PhaseDownloading, "download started", now.Add(time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := job.Transition(PhaseCommitted, "skip", now.Add(2*time.Second)); err == nil {
		t.Fatal("invalid transition was accepted")
	}

	store, err := NewStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if loaded.RequestID != job.RequestID || loaded.Revision != job.Revision || loaded.Phase != PhaseDownloading {
		t.Fatalf("loaded job differs: %+v", loaded)
	}
}

func TestFailedJobCanPauseAndResumeOriginalPhase(t *testing.T) {
	now := time.Now().UTC()
	job, _ := NewJob("request-2", "4.1.0", "4.2.0", now)
	job, _ = job.Transition(PhaseDownloading, "start", now.Add(time.Second))
	job, _ = job.Transition(PhaseFailed, "network interrupted", now.Add(2*time.Second))
	if job.ResumePhase != PhaseDownloading {
		t.Fatalf("resume phase = %s", job.ResumePhase)
	}
	job, _ = job.Transition(PhasePaused, "await retry", now.Add(3*time.Second))
	job, err := job.Transition(PhaseDownloading, "retry", now.Add(4*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if job.ResumePhase != "" || job.Failure != "" {
		t.Fatalf("resumed state retained failure data: %+v", job)
	}
}

func TestActiveJobCanPauseAndResume(t *testing.T) {
	now := time.Now().UTC()
	job, _ := NewJob("request-3", "4.1.0", "4.2.0", now)
	job, _ = job.Transition(PhaseDownloading, "start", now.Add(time.Second))
	job, err := job.Transition(PhasePaused, "operator pause", now.Add(2*time.Second))
	if err != nil || job.ResumePhase != PhaseDownloading {
		t.Fatalf("pause result = %+v, error = %v", job, err)
	}
	job, err = job.Transition(PhaseDownloading, "operator resume", now.Add(3*time.Second))
	if err != nil || job.ResumePhase != "" {
		t.Fatalf("resume result = %+v, error = %v", job, err)
	}
}

func TestDownloadProgressIsValidatedAndPersisted(t *testing.T) {
	now := time.Now().UTC()
	job, _ := NewJob("request-progress", "4.1.0", "4.2.0", now)
	job, _ = job.Transition(PhaseDownloading, "start", now.Add(time.Second))
	job, err := job.ReportProgress(Progress{
		Stage: "artifacts", Item: "compose.release.yml", CompletedBytes: 25, TotalBytes: 100, Percent: 25,
	}, now.Add(2*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if job.Progress == nil || job.Progress.Percent != 25 || job.Revision != 3 {
		t.Fatalf("unexpected progress state: %+v", job)
	}
	if _, err := job.ReportProgress(Progress{Stage: "artifacts", CompletedBytes: 50, TotalBytes: 100, Percent: 60}, now.Add(3*time.Second)); err == nil {
		t.Fatal("mismatched progress percentage was accepted")
	}

	store, _ := NewStore(filepath.Join(t.TempDir(), "state.json"))
	if err := store.Save(job); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.Load()
	if err != nil || loaded.Progress == nil || loaded.Progress.CompletedBytes != 25 {
		t.Fatalf("persisted progress = %+v, error = %v", loaded.Progress, err)
	}
}

func TestBackupPhaseIsPersistedBeforeCompletion(t *testing.T) {
	now := time.Now().UTC()
	job, _ := NewJob("request-backup", "4.1.0", "4.2.0", now)
	for index, phase := range []Phase{PhaseDownloading, PhaseVerified, PhasePrechecked, PhaseBackingUp, PhaseBackedUp} {
		var err error
		job, err = job.Transition(phase, string(phase), now.Add(time.Duration(index+1)*time.Second))
		if err != nil {
			t.Fatalf("transition to %s failed: %v", phase, err)
		}
	}
	if job.Phase != PhaseBackedUp {
		t.Fatalf("unexpected phase: %s", job.Phase)
	}
}

func TestStoreArchivesOnlyTerminalJobs(t *testing.T) {
	root := t.TempDir()
	store, _ := NewStore(filepath.Join(root, "state.json"))
	job, _ := NewJob("request-history", "4.1.0", "4.2.0", time.Now().UTC())
	if err := store.Archive(job); err == nil {
		t.Fatal("non-terminal job was archived")
	}
	for _, phase := range []Phase{PhaseDownloading, PhaseVerified, PhasePrechecked, PhaseBackingUp, PhaseBackedUp, PhaseDraining, PhaseMigrating, PhaseDeploying, PhaseVerifying, PhaseCommitted} {
		job, _ = job.Transition(phase, string(phase), time.Now().UTC())
	}
	if err := store.Archive(job); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "history", "request-history.json")); err != nil {
		t.Fatal(err)
	}
	history, err := store.History()
	if err != nil || len(history) != 1 || history[0].RequestID != job.RequestID {
		t.Fatalf("unexpected history: %+v, %v", history, err)
	}
}

func TestCommittedJobCanEnterApprovedRollbackFlow(t *testing.T) {
	now := time.Now().UTC()
	job, _ := NewJob("post-commit-rollback", "4.1.1", "5.0.0", now)
	for index, phase := range []Phase{PhaseDownloading, PhaseVerified, PhasePrechecked, PhaseBackingUp, PhaseBackedUp, PhaseDraining, PhaseMigrating, PhaseDeploying, PhaseVerifying, PhaseCommitted, PhaseRollbackRequired, PhaseRolledBack} {
		var err error
		job, err = job.Transition(phase, string(phase), now.Add(time.Duration(index+1)*time.Second))
		if err != nil {
			t.Fatalf("transition to %s failed: %v", phase, err)
		}
	}
}
