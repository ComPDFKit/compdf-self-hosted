package preflight

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"time"
)

const maxHTTPResponseBytes = 1024 * 1024

type OSProbe struct {
	HTTPClient *http.Client
}

func (probe OSProbe) Run(ctx context.Context, name string, args ...string) ([]byte, error) {
	output, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w", name, err)
	}
	return output, nil
}

func (probe OSProbe) FreeBytes(path string) (uint64, error) {
	return diskFreeBytes(path)
}

func (probe OSProbe) Get(ctx context.Context, url string) (int, []byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, nil, err
	}
	client := probe.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxHTTPResponseBytes+1))
	if err != nil {
		return 0, nil, err
	}
	if len(body) > maxHTTPResponseBytes {
		return 0, nil, fmt.Errorf("response exceeds %d bytes", maxHTTPResponseBytes)
	}
	return response.StatusCode, body, nil
}
