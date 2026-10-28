package state

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

const maxStateBytes = 4 * 1024 * 1024

var archiveNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$`)

type Store struct {
	path string
}

func NewStore(path string) (*Store, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("state path must be absolute")
	}
	return &Store{path: filepath.Clean(path)}, nil
}

func (store *Store) Load() (Job, error) {
	data, err := os.ReadFile(store.path)
	if err != nil {
		return Job{}, fmt.Errorf("read updater state: %w", err)
	}
	if len(data) > maxStateBytes {
		return Job{}, errors.New("updater state file is too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var job Job
	if err := decoder.Decode(&job); err != nil {
		return Job{}, fmt.Errorf("decode updater state: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return Job{}, errors.New("updater state contains multiple JSON values")
	} else if err != io.EOF {
		return Job{}, fmt.Errorf("decode trailing updater state data: %w", err)
	}
	if job.SchemaVersion != SchemaVersion || job.RequestID == "" || job.Revision < 1 {
		return Job{}, errors.New("updater state identity is invalid")
	}
	if job.Delivery == "" {
		job.Delivery = "online"
	}
	if job.Delivery != "online" && job.Delivery != "offline" {
		return Job{}, errors.New("updater state delivery source is invalid")
	}
	return job, nil
}

func (store *Store) Save(job Job) error {
	return saveAt(store.path, job)
}

func (store *Store) Archive(job Job) error {
	if !archiveNamePattern.MatchString(job.RequestID) {
		return errors.New("refusing to archive state with unsafe request ID")
	}
	if job.Phase != PhaseCommitted && job.Phase != PhaseRolledBack {
		return errors.New("only terminal update state can be archived")
	}
	path := filepath.Join(filepath.Dir(store.path), "history", job.RequestID+".json")
	if _, err := os.Stat(path); err == nil {
		return errors.New("update history already contains this request ID")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return saveAt(path, job)
}

func (store *Store) History() ([]Job, error) {
	directory := filepath.Join(filepath.Dir(store.path), "history")
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return []Job{}, nil
	}
	if err != nil {
		return nil, err
	}
	jobs := make([]Job, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		historyStore, err := NewStore(filepath.Join(directory, entry.Name()))
		if err != nil {
			return nil, err
		}
		job, err := historyStore.Load()
		if err != nil {
			return nil, fmt.Errorf("load update history %s: %w", entry.Name(), err)
		}
		jobs = append(jobs, job)
	}
	sort.Slice(jobs, func(left, right int) bool { return jobs[left].UpdatedAt.After(jobs[right].UpdatedAt) })
	return jobs, nil
}

func saveAt(path string, job Job) error {
	if job.SchemaVersion != SchemaVersion || job.RequestID == "" || job.Revision < 1 {
		return errors.New("refusing to persist invalid updater state")
	}
	data, err := json.MarshalIndent(job, "", "  ")
	if err != nil {
		return fmt.Errorf("encode updater state: %w", err)
	}
	data = append(data, '\n')
	if len(data) > maxStateBytes {
		return errors.New("updater state exceeds maximum size")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create updater state directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".state-*.tmp")
	if err != nil {
		return fmt.Errorf("create temporary updater state: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("protect temporary updater state: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		temporary.Close()
		return fmt.Errorf("write temporary updater state: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return fmt.Errorf("sync temporary updater state: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close temporary updater state: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("commit updater state: %w", err)
	}
	return nil
}
