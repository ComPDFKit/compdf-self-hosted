package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/publisher"
)

func main() {
	spec := flag.String("spec", "", "absolute path to release build spec")
	key := flag.String("private-key", "", "absolute path to protected Base64 Ed25519 private key")
	keyID := flag.String("key-id", "", "release signing key ID")
	output := flag.String("output", "", "absolute output directory")
	offline := flag.String("offline-package", "", "optional absolute .tar.zst output path")
	approved := flag.Bool("approve", false, "approve creation of signed release artifacts")
	flag.Parse()
	if !*approved || *spec == "" || *key == "" || *keyID == "" || *output == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: compdf-release --spec <absolute-path> --private-key <absolute-path> --key-id <id> --output <absolute-directory> [--offline-package <absolute-path>] --approve")
		os.Exit(2)
	}
	result, err := publisher.Build(*spec, *key, *keyID, *output, *offline)
	if err != nil {
		fmt.Fprintf(os.Stderr, "generate release: %v\n", err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Version        string `json:"version"`
		Directory      string `json:"directory"`
		OfflinePackage string `json:"offlinePackage,omitempty"`
	}{Version: result.Manifest.Version, Directory: result.Directory, OfflinePackage: result.OfflinePackage}); err != nil {
		fmt.Fprintf(os.Stderr, "write release result: %v\n", err)
		os.Exit(1)
	}
}
