package updatecheck

import (
	"context"
	"crypto/ed25519"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
)

const maxResponseBytes = 1024 * 1024

type Checker struct {
	client      *http.Client
	baseURL     *url.URL
	channel     string
	trustedKeys map[string]ed25519.PublicKey
	now         func() time.Time
}

type Input struct {
	CurrentVersion string
	UpdaterVersion string
}

type Bundle struct {
	Manifest       release.Manifest
	ManifestBytes  []byte
	SignatureBytes []byte
}

func New(
	client *http.Client,
	baseURL string,
	channel string,
	trustedKeys map[string]ed25519.PublicKey,
) (*Checker, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("release base URL must be HTTPS without credentials, query, or fragment")
	}
	if channel != "stable" && channel != "beta" && channel != "security" {
		return nil, fmt.Errorf("unsupported update channel %q", channel)
	}
	if client == nil {
		client = &http.Client{Timeout: 15 * time.Second}
	}
	clientCopy := *client
	clientCopy.CheckRedirect = sameOriginRedirectPolicy(parsed, client.CheckRedirect)
	return &Checker{
		client:      &clientCopy,
		baseURL:     parsed,
		channel:     channel,
		trustedKeys: copyKeys(trustedKeys),
		now:         func() time.Time { return time.Now().UTC() },
	}, nil
}

func (checker *Checker) Check(ctx context.Context, input Input) (release.Manifest, error) {
	bundle, err := checker.CheckBundle(ctx, input)
	if err != nil {
		return release.Manifest{}, err
	}
	return bundle.Manifest, nil
}

// CheckBundle returns the verified parsed manifest together with the exact
// bytes covered by the detached signature. Callers persist these bytes rather
// than re-encoding the manifest.
func (checker *Checker) CheckBundle(ctx context.Context, input Input) (Bundle, error) {
	manifestURL := checker.releaseURL("release.json")
	signatureURL := checker.releaseURL("release.json.sig")
	manifestBytes, err := checker.fetch(ctx, manifestURL)
	if err != nil {
		return Bundle{}, fmt.Errorf("fetch release manifest: %w", err)
	}
	signatureBytes, err := checker.fetch(ctx, signatureURL)
	if err != nil {
		return Bundle{}, fmt.Errorf("fetch release signature: %w", err)
	}
	signature, err := release.ParseSignature(signatureBytes)
	if err != nil {
		return Bundle{}, err
	}
	if err := release.VerifySignature(manifestBytes, signature, checker.trustedKeys); err != nil {
		return Bundle{}, err
	}
	manifest, err := release.ParseManifest(manifestBytes)
	if err != nil {
		return Bundle{}, err
	}
	if err := manifest.CheckCompatibility(release.Compatibility{
		CurrentVersion: input.CurrentVersion,
		UpdaterVersion: input.UpdaterVersion,
		Channel:        checker.channel,
		Now:            checker.now(),
	}); err != nil {
		return Bundle{}, err
	}
	return Bundle{
		Manifest:       manifest,
		ManifestBytes:  append([]byte(nil), manifestBytes...),
		SignatureBytes: append([]byte(nil), signatureBytes...),
	}, nil
}

func (checker *Checker) releaseURL(name string) *url.URL {
	result := *checker.baseURL
	result.Path = path.Join(checker.baseURL.Path, checker.channel, name)
	return &result
}

func (checker *Checker) fetch(ctx context.Context, target *url.URL) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	response, err := checker.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.Request.URL.Scheme != "https" || !sameOrigin(checker.baseURL, response.Request.URL) {
		return nil, errors.New("release request left its configured HTTPS origin")
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("release server returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxResponseBytes {
		return nil, errors.New("release response exceeds maximum size")
	}
	return data, nil
}

func sameOriginRedirectPolicy(base *url.URL, previous func(*http.Request, []*http.Request) error) func(*http.Request, []*http.Request) error {
	return func(request *http.Request, via []*http.Request) error {
		if len(via) >= 3 {
			return errors.New("too many release redirects")
		}
		if request.URL.Scheme != "https" || !sameOrigin(base, request.URL) {
			return errors.New("release redirect changed HTTPS origin")
		}
		if previous != nil {
			return previous(request, via)
		}
		return nil
	}
}

func sameOrigin(left, right *url.URL) bool {
	return left.Scheme == right.Scheme && left.Host == right.Host
}

func copyKeys(input map[string]ed25519.PublicKey) map[string]ed25519.PublicKey {
	result := make(map[string]ed25519.PublicKey, len(input))
	for keyID, key := range input {
		result[keyID] = append(ed25519.PublicKey(nil), key...)
	}
	return result
}
