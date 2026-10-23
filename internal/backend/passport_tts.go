package backend

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	maxPassportTTSTextBytes   = 256 * 1024
	maxPassportTTSOutputBytes = 8 * 1024 * 1024
	passportTTSChunkBytes     = 1920 // 40 ms of 24 kHz, 16-bit, mono PCM.
)

type passportTTSConfig struct {
	Mode     string
	Endpoint string
	APIKey   string
	Model    string
	Voice    string
	Timeout  time.Duration
	Local    localPassportTTSConfig
}

func passportTTSFailure(code, message string, retryable bool) error {
	return providerFailure(code, message, retryable)
}

// passportTTSConfiguration keeps speech output independently configurable.
// Reusing the common provider requires the explicit "shared" selector; a
// dedicated endpoint may reuse its key only when its canonical audio URL is
// identical to the compatible common provider's canonical audio URL.
func passportTTSConfiguration(common nativeProviderConfig) (passportTTSConfig, error) {
	c := passportTTSConfig{
		Timeout: common.Timeout,
		Model:   strings.TrimSpace(os.Getenv("GROWDESK_TTS_MODEL")),
		Voice:   strings.TrimSpace(os.Getenv("GROWDESK_TTS_VOICE")),
	}
	if c.Timeout <= 0 {
		c.Timeout = 10 * time.Second
	}
	if raw := strings.TrimSpace(os.Getenv("GROWDESK_TTS_TIMEOUT_MS")); raw != "" {
		millis, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || millis < 100 || millis > 180000 {
			return c, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "TTS timeout must be between 100 and 180000 milliseconds", false)
		}
		c.Timeout = time.Duration(millis) * time.Millisecond
	}

	provider := strings.ToLower(strings.TrimSpace(os.Getenv("GROWDESK_TTS_PROVIDER")))
	baseURL := strings.TrimSpace(os.Getenv("GROWDESK_TTS_BASE_URL"))
	apiKey := strings.TrimSpace(os.Getenv("GROWDESK_TTS_API_KEY"))
	if provider == "" {
		if common.Mode == "fixture" && baseURL == "" && apiKey == "" {
			provider = "fixture"
		} else if baseURL != "" || apiKey != "" {
			provider = "openai-compatible"
		} else {
			return c, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "Set GROWDESK_TTS_PROVIDER=shared or configure a dedicated TTS provider", false)
		}
	}
	if provider == "openai" || provider == "compat" {
		provider = "openai-compatible"
	}
	if provider == "local" {
		provider = "local-espeak"
	}
	if provider == "local-espeak" {
		if baseURL != "" || apiKey != "" || c.Model != "" || (c.Voice != "" && !strings.EqualFold(c.Voice, "cmn")) {
			return c, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local eSpeak TTS accepts only the cmn voice and no remote endpoint or model", false)
		}
		local, err := passportTTSLocalConfiguration(c.Timeout)
		if err != nil {
			return c, err
		}
		c.Mode = "local-espeak"
		c.Voice = "cmn"
		c.Local = local
		return c, nil
	}
	if provider == "local-sherpa" {
		if baseURL != "" || apiKey != "" || c.Model != "" || (c.Voice != "" && !strings.EqualFold(c.Voice, "zh")) {
			return c, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Local Sherpa TTS accepts only the zh voice and no remote endpoint, credentials, or model", false)
		}
		local, err := passportTTSLocalSherpaConfiguration(c.Timeout)
		if err != nil {
			return c, err
		}
		c.Mode = "local-sherpa"
		c.Voice = "zh"
		c.Local = local
		return c, nil
	}
	if provider == "fixture" {
		if common.Mode != "fixture" {
			return c, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "TTS fixtures require the explicit AI fixture provider", false)
		}
		c.Mode = "fixture"
		return c, nil
	}
	if provider == "shared" {
		if common.Mode != "openai-compatible" || common.Endpoint == "" || common.APIKey == "" || baseURL != "" || apiKey != "" {
			return c, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "Shared TTS requires the configured compatible common provider and no separate endpoint credentials", false)
		}
		baseURL = common.Endpoint
		apiKey = common.APIKey
		provider = "openai-compatible"
	}
	if provider != "openai-compatible" {
		return c, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "Unsupported TTS provider", false)
	}

	if baseURL == "" {
		return c, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "Configure GROWDESK_TTS_BASE_URL and GROWDESK_TTS_API_KEY", false)
	}
	endpoint, err := passportTTSEndpoint(baseURL)
	if err != nil {
		return c, err
	}
	if apiKey == "" && common.Mode == "openai-compatible" && common.Endpoint != "" && common.APIKey != "" {
		commonEndpoint, commonErr := passportTTSEndpoint(common.Endpoint)
		if commonErr == nil && endpoint == commonEndpoint {
			apiKey = common.APIKey
		}
	}
	if apiKey == "" {
		return c, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "Configure a TTS API key for this endpoint", false)
	}
	if len(apiKey) > 4096 || strings.ContainsAny(apiKey, "\r\n") {
		return c, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "TTS API key is invalid", false)
	}
	if len(c.Model) > 128 || len(c.Voice) > 64 || strings.ContainsAny(c.Model, "\r\n") || strings.ContainsAny(c.Voice, "\r\n") {
		return c, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "TTS model or voice is invalid", false)
	}
	if c.Model == "" {
		c.Model = "tts-1"
	}
	if c.Voice == "" {
		c.Voice = "alloy"
	}
	c.Mode = "openai-compatible"
	c.Endpoint = endpoint
	c.APIKey = apiKey
	return c, nil
}

