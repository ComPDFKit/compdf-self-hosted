package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"path/filepath"
	"time"

	updaterconfig "github.com/ComPDFKit/compdf-self-hosted/updater/internal/config"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/diagnostics"
)

func runDiagnostics(args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("diagnostics", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configPath := flags.String("config", "", "protected updater config")
	output := flags.String("output", "", "absolute output .zip path")
	if flags.Parse(args) != nil || flags.NArg() != 0 || *configPath == "" || !filepath.IsAbs(*output) {
		fmt.Fprintln(stderr, "usage: compdfctl diagnostics --config <path> --output <absolute.zip>")
		return 2
	}
	config, err := updaterconfig.Load(*configPath)
	if err != nil {
		fmt.Fprintf(stderr, "load updater config: %v\n", err)
		return 1
	}
	if err := diagnostics.Create(config, *output, time.Now().UTC()); err != nil {
		fmt.Fprintf(stderr, "create diagnostic bundle: %v\n", err)
		return 1
	}
	if err := json.NewEncoder(stdout).Encode(map[string]any{"created": true, "path": filepath.Clean(*output)}); err != nil {
		return 1
	}
	return 0
}
