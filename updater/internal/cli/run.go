package cli

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/buildinfo"
	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/deploy"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/preflight"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/release"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/state"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/updatecheck"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/verification"
)

const usage = `compdfctl manages ComPDF Self-Hosted application updates.

Usage:
  compdfctl help
  compdfctl version [--json]
  compdfctl config validate --file <path>
  compdfctl backup create --file <path> --request-id <id> --current-version <version> --approve --maintenance-confirmed
  compdfctl backup verify --file <path> --backup-id <id>
  compdfctl apply --config <path> --current-version <version> --version <target> --request-id <id> --approve --maintenance-confirmed [--offline-risk-confirmed]
  compdfctl cancel --config <path> --request-id <id>
  compdfctl check --config <path> --current-version <version> [--json]
  compdfctl download --config <path> --current-version <version> --version <target> --request-id <id>
  compdfctl diagnostics --config <path> --output <absolute.zip>
  compdfctl import --config <path> --file <package.tar.zst> --current-version <version> --request-id <id>
  compdfctl history --config <path>
  compdfctl preflight --config <path> --current-version <version> --version <target> --request-id <id>
  compdfctl rollback --config <path> --request-id <id> --approve
  compdfctl status --config <path>

The updater reads release URLs, channels, and trust roots only from its protected config.`

type dependencies struct {
	httpClient     *http.Client
	timeout        time.Duration
	preflightProbe preflight.Probe
	imagePuller    interface {
		Pull(context.Context, release.Manifest) error
	}
	imageLoader interface {
		Load(context.Context, release.Manifest, string) error
	}
	applyExecutor interface {
		PrepareEnvironment(updaterconfig.Config, release.Manifest, string) (string, error)
		Migrate(context.Context, updaterconfig.Config, release.Manifest, string, string) error
		Activate(context.Context, updaterconfig.Config, string) error
		CommitEnvironment(updaterconfig.Config, string) error
	}
	verifier interface {
		Verify(context.Context, updaterconfig.Config) (verification.Report, error)
	}
	releaseAuthorizer interface {
		Authorize(context.Context, updaterconfig.Config, state.Job, releaseBundle) error
	}
}

func (deps dependencies) authorizer() interface {
	Authorize(context.Context, updaterconfig.Config, state.Job, releaseBundle) error
} {
	if deps.releaseAuthorizer != nil {
		return deps.releaseAuthorizer
	}
	return onlineReleaseAuthorizer{client: deps.httpClient}
}

func (deps dependencies) deploymentExecutor() interface {
	PrepareEnvironment(updaterconfig.Config, release.Manifest, string) (string, error)
	Migrate(context.Context, updaterconfig.Config, release.Manifest, string, string) error
	Activate(context.Context, updaterconfig.Config, string) error
	CommitEnvironment(updaterconfig.Config, string) error
} {
	if deps.applyExecutor != nil {
		return deps.applyExecutor
	}
	return deploy.NewExecutor(nil)
}

func (deps dependencies) releaseVerifier() interface {
	Verify(context.Context, updaterconfig.Config) (verification.Report, error)
} {
	if deps.verifier != nil {
		return deps.verifier
	}
	return verification.New(deps.httpClient)
}

func (deps dependencies) releaseImagePuller() interface {
	Pull(context.Context, release.Manifest) error
} {
	if deps.imagePuller != nil {
		return deps.imagePuller
	}
	return deploy.NewImagePuller(nil)
}

func (deps dependencies) releaseImageLoader() interface {
	Load(context.Context, release.Manifest, string) error
} {
	if deps.imageLoader != nil {
		return deps.imageLoader
	}
	return deploy.NewImageLoader(nil)
}

func configuredHTTPClient(config updaterconfig.Config, provided *http.Client, timeout time.Duration) (*http.Client, error) {
	if provided != nil {
		return provided, nil
	}
	return config.HTTPClient(timeout)
}

type checkResult struct {
	UpdateAvailable     bool             `json:"updateAvailable"`
	CurrentVersion      string           `json:"currentVersion"`
	AvailableVersion    string           `json:"availableVersion"`
	Channel             string           `json:"channel"`
	MaintenanceRequired bool             `json:"maintenanceRequired"`
	Rollback            release.Rollback `json:"rollback"`
	ReleaseNotes        string           `json:"releaseNotes"`
	KnownIssues         []string         `json:"knownIssues"`
}

func Run(args []string, stdout, stderr io.Writer) int {
	return run(args, stdout, stderr, dependencies{})
}

