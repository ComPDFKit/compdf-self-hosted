package deploy

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

type deployCommand struct {
	calls []string
}

func (command *deployCommand) Run(_ context.Context, name string, args ...string) ([]byte, error) {
	command.calls = append(command.calls, strings.Join(append([]string{name}, args...), " "))
	if containsArgument(args, "ps") {
		return []byte(`{"State":"running","Health":"healthy"}`), nil
	}
	return nil, nil
}

func TestPrepareEnvironmentPreservesCustomerValuesAndPinsImages(t *testing.T) {
	root := t.TempDir()
	environment := []byte("COMPDF_LICENSE_KEY=customer-secret\nCOMPDF_INFRA_IMAGE=infra:1.0.0\nCOMPDF_VERSION=4.1.0\n")
	if err := os.WriteFile(filepath.Join(root, ".env"), environment, 0o600); err != nil {
		t.Fatal(err)
	}
	config := updaterconfig.Config{WorkingDirectory: root, ComposeProject: "compdf", ComposeFile: filepath.Join(root, "docker-compose.yml")}
	command := &deployCommand{}
	path, err := NewExecutor(command).PrepareEnvironment(config, deployManifest(), "request-1")
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	for _, expected := range []string{
		"COMPDF_LICENSE_KEY=customer-secret", "COMPDF_INFRA_IMAGE=infra:1.0.0", "COMPDF_VERSION=4.2.0",
		"COMPDF_APP_IMAGE=compdfkit/compdf-app:4.2.0@sha256:", "COMPDF_SERVER_IMAGE=compdfkit/compdf-server:4.2.0@sha256:",
	} {
		if !strings.Contains(text, expected) {
			t.Fatalf("target environment missing %q: %s", expected, text)
		}
	}
}

func TestActivateUsesFixedServiceOrderAndWaitsForHealth(t *testing.T) {
	command := &deployCommand{}
	executor := NewExecutor(command)
	config := updaterconfig.Config{WorkingDirectory: "/opt/compdf", ComposeProject: "compdf", ComposeFile: "/opt/compdf/docker-compose.yml"}
	if err := executor.Activate(context.Background(), config, "/opt/compdf/.env.next"); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.calls, "\n")
	app := strings.Index(joined, "up -d --no-deps compdf-app")
	server := strings.Index(joined, "up -d --no-deps compdf-server")
	if app < 0 || server < 0 || app >= server {
		t.Fatalf("services were not activated in order: %s", joined)
	}
	if strings.Contains(joined, "down") || strings.Contains(joined, "compdf-infra up") {
		t.Fatalf("unsafe deployment command: %s", joined)
	}
}

func TestMigrateUsesTargetServerAndReadOnlyReleaseDirectory(t *testing.T) {
	command := &deployCommand{}
	executor := NewExecutor(command)
	manifest := deployManifest()
	manifest.Migration.Required = true
	manifest.Migration.Artifact = &release.Artifact{Path: "migrations/4.1.0-to-4.2.0.sql", SHA256: strings.Repeat("a", 64), Size: 1}
	config := updaterconfig.Config{WorkingDirectory: "/opt/compdf", ComposeProject: "compdf", ComposeFile: "/opt/compdf/docker-compose.yml"}
	if err := executor.Migrate(context.Background(), config, manifest, "/var/lib/compdf/releases/4.2.0", "/opt/compdf/.env.next"); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.calls, "\n")
	if !strings.Contains(joined, "run --rm --no-deps --volume ") ||
		!strings.Contains(joined, ":/app/release/migrations:ro compdf-server npm run migrate:db") {
		t.Fatalf("unexpected migration command: %s", joined)
	}
}

func deployManifest() release.Manifest {
	return release.Manifest{
		Version: "4.2.0", Migration: release.Migration{From: "4.1.0", To: "4.2.0"},
		Images: map[string]release.Image{
			"app":    {Name: "compdfkit/compdf-app", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("a", 64)},
			"server": {Name: "compdfkit/compdf-server", Tag: "4.2.0", Digest: "sha256:" + strings.Repeat("b", 64)},
		},
	}
}

func containsArgument(args []string, value string) bool {
	for _, item := range args {
		if item == value {
			return true
		}
	}
	return false
}
