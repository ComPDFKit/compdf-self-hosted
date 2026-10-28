package publisher

import (
	"archive/tar"
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/klauspost/compress/zstd"
)

type ArtifactInput struct {
	Path   string `json:"path"`
	Source string `json:"source"`
}

type MigrationInput struct {
	From     string         `json:"from"`
	To       string         `json:"to"`
	Required bool           `json:"required"`
	Artifact *ArtifactInput `json:"artifact,omitempty"`
}

type Spec struct {
	SchemaVersion         int                      `json:"schemaVersion"`
	Version               string                   `json:"version"`
	Channel               string                   `json:"channel"`
	Status                string                   `json:"status,omitempty"`
	StatusReason          string                   `json:"statusReason,omitempty"`
	MinimumVersion        string                   `json:"minimumVersion"`
	MinimumUpdaterVersion string                   `json:"minimumUpdaterVersion"`
	ReleasedAt            time.Time                `json:"releasedAt"`
	ExpiresAt             time.Time                `json:"expiresAt"`
	MaintenanceRequired   bool                     `json:"maintenanceRequired"`
	InfraUpgradeRequired  bool                     `json:"infraUpgradeRequired"`
	Images                map[string]release.Image `json:"images"`
	Migration             MigrationInput           `json:"migration"`
	Rollback              release.Rollback         `json:"rollback"`
	Compose               *ArtifactInput           `json:"compose,omitempty"`
	OfflineImages         map[string]ArtifactInput `json:"offlineImages,omitempty"`
	ReleaseNotes          string                   `json:"releaseNotes"`
	KnownIssues           []string                 `json:"knownIssues"`
}

type Result struct {
	Manifest       release.Manifest
	ManifestBytes  []byte
	SignatureBytes []byte
	Directory      string
	OfflinePackage string
}

