//go:build linux

package backend

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

const localPassportTTSMemoryBytes = uint64(4 * 1024 * 1024 * 1024)

func platformPassportTTSLocalConfiguration(timeout time.Duration) (localPassportTTSConfig, error) {
	espeak, err := validateLocalPassportTTSExecutable("/usr/bin/espeak-ng")
	if err != nil {
		return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "The fixed eSpeak NG executable is unavailable", false)
	}
	ffmpeg, err := validateLocalPassportTTSExecutable("/usr/bin/ffmpeg")
	if err != nil {
		return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "The fixed ffmpeg executable is unavailable", false)
	}
	limiter, err := localASRResourceLimiter()
	if err != nil || limiter == "" {
		return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local speech synthesis requires the validated Linux prlimit launcher", false)
	}
	return localPassportTTSConfig{espeakPath: espeak, ffmpegPath: ffmpeg, limiterPath: limiter, timeout: timeout}, nil
}

func platformPassportTTSLocalSherpaConfiguration(timeout time.Duration) (localPassportTTSConfig, error) {
	pythonResolved, err := validateLocalPassportTTSSherpaPython(localPassportTTSSherpaPythonPath)
	if err != nil {
		return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "The fixed Sherpa TTS Python environment is unavailable", false)
	}
	if err := validateLocalPassportTTSSherpaScript(localPassportTTSSherpaScriptPath); err != nil {
		return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "The protected fixed Sherpa TTS script is unavailable", false)
	}
	ffmpeg, err := validateLocalPassportTTSExecutable("/usr/bin/ffmpeg")
	if err != nil {
		return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "The fixed ffmpeg executable is unavailable", false)
	}
	limiter, err := localASRResourceLimiter()
	if err != nil || limiter == "" {
		return localPassportTTSConfig{}, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local speech synthesis requires the validated Linux prlimit launcher", false)
	}
	return localPassportTTSConfig{
		sherpaPythonPath:         localPassportTTSSherpaPythonPath,
		sherpaPythonResolvedPath: pythonResolved,
		sherpaScriptPath:         localPassportTTSSherpaScriptPath,
		ffmpegPath:               ffmpeg,
		limiterPath:              limiter,
		timeout:                  timeout,
	}, nil
}

