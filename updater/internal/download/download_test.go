package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

func TestDownloadResumesAndVerifies(t *testing.T) {
	content := []byte(strings.Repeat("verified-release-data", 1024))
	digest := sha256.Sum256(content)
	var receivedRange string
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		receivedRange = request.Header.Get("Range")
		offset := 0
		if strings.HasPrefix(receivedRange, "bytes=") {
			offset, _ = strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(receivedRange, "bytes="), "-"))
			response.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", offset, len(content)-1, len(content)))
			response.WriteHeader(http.StatusPartialContent)
		}
		response.Write(content[offset:])
	}))
	defer server.Close()

	root := t.TempDir()
	partial := filepath.Join(root, "images", "server.tar.part")
	if err := os.MkdirAll(filepath.Dir(partial), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(partial, content[:200], 0o600); err != nil {
		t.Fatal(err)
	}
	downloader, err := New(server.Client(), server.URL, root)
	if err != nil {
		t.Fatal(err)
	}
	artifact := release.Artifact{Path: "images/server.tar", SHA256: hex.EncodeToString(digest[:]), Size: int64(len(content))}
	destination, err := downloader.Download(context.Background(), artifact, nil)
	if err != nil {
		t.Fatal(err)
	}
	if receivedRange != "bytes=200-" {
		t.Fatalf("Range = %q", receivedRange)
	}
	got, _ := os.ReadFile(destination)
	if string(got) != string(content) {
		t.Fatal("downloaded content differs")
	}
	if _, err := os.Stat(partial); !os.IsNotExist(err) {
		t.Fatalf("partial file still exists: %v", err)
	}
}

func TestDownloadRejectsChecksumMismatch(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Write([]byte("wrong"))
	}))
	defer server.Close()
	downloader, _ := New(server.Client(), server.URL, t.TempDir())
	artifact := release.Artifact{Path: "artifact.bin", SHA256: strings.Repeat("a", 64), Size: 5}
	if _, err := downloader.Download(context.Background(), artifact, nil); err == nil {
		t.Fatal("checksum mismatch was accepted")
	}
}

func TestDestinationRejectsTraversal(t *testing.T) {
	downloader, _ := New(nil, "https://updates.example.com/", t.TempDir())
	if _, err := downloader.destination("../outside"); err == nil {
		t.Fatal("path traversal was accepted")
	}
}

func TestDownloadStopsWhenProgressCallbackCancels(t *testing.T) {
	content := []byte(strings.Repeat("cancel-me", 32*1024))
	digest := sha256.Sum256(content)
	server := httptest.NewTLSServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Write(content)
	}))
	defer server.Close()
	downloader, _ := New(server.Client(), server.URL, t.TempDir())
	artifact := release.Artifact{Path: "artifact.bin", SHA256: hex.EncodeToString(digest[:]), Size: int64(len(content))}
	callbacks := 0
	_, err := downloader.Download(context.Background(), artifact, func(downloaded, total int64) error {
		callbacks++
		if downloaded >= total/4 {
			return context.Canceled
		}
		return nil
	})
	if !errors.Is(err, context.Canceled) || callbacks == 0 {
		t.Fatalf("download cancellation error = %v, callbacks = %d", err, callbacks)
	}
}

func TestRateDelayUsesConfiguredAverageBandwidth(t *testing.T) {
	delay := rateDelay(512*1024, 1024*1024, 125*time.Millisecond)
	if delay != 375*time.Millisecond {
		t.Fatalf("rate delay = %s, want 375ms", delay)
	}
	if delay := rateDelay(512*1024, 0, 0); delay != 0 {
		t.Fatalf("unlimited download delay = %s", delay)
	}
}
