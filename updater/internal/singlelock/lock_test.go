package singlelock

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLockExcludesSecondInstance(t *testing.T) {
	path := filepath.Join(t.TempDir(), "updater.lock")
	now := time.Now().UTC()
	first, err := Acquire(path, time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(path, time.Minute, now.Add(time.Second)); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Acquire() error = %v", err)
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("lock still exists: %v", err)
	}
}

func TestStaleLockIsQuarantined(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "updater.lock")
	old := time.Now().UTC().Add(-2 * time.Hour)
	if err := os.WriteFile(path, []byte("abandoned\n1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
	lock, err := Acquire(path, time.Minute, time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	matches, err := filepath.Glob(path + ".stale.*")
	if err != nil || len(matches) != 1 {
		t.Fatalf("stale lock was not quarantined: %v %v", matches, err)
	}
}