func passportTTSEndpoint(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "TTS base URL is invalid", false)
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "TTS base URL is invalid", false)
	}
	hostname, port := strings.ToLower(u.Hostname()), u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		u.Host = net.JoinHostPort(hostname, port)
	} else if strings.Contains(hostname, ":") {
		u.Host = "[" + hostname + "]"
	} else {
		u.Host = hostname
	}
	path := strings.TrimRight(u.Path, "/")
	if strings.HasSuffix(path, "/audio/speech") {
		u.Path = path
		u.RawPath = ""
		return u.String(), nil
	}
	path = strings.TrimSuffix(path, "/chat/completions")
	u.Path = strings.TrimRight(path, "/") + "/audio/speech"
	u.RawPath = ""
	return u.String(), nil
}

func passportTTSErrorEvent(turnID string, err error) Object {
	code, message := "TTS_PROVIDER_FAILED", "Speech generation failed"
	switch {
	case errors.Is(err, context.Canceled):
		code, message = "TTS_PROVIDER_CANCELLED", "Speech generation was cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		code, message = "TTS_PROVIDER_TIMEOUT", "Speech provider request timed out"
	default:
		var providerErr *nativeProviderError
		if errors.As(err, &providerErr) && strings.HasPrefix(providerErr.Code, "TTS_PROVIDER_") {
			code, message = providerErr.Code, providerErr.Message
		}
	}
	return Object{"v": 1, "type": "error", "turnId": turnID, "code": code, "message": message}
}

// synthesizePassportTTS buffers only within a strict byte budget so the
// caller can reject an empty, malformed, or truncated PCM stream before
// telling the client that playback has started.
func synthesizePassportTTS(ctx context.Context, c passportTTSConfig, text string) ([]byte, error) {
	if strings.TrimSpace(text) == "" || len(text) > maxPassportTTSTextBytes {
		return nil, passportTTSFailure("TTS_PROVIDER_INVALID_INPUT", "Text to speak is empty or too large", false)
	}
	if c.Mode == "local-espeak" || c.Mode == "local-sherpa" {
		return synthesizeLocalPassportTTS(ctx, c.Local, text)
	}
	if c.Mode == "fixture" {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}
		return make([]byte, 24000*2/10), nil // Explicit fixture: 100 ms of silence.
	}
	if c.Mode != "openai-compatible" || c.Endpoint == "" || c.APIKey == "" {
		return nil, passportTTSFailure("TTS_PROVIDER_NOT_CONFIGURED", "Configure a compatible TTS provider", false)
	}
	if c.Timeout <= 0 {
		c.Timeout = 10 * time.Second
	}
	requestContext, cancel := context.WithTimeout(ctx, c.Timeout)
	defer cancel()
	body, err := jsonBytes(Object{
		"model":           c.Model,
		"input":           text,
		"voice":           c.Voice,
		"response_format": "pcm",
	})
	if err != nil {
		return nil, passportTTSFailure("TTS_PROVIDER_REQUEST_FAILED", "Speech request could not be prepared", false)
	}
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, c.Endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, passportTTSFailure("TTS_PROVIDER_CONFIG_INVALID", "TTS endpoint is invalid", false)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "audio/pcm, application/octet-stream")
	request.Header.Set("Authorization", "Bearer "+c.APIKey)
	client := providerHTTPClient(c.Timeout)
	return synthesizePassportTTSWithClient(requestContext, c, request, client)
}

