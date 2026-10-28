package diagnostics

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
)

type Summary struct {
	SchemaVersion   int       `json:"schemaVersion"`
	CreatedAt       time.Time `json:"createdAt"`
	ComposeProject  string    `json:"composeProject"`
	Channel         string    `json:"channel"`
	AllowedServices []string  `json:"allowedServices"`
	TrustedKeyIDs   []string  `json:"trustedKeyIds"`
}

func Create(config updaterconfig.Config, destination string, now time.Time) error {
	if !filepath.IsAbs(destination) || filepath.Ext(destination) != ".zip" {
		return errors.New("diagnostic output must be an absolute .zip path")
	}
	if _, err := os.Stat(destination); err == nil {
		return errors.New("refusing to overwrite an existing diagnostic bundle")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}
	keyIDs := make([]string, 0, len(config.TrustedKeys))
	for keyID := range config.TrustedKeys {
		keyIDs = append(keyIDs, keyID)
	}
	sort.Strings(keyIDs)
	files := map[string][]byte{}
	files["summary.json"] = encode(Summary{
		SchemaVersion: 1, CreatedAt: now, ComposeProject: config.ComposeProject,
		Channel: config.Channel, AllowedServices: append([]string(nil), config.AllowedServices...), TrustedKeyIDs: keyIDs,
	})
	store, _ := state.NewStore(filepath.Join(config.StateDirectory, "state.json"))
	if job, err := store.Load(); err == nil {
		files["update-state.json"] = encode(job)
	}
	if history, err := store.History(); err == nil {
		files["update-history.json"] = encode(history)
	}
	for name, path := range map[string]string{
		"current-release.json": filepath.Join(config.StateDirectory, "current", release.ManifestFilename),
		"target-release.json":  filepath.Join(config.StateDirectory, "releases", targetVersion(store), release.ManifestFilename),
	} {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		manifest, err := release.ParseManifest(data)
		if err == nil {
			files[name] = encode(manifest)
		}
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".diagnostics-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return err
	}
	archive := zip.NewWriter(temporary)
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		writer, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
		if err != nil {
			archive.Close()
			temporary.Close()
			return err
		}
		if _, err := writer.Write(files[name]); err != nil {
			archive.Close()
			temporary.Close()
			return err
		}
	}
	if err := archive.Close(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		return fmt.Errorf("commit diagnostic bundle: %w", err)
	}
	return nil
}

func encode(value any) []byte {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetIndent("", "  ")
	_ = encoder.Encode(value)
	return buffer.Bytes()
}

func targetVersion(store *state.Store) string {
	job, err := store.Load()
	if err != nil {
		return "unavailable"
	}
	return job.TargetVersion
}