func Build(specPath, privateKeyPath, keyID, outputDirectory, offlinePackage string) (Result, error) {
	if !filepath.IsAbs(specPath) || !filepath.IsAbs(privateKeyPath) || !filepath.IsAbs(outputDirectory) {
		return Result{}, errors.New("spec, private key, and output paths must be absolute")
	}
	if offlinePackage != "" && !filepath.IsAbs(offlinePackage) {
		return Result{}, errors.New("offline package path must be absolute")
	}
	spec, err := loadSpec(specPath)
	if err != nil {
		return Result{}, err
	}
	privateKey, err := loadPrivateKey(privateKeyPath)
	if err != nil {
		return Result{}, err
	}
	if _, err := os.Stat(outputDirectory); err == nil {
		return Result{}, errors.New("release output directory already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, err
	}
	parent := filepath.Dir(outputDirectory)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return Result{}, err
	}
	temporary, err := os.MkdirTemp(parent, ".release-build-*")
	if err != nil {
		return Result{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(temporary)
		}
	}()
	base := filepath.Dir(specPath)
	manifest := release.Manifest{
		SchemaVersion: spec.SchemaVersion, Version: spec.Version, Channel: spec.Channel,
		Status: normalizedStatus(spec.Status), StatusReason: spec.StatusReason,
		MinimumVersion: spec.MinimumVersion, MinimumUpdaterVersion: spec.MinimumUpdaterVersion,
		ReleasedAt: spec.ReleasedAt, ExpiresAt: spec.ExpiresAt,
		MaintenanceRequired: spec.MaintenanceRequired, InfraUpgradeRequired: spec.InfraUpgradeRequired,
		Images: spec.Images, Rollback: spec.Rollback, ReleaseNotes: spec.ReleaseNotes, KnownIssues: append([]string{}, spec.KnownIssues...),
		Migration: release.Migration{From: spec.Migration.From, To: spec.Migration.To, Required: spec.Migration.Required},
	}
	var payload []release.Artifact
	if spec.Compose != nil {
		artifact, err := materializeArtifact(base, temporary, *spec.Compose)
		if err != nil {
			return Result{}, err
		}
		manifest.Compose = &artifact
		payload = append(payload, artifact)
	}
	if spec.Migration.Artifact != nil {
		artifact, err := materializeArtifact(base, temporary, *spec.Migration.Artifact)
		if err != nil {
			return Result{}, err
		}
		manifest.Migration.Artifact = &artifact
		payload = append(payload, artifact)
	}
	if len(spec.OfflineImages) > 0 {
		manifest.OfflineImages = make(map[string]release.Artifact, len(spec.OfflineImages))
		for _, name := range []string{"app", "server"} {
			input, ok := spec.OfflineImages[name]
			if !ok {
				return Result{}, errors.New("offlineImages must define app and server")
			}
			artifact, err := materializeArtifact(base, temporary, input)
			if err != nil {
				return Result{}, err
			}
			manifest.OfflineImages[name] = artifact
			payload = append(payload, artifact)
		}
	}
	// Image-only online releases have no downloadable payload artifacts. In
	// that case omit checksums.txt instead of creating an empty artifact, which
	// cannot satisfy the release artifact contract. Offline or migration
	// releases still receive a checksums file covering every payload artifact.
	if len(payload) > 0 {
		checksumsBytes := renderChecksums(payload)
		checksumsPath := filepath.Join(temporary, "checksums.txt")
		if err := os.WriteFile(checksumsPath, checksumsBytes, 0o600); err != nil {
			return Result{}, err
		}
		checksumsArtifact, err := describe("checksums.txt", checksumsPath)
		if err != nil {
			return Result{}, err
		}
		manifest.Checksums = &checksumsArtifact
	}
	if err := manifest.Validate(); err != nil {
		return Result{}, fmt.Errorf("generated release manifest is invalid: %w", err)
	}
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return Result{}, err
	}
	manifestBytes = append(manifestBytes, '\n')
	manifestDigest := sha256.Sum256(manifestBytes)
	signature := release.Signature{
		SchemaVersion: 1, Algorithm: "Ed25519", KeyID: keyID,
		ManifestSHA256: hex.EncodeToString(manifestDigest[:]),
		Value:          base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, manifestBytes)),
	}
	signatureBytes, err := json.MarshalIndent(signature, "", "  ")
	if err != nil {
		return Result{}, err
	}
	signatureBytes = append(signatureBytes, '\n')
	if _, err := release.ParseSignature(signatureBytes); err != nil {
		return Result{}, fmt.Errorf("generated release signature is invalid: %w", err)
	}
	if err := os.WriteFile(filepath.Join(temporary, release.ManifestFilename), manifestBytes, 0o600); err != nil {
		return Result{}, err
	}
	if err := os.WriteFile(filepath.Join(temporary, release.SignatureFilename), signatureBytes, 0o600); err != nil {
		return Result{}, err
	}
	if err := release.VerifyBundle(temporary, manifest, manifestBytes, signatureBytes); err != nil {
		return Result{}, fmt.Errorf("verify generated release: %w", err)
	}
	if err := os.Rename(temporary, outputDirectory); err != nil {
		return Result{}, err
	}
	committed = true
	if offlinePackage != "" {
		if len(manifest.OfflineImages) != 2 {
			return Result{}, errors.New("offline package requested without both offline image artifacts")
		}
		if err := writeOfflinePackage(outputDirectory, offlinePackage); err != nil {
			return Result{}, err
		}
	}
	return Result{Manifest: manifest, ManifestBytes: manifestBytes, SignatureBytes: signatureBytes, Directory: outputDirectory, OfflinePackage: offlinePackage}, nil
}

func normalizedStatus(status string) string {
	if status == "" {
		return "active"
	}
	return status
}

func loadSpec(path string) (Spec, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Spec{}, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var spec Spec
	if err := decoder.Decode(&spec); err != nil {
		return Spec{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Spec{}, errors.New("release spec contains trailing data")
	}
	return spec, nil
}

func loadPrivateKey(path string) (ed25519.PrivateKey, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return nil, errors.New("release signing key must be a small regular file")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("release signing key must have mode 0600")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSpace(string(data)))
	if err != nil || len(decoded) != ed25519.PrivateKeySize {
		return nil, errors.New("release signing key must be a Base64 Ed25519 private key")
	}
	return ed25519.PrivateKey(decoded), nil
}

