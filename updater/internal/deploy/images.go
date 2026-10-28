package deploy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

type Command interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
}

type OSCommand struct{}

func (OSCommand) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	command := exec.CommandContext(ctx, name, args...)
	output, err := command.Output()
	if err != nil {
		return nil, errors.New("Docker image command failed; inspect local Docker diagnostics")
	}
	return output, nil
}

type ImagePuller struct {
	command Command
}

func NewImagePuller(command Command) *ImagePuller {
	if command == nil {
		command = OSCommand{}
	}
	return &ImagePuller{command: command}
}

func (puller *ImagePuller) Pull(ctx context.Context, manifest release.Manifest) error {
	for _, component := range []string{"app", "server"} {
		image, ok := manifest.Images[component]
		if !ok {
			return fmt.Errorf("manifest is missing %s image", component)
		}
		reference := image.Name + ":" + image.Tag + "@" + image.Digest
		if matched, err := puller.digestMatches(ctx, image, reference); err == nil && matched {
			continue
		}
		if _, err := puller.command.Run(ctx, "docker", "image", "pull", reference); err != nil {
			return fmt.Errorf("pull %s image: %w", component, err)
		}
		matched, err := puller.digestMatches(ctx, image, reference)
		if err != nil {
			return fmt.Errorf("inspect %s image: %w", component, err)
		}
		if !matched {
			return fmt.Errorf("pulled %s image does not expose expected digest %s", component, image.Digest)
		}
	}
	return nil
}

func (puller *ImagePuller) digestMatches(ctx context.Context, image release.Image, reference string) (bool, error) {
	output, err := puller.command.Run(ctx, "docker", "image", "inspect", reference, "--format", "{{json .RepoDigests}}")
	if err != nil {
		return false, err
	}
	var digests []string
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(output))), &digests); err != nil {
		return false, errors.New("Docker image inspect returned invalid digests")
	}
	expected := image.Name + "@" + image.Digest
	for _, digest := range digests {
		if digest == expected {
			return true, nil
		}
	}
	return false, nil
}
