package backend

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	localASRInputLimit      int64 = 25 * 1024 * 1024
	localASROutputLimit     int   = 256 * 1024
	localASRStderrLimit     int64 = 16 * 1024
	localASRTimeout               = 110 * time.Second
	localASRMaxCommandBytes       = 8 * 1024
	localASRMaxArguments          = 64
)

var localASRSlot = make(chan struct{}, 1)

// localASRConfig is built exclusively from service administrator configuration.
// argv is tokenized once without shell expansion and contains exactly one
// {input} marker outside argv[0]. There is deliberately no unbounded execution
// fallback when the platform resource limiter is unavailable.
type localASRConfig struct {
	argv        []string
	limiterPath string
	timeout     time.Duration
	inputLimit  int64
	outputLimit int
	stderrLimit int64
	tempParent  string
	childEnv    []string
}

// localASRConfiguration opts into local recognition only through an explicit
// local selector or the legacy administrator-owned ASR_COMMAND setting.
func localASRConfiguration() (localASRConfig, bool, error) {
	selector := strings.ToLower(strings.TrimSpace(os.Getenv("GROWDESK_ASR_PROVIDER")))
	rawCommand := strings.TrimSpace(os.Getenv("ASR_COMMAND"))
	if selector == "" && rawCommand == "" {
		return localASRConfig{}, false, nil
	}

	switch selector {
	case "openai", "openai-compatible", "compat", "shared":
		if rawCommand != "" {
			return localASRConfig{}, false, localASRConfigError("ASR_COMMAND conflicts with the explicitly selected speech provider")
		}
		return localASRConfig{}, false, nil
	case "", "local", "command":
		if rawCommand == "" {
			if selector == "" {
				return localASRConfig{}, false, nil
			}
			return localASRConfig{}, false, providerFailure("ASR_PROVIDER_NOT_CONFIGURED", "Configure ASR_COMMAND for local speech recognition", false)
		}
	default:
		return localASRConfig{}, false, localASRConfigError("GROWDESK_ASR_PROVIDER has an unsupported value")
	}

	argv, err := parseLocalASRCommand(rawCommand)
	if err != nil {
		return localASRConfig{}, false, err
	}
	program, err := resolveLocalASRProgram(argv)
	if err != nil {
		return localASRConfig{}, false, err
	}
	argv[0] = program
	limiterPath, err := localASRResourceLimiter()
	if err != nil {
		return localASRConfig{}, false, err
	}
	return localASRConfig{
		argv:        argv,
		limiterPath: limiterPath,
		timeout:     localASRTimeout,
		inputLimit:  localASRInputLimit,
		outputLimit: localASROutputLimit,
		stderrLimit: localASRStderrLimit,
		childEnv:    localASRChildEnvironment(),
	}, true, nil
}

func localASRConfigError(message string) error {
	return providerFailure("ASR_PROVIDER_CONFIG_INVALID", message, false)
}

