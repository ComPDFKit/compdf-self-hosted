package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

type ImageLoader struct {
	command Command
}

func NewImageLoader(command Command) *ImageLoader {
	if command == nil {
		command = OSCommand{}
	}
	return &ImageLoader{command: command}
}

func (loader *ImageLoader) Load(ctx context.Context, manifest release.Manifest, releaseDirectory string) error {
	if len(manifest.OfflineImages) != 2 {
		return errors.New("offline image archives are not declared")
	}
	for _, component := range []string{"app", "server"} {
		artifact := manifest.OfflineImages[component]
		archivePath := filepath.Join(releaseDirectory, filepath.FromSlash(artifact.Path))
		if _, err := loader.command.Run(ctx, "docker", "image", "load", "--input", archivePath); err != nil {
			return fmt.Errorf("load %s image archive: %w", component, err)
		}
		image := manifest.Images[component]
		reference := image.Name + ":" + image.Tag + "@" + image.Digest
		output, err := loader.command.Run(ctx, "docker", "image", "inspect", reference, "--format", "{{json .RepoDigests}}")
		if err != nil {
			return fmt.Errorf("inspect imported %s image: %w", component, err)
		}
		var digests []string
		if err := json.Unmarshal([]byte(strings.TrimSpace(string(output))), &digests); err != nil {
			return fmt.Errorf("inspect imported %s image returned invalid digests", component)
		}
		expected := image.Name + "@" + image.Digest
		matched := false
		for _, digest := range digests {
			matched = matched || digest == expected
		}
		if !matched {
			return fmt.Errorf("imported %s image digest does not match manifest", component)
		}
	}
	return nil
}