func synthesizePassportTTSWithClient(ctx context.Context, c passportTTSConfig, request *http.Request, client *http.Client) ([]byte, error) {
	defer client.CloseIdleConnections()
	response, err := client.Do(request)
	if err != nil {
		return nil, passportTTSTransportError(ctx, err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		code := "TTS_PROVIDER_HTTP_ERROR"
		message := "Speech provider returned HTTP " + strconv.Itoa(response.StatusCode)
		if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
			code = "TTS_PROVIDER_AUTH_FAILED"
			message = "Speech provider authentication failed (HTTP " + strconv.Itoa(response.StatusCode) + ")"
		}
		retryable := response.StatusCode == http.StatusRequestTimeout || response.StatusCode == http.StatusConflict || response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500
		return nil, passportTTSFailure(code, message, retryable)
	}
	if !passportTTSContentTypeAllowed(response.Header.Get("Content-Type")) {
		return nil, passportTTSFailure("TTS_PROVIDER_INVALID_RESPONSE", "Speech provider returned an unsupported audio format", false)
	}
	pcm, err := io.ReadAll(io.LimitReader(response.Body, maxPassportTTSOutputBytes+1))
	if err != nil {
		if ctx.Err() != nil {
			return nil, passportTTSTransportError(ctx, err)
		}
		return nil, passportTTSFailure("TTS_PROVIDER_RESPONSE_READ_FAILED", "Speech provider response could not be read", true)
	}
	if len(pcm) == 0 || len(pcm) > maxPassportTTSOutputBytes || len(pcm)%2 != 0 || bytes.HasPrefix(pcm, []byte("RIFF")) {
		return nil, passportTTSFailure("TTS_PROVIDER_INVALID_RESPONSE", "Speech provider returned empty or invalid PCM audio", false)
	}
	// Raw PCM has no self-describing header, so the size, alignment and media
	// metadata checks cannot prove the bytes contain meaningful audio samples.
	return pcm, nil
}

func passportTTSContentTypeAllowed(raw string) bool {
	if strings.TrimSpace(raw) == "" {
		return false
	}
	mediaType, params, err := mime.ParseMediaType(raw)
	if err != nil {
		return false
	}
	switch strings.ToLower(mediaType) {
	case "audio/pcm", "audio/raw", "audio/x-pcm", "application/octet-stream", "application/binary":
	default:
		return false
	}
	for key, value := range params {
		value = strings.ToLower(strings.TrimSpace(value))
		switch strings.ToLower(key) {
		case "rate", "samplerate", "sample-rate", "sampling-rate":
			if value != "24000" {
				return false
			}
		case "channels", "channel":
			if value != "1" {
				return false
			}
		case "bits", "bit-depth", "bits-per-sample":
			if value != "16" {
				return false
			}
		case "endianness", "endian", "byte-order":
			if value != "little" && value != "little-endian" && value != "le" {
				return false
			}
		case "encoding", "format":
			if value != "s16le" && value != "pcm_s16le" && value != "signed-16le" {
				return false
			}
		case "layout", "channel-layout":
			if value != "mono" {
				return false
			}
		}
	}
	return true
}

func passportTTSTransportError(ctx context.Context, err error) error {
	if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
		return context.Canceled
	}
	var networkError interface{ Timeout() bool }
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
		return passportTTSFailure("TTS_PROVIDER_TIMEOUT", "Speech provider request timed out", true)
	}
	return passportTTSFailure("TTS_PROVIDER_NETWORK_ERROR", "Speech provider connection failed", true)
}

