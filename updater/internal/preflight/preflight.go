package preflight

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/backup"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

type Level string

const (
	LevelPass  Level = "pass"
	LevelWarn  Level = "warn"
	LevelBlock Level = "block"
)

type Check struct {
	ID      string            `json:"id"`
	Level   Level             `json:"level"`
	Message string            `json:"message"`
	Details map[string]string `json:"details,omitempty"`
}

type Report struct {
	GeneratedAt    time.Time `json:"generatedAt"`
	CurrentVersion string    `json:"currentVersion"`
	TargetVersion  string    `json:"targetVersion"`
	Overall        Level     `json:"overall"`
	Checks         []Check   `json:"checks"`
}

func (report Report) Blocked() bool {
	for _, check := range report.Checks {
		if check.Level == LevelBlock {
			return true
		}
	}
	return false
}

type Input struct {
	Config         updaterconfig.Config
	Manifest       release.Manifest
	CurrentVersion string
	UpdaterVersion string
	Now            time.Time
}

type Probe interface {
	Run(ctx context.Context, name string, args ...string) ([]byte, error)
	FreeBytes(path string) (uint64, error)
	Get(ctx context.Context, url string) (statusCode int, body []byte, err error)
}

type Checker struct {
	probe        Probe
	architecture string
}

func NewChecker(probe Probe) *Checker {
	return &Checker{probe: probe, architecture: runtime.GOARCH}
}

func (checker *Checker) Check(ctx context.Context, input Input) Report {
	now := input.Now.UTC()
	if input.Now.IsZero() {
		now = time.Now().UTC()
	}
	report := Report{GeneratedAt: now, CurrentVersion: input.CurrentVersion, TargetVersion: input.Manifest.Version}
	report.Checks = append(report.Checks,
		checker.checkArchitecture(),
		checker.checkVersion(input),
	)
	report.Checks = append(report.Checks, checker.checkPaths(input.Config)...)
	report.Checks = append(report.Checks,
		checker.checkDatabaseCredentials(input.Config),
		checker.checkDisk(input.Config),
		checker.checkDocker(ctx),
		checker.checkCompose(ctx),
		checker.checkContainers(ctx, input.Config),
		checker.checkImages(ctx, input.Manifest),
		checker.checkLicense(ctx, input.Config),
		checker.checkMigration(input),
		checker.checkBackupTool(ctx, input.Config),
	)
	report.Overall = LevelPass
	for _, check := range report.Checks {
		if check.Level == LevelBlock {
			report.Overall = LevelBlock
			break
		}
		if check.Level == LevelWarn {
			report.Overall = LevelWarn
		}
	}
	return report
}

func (checker *Checker) checkDatabaseCredentials(config updaterconfig.Config) Check {
	if err := backup.ValidateDatabasePasswordFile(config.DatabasePasswordFile); err != nil {
		return block("database-credentials", "protected database password file is unavailable or invalid")
	}
	return pass("database-credentials", "protected database password file is available")
}

func (checker *Checker) checkArchitecture() Check {
	if checker.architecture == "amd64" || checker.architecture == "arm64" {
		return pass("architecture", "host architecture is supported", "architecture", checker.architecture)
	}
	return block("architecture", "host architecture is unsupported", "architecture", checker.architecture)
}

func (checker *Checker) checkVersion(input Input) Check {
	if err := input.Manifest.CheckCompatibility(release.Compatibility{
		CurrentVersion: input.CurrentVersion,
		UpdaterVersion: input.UpdaterVersion,
		Channel:        input.Config.Channel,
		Now:            input.Now,
	}); err != nil {
		return block("version", "release is incompatible with this installation", "reason", err.Error())
	}
	comparison, err := release.CompareVersions(input.CurrentVersion, input.Manifest.Version)
	if err != nil {
		return block("version", "version comparison failed", "reason", err.Error())
	}
	if comparison >= 0 {
		return block("version", "target version must be newer than the current version", "current", input.CurrentVersion, "target", input.Manifest.Version)
	}
	return pass("version", "release version and channel are compatible", "current", input.CurrentVersion, "target", input.Manifest.Version)
}

func (checker *Checker) checkPaths(config updaterconfig.Config) []Check {
	checks := []Check{
		checkExistingDirectory("working-directory", config.WorkingDirectory),
		checkExistingFile("compose-file", config.ComposeFile),
		checkWritableDirectory("state-directory", config.StateDirectory),
		checkWritableDirectory("backup-directory", config.BackupDirectory),
	}
	return checks
}

