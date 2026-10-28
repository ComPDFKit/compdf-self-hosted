package release

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseManifestFixture(t *testing.T) {
	manifest := readManifestFixture(t, "release.valid.json")
	if manifest.Version != "4.2.0" || manifest.Images["server"].Tag != "4.2.0" {
		t.Fatalf("unexpected manifest: %+v", manifest)
	}
}

func TestParseManifestRejectsFloatingTag(t *testing.T) {
	_, err := ParseManifest(readFixture(t, "release.invalid-floating-tag.json"))
	if err == nil || !strings.Contains(err.Error(), "major.minor.patch") {
		t.Fatalf("ParseManifest() error = %v, want invalid version error", err)
	}
}

func TestManifestCompatibility(t *testing.T) {
	manifest := readManifestFixture(t, "release.valid.json")
	compatible := Compatibility{
		CurrentVersion: "4.1.0",
		UpdaterVersion: "0.1.0",
		Channel:        "stable",
		Now:            time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC),
	}
	if err := manifest.CheckCompatibility(compatible); err != nil {
		t.Fatalf("CheckCompatibility() error = %v", err)
	}

	compatible.Now = manifest.ExpiresAt
	if err := manifest.CheckCompatibility(compatible); !errors.Is(err, ErrManifestExpired) {
		t.Fatalf("expired error = %v", err)
	}
	compatible.Now = time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)
	compatible.UpdaterVersion = "0.0.9"
	if err := manifest.CheckCompatibility(compatible); !errors.Is(err, ErrUpdaterVersionTooOld) {
		t.Fatalf("old updater error = %v", err)
	}
}

func TestManifestCompatibilityRejectsPausedAndWithdrawnRelease(t *testing.T) {
	manifest := readManifestFixture(t, "release.valid.json")
	input := Compatibility{CurrentVersion: "4.1.0", UpdaterVersion: "0.1.0", Channel: "stable", Now: time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC)}
	manifest.Status = "paused"
	manifest.StatusReason = "investigating a conversion regression"
	if err := manifest.CheckCompatibility(input); !errors.Is(err, ErrReleasePaused) {
		t.Fatalf("paused error = %v", err)
	}
	manifest.Status = "withdrawn"
	if err := manifest.CheckCompatibility(input); !errors.Is(err, ErrReleaseWithdrawn) {
		t.Fatalf("withdrawn error = %v", err)
	}
}

func TestManifestAllowsApplicationOnlyReleaseToKeepDatabaseSchemaVersion(t *testing.T) {
	manifest := readManifestFixture(t, "release.valid.json")
	manifest.Version = "5.0.0"
	manifest.Images["app"] = Image{Name: "compdfkit/compdf-app", Tag: "5.0.0", Digest: "sha256:" + strings.Repeat("a", 64)}
	manifest.Images["server"] = Image{Name: "compdfkit/compdf-server", Tag: "5.0.0", Digest: "sha256:" + strings.Repeat("b", 64)}
	manifest.Migration = Migration{From: "4.1.1", To: "4.1.1", Required: false}
	if err := manifest.Validate(); err != nil {
		t.Fatalf("application-only release was rejected: %v", err)
	}
}

func TestSemanticVersionPrecedence(t *testing.T) {
	ordered := []string{
		"1.0.0-alpha",
		"1.0.0-alpha.1",
		"1.0.0-alpha.beta",
		"1.0.0-beta",
		"1.0.0-beta.2",
		"1.0.0-beta.11",
		"1.0.0-rc.1",
		"1.0.0",
	}
	for index := 0; index < len(ordered)-1; index++ {
		left, err := parseSemanticVersion(ordered[index])
		if err != nil {
			t.Fatal(err)
		}
		right, err := parseSemanticVersion(ordered[index+1])
		if err != nil {
			t.Fatal(err)
		}
		if compareSemanticVersions(left, right) >= 0 {
			t.Fatalf("%s should precede %s", ordered[index], ordered[index+1])
		}
	}
}

func TestSemanticVersionRejectsUnsafeBuildMetadata(t *testing.T) {
	for _, version := range []string{"4.2.0+", "4.2.0+../outside", "4.2.0+../../outside", "4.2.0+windows\\path", "4.2.0+one..two", "4.2.0+one+two"} {
		if _, err := CompareVersions(version, "4.1.0"); err == nil {
			t.Errorf("unsafe version %q was accepted", version)
		}
	}
	if comparison, err := CompareVersions("4.2.0+build.001", "4.2.0"); err != nil || comparison != 0 {
		t.Fatalf("valid build metadata changed precedence: %d, %v", comparison, err)
	}
}

func readManifestFixture(t *testing.T, name string) Manifest {
	t.Helper()
	manifest, err := ParseManifest(readFixture(t, name))
	if err != nil {
		t.Fatalf("ParseManifest(%s): %v", name, err)
	}
	return manifest
}

func readFixture(t *testing.T, name string) []byte {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test source")
	}
	path := filepath.Join(filepath.Dir(file), "..", "..", "..", "tests", "fixtures", "release", name)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return data
}
