package release

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strings"
	"time"
)

const (
	ManifestSchemaVersion = 1
	maxManifestBytes      = 1024 * 1024
)

var (
	digestPattern   = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	checksumPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
	artifactPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)
)

var (
	ErrManifestExpired      = errors.New("release manifest has expired")
	ErrChannelMismatch      = errors.New("release channel does not match updater channel")
	ErrCurrentVersionTooOld = errors.New("current product version is below the supported minimum")
	ErrUpdaterVersionTooOld = errors.New("updater version is below the supported minimum")
	ErrInfraUpgradeRequired = errors.New("release requires an infrastructure upgrade")
	ErrReleasePaused        = errors.New("release is paused")
	ErrReleaseWithdrawn     = errors.New("release is withdrawn")
)

type Image struct {
	Name   string `json:"name"`
	Tag    string `json:"tag"`
	Digest string `json:"digest"`
}

type Artifact struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type Migration struct {
	From     string    `json:"from"`
	To       string    `json:"to"`
	Required bool      `json:"required"`
	Artifact *Artifact `json:"artifact,omitempty"`
}

type Rollback struct {
	Application           bool `json:"application"`
	Database              bool `json:"database"`
	RequiresBackupRestore bool `json:"requiresBackupRestore"`
}

type Manifest struct {
	SchemaVersion         int                 `json:"schemaVersion"`
	Version               string              `json:"version"`
	Channel               string              `json:"channel"`
	Status                string              `json:"status"`
	StatusReason          string              `json:"statusReason,omitempty"`
	MinimumVersion        string              `json:"minimumVersion"`
	MinimumUpdaterVersion string              `json:"minimumUpdaterVersion"`
	ReleasedAt            time.Time           `json:"releasedAt"`
	ExpiresAt             time.Time           `json:"expiresAt"`
	MaintenanceRequired   bool                `json:"maintenanceRequired"`
	InfraUpgradeRequired  bool                `json:"infraUpgradeRequired"`
	Images                map[string]Image    `json:"images"`
	Migration             Migration           `json:"migration"`
	Rollback              Rollback            `json:"rollback"`
	Compose               *Artifact           `json:"compose,omitempty"`
	Checksums             *Artifact           `json:"checksums,omitempty"`
	OfflineImages         map[string]Artifact `json:"offlineImages,omitempty"`
	ReleaseNotes          string              `json:"releaseNotes"`
	KnownIssues           []string            `json:"knownIssues"`
}

type Compatibility struct {
	CurrentVersion string
	UpdaterVersion string
	Channel        string
	Now            time.Time
}

// Artifacts returns every file that belongs to the signed release payload.
// The manifest and detached signature are transport metadata and are not
// included here.
func (manifest Manifest) Artifacts() ([]Artifact, error) {
	var artifacts []Artifact
	if manifest.Compose != nil {
		artifacts = append(artifacts, *manifest.Compose)
	}
	if manifest.Migration.Artifact != nil {
		artifacts = append(artifacts, *manifest.Migration.Artifact)
	}
	if manifest.Checksums != nil {
		artifacts = append(artifacts, *manifest.Checksums)
	}
	if len(manifest.OfflineImages) > 0 {
		for _, name := range []string{"app", "server"} {
			artifact, ok := manifest.OfflineImages[name]
			if !ok {
				return nil, errors.New("offlineImages must declare both app and server image archives")
			}
			artifacts = append(artifacts, artifact)
		}
		if len(manifest.OfflineImages) != 2 {
			return nil, errors.New("offlineImages may contain only app and server")
		}
	}
	seen := make(map[string]struct{}, len(artifacts))
	for _, artifact := range artifacts {
		if err := validateArtifact(artifact); err != nil {
			return nil, fmt.Errorf("artifact %q: %w", artifact.Path, err)
		}
		if _, exists := seen[artifact.Path]; exists {
			return nil, fmt.Errorf("artifact path %q is declared more than once", artifact.Path)
		}
		seen[artifact.Path] = struct{}{}
	}
	sort.Slice(artifacts, func(left, right int) bool { return artifacts[left].Path < artifacts[right].Path })
	return artifacts, nil
}