func validateLocalPassportTTSExecutable(candidate string) (string, error) {
	if candidate != "/usr/bin/espeak-ng" && candidate != "/usr/bin/ffmpeg" {
		return "", errors.New("local TTS executable is outside the fixed allowlist")
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(resolved)
	if err != nil || filepath.Clean(abs) != filepath.Clean(candidate) {
		return "", errors.New("fixed local TTS executable resolved outside its configured path")
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 || info.Mode().Perm()&0022 != 0 {
		return "", errors.New("fixed local TTS executable is not a protected executable file")
	}
	return abs, nil
}

func validateLocalPassportTTSSherpaPython(candidate string) (string, error) {
	if candidate != localPassportTTSSherpaPythonPath {
		return "", errors.New("Sherpa Python launcher is outside the fixed allowlist")
	}
	linkInfo, err := os.Lstat(candidate)
	if err != nil || (!linkInfo.Mode().IsRegular() && linkInfo.Mode()&os.ModeSymlink == 0) {
		return "", errors.New("fixed Sherpa Python launcher is not a regular file or symlink")
	}
	if !localPassportTTSOwnedByRoot(linkInfo) || (linkInfo.Mode()&os.ModeSymlink == 0 && linkInfo.Mode().Perm()&0022 != 0) {
		return "", errors.New("fixed Sherpa Python launcher is not root-owned and protected")
	}
	if err := validateLocalPassportTTSRootProtectedDirectories(filepath.Dir(candidate)); err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(resolved)
	if err != nil || !filepath.IsAbs(abs) || filepath.Clean(abs) != filepath.Clean(resolved) {
		return "", errors.New("fixed Sherpa Python launcher resolved to an invalid path")
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 || info.Mode().Perm()&0022 != 0 || !localPassportTTSOwnedByRoot(info) {
		return "", errors.New("resolved Sherpa Python interpreter is not a root-owned protected executable file")
	}
	if err := validateLocalPassportTTSRootProtectedDirectories(filepath.Dir(abs)); err != nil {
		return "", err
	}
	if err := validateLocalPassportTTSSherpaPyVenvConfig(); err != nil {
		return "", err
	}
	if err := validateLocalPassportTTSRootProtectedDirectories(localPassportTTSSherpaSitePackagesPath); err != nil {
		return "", errors.New("fixed Sherpa Python site-packages directory is not root-owned and protected")
	}
	return filepath.Clean(abs), nil
}

func validateLocalPassportTTSSherpaScript(candidate string) error {
	if candidate != localPassportTTSSherpaScriptPath {
		return errors.New("Sherpa TTS script is outside the fixed allowlist")
	}
	info, err := os.Lstat(candidate)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 || info.Mode().Perm()&0444 == 0 || !localPassportTTSOwnedByRoot(info) {
		return errors.New("fixed Sherpa TTS script is not a protected readable regular file")
	}
	if err := validateLocalPassportTTSRootProtectedDirectories(filepath.Dir(candidate)); err != nil {
		return errors.New("fixed Sherpa TTS script has an unprotected ancestor directory")
	}
	return nil
}

func localPassportTTSOwnedByRoot(info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == 0
}

func validateLocalPassportTTSRootProtectedDirectories(directory string) error {
	directory, err := filepath.Abs(directory)
	if err != nil {
		return err
	}
	for current := filepath.Clean(directory); ; current = filepath.Dir(current) {
		info, statErr := os.Lstat(current)
		if statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 || !localPassportTTSOwnedByRoot(info) {
			return errors.New("fixed local TTS path has an unprotected root-owned directory")
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
	}
	return nil
}

func validateLocalPassportTTSSherpaPyVenvConfig() error {
	info, err := os.Lstat(localPassportTTSSherpaPyVenvConfigPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0022 != 0 || info.Mode().Perm()&0444 == 0 || !localPassportTTSOwnedByRoot(info) {
		return errors.New("fixed Sherpa pyvenv.cfg is not a root-owned protected regular file")
	}
	if err := validateLocalPassportTTSRootProtectedDirectories(filepath.Dir(localPassportTTSSherpaPyVenvConfigPath)); err != nil {
		return errors.New("fixed Sherpa pyvenv.cfg has an unprotected ancestor directory")
	}
	return nil
}

func validateLocalPassportTTSSherpaFiles(config localPassportTTSConfig) error {
	resolved, err := validateLocalPassportTTSSherpaPython(config.sherpaPythonPath)
	if err != nil || filepath.Clean(resolved) != filepath.Clean(config.sherpaPythonResolvedPath) {
		return errors.New("fixed Sherpa Python environment changed after configuration")
	}
	if err := validateLocalPassportTTSSherpaScript(config.sherpaScriptPath); err != nil {
		return err
	}
	ffmpeg, err := validateLocalPassportTTSExecutable(config.ffmpegPath)
	if err != nil || filepath.Clean(ffmpeg) != filepath.Clean(config.ffmpegPath) {
		return errors.New("fixed Sherpa ffmpeg executable changed after configuration")
	}
	return nil
}

func runLocalPassportTTSStep(ctx context.Context, config localPassportTTSConfig, executable string, argv []string, stdin io.Reader, stdout *localPassportTTSBoundedWriter, tempDir string) error {
	if err := validateLocalPassportTTSConfig(config); err != nil {
		return err
	}
	if config.engine == "local-sherpa" {
		if err := validateLocalPassportTTSSherpaFiles(config); err != nil {
			return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "A fixed Sherpa speech synthesis file could not be verified", false)
		}
		if executable == config.sherpaPythonPath {
			if len(argv) != 2 || argv[0] != "-I" || argv[1] != config.sherpaScriptPath || stdin == nil {
				return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "The fixed Sherpa speech synthesis command is invalid", false)
			}
		} else if executable != config.ffmpegPath {
			return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local Sherpa speech synthesis executable is invalid", false)
		}
	} else if executable != config.espeakPath && executable != config.ffmpegPath {
		return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local speech synthesis executable is invalid", false)
	}
	if executable == config.ffmpegPath || executable == config.espeakPath {
		validated, err := validateLocalPassportTTSExecutable(executable)
		if err != nil || filepath.Clean(validated) != filepath.Clean(executable) {
			return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "A fixed local speech synthesis executable could not be verified", false)
		}
	}
	limiter, err := localASRResourceLimiter()
	if err != nil || filepath.Clean(limiter) != filepath.Clean(config.limiterPath) {
		return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local speech synthesis requires the validated Linux prlimit launcher", false)
	}
	if err := ctx.Err(); err != nil {
		return localPassportTTSCtxError(ctx, ctx, err)
	}

	stepCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stdout.cancel = cancel
	stderr := &localPassportTTSStderr{limit: maxPassportTTSStderr, cancel: cancel}
	limitedArgs := []string{
		fmt.Sprintf("--cpu=%d:%d", maxPassportTTSLocalCPUSec, maxPassportTTSLocalCPUSec+1),
		fmt.Sprintf("--as=%d:%d", localPassportTTSMemoryBytes, localPassportTTSMemoryBytes),
		"--",
		executable,
	}
	limitedArgs = append(limitedArgs, argv...)
	cmd := exec.CommandContext(stepCtx, config.limiterPath, limitedArgs...)
	cmd.Env = localPassportTTSChildEnvironment(tempDir)
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	configureLocalASRProcessGroup(cmd)
	runErr := cmd.Run()
	if cmd.Process != nil {
		if stopErr := stopLocalASRProcessGroup(cmd.Process.Pid); stopErr != nil && runErr == nil {
			runErr = errors.New("local TTS process group could not be stopped")
		}
	}
	if stdout.exceeded {
		return passportTTSFailure("TTS_PROVIDER_INVALID_RESPONSE", "Local speech synthesis output exceeds the byte budget", false)
	}
	if stderr.exceeded {
		return passportTTSFailure("TTS_PROVIDER_EXECUTION_FAILED", "Local speech synthesis exceeded its diagnostic output budget", false)
	}
	if ctx.Err() != nil {
		return localPassportTTSCtxError(ctx, ctx, ctx.Err())
	}
	if runErr != nil {
		return passportTTSFailure("TTS_PROVIDER_EXECUTION_FAILED", "Local speech synthesis failed", false)
	}
	return nil
}
