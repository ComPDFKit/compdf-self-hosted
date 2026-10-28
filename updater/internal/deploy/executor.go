package deploy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

type Executor struct {
	command      Command
	pollInterval time.Duration
}

func NewExecutor(command Command) *Executor {
	if command == nil {
		command = OSCommand{}
	}
	return &Executor{command: command, pollInterval: 2 * time.Second}
}

func (executor *Executor) PrepareEnvironment(config updaterconfig.Config, manifest release.Manifest, requestID string) (string, error) {
	if requestID == "" {
		return "", errors.New("request ID is required")
	}
	environmentPath := filepath.Join(config.WorkingDirectory, ".env")
	existing, err := os.ReadFile(environmentPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read installation environment: %w", err)
	}
	values := map[string]string{
		"COMPDF_VERSION":           manifest.Version,
		"COMPDF_DB_SCHEMA_VERSION": manifest.Migration.To,
		"COMPDF_APP_IMAGE":         immutableReference(manifest.Images["app"]),
		"COMPDF_SERVER_IMAGE":      immutableReference(manifest.Images["server"]),
	}
	rendered, err := renderEnvironment(existing, values)
	if err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(config.WorkingDirectory, ".env.update-*.tmp")
	if err != nil {
		return "", fmt.Errorf("create target environment: %w", err)
	}
	path := temporary.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(path)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return "", err
	}
	if _, err := temporary.Write(rendered); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return "", err
	}
	if err := temporary.Close(); err != nil {
		return "", err
	}
	if _, err := executor.command.Run(context.Background(), "docker", executor.composeArgs(config, path, "config", "--quiet")...); err != nil {
		return "", errors.New("target Compose environment failed validation")
	}
	cleanup = false
	return path, nil
}

func (executor *Executor) Migrate(ctx context.Context, config updaterconfig.Config, manifest release.Manifest, releaseDirectory, environmentPath string) error {
	if !manifest.Migration.Required {
		return nil
	}
	if manifest.Migration.Artifact == nil {
		return errors.New("required migration artifact is missing")
	}
	migrationPath := filepath.Join(releaseDirectory, filepath.FromSlash(manifest.Migration.Artifact.Path))
	migrationDirectory := filepath.Dir(migrationPath)
	volume := migrationDirectory + ":/app/release/migrations:ro"
	args := executor.composeArgs(config, environmentPath,
		"run", "--rm", "--no-deps", "--volume", volume,
		"compdf-server", "npm", "run", "migrate:db",
	)
	if _, err := executor.command.Run(ctx, "docker", args...); err != nil {
		return errors.New("target database migration failed; target services were not started")
	}
	return nil
}

func (executor *Executor) Activate(ctx context.Context, config updaterconfig.Config, environmentPath string) error {
	for _, service := range []string{"compdf-app", "compdf-server"} {
		args := executor.composeArgs(config, environmentPath, "up", "-d", "--no-deps", service)
		if _, err := executor.command.Run(ctx, "docker", args...); err != nil {
			return fmt.Errorf("activate %s: Docker Compose command failed", service)
		}
		if err := executor.waitHealthy(ctx, config, environmentPath, service); err != nil {
			return err
		}
	}
	return nil
}

func (executor *Executor) CommitEnvironment(config updaterconfig.Config, temporaryPath string) error {
	destination := filepath.Join(config.WorkingDirectory, ".env")
	if runtime.GOOS != "windows" {
		if err := os.Rename(temporaryPath, destination); err != nil {
			return fmt.Errorf("commit target environment: %w", err)
		}
		return nil
	}
	previous := destination + ".previous"
	_ = os.Remove(previous)
	if err := os.Rename(destination, previous); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("preserve previous environment: %w", err)
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		_ = os.Rename(previous, destination)
		return fmt.Errorf("commit target environment: %w", err)
	}
	_ = os.Remove(previous)
	return nil
}

func (executor *Executor) waitHealthy(ctx context.Context, config updaterconfig.Config, environmentPath, service string) error {
	for {
		output, err := executor.command.Run(ctx, "docker", executor.composeArgs(config, environmentPath, "ps", "--format", "json", service)...)
		if err == nil {
			state, health, decodeErr := decodeServiceState(output)
			if decodeErr == nil && strings.EqualFold(state, "running") && strings.EqualFold(health, "healthy") {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("%s did not become healthy before timeout", service)
		case <-time.After(executor.pollInterval):
		}
	}
}

func (executor *Executor) composeArgs(config updaterconfig.Config, environmentPath string, action ...string) []string {
	args := []string{
		"compose", "--project-directory", config.WorkingDirectory,
		"--env-file", environmentPath,
		"--project-name", config.ComposeProject,
		"--file", config.ComposeFile,
	}
	return append(args, action...)
}

func renderEnvironment(existing []byte, replacements map[string]string) ([]byte, error) {
	lines := strings.Split(strings.ReplaceAll(string(existing), "\r\n", "\n"), "\n")
	seen := make(map[string]bool, len(replacements))
	for index, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		key, _, found := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		value, managed := replacements[key]
		if !found || !managed {
			continue
		}
		if seen[key] {
			return nil, fmt.Errorf("installation environment contains duplicate managed key %s", key)
		}
		seen[key] = true
		lines[index] = key + "=" + value
	}
	for _, key := range []string{"COMPDF_VERSION", "COMPDF_DB_SCHEMA_VERSION", "COMPDF_APP_IMAGE", "COMPDF_SERVER_IMAGE"} {
		if !seen[key] {
			lines = append(lines, key+"="+replacements[key])
		}
	}
	return []byte(strings.TrimRight(strings.Join(lines, "\n"), "\n") + "\n"), nil
}

func immutableReference(image release.Image) string {
	return image.Name + ":" + image.Tag + "@" + image.Digest
}

func decodeServiceState(data []byte) (string, string, error) {
	data = bytes.TrimSpace(data)
	if len(data) == 0 {
		return "", "", errors.New("empty Compose status")
	}
	type container struct {
		State  string `json:"State"`
		Health string `json:"Health"`
	}
	if data[0] == '[' {
		var containers []container
		if err := json.Unmarshal(data, &containers); err != nil || len(containers) != 1 {
			return "", "", errors.New("invalid Compose status")
		}
		return containers[0].State, containers[0].Health, nil
	}
	var item container
	if err := json.Unmarshal(data, &item); err != nil {
		return "", "", err
	}
	return item.State, item.Health, nil
}
