package state

import (
	"errors"
	"fmt"
	"time"
)

const SchemaVersion = 1

type Phase string

const (
	PhaseAvailable        Phase = "AVAILABLE"
	PhaseDownloading      Phase = "DOWNLOADING"
	PhaseVerified         Phase = "VERIFIED"
	PhasePrechecked       Phase = "PRECHECKED"
	PhaseBackingUp        Phase = "BACKING_UP"
	PhaseBackedUp         Phase = "BACKED_UP"
	PhaseDraining         Phase = "DRAINING"
	PhaseMigrating        Phase = "MIGRATING"
	PhaseDeploying        Phase = "DEPLOYING"
	PhaseVerifying        Phase = "VERIFYING"
	PhaseCommitted        Phase = "COMMITTED"
	PhaseFailed           Phase = "FAILED"
	PhasePaused           Phase = "PAUSED"
	PhaseRollbackRequired Phase = "ROLLBACK_REQUIRED"
	PhaseRolledBack       Phase = "ROLLED_BACK"
)

type Event struct {
	Revision int64     `json:"revision"`
	Phase    Phase     `json:"phase"`
	Message  string    `json:"message"`
	At       time.Time `json:"at"`
}

type Progress struct {
	Stage          string `json:"stage"`
	Item           string `json:"item,omitempty"`
	CompletedBytes int64  `json:"completedBytes"`
	TotalBytes     int64  `json:"totalBytes"`
	Percent        int    `json:"percent"`
	Indeterminate  bool   `json:"indeterminate,omitempty"`
}

type Recovery struct {
	ApplicationRollbackAllowed bool `json:"applicationRollbackAllowed"`
	DatabaseRestoreRequired    bool `json:"databaseRestoreRequired"`
}

type Job struct {
	SchemaVersion  int       `json:"schemaVersion"`
	Revision       int64     `json:"revision"`
	RequestID      string    `json:"requestId"`
	CurrentVersion string    `json:"currentVersion"`
	TargetVersion  string    `json:"targetVersion"`
	Delivery       string    `json:"delivery"`
	Phase          Phase     `json:"phase"`
	ResumePhase    Phase     `json:"resumePhase,omitempty"`
	Failure        string    `json:"failure,omitempty"`
	BackupID       string    `json:"backupId,omitempty"`
	Progress       *Progress `json:"progress,omitempty"`
	Recovery       *Recovery `json:"recovery,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	UpdatedAt      time.Time `json:"updatedAt"`
	Events         []Event   `json:"events"`
}

func (job Job) ReportProgress(progress Progress, now time.Time) (Job, error) {
	if job.Phase != PhaseDownloading {
		return Job{}, fmt.Errorf("cannot report download progress while job is in %s", job.Phase)
	}
	if progress.Stage == "" || progress.CompletedBytes < 0 || progress.TotalBytes < 0 || progress.CompletedBytes > progress.TotalBytes || progress.Percent < 0 || progress.Percent > 100 {
		return Job{}, errors.New("download progress is invalid")
	}
	if progress.TotalBytes > 0 && progress.Percent != int(progress.CompletedBytes*100/progress.TotalBytes) {
		return Job{}, errors.New("download progress percentage does not match byte counts")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if now.Before(job.UpdatedAt) {
		return Job{}, errors.New("progress timestamp precedes current state")
	}
	job.Revision++
	job.UpdatedAt = now
	copy := progress
	job.Progress = &copy
	return job, nil
}

func NewJob(requestID, currentVersion, targetVersion string, now time.Time) (Job, error) {
	if requestID == "" || currentVersion == "" || targetVersion == "" {
		return Job{}, errors.New("request ID and versions are required")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	job := Job{
		SchemaVersion:  SchemaVersion,
		Revision:       1,
		RequestID:      requestID,
		CurrentVersion: currentVersion,
		TargetVersion:  targetVersion,
		Delivery:       "online",
		Phase:          PhaseAvailable,
		CreatedAt:      now,
		UpdatedAt:      now,
	}
	job.Events = []Event{{Revision: job.Revision, Phase: job.Phase, Message: "update available", At: now}}
	return job, nil
}

// RollbackRecord creates the terminal history entry for restoring the
// application version that preceded this update. The original update job is
// retained separately so the history shows both directions of the operation.
func (job Job) RollbackRecord(now time.Time) (Job, error) {
	if job.Phase != PhaseRolledBack || job.CurrentVersion == "" || job.TargetVersion == "" {
		return Job{}, errors.New("rollback history requires a rolled back update job")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	requestID := job.RequestID + "-rollback"
	return Job{
		SchemaVersion:  SchemaVersion,
		Revision:       1,
		RequestID:      requestID,
		CurrentVersion: job.TargetVersion,
		TargetVersion:  job.CurrentVersion,
		Delivery:       job.Delivery,
		Phase:          PhaseRolledBack,
		CreatedAt:      now,
		UpdatedAt:      now,
		Events: []Event{{
			Revision: 1,
			Phase:    PhaseRolledBack,
			Message:  "previous application release restored and verified",
			At:       now,
		}},
	}, nil
}

func (job Job) Transition(next Phase, message string, now time.Time) (Job, error) {
	if !job.canTransition(next) {
		return Job{}, fmt.Errorf("invalid update transition %s -> %s", job.Phase, next)
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if now.Before(job.UpdatedAt) {
		return Job{}, errors.New("transition timestamp precedes current state")
	}

	previous := job.Phase
	job.Revision++
	job.Phase = next
	job.UpdatedAt = now
	if next == PhaseVerified {
		job.Progress = &Progress{Stage: "complete", Percent: 100}
	}
	if next == PhaseFailed || (next == PhasePaused && isActive(previous)) {
		job.ResumePhase = previous
	}
	if next == PhaseFailed {
		job.Failure = message
	} else if next != PhasePaused && next != PhaseRollbackRequired {
		job.Failure = ""
	}
	if previous == PhasePaused && next == job.ResumePhase {
		job.ResumePhase = ""
	}
	job.Events = append(job.Events, Event{Revision: job.Revision, Phase: next, Message: message, At: now})
	return job, nil
}

func (job Job) canTransition(next Phase) bool {
	if next == PhaseFailed && isActive(job.Phase) {
		return true
	}
	if job.Phase == PhasePaused && next == job.ResumePhase && isActive(next) {
		return true
	}
	allowed := map[Phase][]Phase{
		PhaseAvailable:        {PhaseDownloading},
		PhaseDownloading:      {PhaseVerified, PhasePaused},
		PhaseVerified:         {PhasePrechecked},
		PhasePrechecked:       {PhaseBackingUp},
		PhaseBackingUp:        {PhaseBackedUp, PhasePaused},
		PhaseBackedUp:         {PhaseDraining},
		PhaseDraining:         {PhaseMigrating, PhasePaused},
		PhaseMigrating:        {PhaseDeploying},
		PhaseDeploying:        {PhaseVerifying},
		PhaseVerifying:        {PhaseCommitted},
		PhaseCommitted:        {PhaseRollbackRequired},
		PhaseFailed:           {PhasePaused, PhaseRollbackRequired},
		PhaseRollbackRequired: {PhaseRolledBack},
	}
	for _, candidate := range allowed[job.Phase] {
		if candidate == next {
			return true
		}
	}
	return false
}

func isActive(phase Phase) bool {
	switch phase {
	case PhaseDownloading, PhaseVerified, PhasePrechecked, PhaseBackingUp, PhaseBackedUp,
		PhaseDraining, PhaseMigrating, PhaseDeploying, PhaseVerifying:
		return true
	default:
		return false
	}
}