func (checker *Checker) checkDisk(config updaterconfig.Config) Check {
	free, err := checker.probe.FreeBytes(config.BackupDirectory)
	if err != nil {
		return block("disk-space", "available disk space could not be determined", "reason", err.Error())
	}
	details := map[string]string{
		"availableBytes": fmt.Sprintf("%d", free),
		"requiredBytes":  fmt.Sprintf("%d", config.MinimumFreeBytes),
	}
	if free < config.MinimumFreeBytes {
		return Check{ID: "disk-space", Level: LevelBlock, Message: "available disk space is below the configured minimum", Details: details}
	}
	return Check{ID: "disk-space", Level: LevelPass, Message: "available disk space meets the configured minimum", Details: details}
}

func (checker *Checker) checkDocker(ctx context.Context) Check {
	output, err := checker.probe.Run(ctx, "docker", "version", "--format", "{{.Server.Version}}")
	if err != nil {
		return block("docker", "Docker Engine is unavailable", "reason", err.Error())
	}
	version := strings.TrimSpace(string(output))
	if version == "" {
		return block("docker", "Docker Engine returned no server version")
	}
	return pass("docker", "Docker Engine is available", "version", version)
}

func (checker *Checker) checkCompose(ctx context.Context) Check {
	output, err := checker.probe.Run(ctx, "docker", "compose", "version", "--short")
	if err != nil {
		return block("docker-compose", "Docker Compose v2 is unavailable", "reason", err.Error())
	}
	version := strings.TrimSpace(string(output))
	majorText, _, found := strings.Cut(strings.TrimPrefix(version, "v"), ".")
	major, parseErr := strconv.Atoi(majorText)
	if !found || parseErr != nil || major < 2 {
		return block("docker-compose", "Docker Compose major version 2 or newer is required", "version", version)
	}
	return pass("docker-compose", "Docker Compose v2 or newer is available", "version", version)
}

type composeContainer struct {
	Service string `json:"Service"`
	State   string `json:"State"`
	Health  string `json:"Health"`
}

func (checker *Checker) checkContainers(ctx context.Context, config updaterconfig.Config) Check {
	output, err := checker.probe.Run(ctx, "docker", "compose", "--project-name", config.ComposeProject, "--file", config.ComposeFile, "ps", "--format", "json")
	if err != nil {
		return block("container-health", "container health could not be read", "reason", err.Error())
	}
	containers, err := decodeContainers(output)
	if err != nil {
		return block("container-health", "container health output is invalid", "reason", err.Error())
	}
	byService := make(map[string]composeContainer, len(containers))
	for _, container := range containers {
		byService[container.Service] = container
	}
	var unhealthy []string
	for _, service := range []string{"compdf-infra", "compdf-app", "compdf-server"} {
		container, ok := byService[service]
		if !ok || !strings.EqualFold(container.State, "running") || !strings.EqualFold(container.Health, "healthy") {
			unhealthy = append(unhealthy, service)
		}
	}
	if len(unhealthy) > 0 {
		return block("container-health", "required containers are missing or unhealthy", "services", strings.Join(unhealthy, ","))
	}
	return pass("container-health", "all required containers are running and healthy")
}

func (checker *Checker) checkImages(ctx context.Context, manifest release.Manifest) Check {
	var unavailable []string
	for _, name := range []string{"app", "server"} {
		image := manifest.Images[name]
		reference := image.Name + "@" + image.Digest
		if _, err := checker.probe.Run(ctx, "docker", "image", "inspect", reference, "--format", "{{.Id}}"); err != nil {
			unavailable = append(unavailable, name)
		}
	}
	if len(unavailable) > 0 {
		return block("target-images", "target images are unavailable by immutable digest", "images", strings.Join(unavailable, ","))
	}
	return pass("target-images", "target application images are available by immutable digest")
}

func decodeContainers(data []byte) ([]composeContainer, error) {
	data = []byte(strings.TrimSpace(string(data)))
	if len(data) == 0 {
		return nil, fmt.Errorf("empty output")
	}
	if data[0] == '[' {
		var containers []composeContainer
		if err := json.Unmarshal(data, &containers); err != nil {
			return nil, err
		}
		return containers, nil
	}
	var containers []composeContainer
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	for {
		var container composeContainer
		if err := decoder.Decode(&container); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return nil, err
		}
		containers = append(containers, container)
	}
	return containers, nil
}

