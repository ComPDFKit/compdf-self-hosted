package deploy

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

func TestImageLoaderLoadsOnlyDeclaredApplicationArchives(t *testing.T) {
	command := &fakeCommand{}
	manifest := imageManifest()
	manifest.OfflineImages = map[string]release.Artifact{
		"app":    {Path: "images/app.tar", SHA256: strings.Repeat("c", 64), Size: 1},
		"server": {Path: "images/server.tar", SHA256: strings.Repeat("d", 64), Size: 1},
	}
	root := filepath.Join(t.TempDir(), "release")
	if err := NewImageLoader(command).Load(context.Background(), manifest, root); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.calls, "\n")
	for _, path := range []string{filepath.Join(root, "images", "app.tar"), filepath.Join(root, "images", "server.tar")} {
		if !strings.Contains(joined, "docker image load --input "+path) {
			t.Fatalf("image archive was not loaded: %s", joined)
		}
	}
	if strings.Contains(joined, "compdf-infra") {
		t.Fatalf("offline loader touched infrastructure image: %s", joined)
	}
}