// parseLocalASRCommand implements only a small argument-vector quoting syntax.
// It does not expand variables, globs, redirects, pipes, substitutions, or
// other shell syntax. Shell executables and a shell -c command are rejected;
// an administrator may instead configure an executable wrapper script.
func parseLocalASRCommand(raw string) ([]string, error) {
	if len(raw) == 0 || len(raw) > localASRMaxCommandBytes || !utf8.ValidString(raw) || strings.ContainsAny(raw, "\x00\r\n") {
		return nil, localASRConfigError("ASR_COMMAND is empty or exceeds its configuration budget")
	}
	var argv []string
	var token strings.Builder
	var quote rune
	escaped := false
	started := false
	appendToken := func() error {
		if !started {
			return nil
		}
		argv = append(argv, token.String())
		token.Reset()
		started = false
		if len(argv) > localASRMaxArguments {
			return localASRConfigError("ASR_COMMAND has too many arguments")
		}
		return nil
	}

	for _, r := range raw {
		if escaped {
			token.WriteRune(r)
			escaped = false
			started = true
			continue
		}
		if quote == '\'' {
			if r == '\'' {
				quote = 0
			} else {
				token.WriteRune(r)
			}
			started = true
			continue
		}
		if quote == '"' {
			switch r {
			case '"':
				quote = 0
			case '\\':
				escaped = true
			default:
				token.WriteRune(r)
			}
			started = true
			continue
		}
		switch {
		case r == '\'':
			quote, started = '\'', true
		case r == '"':
			quote, started = '"', true
		case r == '\\':
			escaped, started = true, true
		case r == ' ' || r == '\t':
			if err := appendToken(); err != nil {
				return nil, err
			}
		default:
			token.WriteRune(r)
			started = true
		}
	}
	if escaped || quote != 0 {
		return nil, localASRConfigError("ASR_COMMAND has unfinished quoting")
	}
	if err := appendToken(); err != nil {
		return nil, err
	}
	if len(argv) < 2 || argv[0] == "" {
		return nil, localASRConfigError("ASR_COMMAND requires a program and an {input} argument")
	}
	placeholderCount := 0
	for i, arg := range argv {
		count := strings.Count(arg, "{input}")
		if i == 0 && count != 0 {
			return nil, localASRConfigError("ASR_COMMAND cannot place {input} in the program name")
		}
		placeholderCount += count
	}
	if placeholderCount != 1 {
		return nil, localASRConfigError("ASR_COMMAND must contain exactly one {input} argument marker")
	}
	if launchesShellIndirectly(argv) {
		return nil, localASRConfigError("ASR_COMMAND must not launch a shell directly or through a command dispatcher")
	}
	return argv, nil
}

func isShellProgram(program string) bool {
	switch strings.ToLower(filepath.Base(program)) {
	case "sh", "bash", "dash", "zsh", "fish", "ksh", "csh", "tcsh", "ash":
		return true
	default:
		return false
	}
}

func launchesShellIndirectly(argv []string) bool {
	if len(argv) == 0 {
		return false
	}
	program := strings.ToLower(filepath.Base(argv[0]))
	if isShellProgram(program) {
		return true
	}
	switch program {
	case "env":
		for _, arg := range argv[1:] {
			if arg == "-S" || arg == "--split-string" {
				return true
			}
			if isShellProgram(arg) {
				return true
			}
			first := strings.Fields(arg)
			if len(first) > 0 && isShellProgram(first[0]) {
				return true
			}
		}
	case "busybox", "toybox", "nohup", "setsid":
		for _, arg := range argv[1:] {
			if isShellProgram(arg) {
				return true
			}
		}
	}
	return false
}

func resolveLocalASRProgram(argv []string) (string, error) {
	if len(argv) == 0 {
		return "", localASRConfigError("ASR_COMMAND program is invalid")
	}
	program := argv[0]
	if program == "" || strings.HasPrefix(program, "-") || isShellProgram(program) {
		return "", localASRConfigError("ASR_COMMAND program is invalid or is a shell")
	}
	if !filepath.IsAbs(program) && strings.ContainsRune(program, filepath.Separator) {
		return "", localASRConfigError("ASR_COMMAND program paths must be absolute")
	}
	resolved, err := exec.LookPath(program)
	if err != nil {
		return "", localASRConfigError("ASR_COMMAND program is not available on the service")
	}
	resolved, err = filepath.Abs(resolved)
	if err != nil {
		return "", localASRConfigError("ASR_COMMAND program path is invalid")
	}
	resolved, err = filepath.EvalSymlinks(resolved)
	if err != nil {
		return "", localASRConfigError("ASR_COMMAND program path is invalid")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
		return "", localASRConfigError("ASR_COMMAND program must be an executable file")
	}
	resolvedArgv := append([]string(nil), argv...)
	resolvedArgv[0] = resolved
	if launchesShellIndirectly(resolvedArgv) {
		return "", localASRConfigError("ASR_COMMAND program must not resolve to a shell dispatcher")
	}
	return resolved, nil
}

