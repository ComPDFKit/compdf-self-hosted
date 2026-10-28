package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
)

const maxPasswordFileBytes = 4096

// Password is passed over stdin to the container, never in Docker's command
// arguments, process environment, stdout, or error text on the host.
const dumpScript = "IFS= read -r MYSQL_PWD || exit 1; export MYSQL_PWD; exec mysqldump --single-transaction --quick --routines --events --hex-blob --no-tablespaces --default-character-set=utf8mb4 -u compdfkit --databases compdfkit"

type DumpCommand interface {
	Run(ctx context.Context, name string, args []string, stdin io.Reader, stdout io.Writer) error
}

type OSCommand struct{}

func (OSCommand) Run(ctx context.Context, name string, args []string, stdin io.Reader, stdout io.Writer) error {
	command := exec.CommandContext(ctx, name, args...)
	command.Stdin = stdin
	command.Stdout = stdout
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		return errors.New("Docker database export failed; inspect local Docker diagnostics without sharing credentials")
	}
	return nil
}

type DockerDumper struct {
	config  updaterconfig.Config
	command DumpCommand
}

type DockerVolumeDumper struct {
	config  updaterconfig.Config
	command DumpCommand
}

func NewDockerDumper(config updaterconfig.Config, command DumpCommand) *DockerDumper {
	if command == nil {
		command = OSCommand{}
	}
	return &DockerDumper{config: config, command: command}
}

func NewDockerVolumeDumper(config updaterconfig.Config, command DumpCommand) *DockerVolumeDumper {
	if command == nil {
		command = OSCommand{}
	}
	return &DockerVolumeDumper{config: config, command: command}
}

func (dumper *DockerDumper) Dump(ctx context.Context, destination io.Writer) error {
	password, err := readPassword(dumper.config.DatabasePasswordFile)
	if err != nil {
		return err
	}
	args := []string{
		"compose", "--project-name", dumper.config.ComposeProject,
		"--file", dumper.config.ComposeFile,
		"exec", "-T", "compdf-infra", "sh", "-c", dumpScript,
	}
	if err := dumper.command.Run(ctx, "docker", args, strings.NewReader(password+"\n"), destination); err != nil {
		return fmt.Errorf("export compdfkit database: %w", err)
	}
	return nil
}

func (dumper *DockerVolumeDumper) Dump(ctx context.Context, source VolumeSource, destination io.Writer) error {
	args := []string{
		"compose", "--project-name", dumper.config.ComposeProject,
		"--file", dumper.config.ComposeFile,
		"exec", "-T", source.Service,
		"tar", "--numeric-owner", "-C", source.ContainerPath, "-cf", "-", ".",
	}
	if err := dumper.command.Run(ctx, "docker", args, nil, destination); err != nil {
		return fmt.Errorf("export %s: %w", source.Name, err)
	}
	return nil
}

func readPassword(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", fmt.Errorf("database password file is unavailable: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > maxPasswordFileBytes {
		return "", errors.New("database password file must be a nonempty regular file under 4 KiB")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("database password file must not be accessible by group or others")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read database password file: %w", err)
	}
	password := strings.TrimSuffix(string(data), "\n")
	if password == "" || strings.ContainsAny(password, "\x00\r\n") {
		return "", errors.New("database password file contains an invalid value")
	}
	return password, nil
}

func ValidateDatabasePasswordFile(path string) error {
	_, err := readPassword(path)
	return err
}
