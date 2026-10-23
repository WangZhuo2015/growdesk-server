//go:build linux

package backend

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	localASRCPUSeconds  = 110
	localASRMemoryBytes = uint64(4 * 1024 * 1024 * 1024)
)

func localASRResourceLimiter() (string, error) {
	for _, candidate := range []string{"/usr/bin/prlimit", "/bin/prlimit"} {
		resolved, err := filepath.EvalSymlinks(candidate)
		if err != nil {
			continue
		}
		info, err := os.Stat(resolved)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
			continue
		}
		if !strings.HasSuffix(filepath.Base(resolved), "prlimit") {
			continue
		}
		return resolved, nil
	}
	return "", localASRConfigError("Local speech recognition requires the validated Linux prlimit launcher")
}

func runLocalASRWithLimits(ctx context.Context, config localASRConfig, argv, env []string, stdout, stderr io.Writer) error {
	limiter, err := localASRResourceLimiter()
	if err != nil || config.limiterPath == "" || filepath.Clean(limiter) != filepath.Clean(config.limiterPath) {
		return localASRConfigError("Local speech recognition requires the validated Linux prlimit launcher")
	}
	limitedArgv := make([]string, 0, len(argv)+5)
	limitedArgv = append(limitedArgv,
		config.limiterPath,
		fmt.Sprintf("--cpu=%d:%d", localASRCPUSeconds, localASRCPUSeconds+1),
		fmt.Sprintf("--as=%d:%d", localASRMemoryBytes, localASRMemoryBytes),
		"--",
		argv[0],
	)
	limitedArgv = append(limitedArgv, argv[1:]...)
	return runLocalASRProcess(ctx, limitedArgv, env, stdout, stderr)
}