func localASRChildEnvironment() []string {
	path := strings.TrimSpace(os.Getenv("PATH"))
	if path == "" {
		path = "/usr/bin:/bin"
	}
	// Never inherit service credentials, provider keys, or arbitrary environment
	// values into a local model process. Model and wrapper settings belong in the
	// administrator's fixed argv or wrapper script.
	return []string{"PATH=" + path, "LANG=C.UTF-8", "LC_ALL=C.UTF-8"}
}

func transcribeLocalASR(ctx context.Context, config localASRConfig, audio io.Reader, mimeType string) (transcript string, retErr error) {
	if ctx == nil || audio == nil {
		return "", providerFailure("ASR_PROVIDER_INVALID_INPUT", "Audio input is unavailable", false)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := validateLocalASRConfig(config); err != nil {
		return "", err
	}
	suffix, err := localASRAudioSuffix(mimeType)
	if err != nil {
		return "", err
	}
	select {
	case localASRSlot <- struct{}{}:
		defer func() { <-localASRSlot }()
	default:
		return "", providerFailure("ASR_PROVIDER_BUSY", "Local speech recognition is busy", true)
	}

	tempDir, err := os.MkdirTemp(config.tempParent, "growdesk-asr-")
	if err != nil {
		return "", providerFailure("ASR_PROVIDER_TEMP_IO_FAILED", "Local speech recognition could not create a private input", true)
	}
	defer func() {
		if cleanupErr := os.RemoveAll(tempDir); cleanupErr != nil {
			transcript = ""
			retErr = providerFailure("ASR_PROVIDER_TEMP_IO_FAILED", "Local speech recognition temporary files could not be removed", false)
		}
	}()
	if err = os.Chmod(tempDir, 0700); err != nil {
		return "", providerFailure("ASR_PROVIDER_TEMP_IO_FAILED", "Local speech recognition could not protect its input", false)
	}

	input, err := os.CreateTemp(tempDir, "input-*"+suffix)
	if err != nil {
		return "", providerFailure("ASR_PROVIDER_TEMP_IO_FAILED", "Local speech recognition could not create a private input", true)
	}
	inputPath := input.Name()
	if err = input.Chmod(0600); err != nil {
		_ = input.Close()
		return "", providerFailure("ASR_PROVIDER_TEMP_IO_FAILED", "Local speech recognition could not protect its input", false)
	}
	written, copyErr := io.Copy(input, io.LimitReader(audio, config.inputLimit+1))
	closeErr := input.Close()
	if copyErr != nil || closeErr != nil {
		return "", providerFailure("ASR_PROVIDER_TEMP_IO_FAILED", "Local speech recognition input could not be written", true)
	}
	if written == 0 {
		return "", providerFailure("ASR_PROVIDER_INVALID_INPUT", "Audio input is empty", false)
	}
	if written > config.inputLimit {
		return "", providerFailure("ASR_PROVIDER_INPUT_TOO_LARGE", "Audio input exceeds the local recognition budget", false)
	}

	argv := make([]string, len(config.argv))
	copy(argv, config.argv)
	for i := 1; i < len(argv); i++ {
		argv[i] = strings.ReplaceAll(argv[i], "{input}", inputPath)
	}

	runCtx, cancel := context.WithTimeout(ctx, config.timeout)
	defer cancel()
	stdout := &localASRStdout{limit: config.outputLimit, cancel: cancel}
	stderr := &localASRStderr{limit: config.stderrLimit, cancel: cancel}
	env := append([]string(nil), config.childEnv...)
	env = append(env, "TMPDIR="+tempDir)
	runErr := runLocalASRWithLimits(runCtx, config, argv, env, stdout, stderr)

	if errors.Is(ctx.Err(), context.Canceled) {
		return "", context.Canceled
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "", providerFailure("ASR_PROVIDER_TIMEOUT", "Local speech recognition timed out", true)
	}
	if stdout.exceeded {
		return "", providerFailure("ASR_PROVIDER_INVALID_RESPONSE", "Local speech recognition output exceeds the byte budget", false)
	}
	if stderr.exceeded {
		return "", providerFailure("ASR_PROVIDER_EXECUTION_FAILED", "Local speech recognizer exceeded its diagnostic output budget", false)
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		return "", providerFailure("ASR_PROVIDER_TIMEOUT", "Local speech recognition timed out", true)
	}
	if runErr != nil {
		return "", providerFailure("ASR_PROVIDER_EXECUTION_FAILED", "Local speech recognition failed", false)
	}
	transcript = strings.TrimSpace(stdout.String())
	return validateLocalASRTranscript(transcript, config.outputLimit)
}

func validateLocalASRTranscript(transcript string, outputLimit int) (string, error) {
	if !utf8.ValidString(transcript) || len(transcript) > outputLimit {
		return "", providerFailure("ASR_PROVIDER_INVALID_RESPONSE", "Local speech recognizer returned no valid transcript", false)
	}
	return validateASRTranscript(transcript)
}

func validateLocalASRConfig(config localASRConfig) error {
	if len(config.argv) < 2 || config.argv[0] == "" || config.timeout <= 0 || config.timeout > localASRTimeout ||
		config.inputLimit <= 0 || config.inputLimit > localASRInputLimit || config.outputLimit <= 0 || config.outputLimit > localASROutputLimit ||
		config.stderrLimit <= 0 || config.stderrLimit > localASRStderrLimit {
		return localASRConfigError("Local speech recognition configuration is invalid")
	}
	if config.limiterPath == "" {
		return localASRConfigError("Local speech recognition requires a validated resource limiter")
	}
	count := 0
	for i, arg := range config.argv {
		if strings.ContainsRune(arg, '\x00') || (i == 0 && strings.Contains(arg, "{input}")) {
			return localASRConfigError("Local speech recognition command is invalid")
		}
		count += strings.Count(arg, "{input}")
	}
	if count != 1 {
		return localASRConfigError("Local speech recognition command must contain one input marker")
	}
	return nil
}

func localASRAudioSuffix(raw string) (string, error) {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(raw))
	if err != nil {
		return "", providerFailure("ASR_PROVIDER_INVALID_INPUT", "Voice input is not a supported audio format", false)
	}
	suffixes := map[string]string{
		"audio/m4a":   ".m4a",
		"audio/mp4":   ".mp4",
		"audio/mpeg":  ".mp3",
		"audio/wav":   ".wav",
		"audio/x-wav": ".wav",
	}
	if suffix, ok := suffixes[strings.ToLower(mediaType)]; ok {
		return suffix, nil
	}
	return "", providerFailure("ASR_PROVIDER_INVALID_INPUT", "Voice input is not a supported audio format", false)
}

