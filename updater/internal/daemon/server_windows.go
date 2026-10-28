//go:build windows

package daemon

import (
	"context"
	"errors"
	"net/http"
)

func Serve(context.Context, string, http.Handler) error {
	return errors.New("compdf-updater daemon requires a Unix socket and is supported on Linux hosts")
}
