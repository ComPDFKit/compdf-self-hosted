package backup

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fakeDumper struct {
	data string
	err  error
}

type fakeVolumeDumper struct {
	err error
}

func (dumper fakeVolumeDumper) Dump(_ context.Context, source VolumeSource, destination io.Writer) error {
	if dumper.err != nil {
		return dumper.err
	}
	_, err := io.WriteString(destination, "archive for "+source.Name+"\n")
	return err
}

func (dumper fakeDumper) Dump(_ context.Context, destination io.Writer) error {
	if dumper.err != nil {
		return dumper.err
	}
	_, err := io.WriteString(destination, dumper.data)
	return err
}

func TestCreateAndVerifyBackup(t *testing.T) {
	request := validRequest(t, "request-1", time.Date(2026, 9, 16, 1, 2, 3, 0, time.UTC))
	manifest, directory, err := NewExecutor().Create(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if manifest.BackupID != "20260916T010203Z-request-1" {
		t.Fatalf("unexpected backup ID: %s", manifest.BackupID)
	}
	verified, err := Verify(directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(verified.Artifacts) != 2 || len(verified.Sources) != 2 {
		t.Fatalf("unexpected manifest: %+v", verified)
	}
	if data, err := os.ReadFile(filepath.Join(directory, "database.sql")); err != nil || string(data) != "database dump\n" {
		t.Fatalf("unexpected database dump: %q, %v", data, err)
	}
}

func TestCreateCompleteBackupIncludesEveryApplicationVolume(t *testing.T) {
	request := validRequest(t, "complete", time.Now().UTC())
	request.Volumes = []VolumeSource{
		{Name: "rustfs-data", Service: "compdf-infra", ContainerPath: "/data"},
		{Name: "pdf-data", Service: "compdf-app", ContainerPath: "/data"},
		{Name: "output", Service: "compdf-app", ContainerPath: "/tmp/compdf_output"},
	}
	request.VolumeDumper = fakeVolumeDumper{}
	manifest, directory, err := NewExecutor().Create(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if !manifest.Complete() || len(manifest.Artifacts) != 5 || len(manifest.NotCovered) != 0 {
		t.Fatalf("backup is not complete: %+v", manifest)
	}
	verified, err := Verify(directory)
	if err != nil || !verified.Complete() {
		t.Fatalf("complete backup did not verify: %+v, %v", verified, err)
	}
}

func TestCreateRejectsPartialVolumeSelection(t *testing.T) {
	request := validRequest(t, "partial-volumes", time.Now().UTC())
	request.Volumes = []VolumeSource{{Name: "rustfs-data", Service: "compdf-infra", ContainerPath: "/data"}}
	request.VolumeDumper = fakeVolumeDumper{}
	if _, _, err := NewExecutor().Create(context.Background(), request); err == nil {
		t.Fatal("partial volume selection was accepted")
	}
}

func TestCreateRemovesPartialBackupOnFailure(t *testing.T) {
	request := validRequest(t, "request-2", time.Now().UTC())
	request.Dumper = fakeDumper{err: errors.New("dump failed")}
	if _, _, err := NewExecutor().Create(context.Background(), request); err == nil {
		t.Fatal("database dump failure was ignored")
	}
	entries, err := os.ReadDir(request.BackupRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("partial backup was retained: %+v", entries)
	}
}

func TestCreateRejectsEmptyDatabaseDump(t *testing.T) {
	request := validRequest(t, "empty", time.Now().UTC())
	request.Dumper = fakeDumper{}
	if _, _, err := NewExecutor().Create(context.Background(), request); err == nil {
		t.Fatal("empty dump accepted")
	}
}

func TestCreateRejectsBackupRootInsideSource(t *testing.T) {
	request := validRequest(t, "recursive", time.Now().UTC())
	request.BackupRoot = filepath.Join(request.Sources[0].Path, "backups")
	if _, _, err := NewExecutor().Create(context.Background(), request); err == nil {
		t.Fatal("recursive source accepted")
	}
}

func TestVerifyDetectsTamperedArtifact(t *testing.T) {
	request := validRequest(t, "request-3", time.Now().UTC())
	_, directory, err := NewExecutor().Create(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "database.sql"), []byte("tampered"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(directory); err == nil {
		t.Fatal("tampered artifact was accepted")
	}
}

func TestVerifyRejectsTrailingManifestData(t *testing.T) {
	request := validRequest(t, "request-4", time.Now().UTC())
	_, directory, err := NewExecutor().Create(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(directory, "manifest.json")
	file, err := os.OpenFile(manifestPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("{}\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Verify(directory); err == nil {
		t.Fatal("manifest with trailing JSON was accepted")
	}
}

func TestReadFileSourceReturnsVerifiedNamedFile(t *testing.T) {
	request := validRequest(t, "read-source", time.Now().UTC())
	_, directory, err := NewExecutor().Create(context.Background(), request)
	if err != nil {
		t.Fatal(err)
	}
	data, err := ReadFileSource(directory, "environment", 1024)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "SECRET=redacted-in-logs\n" {
		t.Fatalf("unexpected source: %q", data)
	}
	if _, err := ReadFileSource(directory, "missing", 1024); err == nil {
		t.Fatal("missing source was accepted")
	}
}

func TestRetentionPreservesNewestAndProtectedBackups(t *testing.T) {
	root := filepath.Join(t.TempDir(), "backups")
	requests := []Request{
		validRequestAtRoot(t, root, "old", time.Date(2026, 9, 14, 0, 0, 0, 0, time.UTC)),
		validRequestAtRoot(t, root, "protected", time.Date(2026, 9, 15, 0, 0, 0, 0, time.UTC)),
		validRequestAtRoot(t, root, "new", time.Date(2026, 9, 16, 0, 0, 0, 0, time.UTC)),
	}
	var protectedID string
	for index, request := range requests {
		manifest, _, err := NewExecutor().Create(context.Background(), request)
		if err != nil {
			t.Fatal(err)
		}
		if index == 1 {
			protectedID = manifest.BackupID
		}
	}
	result, err := ApplyRetention(root, 1, map[string]struct{}{protectedID: {}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Removed) != 1 || !strings.Contains(result.Removed[0], "old") || len(result.Kept) != 2 {
		t.Fatalf("unexpected retention result: %+v", result)
	}
}

func validRequest(t *testing.T, requestID string, now time.Time) Request {
	t.Helper()
	return validRequestAtRoot(t, filepath.Join(t.TempDir(), "backups"), requestID, now)
}

func validRequestAtRoot(t *testing.T, root, requestID string, now time.Time) Request {
	t.Helper()
	sourceDirectory := filepath.Join(t.TempDir(), "configs")
	if err := os.MkdirAll(sourceDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDirectory, "settings.json"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	environmentFile := filepath.Join(t.TempDir(), ".env")
	if err := os.WriteFile(environmentFile, []byte("SECRET=redacted-in-logs\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return Request{
		RequestID:      requestID,
		CurrentVersion: "4.1.0",
		BackupRoot:     root,
		Sources: []Source{
			{Name: "configs", Path: sourceDirectory, Required: true},
			{Name: "environment", Path: environmentFile, Required: true},
		},
		Dumper: fakeDumper{data: "database dump\n"},
		Now:    now,
	}
}
