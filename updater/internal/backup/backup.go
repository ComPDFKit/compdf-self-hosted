package backup

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const SchemaVersion = 1

var safeNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

type Source struct {
	Name     string
	Path     string
	Required bool
}

type Dumper interface {
	Dump(ctx context.Context, destination io.Writer) error
}

type VolumeSource struct {
	Name          string
	Service       string
	ContainerPath string
}

type VolumeDumper interface {
	Dump(ctx context.Context, source VolumeSource, destination io.Writer) error
}

type Request struct {
	RequestID      string
	CurrentVersion string
	BackupRoot     string
	Sources        []Source
	Dumper         Dumper
	Volumes        []VolumeSource
	VolumeDumper   VolumeDumper
	Now            time.Time
}

type Artifact struct {
	Path        string `json:"path"`
	SHA256      string `json:"sha256"`
	Size        int64  `json:"size"`
	ContentType string `json:"contentType"`
}

type SourceRecord struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type VolumeRecord struct {
	Name          string `json:"name"`
	Service       string `json:"service"`
	ContainerPath string `json:"containerPath"`
}

type Manifest struct {
	SchemaVersion        int            `json:"schemaVersion"`
	BackupID             string         `json:"backupId"`
	RequestID            string         `json:"requestId"`
	CurrentVersion       string         `json:"currentVersion"`
	CreatedAt            time.Time      `json:"createdAt"`
	CompletedAt          time.Time      `json:"completedAt"`
	Sources              []SourceRecord `json:"sources"`
	Volumes              []VolumeRecord `json:"volumes"`
	Artifacts            []Artifact     `json:"artifacts"`
	NotCovered           []string       `json:"notCovered"`
	RecoveryInstructions string         `json:"recoveryInstructions"`
}

type Executor struct {
	now func() time.Time
}

func NewExecutor() *Executor {
	return &Executor{now: func() time.Time { return time.Now().UTC() }}
}

func (executor *Executor) Create(ctx context.Context, request Request) (Manifest, string, error) {
	if err := validateRequest(request); err != nil {
		return Manifest{}, "", err
	}
	now := request.Now.UTC()
	if request.Now.IsZero() {
		now = executor.now()
	}
	backupID := now.Format("20060102T150405Z") + "-" + request.RequestID
	if err := os.MkdirAll(request.BackupRoot, 0o700); err != nil {
		return Manifest{}, "", fmt.Errorf("create backup root: %w", err)
	}
	partialDirectory, err := os.MkdirTemp(request.BackupRoot, "."+backupID+".partial-")
	if err != nil {
		return Manifest{}, "", fmt.Errorf("create partial backup directory: %w", err)
	}
	if err := os.Chmod(partialDirectory, 0o700); err != nil {
		_ = os.RemoveAll(partialDirectory)
		return Manifest{}, "", fmt.Errorf("protect partial backup directory: %w", err)
	}
	completed := false
	defer func() {
		if !completed {
			_ = os.RemoveAll(partialDirectory)
		}
	}()

	databaseArtifact, err := writeDatabaseDump(ctx, partialDirectory, request.Dumper)
	if err != nil {
		return Manifest{}, "", err
	}
	filesArtifact, records, err := writeFilesArchive(partialDirectory, request.Sources)
	if err != nil {
		return Manifest{}, "", err
	}
	artifacts := []Artifact{databaseArtifact, filesArtifact}
	volumeRecords := make([]VolumeRecord, 0, len(request.Volumes))
	for _, volume := range request.Volumes {
		artifact, err := writeVolumeArchive(ctx, partialDirectory, volume, request.VolumeDumper)
		if err != nil {
			return Manifest{}, "", err
		}
		artifacts = append(artifacts, artifact)
		volumeRecords = append(volumeRecords, VolumeRecord(volume))
	}
	notCovered := []string(nil)
	if len(request.Volumes) == 0 {
		notCovered = []string{"compdf_rustfs_data", "compdf_pdf_data", "compdf_output"}
	}
	manifest := Manifest{
		SchemaVersion:        SchemaVersion,
		BackupID:             backupID,
		RequestID:            request.RequestID,
		CurrentVersion:       request.CurrentVersion,
		CreatedAt:            now,
		CompletedAt:          completedAt(executor.now(), now),
		Sources:              records,
		Volumes:              volumeRecords,
		Artifacts:            artifacts,
		NotCovered:           notCovered,
		RecoveryInstructions: "Verify all checksums, restore database.sql, restore each volume archive to its documented container path, then extract files.tar.gz into the documented installation locations.",
	}
	if err := writeManifest(partialDirectory, manifest); err != nil {
		return Manifest{}, "", err
	}
	finalDirectory := filepath.Join(request.BackupRoot, backupID)
	if _, err := os.Stat(finalDirectory); err == nil {
		return Manifest{}, "", fmt.Errorf("backup %s already exists", backupID)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Manifest{}, "", fmt.Errorf("check final backup directory: %w", err)
	}
	if err := os.Rename(partialDirectory, finalDirectory); err != nil {
		return Manifest{}, "", fmt.Errorf("commit backup: %w", err)
	}
	completed = true
	return manifest, finalDirectory, nil
}

