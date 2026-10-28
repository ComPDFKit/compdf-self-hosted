package release

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	ManifestFilename  = "release.json"
	SignatureFilename = "release.json.sig"
)

// VerifyBundle verifies declared artifacts and rejects undeclared files. The
// release directory must already contain the exact signed manifest bytes and
// detached signature that were obtained from the trusted release endpoint.
func VerifyBundle(root string, manifest Manifest, manifestBytes, signatureBytes []byte) error {
	if !filepath.IsAbs(root) {
		return errors.New("release directory must be absolute")
	}
	if len(manifestBytes) == 0 || len(signatureBytes) == 0 {
		return errors.New("release manifest and signature bytes are required")
	}
	artifacts, err := manifest.Artifacts()
	if err != nil {
		return err
	}
	expected := map[string]Artifact{}
	for _, artifact := range artifacts {
		expected[filepath.Clean(filepath.FromSlash(artifact.Path))] = artifact
	}
	metadata := map[string][]byte{
		ManifestFilename:  manifestBytes,
		SignatureFilename: signatureBytes,
	}

	seen := make(map[string]struct{}, len(expected)+len(metadata))
	err = filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("release contains non-regular entry %q", entry.Name())
		}
		relative, err := filepath.Rel(root, path)
		if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return errors.New("release entry escapes release directory")
		}
		if expectedBytes, ok := metadata[relative]; ok {
			actual, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if string(actual) != string(expectedBytes) {
				return fmt.Errorf("release metadata %q does not match verified bytes", relative)
			}
			seen[relative] = struct{}{}
			return nil
		}
		artifact, ok := expected[relative]
		if !ok {
			return fmt.Errorf("release contains undeclared file %q", filepath.ToSlash(relative))
		}
		if err := verifyArtifactFile(path, artifact); err != nil {
			return err
		}
		seen[relative] = struct{}{}
		return nil
	})
	if err != nil {
		return err
	}
	for relative := range metadata {
		if _, ok := seen[relative]; !ok {
			return fmt.Errorf("release metadata %q is missing", relative)
		}
	}
	for relative := range expected {
		if _, ok := seen[relative]; !ok {
			return fmt.Errorf("declared release artifact %q is missing", filepath.ToSlash(relative))
		}
	}
	return nil
}

func verifyArtifactFile(path string, artifact Artifact) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if info.Size() != artifact.Size {
		return fmt.Errorf("artifact %q size does not match manifest", artifact.Path)
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != artifact.SHA256 {
		return fmt.Errorf("artifact %q checksum does not match manifest", artifact.Path)
	}
	return nil
}
