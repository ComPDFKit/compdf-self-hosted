package verification

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
)

const maxSmokeResponseBytes = 20 * 1024 * 1024

const updaterSmokeTokenFile = ".updater-smoke-token"

type Report struct {
	HealthPassed bool  `json:"healthPassed"`
	SmokePassed  bool  `json:"smokePassed"`
	OutputBytes  int64 `json:"outputBytes"`
}

type Verifier struct {
	client *http.Client
}

type healthStatus struct {
	Infra struct {
		MySQL string `json:"mysql"`
		Redis string `json:"redis"`
	} `json:"infra"`
	App string `json:"app"`
	Web string `json:"web"`
}

func New(client *http.Client) *Verifier {
	if client == nil {
		client = &http.Client{Timeout: 2 * time.Minute}
	}
	return &Verifier{client: client}
}

func (verifier *Verifier) Verify(ctx context.Context, config updaterconfig.Config) (Report, error) {
	if err := verifier.health(ctx, config.ServerBaseURL); err != nil {
		return Report{}, err
	}
	outputBytes, err := verifier.smoke(ctx, config)
	if err != nil {
		return Report{HealthPassed: true}, err
	}
	return Report{HealthPassed: true, SmokePassed: true, OutputBytes: outputBytes}, nil
}

func (verifier *Verifier) health(ctx context.Context, baseURL string) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/api/v1/status", nil)
	if err != nil {
		return err
	}
	response, err := verifier.client.Do(request)
	if err != nil {
		return errors.New("server health endpoint is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("server health endpoint returned HTTP %d", response.StatusCode)
	}
	var body struct {
		healthStatus
		Data *healthStatus `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 1024*1024))
	if err := decoder.Decode(&body); err != nil {
		return errors.New("server health response is invalid")
	}
	status := body.healthStatus
	if body.Data != nil {
		status = *body.Data
	}
	if status.Infra.MySQL != "ok" || status.Infra.Redis != "ok" || status.App != "ok" || status.Web != "ok" {
		return errors.New("server health response reports an unhealthy dependency")
	}
	return nil
}

func (verifier *Verifier) smoke(ctx context.Context, config updaterconfig.Config) (int64, error) {
	apiKey, err := readAPIKey(filepath.Join(config.WorkingDirectory, "data", "server-storage", ".api-key-plaintext"))
	if err != nil {
		return 0, err
	}
	smokeToken, cleanup, err := createSmokeToken(filepath.Join(config.WorkingDirectory, "data", "server-storage"))
	if err != nil {
		return 0, err
	}
	defer cleanup()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	file, err := writer.CreateFormFile("file", "updater-smoke.pdf")
	if err != nil {
		return 0, err
	}
	if _, err := file.Write(minimalPDF()); err != nil {
		return 0, err
	}
	if err := writer.WriteField("request", `{}`); err != nil {
		return 0, err
	}
	if err := writer.Close(); err != nil {
		return 0, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(config.ServerBaseURL, "/")+"/api/v1/process/pdf/compress", &body)
	if err != nil {
		return 0, err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("x-api-key", apiKey)
	request.Header.Set("x-compdf-updater-verification", smokeToken)
	response, err := verifier.client.Do(request)
	if err != nil {
		return 0, errors.New("PDF smoke conversion request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("PDF smoke conversion returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxSmokeResponseBytes+1))
	if err != nil {
		return 0, errors.New("read PDF smoke conversion result failed")
	}
	if len(data) > maxSmokeResponseBytes || !bytes.HasPrefix(data, []byte("%PDF-")) {
		return 0, errors.New("PDF smoke conversion returned an invalid PDF")
	}
	return int64(len(data)), nil
}

func createSmokeToken(storageDirectory string) (string, func(), error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", func() {}, errors.New("create PDF smoke verification capability failed")
	}
	token := hex.EncodeToString(value)
	destination := filepath.Join(storageDirectory, updaterSmokeTokenFile)
	if info, err := os.Lstat(destination); err == nil {
		if !info.Mode().IsRegular() {
			return "", func() {}, errors.New("PDF smoke verification capability path is unsafe")
		}
		if err := os.Remove(destination); err != nil {
			return "", func() {}, errors.New("remove stale PDF smoke verification capability failed")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", func() {}, errors.New("inspect PDF smoke verification capability failed")
	}
	temporary, err := os.CreateTemp(storageDirectory, ".updater-smoke-token-*.tmp")
	if err != nil {
		return "", func() {}, errors.New("create PDF smoke verification capability failed")
	}
	temporaryPath := temporary.Name()
	cleanup := func() {
		_ = os.Remove(temporaryPath)
		_ = os.Remove(destination)
	}
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		cleanup()
		return "", func() {}, errors.New("protect PDF smoke verification capability failed")
	}
	if _, err := temporary.WriteString(token + "\n"); err != nil {
		temporary.Close()
		cleanup()
		return "", func() {}, errors.New("write PDF smoke verification capability failed")
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		cleanup()
		return "", func() {}, errors.New("persist PDF smoke verification capability failed")
	}
	if err := temporary.Close(); err != nil {
		cleanup()
		return "", func() {}, errors.New("close PDF smoke verification capability failed")
	}
	if err := os.Rename(temporaryPath, destination); err != nil {
		cleanup()
		return "", func() {}, errors.New("publish PDF smoke verification capability failed")
	}
	return token, cleanup, nil
}

func readAPIKey(path string) (string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", errors.New("persisted API key for smoke verification is unavailable")
	}
	if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 4096 {
		return "", errors.New("persisted API key file is invalid")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("persisted API key file permissions are too broad")
	}
	value, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("persisted API key could not be read")
	}
	key := strings.TrimSpace(string(value))
	if key == "" || strings.ContainsAny(key, "\x00\r\n") {
		return "", errors.New("persisted API key file contains an invalid value")
	}
	return key, nil
}

func minimalPDF() []byte {
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents 4 0 R >>",
		"<< /Length 0 >>\nstream\n\nendstream",
	}
	var output bytes.Buffer
	output.WriteString("%PDF-1.4\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = output.Len()
		fmt.Fprintf(&output, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xref := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n0000000000 65535 f \n", len(objects)+1)
	for index := 1; index <= len(objects); index++ {
		fmt.Fprintf(&output, "%010d 00000 n \n", offsets[index])
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objects)+1, xref)
	return output.Bytes()
}
