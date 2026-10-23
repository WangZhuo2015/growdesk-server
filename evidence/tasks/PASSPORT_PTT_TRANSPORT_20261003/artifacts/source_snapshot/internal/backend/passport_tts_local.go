package backend

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	maxPassportTTSWaveBytes                int64 = 12 * 1024 * 1024
	maxPassportTTSStderr                   int64 = 16 * 1024
	maxPassportTTSLocalCPUSec                    = 110
	maxPassportTTSLocalTimeout                   = 110 * time.Second
	maxLocalSherpaTTSTextBytes                   = 8 * 1024
	localPassportTTSSherpaPythonPath             = "/srv/growdesk-tts/venv/bin/python"
	localPassportTTSSherpaPyVenvConfigPath       = "/srv/growdesk-tts/venv/pyvenv.cfg"
	localPassportTTSSherpaSitePackagesPath       = "/srv/growdesk-tts/venv/lib/python3.12/site-packages"
	localPassportTTSSherpaScriptPath             = "/srv/growdesk-tts/synthesize.py"
)

var localPassportTTSSlot = make(chan struct{}, 1)

func localPassportTTSChildEnvironment(tempDir string) []string {
	return []string{
		"PATH=/usr/bin:/bin",
		"HOME=" + tempDir,
		"TMPDIR=" + tempDir,
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
	}
}

type localPassportTTSConfig struct {
	engine                   string
	espeakPath               string
	sherpaPythonPath         string
	sherpaPythonResolvedPath string
	sherpaScriptPath         string
	ffmpegPath               string
	limiterPath              string
	timeout                  time.Duration
	tempParent               string
}

func passportTTSLocalConfiguration(timeout time.Duration) (localPassportTTSConfig, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	if timeout > maxPassportTTSLocalTimeout {
		timeout = maxPassportTTSLocalTimeout
	}
	config, err := platformPassportTTSLocalConfiguration(timeout)
	if err != nil {
		return localPassportTTSConfig{}, err
	}
	config.engine = "local-espeak"
	return config, nil
}

func passportTTSLocalSherpaConfiguration(timeout time.Duration) (localPassportTTSConfig, error) {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	if timeout > maxPassportTTSLocalTimeout {
		timeout = maxPassportTTSLocalTimeout
	}
	config, err := platformPassportTTSLocalSherpaConfiguration(timeout)
	if err != nil {
		return localPassportTTSConfig{}, err
	}
	config.engine = "local-sherpa"
	return config, nil
}

func validateLocalPassportTTSConfig(config localPassportTTSConfig) error {
	if config.ffmpegPath == "" || config.limiterPath == "" || config.timeout <= 0 || config.timeout > maxPassportTTSLocalTimeout {
		return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local speech synthesis configuration is invalid", false)
	}
	switch config.engine {
	case "local-espeak":
		if config.espeakPath == "" || config.sherpaPythonPath != "" || config.sherpaPythonResolvedPath != "" || config.sherpaScriptPath != "" {
			return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local eSpeak speech synthesis configuration is invalid", false)
		}
	case "local-sherpa":
		if config.espeakPath != "" || config.sherpaPythonPath != localPassportTTSSherpaPythonPath || config.sherpaPythonResolvedPath == "" || config.sherpaScriptPath != localPassportTTSSherpaScriptPath {
			return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local Sherpa speech synthesis configuration is invalid", false)
		}
	default:
		return passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local speech synthesis engine is unsupported", false)
	}
	return nil
}

