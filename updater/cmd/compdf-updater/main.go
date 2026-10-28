package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/cli"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/daemon"
	"github.com/ComPDFKit/compdf-self-hosted/updater/internal/scheduler"
)

func main() {
	configPath := flag.String("config", "", "absolute protected updater config path")
	socketPath := flag.String("socket", "/run/compdf-updater/compdf-updater.sock", "absolute Unix socket path")
	flag.Parse()
	if *configPath == "" || flag.NArg() != 0 {
		fmt.Fprintln(os.Stderr, "usage: compdf-updater --config <absolute-path> [--socket <absolute-path>]")
		os.Exit(2)
	}
	handler, err := daemon.NewHandler(*configPath, nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "initialize updater daemon: %v\n", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	automation, err := scheduler.New(*configPath, cli.Run)
	if err != nil {
		fmt.Fprintf(os.Stderr, "initialize updater scheduler: %v\n", err)
		os.Exit(1)
	}
	go automation.Run(ctx)
	if err := daemon.Serve(ctx, *socketPath, handler); err != nil {
		fmt.Fprintf(os.Stderr, "serve updater daemon: %v\n", err)
		os.Exit(1)
	}
}
