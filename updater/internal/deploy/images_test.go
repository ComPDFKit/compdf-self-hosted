package deploy

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

type fakeCommand struct {
	calls []string
	fail  string
	local bool
}

func (command *fakeCommand) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	call := strings.Join(append([]string{name}, args...), " ")
	command.calls = append(command.calls, call)
	if strings.Contains(call, command.fail) && command.fail != "" {
		return nil, fmt.Errorf("failed")
	}
	if strings.Contains(call, "inspect") {
		reference := args[2]
		if !command.local && !containsImageAvailability(command.calls, reference) {
			return nil, fmt.Errorf("not found")
		}
		at := strings.LastIndex(reference, "@")
		colon := strings.LastIndex(reference[:at], ":")
		return []byte(fmt.Sprintf("[%q]", reference[:colon]+reference[at:])), nil
	}
	return []byte("pulled"), nil
}

func containsImageAvailability(calls []string, reference string) bool {
	for _, call := range calls {
		if call == "docker image pull "+reference || strings.HasPrefix(call, "docker image load ") {
			return true
		}
	}
	return false
}

func TestImagePullerUsesImmutableReferencesAndVerifiesDigests(t *testing.T) {
	command := &fakeCommand{}
	manifest := imageManifest()
	if err := NewImagePuller(command).Pull(context.Background(), manifest); err != nil {
		t.Fatal(err)
	}
	if len(command.calls) != 6 {
		t.Fatalf("unexpected calls: %+v", command.calls)
	}
	for _, component := range []string{"app", "server"} {
		image := manifest.Images[component]
		reference := image.Name + ":" + image.Tag + "@" + image.Digest
		if !strings.Contains(strings.Join(command.calls, "\n"), "docker image pull "+reference) {
			t.Fatalf("immutable pull missing for %s", component)
		}
	}
}

func TestImagePullerReusesLocallyVerifiedImmutableImages(t *testing.T) {
	command := &fakeCommand{local: true}
	if err := NewImagePuller(command).Pull(context.Background(), imageManifest()); err != nil {
		t.Fatal(err)
	}
	if len(command.calls) != 2 {
		t.Fatalf("expected one local digest inspection per image, got %+v", command.calls)
	}
	if strings.Contains(strings.Join(command.calls, "\n"), " image pull ") {
		t.Fatalf("locally verified images should not be pulled: %+v", command.calls)
	}
}

func imageManifest() release.Manifest {
	return release.Manifest{Images: map[string]release.Image{
		"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
		"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
	}}
}