type localASRStdout struct {
	bytes.Buffer
	limit    int
	cancel   context.CancelFunc
	exceeded bool
}

func (w *localASRStdout) Write(p []byte) (int, error) {
	remaining := w.limit - w.Len()
	if remaining <= 0 {
		w.exceeded = true
		w.cancel()
		return 0, errors.New("local ASR stdout byte budget exceeded")
	}
	if len(p) > remaining {
		_, _ = w.Buffer.Write(p[:remaining])
		w.exceeded = true
		w.cancel()
		return remaining, errors.New("local ASR stdout byte budget exceeded")
	}
	return w.Buffer.Write(p)
}

type localASRStderr struct {
	limit    int64
	seen     int64
	cancel   context.CancelFunc
	exceeded bool
}

func (w *localASRStderr) Write(p []byte) (int, error) {
	w.seen += int64(len(p))
	if w.seen > w.limit {
		w.exceeded = true
		w.cancel()
	}
	// Drain but never retain or expose diagnostic output.
	return len(p), nil
}

func runLocalASRProcess(ctx context.Context, argv, env []string, stdout, stderr io.Writer) error {
	if len(argv) == 0 || argv[0] == "" {
		return errors.New("empty local ASR argv")
	}
	cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
	cmd.Env = append([]string(nil), env...)
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	configureLocalASRProcessGroup(cmd)
	runErr := cmd.Run()
	if cmd.Process != nil {
		if err := stopLocalASRProcessGroup(cmd.Process.Pid); err != nil && runErr == nil {
			return errors.New("local ASR process group could not be stopped")
		}
	}
	return runErr
}