func Verify(directory string) (Manifest, error) {
	data, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return Manifest{}, fmt.Errorf("read backup manifest: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("decode backup manifest: %w", err)
	}
	var trailing unknownJSON
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return Manifest{}, errors.New("backup manifest contains trailing data")
	}
	if manifest.SchemaVersion != SchemaVersion || manifest.BackupID == "" || len(manifest.Artifacts) < 2 {
		return Manifest{}, errors.New("backup manifest is incomplete or unsupported")
	}
	for _, artifact := range manifest.Artifacts {
		if !safeNamePattern.MatchString(artifact.Path) {
			return Manifest{}, fmt.Errorf("unsafe artifact path %q", artifact.Path)
		}
		path := filepath.Join(directory, artifact.Path)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			return Manifest{}, fmt.Errorf("backup artifact %s is unavailable", artifact.Path)
		}
		if info.Size() != artifact.Size {
			return Manifest{}, fmt.Errorf("backup artifact %s size mismatch", artifact.Path)
		}
		sum, err := fileSHA256(path)
		if err != nil {
			return Manifest{}, err
		}
		if sum != artifact.SHA256 {
			return Manifest{}, fmt.Errorf("backup artifact %s checksum mismatch", artifact.Path)
		}
	}
	return manifest, nil
}

// ReadFileSource returns one named top-level file from the verified host-files
// archive. It never extracts paths to disk.
func ReadFileSource(directory, sourceName string, maxBytes int64) ([]byte, error) {
	if !safeNamePattern.MatchString(sourceName) || maxBytes <= 0 {
		return nil, errors.New("invalid backup source read request")
	}
	manifest, err := Verify(directory)
	if err != nil {
		return nil, err
	}
	foundSource := false
	for _, source := range manifest.Sources {
		if source.Name == sourceName {
			foundSource = true
			break
		}
	}
	if !foundSource {
		return nil, fmt.Errorf("backup source %q is unavailable", sourceName)
	}
	file, err := os.Open(filepath.Join(directory, "files.tar.gz"))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	gzipReader, err := gzip.NewReader(file)
	if err != nil {
		return nil, err
	}
	defer gzipReader.Close()
	tarReader := tar.NewReader(gzipReader)
	var result []byte
	for {
		header, err := tarReader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if header.Name != sourceName {
			continue
		}
		if header.Typeflag != tar.TypeReg || header.Size < 0 || header.Size > maxBytes {
			return nil, fmt.Errorf("backup source %q is not a bounded regular file", sourceName)
		}
		if result != nil {
			return nil, fmt.Errorf("backup source %q appears more than once", sourceName)
		}
		result, err = io.ReadAll(io.LimitReader(tarReader, maxBytes+1))
		if err != nil || int64(len(result)) != header.Size {
			return nil, fmt.Errorf("read backup source %q failed", sourceName)
		}
	}
	if result == nil {
		return nil, fmt.Errorf("backup source %q is missing from archive", sourceName)
	}
	return result, nil
}

func (manifest Manifest) Complete() bool {
	return len(manifest.NotCovered) == 0 && len(manifest.Volumes) == 3
}

func writeDatabaseDump(ctx context.Context, directory string, dumper Dumper) (Artifact, error) {
	path := filepath.Join(directory, "database.sql")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Artifact{}, fmt.Errorf("create database dump: %w", err)
	}
	dumpErr := dumper.Dump(ctx, file)
	closeErr := file.Close()
	if dumpErr != nil {
		return Artifact{}, fmt.Errorf("export database: %w", dumpErr)
	}
	if closeErr != nil {
		return Artifact{}, fmt.Errorf("close database dump: %w", closeErr)
	}
	artifact, err := describeArtifact(path, "application/sql")
	if err != nil {
		return Artifact{}, err
	}
	if artifact.Size == 0 {
		return Artifact{}, errors.New("database dump is empty")
	}
	return artifact, nil
}

