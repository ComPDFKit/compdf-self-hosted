package daemon

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/cli"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/licenseupdate"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/scheduler"
)

const maxRequestBytes = 64 * 1024

var (
	requestIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$`)
	versionPattern     = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
	packageNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,180}\.tar\.zst$`)
)

type Runner func(args []string, stdout, stderr io.Writer) int

type Handler struct {
	configPath      string
	importDirectory string
	automation      updaterconfig.Automation
	automationState string
	run             Runner
}

type operationRequest struct {
	CurrentVersion       string `json:"currentVersion,omitempty"`
	TargetVersion        string `json:"targetVersion,omitempty"`
	RequestID            string `json:"requestId,omitempty"`
	PackageName          string `json:"packageName,omitempty"`
	Approve              bool   `json:"approve,omitempty"`
	MaintenanceConfirmed bool   `json:"maintenanceConfirmed,omitempty"`
	OfflineRiskConfirmed bool   `json:"offlineRiskConfirmed,omitempty"`
}

type response struct {
	ExitCode int             `json:"exitCode"`
	Result   json.RawMessage `json:"result,omitempty"`
	Error    string          `json:"error,omitempty"`
}

func NewHandler(configPath string, runner Runner) (http.Handler, error) {
	config, err := updaterconfig.Load(configPath)
	if err != nil {
		return nil, err
	}
	if runner == nil {
		runner = cli.Run
	}
	handler := &Handler{configPath: configPath, importDirectory: filepath.Join(config.StateDirectory, "inbox"), automation: config.Automation, automationState: filepath.Join(config.StateDirectory, "automation-status.json"), run: runner}
	mux := http.NewServeMux()
	licenses, err := licenseupdate.New(config)
	if err != nil {
		return nil, err
	}
	mux.HandleFunc("GET /v1/license", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, response{Result: mustJSON(licenses.Status())})
	})
	mux.HandleFunc("POST /v1/license", func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			RequestID            string `json:"requestId"`
			XML                  []byte `json:"xml"`
			Approve              bool   `json:"approve"`
			MaintenanceConfirmed bool   `json:"maintenanceConfirmed"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 96*1024))
		decoder.DisallowUnknownFields()
		var trailing any
		if decoder.Decode(&request) != nil || decoder.Decode(&trailing) != io.EOF || !request.Approve || !request.MaintenanceConfirmed {
			writeProtocolError(w, 400, "license update requires XML, approval and maintenance confirmation")
			return
		}
		status, err := licenses.Start(request.RequestID, request.XML)
		if err != nil {
			writeProtocolError(w, 409, err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, response{Result: mustJSON(status)})
	})
	mux.HandleFunc("POST /v1/license/recover", func(w http.ResponseWriter, r *http.Request) {
		request, ok := decodeRequest(w, r)
		if !ok {
			return
		}
		if !request.Approve || !request.MaintenanceConfirmed {
			writeProtocolError(w, 400, "recovery requires approval and maintenance confirmation")
			return
		}
		status, err := licenses.Recover(request.RequestID)
		if err != nil {
			writeProtocolError(w, 409, err.Error())
			return
		}
		writeJSON(w, http.StatusAccepted, response{Result: mustJSON(status)})
	})
	mux.HandleFunc("GET /healthz", handler.health)
	mux.HandleFunc("GET /v1/status", handler.status)
	mux.HandleFunc("GET /v1/history", handler.history)
	mux.HandleFunc("GET /v1/automation", handler.automationStatus)
	mux.HandleFunc("POST /v1/check", handler.check)
	mux.HandleFunc("POST /v1/download", handler.download)
	mux.HandleFunc("POST /v1/cancel", handler.cancel)
	mux.HandleFunc("POST /v1/import", handler.importOffline)
	mux.HandleFunc("POST /v1/preflight", handler.preflight)
	mux.HandleFunc("POST /v1/backup", handler.backup)
	mux.HandleFunc("POST /v1/apply", handler.apply)
	mux.HandleFunc("POST /v1/rollback", handler.rollback)
	return securityHeaders(mux), nil
}

func (handler *Handler) health(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]any{"status": "ok", "protocolVersion": 1})
}

func (handler *Handler) status(writer http.ResponseWriter, _ *http.Request) {
	handler.execute(writer, []string{"status", "--config", handler.configPath})
}

func (handler *Handler) history(writer http.ResponseWriter, _ *http.Request) {
	handler.execute(writer, []string{"history", "--config", handler.configPath})
}

func (handler *Handler) automationStatus(writer http.ResponseWriter, _ *http.Request) {
	status := scheduler.Status{SchemaVersion: 1}
	if data, err := os.ReadFile(handler.automationState); err == nil && len(data) <= maxRequestBytes {
		_ = json.Unmarshal(data, &status)
	}
	writeJSON(writer, http.StatusOK, response{ExitCode: 0, Result: mustJSON(map[string]any{"policy": handler.automation, "status": status})})
}

func mustJSON(value any) json.RawMessage {
	data, _ := json.Marshal(value)
	return data
}

func (handler *Handler) check(writer http.ResponseWriter, httpRequest *http.Request) {
	request, ok := decodeRequest(writer, httpRequest)
	if !ok {
		return
	}
	if !validVersion(request.CurrentVersion) {
		writeProtocolError(writer, http.StatusBadRequest, "currentVersion is required")
		return
	}
	handler.execute(writer, []string{"check", "--config", handler.configPath, "--current-version", request.CurrentVersion, "--json"})
}

func (handler *Handler) download(writer http.ResponseWriter, httpRequest *http.Request) {
	request, ok := decodeRequest(writer, httpRequest)
	if !ok {
		return
	}
	if !validJobRequest(request) {
		writeProtocolError(writer, http.StatusBadRequest, "currentVersion, targetVersion, and requestId are required")
		return
	}
	handler.execute(writer, []string{"download", "--config", handler.configPath, "--current-version", request.CurrentVersion, "--version", request.TargetVersion, "--request-id", request.RequestID})
}

func (handler *Handler) cancel(writer http.ResponseWriter, httpRequest *http.Request) {
	request, ok := decodeRequest(writer, httpRequest)
	if !ok {
		return
	}
	if !requestIDPattern.MatchString(request.RequestID) {
		writeProtocolError(writer, http.StatusBadRequest, "requestId is required")
		return
	}
	handler.execute(writer, []string{"cancel", "--config", handler.configPath, "--request-id", request.RequestID})
}

func (handler *Handler) importOffline(writer http.ResponseWriter, httpRequest *http.Request) {
	request, ok := decodeRequest(writer, httpRequest)
	if !ok {
		return
	}
	if !validVersion(request.CurrentVersion) || !requestIDPattern.MatchString(request.RequestID) || !packageNamePattern.MatchString(request.PackageName) {
		writeProtocolError(writer, http.StatusBadRequest, "currentVersion, safe packageName, and requestId are required")
		return
	}
	packagePath := filepath.Join(handler.importDirectory, request.PackageName)
	handler.execute(writer, []string{"import", "--config", handler.configPath, "--file", packagePath, "--current-version", request.CurrentVersion, "--request-id", request.RequestID})
}

func (handler *Handler) preflight(writer http.ResponseWriter, httpRequest *http.Request) {
	request, ok := decodeRequest(writer, httpRequest)
	if !ok {
		return
	}
	if !validJobRequest(request) {
		writeProtocolError(writer, http.StatusBadRequest, "currentVersion, targetVersion, and requestId are required")
		return
	}
	handler.execute(writer, []string{"preflight", "--config", handler.configPath, "--current-version", request.CurrentVersion, "--version", request.TargetVersion, "--request-id", request.RequestID})
}

func (handler *Handler) backup(writer http.ResponseWriter, httpRequest *http.Request) {
	request, ok := decodeRequest(writer, httpRequest)
	if !ok {
		return
	}
	if !validVersion(request.CurrentVersion) || !requestIDPattern.MatchString(request.RequestID) || !request.Approve || !request.MaintenanceConfirmed {
		writeProtocolError(writer, http.StatusBadRequest, "backup requires currentVersion, requestId, approve, and maintenanceConfirmed")
		return
	}
	handler.execute(writer, []string{"backup", "create", "--file", handler.configPath, "--request-id", request.RequestID, "--current-version", request.CurrentVersion, "--approve", "--maintenance-confirmed"})
}

func (handler *Handler) apply(writer http.ResponseWriter, httpRequest *http.Request) {
	request, ok := decodeRequest(writer, httpRequest)
	if !ok {
		return
	}
	if !validJobRequest(request) || !request.Approve || !request.MaintenanceConfirmed {
		writeProtocolError(writer, http.StatusBadRequest, "apply requires versions, requestId, approve, and maintenanceConfirmed")
		return
	}
	args := []string{"apply", "--config", handler.configPath, "--current-version", request.CurrentVersion, "--version", request.TargetVersion, "--request-id", request.RequestID, "--approve", "--maintenance-confirmed"}
	if request.OfflineRiskConfirmed {
		args = append(args, "--offline-risk-confirmed")
	}
	handler.execute(writer, args)
}

func (handler *Handler) rollback(writer http.ResponseWriter, httpRequest *http.Request) {
	request, ok := decodeRequest(writer, httpRequest)
	if !ok {
		return
	}
	if !requestIDPattern.MatchString(request.RequestID) || !request.Approve {
		writeProtocolError(writer, http.StatusBadRequest, "rollback requires requestId and approve")
		return
	}
	handler.execute(writer, []string{"rollback", "--config", handler.configPath, "--request-id", request.RequestID, "--approve"})
}

func (handler *Handler) execute(writer http.ResponseWriter, args []string) {
	var stdout, stderr bytes.Buffer
	exitCode := handler.run(args, &stdout, &stderr)
	result := bytes.TrimSpace(stdout.Bytes())
	protocol := response{ExitCode: exitCode}
	if len(result) > 0 && json.Valid(result) {
		protocol.Result = append(json.RawMessage(nil), result...)
	}
	if exitCode != 0 {
		protocol.Error = strings.TrimSpace(stderr.String())
		if protocol.Error == "" {
			protocol.Error = "updater operation did not complete"
		}
	}
	status := http.StatusOK
	if exitCode == 2 {
		status = http.StatusBadRequest
	} else if exitCode != 0 {
		status = http.StatusConflict
	}
	writeJSON(writer, status, protocol)
}

func decodeRequest(writer http.ResponseWriter, httpRequest *http.Request) (operationRequest, bool) {
	defer httpRequest.Body.Close()
	decoder := json.NewDecoder(io.LimitReader(httpRequest.Body, maxRequestBytes+1))
	decoder.DisallowUnknownFields()
	var value operationRequest
	if err := decoder.Decode(&value); err != nil {
		writeProtocolError(writer, http.StatusBadRequest, "request body is invalid")
		return value, false
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeProtocolError(writer, http.StatusBadRequest, "request body contains trailing data")
		return value, false
	}
	return value, true
}

func validJobRequest(request operationRequest) bool {
	return validVersion(request.CurrentVersion) && validVersion(request.TargetVersion) && requestIDPattern.MatchString(request.RequestID)
}

func validVersion(version string) bool {
	return versionPattern.MatchString(version)
}

func writeProtocolError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, response{ExitCode: 2, Error: message})
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("Cache-Control", "no-store")
		writer.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(writer, request)
	})
}