func ParseManifest(data []byte) (Manifest, error) {
	if len(data) == 0 {
		return Manifest{}, errors.New("release manifest is empty")
	}
	if len(data) > maxManifestBytes {
		return Manifest{}, fmt.Errorf("release manifest exceeds %d bytes", maxManifestBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode release manifest: %w", err)
	}
	if err := rejectTrailingJSON(decoder); err != nil {
		return Manifest{}, err
	}
	if err := manifest.Validate(); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func (manifest Manifest) Validate() error {
	if manifest.SchemaVersion != ManifestSchemaVersion {
		return fmt.Errorf("unsupported manifest schema version %d", manifest.SchemaVersion)
	}
	target, err := parseSemanticVersion(manifest.Version)
	if err != nil {
		return err
	}
	minimum, err := parseSemanticVersion(manifest.MinimumVersion)
	if err != nil {
		return err
	}
	if compareSemanticVersions(minimum, target) > 0 {
		return errors.New("minimumVersion is greater than target version")
	}
	if _, err := parseSemanticVersion(manifest.MinimumUpdaterVersion); err != nil {
		return err
	}
	if manifest.Channel != "stable" && manifest.Channel != "beta" && manifest.Channel != "security" {
		return fmt.Errorf("unsupported release channel %q", manifest.Channel)
	}
	status := manifest.Status
	if status == "" {
		status = "active"
	}
	if status != "active" && status != "paused" && status != "withdrawn" {
		return fmt.Errorf("unsupported release status %q", manifest.Status)
	}
	if status != "active" && strings.TrimSpace(manifest.StatusReason) == "" {
		return errors.New("paused or withdrawn release requires statusReason")
	}
	if manifest.ReleasedAt.IsZero() || manifest.ExpiresAt.IsZero() || !manifest.ExpiresAt.After(manifest.ReleasedAt) {
		return errors.New("release timestamps are missing or invalid")
	}
	if manifest.ReleaseNotes == "" {
		return errors.New("releaseNotes is required")
	}
	for _, name := range []string{"app", "server"} {
		image, ok := manifest.Images[name]
		if !ok {
			return fmt.Errorf("images.%s is required", name)
		}
		if image.Name == "" || !digestPattern.MatchString(image.Digest) {
			return fmt.Errorf("images.%s has an invalid name or digest", name)
		}
		if _, err := parseSemanticVersion(image.Tag); err != nil {
			return fmt.Errorf("images.%s tag: %w", name, err)
		}
	}
	if len(manifest.Images) != 2 {
		return errors.New("only app and server images are allowed")
	}
	if err := validateMigration(manifest); err != nil {
		return err
	}
	if manifest.Compose != nil {
		if err := validateArtifact(*manifest.Compose); err != nil {
			return fmt.Errorf("compose artifact: %w", err)
		}
	}
	if _, err := manifest.Artifacts(); err != nil {
		return err
	}
	return nil
}

func (manifest Manifest) CheckCompatibility(input Compatibility) error {
	if input.Now.IsZero() {
		input.Now = time.Now().UTC()
	}
	if !input.Now.Before(manifest.ExpiresAt) {
		return ErrManifestExpired
	}
	switch manifest.Status {
	case "", "active":
	case "paused":
		return ErrReleasePaused
	case "withdrawn":
		return ErrReleaseWithdrawn
	}
	if input.Channel != manifest.Channel {
		return ErrChannelMismatch
	}
	current, err := parseSemanticVersion(input.CurrentVersion)
	if err != nil {
		return fmt.Errorf("current version: %w", err)
	}
	minimum, _ := parseSemanticVersion(manifest.MinimumVersion)
	if compareSemanticVersions(current, minimum) < 0 {
		return ErrCurrentVersionTooOld
	}
	updater, err := parseSemanticVersion(input.UpdaterVersion)
	if err != nil {
		return fmt.Errorf("updater version: %w", err)
	}
	minimumUpdater, _ := parseSemanticVersion(manifest.MinimumUpdaterVersion)
	if compareSemanticVersions(updater, minimumUpdater) < 0 {
		return ErrUpdaterVersionTooOld
	}
	if manifest.InfraUpgradeRequired {
		return ErrInfraUpgradeRequired
	}
	return nil
}

func validateMigration(manifest Manifest) error {
	from, err := parseSemanticVersion(manifest.Migration.From)
	if err != nil {
		return fmt.Errorf("migration.from: %w", err)
	}
	to, err := parseSemanticVersion(manifest.Migration.To)
	if err != nil {
		return fmt.Errorf("migration.to: %w", err)
	}
	if compareSemanticVersions(from, to) > 0 {
		return errors.New("migration.from is greater than migration.to")
	}
	if manifest.Migration.Required && manifest.Migration.Artifact == nil {
		return errors.New("required migration has no artifact")
	}
	if manifest.Migration.Artifact != nil {
		if err := validateArtifact(*manifest.Migration.Artifact); err != nil {
			return fmt.Errorf("migration artifact: %w", err)
		}
	}
	return nil
}

func validateArtifact(artifact Artifact) error {
	if !artifactPattern.MatchString(artifact.Path) || artifact.Size <= 0 || !checksumPattern.MatchString(artifact.SHA256) {
		return errors.New("path, sha256, or size is invalid")
	}
	if artifact.Path[0] == '/' || bytes.Contains([]byte(artifact.Path), []byte("..")) {
		return errors.New("path must be a relative clean release path")
	}
	return nil
}

func rejectTrailingJSON(decoder *json.Decoder) error {
	var trailing unknownJSON
	if err := decoder.Decode(&trailing); err == io.EOF {
		return nil
	} else if err != nil {
		return fmt.Errorf("decode trailing release manifest data: %w", err)
	}
	return errors.New("release manifest contains multiple JSON values")
}

type unknownJSON any
