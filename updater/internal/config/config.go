package config

import (
	"bytes"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"time"
)

const (
	SchemaVersion  = 1
	maxConfigBytes = 1024 * 1024
)

var projectPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,62}$`)
var keyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

type Config struct {
	SchemaVersion            int               `json:"schemaVersion"`
	ComposeProject           string            `json:"composeProject"`
	WorkingDirectory         string            `json:"workingDirectory"`
	ComposeFile              string            `json:"composeFile"`
	StateDirectory           string            `json:"stateDirectory"`
	BackupDirectory          string            `json:"backupDirectory"`
	DatabasePasswordFile     string            `json:"databasePasswordFile"`
	ReleaseBaseURL           string            `json:"releaseBaseUrl"`
	ReleaseBearerTokenFile   string            `json:"releaseBearerTokenFile,omitempty"`
	TrustedCACertificateFile string            `json:"trustedCACertificateFile,omitempty"`
	ServerBaseURL            string            `json:"serverBaseUrl"`
	MinimumFreeBytes         uint64            `json:"minimumFreeBytes"`
	Channel                  string            `json:"channel"`
	AllowedServices          []string          `json:"allowedServices"`
	TrustedKeys              map[string]string `json:"trustedKeys"`
	Automation               Automation        `json:"automation,omitempty"`
}

type Automation struct {
	CheckIntervalMinutes   int   `json:"checkIntervalMinutes,omitempty"`
	JitterPercent          int   `json:"jitterPercent,omitempty"`
	MaximumBackoffMinutes  int   `json:"maximumBackoffMinutes,omitempty"`
	AutoDownload           bool  `json:"autoDownload,omitempty"`
	RetainReleases         int   `json:"retainReleases,omitempty"`
	DownloadBytesPerSecond int64 `json:"downloadBytesPerSecond,omitempty"`
}

func Load(path string) (Config, error) {
	info, err := os.Stat(path)
	if err != nil {
		return Config{}, fmt.Errorf("stat updater config: %w", err)
	}
	if info.Size() <= 0 || info.Size() > maxConfigBytes {
		return Config{}, errors.New("updater config is empty or too large")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, fmt.Errorf("read updater config: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return Config{}, fmt.Errorf("decode updater config: %w", err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); err == nil {
		return Config{}, errors.New("updater config contains multiple JSON values")
	} else if err != io.EOF {
		return Config{}, fmt.Errorf("decode trailing updater config data: %w", err)
	}
	if err := config.Validate(); err != nil {
		return Config{}, err
	}
	return config, nil
}

func (config Config) Validate() error {
	if config.SchemaVersion != SchemaVersion {
		return fmt.Errorf("unsupported updater config schema version %d", config.SchemaVersion)
	}
	if !projectPattern.MatchString(config.ComposeProject) {
		return errors.New("composeProject is invalid")
	}
	for name, path := range map[string]string{
		"workingDirectory":     config.WorkingDirectory,
		"composeFile":          config.ComposeFile,
		"stateDirectory":       config.StateDirectory,
		"backupDirectory":      config.BackupDirectory,
		"databasePasswordFile": config.DatabasePasswordFile,
	} {
		if !filepath.IsAbs(path) || filepath.Clean(path) == filepath.VolumeName(path)+string(filepath.Separator) {
			return fmt.Errorf("%s must be a non-root absolute path", name)
		}
	}
	workingDirectory := filepath.Clean(config.WorkingDirectory)
	composeFile := filepath.Clean(config.ComposeFile)
	if relative, err := filepath.Rel(workingDirectory, composeFile); err != nil || relative == ".." || filepath.IsAbs(relative) || startsWithParent(relative) {
		return errors.New("composeFile must be inside workingDirectory")
	}
	if filepath.Clean(config.StateDirectory) == filepath.Clean(config.BackupDirectory) {
		return errors.New("stateDirectory and backupDirectory must be different")
	}
	if config.TrustedCACertificateFile != "" {
		path := config.TrustedCACertificateFile
		if !filepath.IsAbs(path) || filepath.Clean(path) == filepath.VolumeName(path)+string(filepath.Separator) {
			return errors.New("trustedCACertificateFile must be a non-root absolute path")
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > maxConfigBytes {
			return errors.New("trustedCACertificateFile must be a nonempty regular file under 1 MiB")
		}
		if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
			return errors.New("trustedCACertificateFile must not be accessible by group or others")
		}
	}
	if config.ReleaseBearerTokenFile != "" {
		if _, err := readReleaseToken(config.ReleaseBearerTokenFile); err != nil {
			return err
		}
	}
	releaseURL, err := url.Parse(config.ReleaseBaseURL)
	if err != nil || releaseURL.Scheme != "https" || releaseURL.Host == "" || releaseURL.User != nil || releaseURL.RawQuery != "" || releaseURL.Fragment != "" {
		return errors.New("releaseBaseUrl must be an HTTPS URL without credentials, query, or fragment")
	}
	serverURL, err := url.Parse(config.ServerBaseURL)
	if err != nil || (serverURL.Scheme != "http" && serverURL.Scheme != "https") || serverURL.Host == "" || serverURL.User != nil || serverURL.RawQuery != "" || serverURL.Fragment != "" {
		return errors.New("serverBaseUrl must be an HTTP(S) URL without credentials, query, or fragment")
	}
	switch serverURL.Hostname() {
	case "localhost", "127.0.0.1", "::1":
	case "compdf-server":
		// Fixed Compose service on the private application network. The updater
		// must survive replacement of the Server container during an upgrade.
		if serverURL.Scheme != "http" || serverURL.Port() != "8080" || serverURL.Path != "" {
			return errors.New("Compose serverBaseUrl must be http://compdf-server:8080")
		}
	default:
		return errors.New("serverBaseUrl must target the local server")
	}
	if config.MinimumFreeBytes < 1024*1024*1024 {
		return errors.New("minimumFreeBytes must be at least 1 GiB")
	}
	if config.Channel != "stable" && config.Channel != "beta" && config.Channel != "security" {
		return errors.New("channel must be stable, beta, or security")
	}
	if err := config.Automation.Validate(); err != nil {
		return err
	}
	if _, err := config.TrustedPublicKeys(); err != nil {
		return err
	}
	services := append([]string(nil), config.AllowedServices...)
	sort.Strings(services)
	if len(services) != 2 || services[0] != "compdf-app" || services[1] != "compdf-server" {
		return errors.New("allowedServices must contain only compdf-app and compdf-server")
	}
	return nil
}

func (config Config) HTTPClient(timeout time.Duration) (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if config.TrustedCACertificateFile != "" {
		certificate, err := os.ReadFile(config.TrustedCACertificateFile)
		if err != nil {
			return nil, fmt.Errorf("read trusted CA certificate: %w", err)
		}
		roots, err := x509.SystemCertPool()
		if err != nil || roots == nil {
			roots = x509.NewCertPool()
		}
		if !roots.AppendCertsFromPEM(certificate) {
			return nil, errors.New("trusted CA certificate file contains no valid PEM certificates")
		}
		transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	}
	var roundTripper http.RoundTripper = transport
	if config.ReleaseBearerTokenFile != "" {
		token, err := readReleaseToken(config.ReleaseBearerTokenFile)
		if err != nil {
			return nil, err
		}
		origin, err := url.Parse(config.ReleaseBaseURL)
		if err != nil || origin.Scheme != "https" || origin.Host == "" {
			return nil, errors.New("release token requires a valid HTTPS release origin")
		}
		roundTripper = releaseTokenTransport{base: transport, origin: origin, token: token}
	}
	return &http.Client{Transport: roundTripper, Timeout: timeout}, nil
}

type releaseTokenTransport struct {
	base   http.RoundTripper
	origin *url.URL
	token  string
}

func (transport releaseTokenTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	// Go may forward Authorization across same-domain redirects. Always scope
	// the token to the exact configured HTTPS origin, including its port.
	if clone.URL.Scheme == "https" && clone.URL.Host == transport.origin.Host {
		clone.Header.Set("Authorization", "Bearer "+transport.token)
	} else {
		clone.Header.Del("Authorization")
	}
	return transport.base.RoundTrip(clone)
}

func readReleaseToken(path string) (string, error) {
	if !filepath.IsAbs(path) {
		return "", errors.New("releaseBearerTokenFile must be an absolute path")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > 16384 {
		return "", errors.New("releaseBearerTokenFile must be a nonempty regular file under 16 KiB")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return "", errors.New("releaseBearerTokenFile must not be accessible by group or others")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("cannot read releaseBearerTokenFile")
	}
	token := string(bytes.TrimSuffix(data, []byte("\n")))
	if token == "" || bytes.ContainsAny([]byte(token), "\r\n\x00") {
		return "", errors.New("releaseBearerTokenFile must contain a single nonempty token")
	}
	return token, nil
}

func (automation Automation) Validate() error {
	if automation.CheckIntervalMinutes == 0 {
		if automation.AutoDownload {
			return errors.New("automation.autoDownload requires checkIntervalMinutes")
		}
	} else if automation.CheckIntervalMinutes < 15 || automation.CheckIntervalMinutes > 10080 {
		return errors.New("automation.checkIntervalMinutes must be between 15 and 10080")
	}
	if automation.JitterPercent < 0 || automation.JitterPercent > 50 {
		return errors.New("automation.jitterPercent must be between 0 and 50")
	}
	if automation.MaximumBackoffMinutes < 0 || automation.MaximumBackoffMinutes > 10080 {
		return errors.New("automation.maximumBackoffMinutes must be between 0 and 10080")
	}
	if automation.RetainReleases < 0 || automation.RetainReleases > 20 {
		return errors.New("automation.retainReleases must be between 0 and 20")
	}
	if automation.DownloadBytesPerSecond < 0 || automation.DownloadBytesPerSecond > 10*1024*1024*1024 {
		return errors.New("automation.downloadBytesPerSecond must be between 0 and 10 GiB/s")
	}
	return nil
}

func (config Config) TrustedPublicKeys() (map[string]ed25519.PublicKey, error) {
	if len(config.TrustedKeys) == 0 {
		return nil, errors.New("trustedKeys must contain at least one Ed25519 public key")
	}
	keys := make(map[string]ed25519.PublicKey, len(config.TrustedKeys))
	for keyID, encoded := range config.TrustedKeys {
		if !keyIDPattern.MatchString(keyID) {
			return nil, fmt.Errorf("trustedKeys key ID %q is invalid", keyID)
		}
		decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil || len(decoded) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("trustedKeys.%s must be a canonical Base64 Ed25519 public key", keyID)
		}
		keys[keyID] = ed25519.PublicKey(append([]byte(nil), decoded...))
	}
	return keys, nil
}

func startsWithParent(path string) bool {
	prefix := ".." + string(filepath.Separator)
	return len(path) >= len(prefix) && path[:len(prefix)] == prefix
}
