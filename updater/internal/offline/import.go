package offline

import (
	"archive/tar"
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/klauspost/compress/zstd"
)

const (
	maxEntries           = 10000
	maxExpandedBytes     = int64(250 * 1024 * 1024 * 1024)
	maxManifestFileBytes = int64(2 * 1024 * 1024)
)

type Result struct {
	Manifest       release.Manifest
	ManifestBytes  []byte
	SignatureBytes []byte
	Directory      string
}

func Import(ctx context.Context, packagePath, stateDirectory string, trustedKeys map[string]ed25519.PublicKey) (Result, error) {
	if !filepath.IsAbs(packagePath) || !filepath.IsAbs(stateDirectory) {
		return Result{}, errors.New("offline package and state directory paths must be absolute")
	}
	info, err := os.Lstat(packagePath)
	if err != nil || !info.Mode().IsRegular() {
		return Result{}, errors.New("offline package must be a regular file")
	}
	releasesRoot := filepath.Join(stateDirectory, "releases")
	if err := os.MkdirAll(releasesRoot, 0o700); err != nil {
		return Result{}, err
	}
	temporary, err := os.MkdirTemp(releasesRoot, ".offline-import-*")
	if err != nil {
		return Result{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(temporary)
		}
	}()
	if err := extract(ctx, packagePath, temporary); err != nil {
		return Result{}, err
	}
	manifestBytes, err := readBounded(filepath.Join(temporary, release.ManifestFilename), maxManifestFileBytes)
	if err != nil {
		return Result{}, err
	}
	signatureBytes, err := readBounded(filepath.Join(temporary, release.SignatureFilename), maxManifestFileBytes)
	if err != nil {
		return Result{}, err
	}
	signature, err := release.ParseSignature(signatureBytes)
	if err != nil {
		return Result{}, err
	}
	if err := release.VerifySignature(manifestBytes, signature, trustedKeys); err != nil {
		return Result{}, err
	}
	manifest, err := release.ParseManifest(manifestBytes)
	if err != nil {
		return Result{}, err
	}
	if len(manifest.OfflineImages) != 2 {
		return Result{}, errors.New("offline package manifest does not declare both image archives")
	}
	if err := release.VerifyBundle(temporary, manifest, manifestBytes, signatureBytes); err != nil {
		return Result{}, err
	}
	finalDirectory := filepath.Join(releasesRoot, manifest.Version)
	if _, err := os.Stat(finalDirectory); err == nil {
		existingManifest, readErr := os.ReadFile(filepath.Join(finalDirectory, release.ManifestFilename))
		if readErr != nil || string(existingManifest) != string(manifestBytes) {
			return Result{}, errors.New("a different release with this version already exists")
		}
		if err := release.VerifyBundle(finalDirectory, manifest, manifestBytes, signatureBytes); err != nil {
			return Result{}, fmt.Errorf("existing release is incomplete: %w", err)
		}
		return Result{Manifest: manifest, ManifestBytes: manifestBytes, SignatureBytes: signatureBytes, Directory: finalDirectory}, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return Result{}, err
	}
	if err := os.Rename(temporary, finalDirectory); err != nil {
		return Result{}, fmt.Errorf("commit offline release: %w", err)
	}
	committed = true
	return Result{Manifest: manifest, ManifestBytes: manifestBytes, SignatureBytes: signatureBytes, Directory: finalDirectory}, nil
}

func extract(ctx context.Context, packagePath, destination string) error {
	file, err := os.Open(packagePath)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder, err := zstd.NewReader(file, zstd.WithDecoderMaxMemory(256*1024*1024))
	if err != nil {
		return fmt.Errorf("open zstd package: %w", err)
	}
	defer decoder.Close()
	reader := tar.NewReader(decoder)
	seen := map[string]struct{}{}
	var total int64
	for count := 0; ; count++ {
		if count >= maxEntries {
			return errors.New("offline package contains too many entries")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("read offline package: %w", err)
		}
		name, err := safeArchivePath(header.Name)
		if err != nil {
			return err
		}
		if _, exists := seen[name]; exists {
			return fmt.Errorf("offline package contains duplicate entry %q", header.Name)
		}
		seen[name] = struct{}{}
		total += header.Size
		if header.Size < 0 || total > maxExpandedBytes {
			return errors.New("offline package exceeds expanded size limit")
		}
		target := filepath.Join(destination, name)
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
			if err != nil {
				return err
			}
			written, copyErr := io.CopyN(output, reader, header.Size)
			closeErr := output.Close()
			if copyErr != nil || closeErr != nil || written != header.Size {
				return fmt.Errorf("extract offline entry %q failed", header.Name)
			}
		default:
			return fmt.Errorf("offline package entry %q has unsupported type", header.Name)
		}
	}
	return nil
}

func safeArchivePath(name string) (string, error) {
	if name == "" || strings.ContainsRune(name, '\x00') || strings.Contains(name, "\\") {
		return "", errors.New("offline package contains an unsafe path")
	}
	clean := filepath.Clean(filepath.FromSlash(name))
	if clean == "." || filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("offline package path %q escapes the release directory", name)
	}
	return clean, nil
}

func readBounded(path string, maximum int64) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, maximum+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maximum {
		return nil, errors.New("offline package metadata exceeds size limit")
	}
	return data, nil
}
