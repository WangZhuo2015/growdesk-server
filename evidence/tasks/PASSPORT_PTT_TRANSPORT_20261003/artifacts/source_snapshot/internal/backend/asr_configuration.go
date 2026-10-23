package backend

import (
	"context"
	"errors"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// Speech has its own administrator configuration. A local recognizer does not
// require a chat-provider key or an /audio/transcriptions route on a chat host.
func nativeSpeechConfiguration() (nativeProviderConfig, error) {
	_, enabled, err := localASRConfiguration()
	if err != nil {
		return nativeProviderConfig{}, err
	}
	if enabled {
		return nativeProviderConfig{Mode: "local"}, nil
	}
	mode := strings.ToLower(strings.TrimSpace(os.Getenv("GROWDESK_ASR_PROVIDER")))
	if mode == "openai-compatible" || mode == "openai" || mode == "compat" {
		c := nativeProviderConfig{Mode: "openai-compatible", Timeout: 110 * time.Second,
			ASRModel: strings.TrimSpace(os.Getenv("GROWDESK_ASR_MODEL"))}
		c.APIKey = firstConfigured("GROWDESK_ASR_API_KEY")
		if raw := os.Getenv("GROWDESK_ASR_TIMEOUT_MS"); raw != "" {
			n, e := strconv.ParseInt(raw, 10, 64)
			if e != nil || n < 100 || n > 180000 {
				return c, providerFailure("ASR_PROVIDER_CONFIG_INVALID", "Speech timeout must be between 100 and 180000 milliseconds", false)
			}
			c.Timeout = time.Duration(n) * time.Millisecond
		}
		u, e := url.Parse(strings.TrimSpace(os.Getenv("GROWDESK_ASR_BASE_URL")))
		if e != nil || u.Hostname() == "" || (u.Scheme != "https" && u.Scheme != "http") ||
			u.User != nil || u.RawQuery != "" || u.Fragment != "" || c.APIKey == "" {
			return c, providerFailure("ASR_PROVIDER_CONFIG_INVALID", "Configure a speech endpoint and key for the approved recognizer", false)
		}
		u.Path = strings.TrimRight(u.Path, "/")
		u.Path = strings.TrimSuffix(u.Path, "/audio/transcriptions")
		u.Path = strings.TrimSuffix(u.Path, "/chat/completions")
		u.RawPath = ""
		// The existing WAV/attachment adapters derive their speech URL from this
		// internal base. This value is never used for the chat stage.
		c.Endpoint = u.String() + "/chat/completions"
		if c.ASRModel == "" {
			c.ASRModel = "whisper-1"
		}
		return c, nil
	}
	// Chat compatibility does not prove that a host exposes speech routes.
	// Shared endpoints require a separate administrator opt-in.
	if mode != "shared" && strings.ToLower(strings.TrimSpace(os.Getenv("GROWDESK_AI_PROVIDER"))) != "fixture" {
		return nativeProviderConfig{}, providerFailure("ASR_PROVIDER_NOT_CONFIGURED", "Configure the existing ASR_COMMAND or an approved speech provider on the Go service", false)
	}
	c, err := nativeProviderConfiguration()
	if err != nil {
		var app *APIError
		if errors.As(err, &app) && app.Code == "AI_PROVIDER_CONFIG_INVALID" {
			return c, providerFailure("ASR_PROVIDER_CONFIG_INVALID", "The shared speech provider configuration is invalid", false)
		}
		return c, providerFailure("ASR_PROVIDER_NOT_CONFIGURED", "Configure the existing ASR_COMMAND or an approved speech provider on the Go service", false)
	}
	if mode == "shared" && c.Mode != "openai-compatible" {
		return c, providerFailure("ASR_PROVIDER_CONFIG_INVALID", "Shared speech requires an explicitly configured compatible provider", false)
	}
	return c, nil
}

func firstConfigured(names ...string) string {
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			return value
		}
	}
	return ""
}

func speechSubmissionError(err error) error {
	var failure *nativeProviderError
	if errors.As(err, &failure) && strings.HasPrefix(failure.Code, "ASR_PROVIDER_") {
		status := 503
		if failure.Code == "ASR_PROVIDER_CONFIG_INVALID" {
			status = 500
		}
		return apiError(status, failure.Code, failure.Message)
	}
	return err
}

func passportAIErrorEvent(err error) Object {
	code, message := "AGENT_FAILED", "AI assistant processing failed"
	if errors.Is(err, context.DeadlineExceeded) {
		return Object{"v": 1, "type": "error", "code": "AI_PROVIDER_TIMEOUT", "message": "AI provider request timed out"}
	}
	var app *APIError
	var provider *nativeProviderError
	if errors.As(err, &app) && strings.HasPrefix(app.Code, "AI_PROVIDER_") {
		code, message = app.Code, app.Message
	} else if errors.As(err, &provider) && strings.HasPrefix(provider.Code, "AI_PROVIDER_") {
		code, message = provider.Code, provider.Message
	}
	return Object{"v": 1, "type": "error", "code": code, "message": message}
}
