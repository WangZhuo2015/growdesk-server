//go:build !linux

package backend

import (
	"context"
	"io"
)

func localASRResourceLimiter() (string, error) {
	return "", localASRConfigError("Local speech recognition requires Linux resource limits")
}

func runLocalASRWithLimits(context.Context, localASRConfig, []string, []string, io.Writer, io.Writer) error {
	return localASRConfigError("Local speech recognition requires Linux resource limits")
}
