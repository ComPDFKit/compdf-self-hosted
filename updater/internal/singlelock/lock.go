package singlelock

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

var ErrLocked = errors.New("another updater instance holds the lock")

type Lock struct {
	path  string
	token string
}

func Acquire(path string, staleAfter time.Duration, now time.Time) (*Lock, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("lock path must be absolute")
	}
	if staleAfter <= 0 {
		return nil, errors.New("stale lock duration must be positive")
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, fmt.Errorf("create lock directory: %w", err)
	}
	token, err := randomToken()
	if err != nil {
		return nil, err
	}

	for attempt := 0; attempt < 3; attempt++ {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			if _, writeErr := fmt.Fprintf(file, "%s\n%d\n", token, os.Getpid()); writeErr != nil {
				file.Close()
				os.Remove(path)
				return nil, fmt.Errorf("write updater lock: %w", writeErr)
			}
			if closeErr := file.Close(); closeErr != nil {
				os.Remove(path)
				return nil, fmt.Errorf("close updater lock: %w", closeErr)
			}
			return &Lock{path: path, token: token}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, fmt.Errorf("acquire updater lock: %w", err)
		}
		info, statErr := os.Stat(path)
		if statErr != nil {
			continue
		}
		if now.Sub(info.ModTime()) <= staleAfter {
			return nil, ErrLocked
		}
		stalePath := fmt.Sprintf("%s.stale.%d", path, now.UnixNano())
		if renameErr := os.Rename(path, stalePath); renameErr != nil {
			continue
		}
	}
	return nil, ErrLocked
}

func (lock *Lock) Refresh(now time.Time) error {
	if now.IsZero() {
		now = time.Now().UTC()
	}
	owned, err := lock.owned()
	if err != nil {
		return err
	}
	if !owned {
		return ErrLocked
	}
	return os.Chtimes(lock.path, now, now)
}

func (lock *Lock) Release() error {
	owned, err := lock.owned()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !owned {
		return ErrLocked
	}
	return os.Remove(lock.path)
}

func (lock *Lock) owned() (bool, error) {
	data, err := os.ReadFile(lock.path)
	if err != nil {
		return false, err
	}
	ownerToken := strings.SplitN(string(data), "\n", 2)[0]
	return ownerToken == lock.token, nil
}

func randomToken() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", fmt.Errorf("generate updater lock token: %w", err)
	}
	return hex.EncodeToString(value), nil
}
