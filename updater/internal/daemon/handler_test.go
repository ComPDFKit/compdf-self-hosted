package daemon

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
)

type recordingRunner struct {
	args []string
	code int
}

func (runner *recordingRunner) Run(args []string, stdout, stderr io.Writer) int {
	runner.args = append([]string(nil), args...)
	if runner.code == 0 {
		io.WriteString(stdout, `{"ok":true}`)
	} else {
		io.WriteString(stderr, "blocked")
	}
	return runner.code
}

func TestHandlerMapsStructuredDownloadWithoutAcceptingPathsOrCommands(t *testing.T) {
	runner := &recordingRunner{}
	configPath, _ := daemonConfig(t)
	handler, err := NewHandler(configPath, runner.Run)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/download", strings.NewReader(`{"currentVersion":"4.1.0","targetVersion":"4.2.0","requestId":"job-1"}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	joined := strings.Join(runner.args, " ")
	if !strings.Contains(joined, "download --config "+configPath) || !strings.Contains(joined, "--request-id job-1") {
		t.Fatalf("unexpected updater args: %s", joined)
	}

	request = httptest.NewRequest(http.MethodPost, "/v1/download", strings.NewReader(`{"currentVersion":"4.1.0","targetVersion":"4.2.0","requestId":"job-2","command":"docker rm"}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown command field was accepted: %d", response.Code)
	}
}

func TestHandlerMapsCancellationByRequestIDOnly(t *testing.T) {
	runner := &recordingRunner{}
	configPath, _ := daemonConfig(t)
	handler, err := NewHandler(configPath, runner.Run)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/cancel", strings.NewReader(`{"requestId":"job-1"}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || strings.Join(runner.args, " ") != "cancel --config "+configPath+" --request-id job-1" {
		t.Fatalf("unexpected cancellation mapping: %d %+v", response.Code, runner.args)
	}

	request = httptest.NewRequest(http.MethodPost, "/v1/cancel", strings.NewReader(`{"requestId":"../escape"}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("unsafe cancellation request ID was accepted: %d", response.Code)
	}
}

func TestHealthDoesNotInvokeUpdaterCommands(t *testing.T) {
	runner := &recordingRunner{}
	configPath, _ := daemonConfig(t)
	handler, _ := NewHandler(configPath, runner.Run)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusOK || len(runner.args) != 0 || !strings.Contains(response.Body.String(), `"protocolVersion":1`) {
		t.Fatalf("unexpected health response: %d %s", response.Code, response.Body.String())
	}
}

func TestAutomationStatusContainsOnlyPolicyAndRuntimeStatus(t *testing.T) {
	runner := &recordingRunner{}
	configPath, _ := daemonConfig(t)
	handler, _ := NewHandler(configPath, runner.Run)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/v1/automation", nil))
	if response.Code != http.StatusOK || len(runner.args) != 0 || !strings.Contains(response.Body.String(), `"schemaVersion":1`) {
		t.Fatalf("unexpected automation response: %d %s", response.Code, response.Body.String())
	}
}

func TestHandlerConstrainsOfflineImportToInboxFilename(t *testing.T) {
	runner := &recordingRunner{}
	configPath, stateDirectory := daemonConfig(t)
	handler, err := NewHandler(configPath, runner.Run)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/import", bytes.NewBufferString(`{"currentVersion":"4.1.0","requestId":"job-3","packageName":"release.tar.zst"}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	want := filepath.Join(stateDirectory, "inbox", "release.tar.zst")
	if !strings.Contains(strings.Join(runner.args, " "), "--file "+want) {
		t.Fatalf("import path was not constrained: %+v", runner.args)
	}

	request = httptest.NewRequest(http.MethodPost, "/v1/import", bytes.NewBufferString(`{"currentVersion":"4.1.0","requestId":"job-4","packageName":"../escape.tar.zst"}`))
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("traversal package name accepted: %d", response.Code)
	}
}

func TestHandlerForwardsOnlyExplicitOfflineRiskConfirmation(t *testing.T) {
	runner := &recordingRunner{}
	configPath, _ := daemonConfig(t)
	handler, err := NewHandler(configPath, runner.Run)
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/apply", strings.NewReader(`{"currentVersion":"4.1.0","targetVersion":"4.2.0","requestId":"job-offline","approve":true,"maintenanceConfirmed":true,"offlineRiskConfirmed":true}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(strings.Join(runner.args, " "), "--offline-risk-confirmed") {
		t.Fatalf("offline confirmation was not forwarded: %d %+v", response.Code, runner.args)
	}
}

func daemonConfig(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	working := filepath.Join(root, "install")
	stateDirectory := filepath.Join(root, "state")
	config := updaterconfig.Config{
		SchemaVersion: 1, ComposeProject: "compdf", WorkingDirectory: working,
		ComposeFile: filepath.Join(working, "docker-compose.yml"), StateDirectory: stateDirectory,
		BackupDirectory: filepath.Join(stateDirectory, "backups"), DatabasePasswordFile: filepath.Join(root, "mysql-password"),
		ReleaseBaseURL: "https://updates.example.com/", ServerBaseURL: "http://127.0.0.1:8080", MinimumFreeBytes: 1024 * 1024 * 1024,
		Channel: "stable", AllowedServices: []string{"compdf-app", "compdf-server"},
		TrustedKeys: map[string]string{"test": base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))},
	}
	data, _ := json.Marshal(config)
	path := filepath.Join(root, "config.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path, stateDirectory
}
