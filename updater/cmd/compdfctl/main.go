package main

import (
	"os"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/cli"
)

func main() {
	os.Exit(cli.Run(os.Args[1:], os.Stdout, os.Stderr))
}