// streamPassportTTS validates provider output before emitting tts.start, then
// preserves the existing 24 kHz mono PCM event and binary-chunk contract.
func (s *Server) streamPassportTTS(ctx context.Context, common nativeProviderConfig, turnID, textToSpeak string, sendJSON func(any) error, sendBinary func([]byte) error) {
	diagnostic := passportSpeechDiagnostic{phase: "configuration", started: time.Now()}
	defer s.logPassportSpeechOutcome(&diagnostic)
	config, err := passportTTSConfiguration(common)
	if err != nil {
		diagnostic.failure("configuration", err)
		_ = sendJSON(passportTTSErrorEvent(turnID, err))
		return
	}
	diagnostic.provider = config.Mode
	pcm, err := synthesizePassportTTS(ctx, config, textToSpeak)
	if err != nil {
		diagnostic.failure("synthesis", err)
		if errors.Is(ctx.Err(), context.Canceled) || errors.Is(err, context.Canceled) {
			return
		}
		_ = sendJSON(passportTTSErrorEvent(turnID, err))
		return
	}
	diagnostic.pcmBytes = len(pcm)
	diagnostic.peakAmplitude = passportPCMPeak(pcm)
	select {
	case <-ctx.Done():
		diagnostic.failure("before_start", ctx.Err())
		if !errors.Is(ctx.Err(), context.Canceled) {
			_ = sendJSON(passportTTSErrorEvent(turnID, ctx.Err()))
		}
		return
	default:
	}
	if err := sendJSON(Object{
		"v":      1,
		"type":   "tts.start",
		"turnId": turnID,
		"audioFormat": Object{
			"codec":      "pcm_s16le",
			"sampleRate": 24000,
			"channels":   1,
		},
	}); err != nil {
		diagnostic.sendFailure(ctx, "start")
		return
	}
	for offset := 0; offset < len(pcm); {
		select {
		case <-ctx.Done():
			diagnostic.failure("stream", ctx.Err())
			if !errors.Is(ctx.Err(), context.Canceled) {
				_ = sendJSON(passportTTSErrorEvent(turnID, ctx.Err()))
			}
			return
		default:
		}
		end := offset + passportTTSChunkBytes
		if end > len(pcm) {
			end = len(pcm)
		}
		chunkSize := end - offset
		chunkStarted := time.Now()
		if err := sendBinary(pcm[offset:end]); err != nil {
			diagnostic.sendFailure(ctx, "stream")
			if ctx.Err() == nil {
				_ = sendJSON(passportTTSErrorEventWithCode(turnID, "WS_AUDIO_SEND_FAILED", "Speech audio could not be sent"))
			}
			return
		}
		diagnostic.sentBytes += chunkSize
		diagnostic.chunks++
		offset = end
		if delay := passportTTSPacingDelay(chunkSize, time.Since(chunkStarted)); delay > 0 {
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				diagnostic.failure("stream", ctx.Err())
				timer.Stop()
				if !errors.Is(ctx.Err(), context.Canceled) {
					_ = sendJSON(passportTTSErrorEvent(turnID, ctx.Err()))
				}
				return
			case <-timer.C:
			}
		}
	}
	if err := sendJSON(Object{"v": 1, "type": "tts.end", "turnId": turnID}); err != nil {
		diagnostic.sendFailure(ctx, "end")
		return
	}
	diagnostic.phase = "complete"
}

func passportTTSChunkDuration(byteCount int) time.Duration {
	if byteCount <= 0 || byteCount%2 != 0 {
		return 0
	}
	return time.Duration(byteCount/2) * time.Second / 24000
}

func passportTTSPacingDelay(byteCount int, writeDuration time.Duration) time.Duration {
	remaining := passportTTSChunkDuration(byteCount) - writeDuration
	if remaining < 0 {
		return 0
	}
	return remaining
}

func passportTTSErrorEventWithCode(turnID, code, message string) Object {
	return Object{"v": 1, "type": "error", "turnId": turnID, "code": code, "message": message}
}
