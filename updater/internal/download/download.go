package download

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

type Progress func(downloaded, total int64) error

type Downloader struct {
	client  *http.Client
	baseURL *url.URL
	root    string
	limit   int64
}

func (downloader *Downloader) SetBandwidthLimit(bytesPerSecond int64) {
	downloader.limit = bytesPerSecond
}

func New(client *http.Client, baseURL, root string) (*Downloader, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("download base URL must be HTTPS without credentials, query, or fragment")
	}
	if !filepath.IsAbs(root) {
		return nil, errors.New("download root must be absolute")
	}
	if client == nil {
		client = http.DefaultClient
	}
	return &Downloader{client: client, baseURL: parsed, root: filepath.Clean(root)}, nil
}

func (downloader *Downloader) Download(ctx context.Context, artifact release.Artifact, progress Progress) (string, error) {
	destination, err := downloader.destination(artifact.Path)
	if err != nil {
		return "", err
	}
	if valid, err := validFile(destination, artifact); err != nil {
		return "", err
	} else if valid {
		if progress != nil {
			if err := progress(artifact.Size, artifact.Size); err != nil {
				return "", err
			}
		}
		return destination, nil
	}
	if err := os.MkdirAll(filepath.Dir(destination), 0o700); err != nil {
		return "", fmt.Errorf("create artifact directory: %w", err)
	}

	partial := destination + ".part"
	offset, err := partialSize(partial, artifact.Size)
	if err != nil {
		return "", err
	}
	response, err := downloader.request(ctx, artifact.Path, offset)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	appendMode := offset > 0 && response.StatusCode == http.StatusPartialContent
	if appendMode && !validContentRange(response.Header.Get("Content-Range"), offset, artifact.Size) {
		return "", errors.New("download server returned an invalid Content-Range")
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent {
		return "", fmt.Errorf("download server returned HTTP %d", response.StatusCode)
	}
	if !appendMode {
		offset = 0
	}

	flags := os.O_CREATE | os.O_WRONLY
	if appendMode {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(partial, flags, 0o600)
	if err != nil {
		return "", fmt.Errorf("open partial artifact: %w", err)
	}
	remaining := artifact.Size - offset
	written, copyErr := copyWithProgress(ctx, file, io.LimitReader(response.Body, remaining+1), offset, artifact.Size, downloader.limit, progress)
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil {
		return "", fmt.Errorf("download artifact: %w", copyErr)
	}
	if syncErr != nil {
		return "", fmt.Errorf("sync partial artifact: %w", syncErr)
	}
	if closeErr != nil {
		return "", fmt.Errorf("close partial artifact: %w", closeErr)
	}
	if offset+written != artifact.Size {
		return "", fmt.Errorf("downloaded size %d does not match expected size %d", offset+written, artifact.Size)
	}
	valid, err := validFile(partial, artifact)
	if err != nil {
		return "", err
	}
	if !valid {
		_ = os.Remove(partial)
		return "", errors.New("downloaded artifact checksum does not match manifest")
	}
	if err := os.Rename(partial, destination); err != nil {
		return "", fmt.Errorf("commit downloaded artifact: %w", err)
	}
	return destination, nil
}

func (downloader *Downloader) request(ctx context.Context, artifactPath string, offset int64) (*http.Response, error) {
	target := *downloader.baseURL
	target.Path = path.Join(downloader.baseURL.Path, artifactPath)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	if offset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	response, err := downloader.client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("request artifact: %w", err)
	}
	if response.Request.URL.Scheme != "https" || response.Request.URL.Host != downloader.baseURL.Host {
		response.Body.Close()
		return nil, errors.New("artifact request left its configured HTTPS origin")
	}
	return response, nil
}

func (downloader *Downloader) destination(artifactPath string) (string, error) {
	cleanRelative := filepath.Clean(filepath.FromSlash(artifactPath))
	if cleanRelative == "." || filepath.IsAbs(cleanRelative) || cleanRelative == ".." || strings.HasPrefix(cleanRelative, ".."+string(filepath.Separator)) {
		return "", errors.New("artifact path escapes download root")
	}
	destination := filepath.Join(downloader.root, cleanRelative)
	relative, err := filepath.Rel(downloader.root, destination)
	if err != nil || filepath.IsAbs(relative) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("artifact destination escapes download root")
	}
	return destination, nil
}

func partialSize(path string, expected int64) (int64, error) {
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("stat partial artifact: %w", err)
	}
	if info.Size() > expected {
		if err := os.Remove(path); err != nil {
			return 0, fmt.Errorf("remove oversized partial artifact: %w", err)
		}
		return 0, nil
	}
	return info.Size(), nil
}

func validFile(path string, artifact release.Artifact) (bool, error) {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("open artifact for verification: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return false, err
	}
	if info.Size() != artifact.Size {
		return false, nil
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return false, err
	}
	return hex.EncodeToString(hash.Sum(nil)) == artifact.SHA256, nil
}

func validContentRange(value string, offset, total int64) bool {
	prefix := fmt.Sprintf("bytes %d-", offset)
	return strings.HasPrefix(value, prefix) && strings.HasSuffix(value, "/"+strconv.FormatInt(total, 10))
}

func copyWithProgress(ctx context.Context, destination io.Writer, source io.Reader, offset, total, bytesPerSecond int64, progress Progress) (int64, error) {
	buffer := make([]byte, 64*1024)
	var written int64
	started := time.Now()
	for {
		count, readErr := source.Read(buffer)
		if count > 0 {
			outputCount, writeErr := destination.Write(buffer[:count])
			written += int64(outputCount)
			if progress != nil {
				if progressErr := progress(offset+written, total); progressErr != nil {
					return written, progressErr
				}
			}
			if writeErr != nil {
				return written, writeErr
			}
			if outputCount != count {
				return written, io.ErrShortWrite
			}
			if delay := rateDelay(written, bytesPerSecond, time.Since(started)); delay > 0 {
				timer := time.NewTimer(delay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return written, ctx.Err()
				case <-timer.C:
				}
			}
		}
		if readErr == io.EOF {
			return written, nil
		}
		if readErr != nil {
			return written, readErr
		}
	}
}

func rateDelay(written, bytesPerSecond int64, elapsed time.Duration) time.Duration {
	if written <= 0 || bytesPerSecond <= 0 {
		return 0
	}
	target := time.Duration(float64(written) / float64(bytesPerSecond) * float64(time.Second))
	if target <= elapsed {
		return 0
	}
	return target - elapsed
}