func materializeArtifact(base, root string, input ArtifactInput) (release.Artifact, error) {
	clean, err := safeRelativePath(input.Path)
	if err != nil {
		return release.Artifact{}, err
	}
	source := input.Source
	if !filepath.IsAbs(source) {
		source = filepath.Join(base, source)
	}
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() {
		return release.Artifact{}, fmt.Errorf("artifact source %q is not a regular file", input.Source)
	}
	destination := filepath.Join(root, clean)
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return release.Artifact{}, err
	}
	inputFile, err := os.Open(source)
	if err != nil {
		return release.Artifact{}, err
	}
	defer inputFile.Close()
	output, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return release.Artifact{}, err
	}
	_, copyErr := io.Copy(output, inputFile)
	closeErr := output.Close()
	if copyErr != nil || closeErr != nil {
		return release.Artifact{}, fmt.Errorf("copy artifact %q failed", input.Path)
	}
	return describe(filepath.ToSlash(clean), destination)
}

func describe(path, source string) (release.Artifact, error) {
	file, err := os.Open(source)
	if err != nil {
		return release.Artifact{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() <= 0 {
		return release.Artifact{}, errors.New("release artifact is empty")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return release.Artifact{}, err
	}
	return release.Artifact{Path: path, SHA256: hex.EncodeToString(hash.Sum(nil)), Size: info.Size()}, nil
}

func renderChecksums(artifacts []release.Artifact) []byte {
	items := append([]release.Artifact(nil), artifacts...)
	sort.Slice(items, func(left, right int) bool { return items[left].Path < items[right].Path })
	var output strings.Builder
	for _, artifact := range items {
		fmt.Fprintf(&output, "%s  %s\n", artifact.SHA256, artifact.Path)
	}
	return []byte(output.String())
}

func safeRelativePath(path string) (string, error) {
	if path == "" || strings.Contains(path, "\\") || strings.ContainsRune(path, '\x00') {
		return "", errors.New("artifact path is unsafe")
	}
	clean := filepath.Clean(filepath.FromSlash(path))
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", errors.New("artifact path escapes release directory")
	}
	return clean, nil
}

func writeOfflinePackage(directory, destination string) error {
	if _, err := os.Stat(destination); err == nil {
		return errors.New("offline package already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(filepath.Dir(destination), ".offline-*.tmp")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	encoder, err := zstd.NewWriter(temporary, zstd.WithEncoderLevel(zstd.SpeedDefault))
	if err != nil {
		temporary.Close()
		return err
	}
	writer := tar.NewWriter(encoder)
	var files []string
	err = filepath.WalkDir(directory, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type().IsRegular() {
			files = append(files, path)
		} else if !entry.IsDir() {
			return fmt.Errorf("release contains unsupported entry %s", path)
		}
		return nil
	})
	if err == nil {
		sort.Strings(files)
		for _, path := range files {
			relative, _ := filepath.Rel(directory, path)
			info, statErr := os.Stat(path)
			if statErr != nil {
				err = statErr
				break
			}
			header := &tar.Header{Name: filepath.ToSlash(relative), Mode: 0o600, Size: info.Size(), Typeflag: tar.TypeReg, ModTime: time.Unix(0, 0).UTC()}
			if err = writer.WriteHeader(header); err != nil {
				break
			}
			file, openErr := os.Open(path)
			if openErr != nil {
				err = openErr
				break
			}
			_, copyErr := io.Copy(writer, file)
			closeErr := file.Close()
			if copyErr != nil {
				err = copyErr
				break
			}
			if closeErr != nil {
				err = closeErr
				break
			}
		}
	}
	if closeErr := writer.Close(); err == nil {
		err = closeErr
	}
	if closeErr := encoder.Close(); err == nil {
		err = closeErr
	}
	if syncErr := temporary.Sync(); err == nil {
		err = syncErr
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temporaryPath, destination)
}
