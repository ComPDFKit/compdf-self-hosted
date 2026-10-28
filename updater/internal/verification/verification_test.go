package verification

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
)

func TestVerifyRequiresHealthAndRealPDFSmokeResult(t *testing.T) {
	root := t.TempDir()
	storage := filepath.Join(root, "data", "server-storage")
	if err := os.MkdirAll(storage, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storage, ".api-key-plaintext"), []byte("smoke-key"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/status":
			response.Header().Set("Content-Type", "application/json")
			io.WriteString(response, `{"code":200,"msg":"success","data":{"infra":{"mysql":"ok","redis":"ok"},"app":"ok","web":"ok"}}`)
		case "/api/v1/process/pdf/compress":
			if len(request.Header.Get("x-compdf-updater-verification")) != 64 {
				http.Error(response, "missing updater verification capability", http.StatusServiceUnavailable)
				return
			}
			if request.Header.Get("x-api-key") != "smoke-key" {
				http.Error(response, "unauthorized", http.StatusUnauthorized)
				return
			}
			if err := request.ParseMultipartForm(1024 * 1024); err != nil || request.MultipartForm.File["file"][0].Filename != "updater-smoke.pdf" {
				http.Error(response, "bad request", http.StatusBadRequest)
				return
			}
			response.Header().Set("Content-Type", "application/pdf")
			response.Write(minimalPDF())
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	report, err := New(server.Client()).Verify(context.Background(), updaterconfig.Config{WorkingDirectory: root, ServerBaseURL: server.URL})
	if err != nil {
		t.Fatal(err)
	}
	if !report.HealthPassed || !report.SmokePassed || report.OutputBytes == 0 {
		t.Fatalf("unexpected report: %+v", report)
	}
}

func TestCreateSmokeTokenRefusesNonRegularDestination(t *testing.T) {
	storage := t.TempDir()
	if err := os.Mkdir(filepath.Join(storage, updaterSmokeTokenFile), 0o700); err != nil {
		t.Fatal(err)
	}
	_, _, err := createSmokeToken(storage)
	if err == nil || !strings.Contains(err.Error(), "unsafe") {
		t.Fatalf("unsafe capability destination accepted: %v", err)
	}
}

func TestVerifyRejectsHealthyHTTPWithUnhealthyDependency(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		io.WriteString(response, `{"code":200,"msg":"success","data":{"infra":{"mysql":"down","redis":"ok"},"app":"ok","web":"ok"}}`)
	}))
	defer server.Close()
	_, err := New(server.Client()).Verify(context.Background(), updaterconfig.Config{WorkingDirectory: t.TempDir(), ServerBaseURL: server.URL})
	if err == nil || !strings.Contains(err.Error(), "unhealthy") {
		t.Fatalf("unhealthy dependency accepted: %v", err)
	}
}

func TestHealthSupportsLegacyUnwrappedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		io.WriteString(response, `{"infra":{"mysql":"ok","redis":"ok"},"app":"ok","web":"ok"}`)
	}))
	defer server.Close()
	if err := New(server.Client()).health(context.Background(), server.URL); err != nil {
		t.Fatalf("legacy unwrapped health response rejected: %v", err)
	}
}

func TestMinimalPDFHasValidCrossReferenceEnvelope(t *testing.T) {
	data := minimalPDF()
	if !strings.HasPrefix(string(data), "%PDF-1.4") || !strings.HasSuffix(string(data), "%%EOF\n") || !strings.Contains(string(data), "xref\n") {
		t.Fatalf("minimal PDF is malformed: %q", data)
	}
}
