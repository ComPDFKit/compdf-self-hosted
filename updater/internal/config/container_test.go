package config

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestComposeServerURLIsRestrictedToFixedService(t *testing.T) {
	for _, address := range []string{"http://compdf-server:8080", "http://compdf-server:9090", "https://compdf-server:8080", "http://compdf-server:8080/path", "http://other-service:8080"} {
		cfg := validConfig(t.TempDir())
		cfg.ServerBaseURL = address
		err := cfg.Validate()
		if (err == nil) != (address == "http://compdf-server:8080") {
			t.Fatalf("unexpected validation for %s: %v", address, err)
		}
	}
}

type tokenRoundTripper func(*http.Request) (*http.Response, error)

func (run tokenRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return run(request)
}

func TestReleaseTokenNeverReachesOtherOrigins(t *testing.T) {
	origin, _ := url.Parse("https://updates.example.com/compdf/")
	for _, address := range []string{
		"https://updates.example.com/compdf/stable/release.json",
		"http://updates.example.com/compdf/",
		"https://updates.example.com:444/compdf/",
		"https://cdn.updates.example.com/compdf/",
		"http://compdf-server:8080/api/v1/status",
	} {
		request, _ := http.NewRequest(http.MethodGet, address, nil)
		// Simulate a redirect which retained the previous Authorization header.
		request.Header.Set("Authorization", "Bearer previous-secret")
		transport := releaseTokenTransport{origin: origin, token: "test-token", base: tokenRoundTripper(func(outgoing *http.Request) (*http.Response, error) {
			expected := ""
			if address == "https://updates.example.com/compdf/stable/release.json" {
				expected = "Bearer test-token"
			}
			if got := outgoing.Header.Get("Authorization"); got != expected {
				t.Fatalf("unexpected Authorization for %s", address)
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("ok"))}, nil
		})}
		response, err := transport.RoundTrip(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if request.Header.Get("Authorization") != "Bearer previous-secret" {
			t.Fatal("transport mutated its caller's request")
		}
	}
}

func TestReleaseTokenFileValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "token")
	for _, value := range []string{"", "line1\nline2", "line1\rline2", "line1\x00line2", strings.Repeat("x", 16385)} {
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := readReleaseToken(path); err == nil {
			t.Fatal("accepted invalid token contents")
		}
	}
	if err := os.WriteFile(path, []byte("test-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if token, err := readReleaseToken(path); err != nil || token != "test-token" {
		t.Fatalf("valid token rejected: %v", err)
	}
	cfg := validConfig(t.TempDir())
	cfg.ReleaseBearerTokenFile = path
	if _, err := cfg.HTTPClient(time.Second); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := cfg.HTTPClient(time.Second); err == nil {
			t.Fatal("accepted a world-readable token file")
		}
	}
}