func synthesizeLocalPassportTTS(ctx context.Context, config localPassportTTSConfig, text string) (pcm []byte, retErr error) {
	maxTextBytes := maxPassportTTSTextBytes
	if config.engine == "local-sherpa" {
		maxTextBytes = maxLocalSherpaTTSTextBytes
	}
	if ctx == nil || strings.TrimSpace(text) == "" || len(text) > maxTextBytes || !utf8.ValidString(text) || strings.ContainsRune(text, '\x00') {
		return nil, passportTTSFailure("TTS_PROVIDER_INVALID_INPUT", "Text to speak is empty, invalid, or too large", false)
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateLocalPassportTTSConfig(config); err != nil {
		return nil, err
	}
	select {
	case localPassportTTSSlot <- struct{}{}:
		defer func() { <-localPassportTTSSlot }()
	default:
		return nil, passportTTSFailure("TTS_PROVIDER_BUSY", "Local speech synthesis is busy", true)
	}

	tempDir, err := os.MkdirTemp(config.tempParent, "growdesk-tts-")
	if err != nil {
		return nil, passportTTSFailure("TTS_PROVIDER_TEMP_IO_FAILED", "Local speech synthesis could not create private temporary storage", true)
	}
	defer func() {
		if cleanupErr := os.RemoveAll(tempDir); cleanupErr != nil {
			pcm = nil
			retErr = passportTTSFailure("TTS_PROVIDER_TEMP_IO_FAILED", "Local speech synthesis temporary files could not be removed", false)
		}
	}()
	if err = os.Chmod(tempDir, 0700); err != nil {
		return nil, passportTTSFailure("TTS_PROVIDER_TEMP_IO_FAILED", "Local speech synthesis could not protect temporary storage", false)
	}

	requestCtx, cancel := context.WithTimeout(ctx, config.timeout)
	defer cancel()
	if err := requestCtx.Err(); err != nil {
		return nil, localPassportTTSCtxError(ctx, requestCtx, err)
	}

	waveFile, err := os.CreateTemp(tempDir, "speech-*.wav")
	if err != nil {
		return nil, passportTTSFailure("TTS_PROVIDER_TEMP_IO_FAILED", "Local speech synthesis could not create its private wave file", true)
	}
	if err = waveFile.Chmod(0600); err != nil {
		_ = waveFile.Close()
		return nil, passportTTSFailure("TTS_PROVIDER_TEMP_IO_FAILED", "Local speech synthesis could not protect its wave file", false)
	}
	wavePath := waveFile.Name()
	waveWriter := &localPassportTTSBoundedWriter{writer: waveFile, limit: maxPassportTTSWaveBytes}
	var waveErr error
	switch config.engine {
	case "local-espeak":
		waveArgs := []string{"--stdin", "--stdout", "-v", "cmn"}
		waveErr = runLocalPassportTTSStep(requestCtx, config, config.espeakPath, waveArgs, strings.NewReader(text), waveWriter, tempDir)
	case "local-sherpa":
		waveArgs := []string{"-I", config.sherpaScriptPath}
		waveErr = runLocalPassportTTSStep(requestCtx, config, config.sherpaPythonPath, waveArgs, strings.NewReader(text), waveWriter, tempDir)
	default:
		return nil, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local speech synthesis engine is unsupported", false)
	}
	if waveErr != nil {
		_ = waveFile.Close()
		return nil, waveErr
	}
	if err := waveFile.Sync(); err != nil {
		_ = waveFile.Close()
		return nil, passportTTSFailure("TTS_PROVIDER_TEMP_IO_FAILED", "Local speech synthesis wave output could not be finalized", true)
	}
	if err := waveFile.Close(); err != nil {
		return nil, passportTTSFailure("TTS_PROVIDER_TEMP_IO_FAILED", "Local speech synthesis wave output could not be closed", true)
	}
	if waveWriter.written == 0 {
		return nil, passportTTSFailure("TTS_PROVIDER_INVALID_RESPONSE", "Local speech synthesis returned no wave audio", false)
	}

	pcmBuffer := &bytes.Buffer{}
	pcmWriter := &localPassportTTSBoundedWriter{writer: pcmBuffer, limit: maxPassportTTSOutputBytes}
	ffmpegArgs := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1", "-filter_threads", "1", "-i", wavePath, "-map_metadata", "-1", "-threads", "1", "-f", "s16le", "-acodec", "pcm_s16le", "-ar", "24000", "-ac", "1", "pipe:1"}
	if err := runLocalPassportTTSStep(requestCtx, config, config.ffmpegPath, ffmpegArgs, nil, pcmWriter, tempDir); err != nil {
		return nil, err
	}
	pcm = pcmBuffer.Bytes()
	if !validLocalPassportTTSPCM(pcm) {
		return nil, passportTTSFailure("TTS_PROVIDER_INVALID_RESPONSE", "Local speech synthesis returned empty or invalid PCM audio", false)
	}
	return pcm, nil
}

func localPassportTTSCtxError(parent, request context.Context, err error) error {
	if errors.Is(parent.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	if errors.Is(parent.Err(), context.DeadlineExceeded) || errors.Is(request.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) {
		return passportTTSFailure("TTS_PROVIDER_TIMEOUT", "Local speech synthesis timed out", true)
	}
	return passportTTSFailure("TTS_PROVIDER_EXECUTION_FAILED", "Local speech synthesis failed", false)
}

func validLocalPassportTTSPCM(pcm []byte) bool {
	if len(pcm) == 0 || len(pcm) > maxPassportTTSOutputBytes || len(pcm)%2 != 0 || bytes.HasPrefix(pcm, []byte("RIFF")) {
		return false
	}
	return true
}

type localPassportTTSBoundedWriter struct {
	writer   io.Writer
	limit    int64
	written  int64
	cancel   context.CancelFunc
	exceeded bool
}

func (w *localPassportTTSBoundedWriter) Write(p []byte) (int, error) {
	remaining := w.limit - w.written
	if remaining <= 0 {
		w.exceeded = true
		if w.cancel != nil {
			w.cancel()
		}
		return 0, errors.New("local TTS byte budget exceeded")
	}
	if int64(len(p)) > remaining {
		n, err := w.writer.Write(p[:remaining])
		w.written += int64(n)
		w.exceeded = true
		if w.cancel != nil {
			w.cancel()
		}
		if err != nil {
			return n, err
		}
		return n, errors.New("local TTS byte budget exceeded")
	}
	n, err := w.writer.Write(p)
	w.written += int64(n)
	return n, err
}

type localPassportTTSStderr struct {
	seen     int64
	limit    int64
	cancel   context.CancelFunc
	exceeded bool
}

func (w *localPassportTTSStderr) Write(p []byte) (int, error) {
	w.seen += int64(len(p))
	if w.seen > w.limit {
		w.exceeded = true
		if w.cancel != nil {
			w.cancel()
		}
	}
	// Diagnostics are drained to avoid pipe deadlocks, never retained or exposed.
	return len(p), nil
}