func run(args []string, stdout, stderr io.Writer, deps dependencies) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		fmt.Fprintln(stdout, usage)
		return 0
	}

	switch args[0] {
	case "version":
		return printVersion(args[1:], stdout, stderr)
	case "config":
		return validateConfig(args[1:], stdout, stderr)
	case "backup":
		return runBackup(args[1:], stdout, stderr)
	case "apply":
		return runApply(args[1:], stdout, stderr, deps)
	case "cancel":
		return runCancel(args[1:], stdout, stderr)
	case "check":
		return checkRelease(args[1:], stdout, stderr, deps)
	case "download":
		return runDownload(args[1:], stdout, stderr, deps)
	case "diagnostics":
		return runDiagnostics(args[1:], stdout, stderr)
	case "import":
		return runImport(args[1:], stdout, stderr, deps)
	case "history":
		return runHistory(args[1:], stdout, stderr)
	case "preflight":
		return runPreflight(args[1:], stdout, stderr, deps)
	case "rollback":
		return runRollback(args[1:], stdout, stderr, deps)
	case "status":
		return runStatus(args[1:], stdout, stderr)
	default:
		fmt.Fprintf(stderr, "unknown command %q\n\n%s\n", args[0], usage)
		return 2
	}
}

func checkRelease(args []string, stdout, stderr io.Writer, deps dependencies) int {
	flags := flag.NewFlagSet("check", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "path to protected updater config")
	currentVersion := flags.String("current-version", "", "installed product version")
	jsonOutput := flags.Bool("json", false, "write machine-readable JSON")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *configPath == "" || *currentVersion == "" {
		fmt.Fprintln(stderr, "usage: compdfctl check --config <path> --current-version <version> [--json]")
		return 2
	}

	config, err := updaterconfig.Load(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "load updater config: %v\n", err)
		return 1
	}
	trustedKeys, err := config.TrustedPublicKeys()
	if err != nil {
		fmt.Fprintf(stderr, "load trusted release keys: %v\n", err)
		return 1
	}
	timeout := deps.timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	client, err := configuredHTTPClient(config, deps.httpClient, timeout)
	if err != nil {
		fmt.Fprintf(stderr, "initialize release transport: %v\n", err)
		return 1
	}
	checker, err := updatecheck.New(client, config.ReleaseBaseURL, config.Channel, trustedKeys)
	if err != nil {
		fmt.Fprintf(stderr, "initialize release check: %v\n", err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	manifest, err := checker.Check(ctx, updatecheck.Input{
		CurrentVersion: *currentVersion,
		UpdaterVersion: buildinfo.Version,
	})
	if err != nil {
		fmt.Fprintf(stderr, "check release: %v\n", err)
		return 1
	}
	comparison, err := release.CompareVersions(*currentVersion, manifest.Version)
	if err != nil {
		fmt.Fprintf(stderr, "compare release versions: %v\n", err)
		return 1
	}
	result := checkResult{
		UpdateAvailable:     comparison < 0,
		CurrentVersion:      *currentVersion,
		AvailableVersion:    manifest.Version,
		Channel:             manifest.Channel,
		MaintenanceRequired: manifest.MaintenanceRequired,
		Rollback:            manifest.Rollback,
		ReleaseNotes:        manifest.ReleaseNotes,
		KnownIssues:         append([]string{}, manifest.KnownIssues...),
	}
	if *jsonOutput {
		if err := json.NewEncoder(stdout).Encode(result); err != nil {
			fmt.Fprintf(stderr, "write release check: %v\n", err)
			return 1
		}
		return 0
	}
	if result.UpdateAvailable {
		maintenance := "no maintenance window declared"
		if result.MaintenanceRequired {
			maintenance = "maintenance required"
		}
		fmt.Fprintf(stdout, "Update available: %s -> %s (%s, %s)\n", result.CurrentVersion, result.AvailableVersion, result.Channel, maintenance)
		return 0
	}
	fmt.Fprintf(stdout, "No newer %s release is available (current %s, published %s).\n", result.Channel, result.CurrentVersion, result.AvailableVersion)
	return 0
}

func validateConfig(args []string, stdout, stderr io.Writer) int {
	if len(args) != 3 || args[0] != "validate" || args[1] != "--file" || args[2] == "" {
		fmt.Fprintln(stderr, "usage: compdfctl config validate --file <path>")
		return 2
	}
	config, err := updaterconfig.Load(args[2])
	if err != nil {
		fmt.Fprintf(stderr, "invalid updater config: %v\n", err)
		return 1
	}
	result := struct {
		Valid          bool   `json:"valid"`
		ComposeProject string `json:"composeProject"`
		Channel        string `json:"channel"`
	}{Valid: true, ComposeProject: config.ComposeProject, Channel: config.Channel}
	if err := json.NewEncoder(stdout).Encode(result); err != nil {
		fmt.Fprintf(stderr, "write config result: %v\n", err)
		return 1
	}
	return 0
}

func printVersion(args []string, stdout, stderr io.Writer) int {
	info := buildinfo.Current()
	if len(args) == 0 {
		fmt.Fprintf(stdout, "compdfctl %s (commit %s, built %s)\n", info.Version, info.Commit, info.BuiltAt)
		return 0
	}
	if len(args) == 1 && args[0] == "--json" {
		if err := json.NewEncoder(stdout).Encode(info); err != nil {
			fmt.Fprintf(stderr, "write version: %v\n", err)
			return 1
		}
		return 0
	}
	fmt.Fprintln(stderr, "usage: compdfctl version [--json]")
	return 2
}