func writeFilesArchive(directory string, sources []Source) (Artifact, []SourceRecord, error) {
	path := filepath.Join(directory, "files.tar.gz")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Artifact{}, nil, fmt.Errorf("create files archive: %w", err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	var records []SourceRecord
	for _, source := range sources {
		info, err := os.Lstat(source.Path)
		if errors.Is(err, os.ErrNotExist) && !source.Required {
			continue
		}
		if err != nil {
			_ = tarWriter.Close()
			_ = gzipWriter.Close()
			_ = file.Close()
			return Artifact{}, nil, fmt.Errorf("inspect backup source %s: %w", source.Name, err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			_ = tarWriter.Close()
			_ = gzipWriter.Close()
			_ = file.Close()
			return Artifact{}, nil, fmt.Errorf("backup source %s is a symbolic link", source.Name)
		}
		if err := addSource(tarWriter, source); err != nil {
			_ = tarWriter.Close()
			_ = gzipWriter.Close()
			_ = file.Close()
			return Artifact{}, nil, err
		}
		records = append(records, SourceRecord{Name: source.Name, Path: source.Path})
	}
	if err := tarWriter.Close(); err != nil {
		_ = gzipWriter.Close()
		_ = file.Close()
		return Artifact{}, nil, fmt.Errorf("finalize files archive: %w", err)
	}
	if err := gzipWriter.Close(); err != nil {
		_ = file.Close()
		return Artifact{}, nil, fmt.Errorf("compress files archive: %w", err)
	}
	if err := file.Close(); err != nil {
		return Artifact{}, nil, fmt.Errorf("close files archive: %w", err)
	}
	artifact, err := describeArtifact(path, "application/gzip")
	return artifact, records, err
}

func writeVolumeArchive(ctx context.Context, directory string, source VolumeSource, dumper VolumeDumper) (Artifact, error) {
	path := filepath.Join(directory, "volume-"+source.Name+".tar.gz")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Artifact{}, fmt.Errorf("create volume archive %s: %w", source.Name, err)
	}
	gzipWriter := gzip.NewWriter(file)
	dumpErr := dumper.Dump(ctx, source, gzipWriter)
	gzipErr := gzipWriter.Close()
	closeErr := file.Close()
	if dumpErr != nil {
		return Artifact{}, fmt.Errorf("archive volume %s: %w", source.Name, dumpErr)
	}
	if gzipErr != nil {
		return Artifact{}, fmt.Errorf("compress volume %s: %w", source.Name, gzipErr)
	}
	if closeErr != nil {
		return Artifact{}, fmt.Errorf("close volume archive %s: %w", source.Name, closeErr)
	}
	artifact, err := describeArtifact(path, "application/gzip")
	if err != nil {
		return Artifact{}, err
	}
	if artifact.Size == 0 {
		return Artifact{}, fmt.Errorf("volume archive %s is empty", source.Name)
	}
	return artifact, nil
}

func addSource(writer *tar.Writer, source Source) error {
	return filepath.WalkDir(source.Path, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("backup source %s contains symbolic link %s", source.Name, path)
		}
		if !info.IsDir() && !info.Mode().IsRegular() {
			return fmt.Errorf("backup source %s contains unsupported file type %s", source.Name, path)
		}
		relative, err := filepath.Rel(source.Path, path)
		if err != nil {
			return err
		}
		archiveName := source.Name
		if relative != "." {
			archiveName = filepath.Join(source.Name, relative)
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(archiveName)
		if info.IsDir() {
			header.Name += "/"
		}
		if err := writer.WriteHeader(header); err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		file, err := os.Open(path)
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(writer, file)
		closeErr := file.Close()
		if copyErr != nil {
			return copyErr
		}
		return closeErr
	})
}

func writeManifest(directory string, manifest Manifest) error {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode backup manifest: %w", err)
	}
	data = append(data, '\n')
	if err := os.WriteFile(filepath.Join(directory, "manifest.json"), data, 0o600); err != nil {
		return fmt.Errorf("write backup manifest: %w", err)
	}
	return nil
}

func describeArtifact(path, contentType string) (Artifact, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Artifact{}, err
	}
	sum, err := fileSHA256(path)
	if err != nil {
		return Artifact{}, err
	}
	return Artifact{Path: filepath.Base(path), SHA256: sum, Size: info.Size(), ContentType: contentType}, nil
}

func fileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func validateRequest(request Request) error {
	if !safeNamePattern.MatchString(request.RequestID) {
		return errors.New("request ID is missing or unsafe")
	}
	if request.CurrentVersion == "" {
		return errors.New("current version is required")
	}
	if request.Dumper == nil {
		return errors.New("database dumper is required")
	}
	if len(request.Volumes) > 0 && request.VolumeDumper == nil {
		return errors.New("volume dumper is required when volume sources are configured")
	}
	if !isNonRootAbsolutePath(request.BackupRoot) {
		return errors.New("backup root must be a non-root absolute path")
	}
	seen := make(map[string]struct{}, len(request.Sources))
	for _, source := range request.Sources {
		if !safeNamePattern.MatchString(source.Name) || !isNonRootAbsolutePath(source.Path) {
			return fmt.Errorf("backup source %q is invalid", source.Name)
		}
		if _, exists := seen[source.Name]; exists {
			return fmt.Errorf("backup source %q is duplicated", source.Name)
		}
		if pathContains(source.Path, request.BackupRoot) {
			return fmt.Errorf("backup root is inside source %q", source.Name)
		}
		seen[source.Name] = struct{}{}
	}
	allowedVolumes := map[string]VolumeSource{
		"rustfs-data": {Name: "rustfs-data", Service: "compdf-infra", ContainerPath: "/data"},
		"pdf-data":    {Name: "pdf-data", Service: "compdf-app", ContainerPath: "/data"},
		"output":      {Name: "output", Service: "compdf-app", ContainerPath: "/tmp/compdf_output"},
	}
	volumeNames := make(map[string]struct{}, len(request.Volumes))
	for _, volume := range request.Volumes {
		allowed, ok := allowedVolumes[volume.Name]
		if !ok || volume != allowed {
			return fmt.Errorf("volume source %q is not an allowed ComPDF data volume", volume.Name)
		}
		if _, exists := volumeNames[volume.Name]; exists {
			return fmt.Errorf("volume source %q is duplicated", volume.Name)
		}
		volumeNames[volume.Name] = struct{}{}
	}
	if len(request.Volumes) != 0 && len(request.Volumes) != len(allowedVolumes) {
		return errors.New("volume backup must include all three application data volumes")
	}
	return nil
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(filepath.Clean(parent), filepath.Clean(child))
	if err != nil {
		return false
	}
	return relative == "." || (relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

func isNonRootAbsolutePath(path string) bool {
	if !filepath.IsAbs(path) {
		return false
	}
	clean := filepath.Clean(path)
	return clean != filepath.VolumeName(clean)+string(filepath.Separator)
}

type RetentionResult struct {
	Removed []string
	Kept    []string
}

func ApplyRetention(root string, keep int, protected map[string]struct{}) (RetentionResult, error) {
	if !isNonRootAbsolutePath(root) || keep < 0 {
		return RetentionResult{}, errors.New("invalid retention arguments")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		return RetentionResult{}, err
	}
	type candidate struct {
		name string
		at   time.Time
	}
	var candidates []candidate
	for _, entry := range entries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		manifest, err := Verify(filepath.Join(root, entry.Name()))
		if err != nil || manifest.BackupID != entry.Name() {
			continue
		}
		candidates = append(candidates, candidate{name: entry.Name(), at: manifest.CompletedAt})
	}
	sort.Slice(candidates, func(left, right int) bool {
		if candidates[left].at.Equal(candidates[right].at) {
			return candidates[left].name > candidates[right].name
		}
		return candidates[left].at.After(candidates[right].at)
	})
	result := RetentionResult{}
	for index, item := range candidates {
		_, isProtected := protected[item.name]
		if index < keep || isProtected {
			result.Kept = append(result.Kept, item.name)
			continue
		}
		path := filepath.Join(root, item.name)
		relative, err := filepath.Rel(root, path)
		if err != nil || relative != item.name {
			return result, fmt.Errorf("refusing to remove backup outside root: %s", item.name)
		}
		if err := os.RemoveAll(path); err != nil {
			return result, fmt.Errorf("remove expired backup %s: %w", item.name, err)
		}
		result.Removed = append(result.Removed, item.name)
	}
	return result, nil
}

func completedAt(actual, created time.Time) time.Time {
	if actual.Before(created) {
		return created
	}
	return actual
}

type unknownJSON any
