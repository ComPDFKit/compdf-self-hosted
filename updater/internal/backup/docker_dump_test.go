package backup

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
)

type recordingCommand struct {
	args   []string
	stdin  string
	result error
}

func (command *recordingCommand) Run(_ context.Context, name string, args []string, stdin io.Reader, stdout io.Writer) error {
	if name != "docker" {
		return errors.New("wrong command")
	}
	command.args = append([]string(nil), args...)
	if stdin != nil {
		input, err := io.ReadAll(stdin)
		if err != nil {
			return err
		}
		command.stdin = string(input)
	}
	if command.result != nil {
		return command.result
	}
	_, err := io.WriteString(stdout, "-- database snapshot --\n")
	return err
}

func TestDockerVolumeDumperUsesControlledServiceAndPath(t *testing.T) {
	root := t.TempDir()
	config := updaterconfig.Config{ComposeProject: "compdf-self-hosted", ComposeFile: filepath.Join(root, "docker-compose.yml")}
	command := &recordingCommand{}
	var output bytes.Buffer
	source := VolumeSource{Name: "pdf-data", Service: "compdf-app", ContainerPath: "/data"}
	if err := NewDockerVolumeDumper(config, command).Dump(context.Background(), source, &output); err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(command.args, " ")
	if !strings.Contains(joined, "exec -T compdf-app tar --numeric-owner -C /data -cf - .") {
		t.Fatalf("unexpected volume dump invocation: %s", joined)
	}
	if command.stdin != "" || output.String() != "-- database snapshot --\n" {
		t.Fatal("volume dumper unexpectedly used stdin or lost output")
	}
}

func TestDockerDumperKeepsPasswordOutOfArguments(t *testing.T) {
	root := t.TempDir()
	passwordPath := filepath.Join(root, "mysql-password")
	if err := os.WriteFile(passwordPath, []byte("secret-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	config := updaterconfig.Config{ComposeProject: "compdf-self-hosted", ComposeFile: filepath.Join(root, "docker-compose.yml"), DatabasePasswordFile: passwordPath}
	command := &recordingCommand{}
	var output bytes.Buffer
	if err := NewDockerDumper(config, command).Dump(context.Background(), &output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(command.args, " "), "secret-value") {
		t.Fatal("password was included in command arguments")
	}
	if command.stdin != "secret-value\n" {
		t.Fatal("unexpected password input")
	}
	invocation := strings.Join(command.args, " ")
	if !strings.Contains(invocation, "--single-transaction") || !strings.Contains(invocation, "--no-tablespaces") || output.String() != "-- database snapshot --\n" {
		t.Fatal("unexpected dump invocation")
	}
}

func TestDockerDumperRejectsSymlinkAndWeakPermissions(t *testing.T) {
	root := t.TempDir()
	passwordPath := filepath.Join(root, "mysql-password")
	if err := os.WriteFile(passwordPath, []byte("secret-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "password-link")
	if err := os.Symlink(passwordPath, link); err == nil {
		if _, err := readPassword(link); err == nil {
			t.Fatal("password symlink was accepted")
		}
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(passwordPath, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := readPassword(passwordPath); err == nil {
			t.Fatal("world-readable password was accepted")
		}
	}
}

func TestDockerDumperRejectsNewlineInPassword(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mysql-password")
	if err := os.WriteFile(path, []byte("secret\nother\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPassword(path); err == nil {
		t.Fatal("multi-line password was accepted")
	}
}