func (checker *Checker) checkLicense(ctx context.Context, config updaterconfig.Config) Check {
	endpoint := strings.TrimRight(config.ServerBaseURL, "/") + "/api/v1/license"
	statusCode, body, err := checker.probe.Get(ctx, endpoint)
	if err != nil {
		return block("license", "local license status endpoint is unavailable", "reason", err.Error())
	}
	if statusCode != 200 {
		return block("license", "local license status endpoint returned an error", "httpStatus", fmt.Sprintf("%d", statusCode))
	}
	var envelope struct {
		Data struct {
			Status  string `json:"status"`
			Present bool   `json:"present"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return block("license", "local license status response is invalid", "reason", err.Error())
	}
	switch envelope.Data.Status {
	case "valid":
		if envelope.Data.Present {
			return pass("license", "license display status is valid; signature remains subject to business smoke verification")
		}
	case "expiring":
		if envelope.Data.Present {
			return warn("license", "license is near expiry; signature remains subject to business smoke verification")
		}
	}
	return block("license", "license is missing, inactive, or expired", "status", envelope.Data.Status)
}

func (checker *Checker) checkMigration(input Input) Check {
	if !input.Manifest.Migration.Required {
		return pass("migration", "release does not require a database migration")
	}
	artifact := input.Manifest.Migration.Artifact
	if artifact == nil {
		return block("migration", "required migration artifact is not declared")
	}
	path := filepath.Join(input.Config.StateDirectory, "releases", input.Manifest.Version, filepath.FromSlash(artifact.Path))
	data, err := os.ReadFile(path)
	if err != nil {
		return block("migration", "required migration artifact is unavailable", "path", artifact.Path, "reason", err.Error())
	}
	sum := sha256.Sum256(data)
	if int64(len(data)) != artifact.Size || hex.EncodeToString(sum[:]) != artifact.SHA256 {
		return block("migration", "required migration artifact failed size or checksum verification", "path", artifact.Path)
	}
	return pass("migration", "required migration artifact is present and verified", "path", artifact.Path)
}

func (checker *Checker) checkBackupTool(ctx context.Context, config updaterconfig.Config) Check {
	output, err := checker.probe.Run(ctx, "docker", "compose", "--project-name", config.ComposeProject, "--file", config.ComposeFile, "exec", "-T", "compdf-infra", "mysqldump", "--version")
	if err != nil {
		return block("backup-tool", "mysqldump is unavailable in compdf-infra", "reason", err.Error())
	}
	version := strings.TrimSpace(string(output))
	for _, service := range []string{"compdf-infra", "compdf-app"} {
		if _, err := checker.probe.Run(ctx, "docker", "compose", "--project-name", config.ComposeProject, "--file", config.ComposeFile, "exec", "-T", service, "tar", "--version"); err != nil {
			return block("backup-tool", "tar is unavailable for application data volume backup", "service", service, "reason", err.Error())
		}
	}
	return pass("backup-tool", "database and application volume backup tools are available", "mysqldumpVersion", version)
}

func checkExistingDirectory(id, path string) Check {
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return block(id, "required directory is unavailable", "path", path)
	}
	return pass(id, "required directory is available", "path", path)
}

func checkExistingFile(id, path string) Check {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return block(id, "required file is unavailable", "path", path)
	}
	return pass(id, "required file is available", "path", path)
}

func checkWritableDirectory(id, path string) Check {
	if err := os.MkdirAll(path, 0o700); err != nil {
		return block(id, "directory could not be created", "path", path, "reason", err.Error())
	}
	file, err := os.CreateTemp(path, ".write-check-*")
	if err != nil {
		return block(id, "directory is not writable", "path", path, "reason", err.Error())
	}
	name := file.Name()
	closeErr := file.Close()
	removeErr := os.Remove(name)
	if closeErr != nil || removeErr != nil {
		return block(id, "directory write check cleanup failed", "path", path)
	}
	return pass(id, "directory is writable", "path", path)
}

func pass(id, message string, details ...string) Check {
	return result(id, LevelPass, message, details...)
}

func warn(id, message string, details ...string) Check {
	return result(id, LevelWarn, message, details...)
}

func block(id, message string, details ...string) Check {
	return result(id, LevelBlock, message, details...)
}

func result(id string, level Level, message string, details ...string) Check {
	check := Check{ID: id, Level: level, Message: message}
	if len(details) > 0 {
		check.Details = make(map[string]string, len(details)/2)
		for index := 0; index+1 < len(details); index += 2 {
			check.Details[details[index]] = details[index+1]
		}
	}
	return check
}

func SortedBlockingIDs(report Report) []string {
	var ids []string
	for _, check := range report.Checks {
		if check.Level == LevelBlock {
			ids = append(ids, check.ID)
		}
	}
	sort.Strings(ids)
	return ids
}
