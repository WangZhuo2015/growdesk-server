package backend

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func clearSpeechTestEnvironment(t *testing.T) {
	t.Helper()
	for _, name := range []string{
		"ASR_COMMAND", "GROWDESK_ASR_PROVIDER", "GROWDESK_ASR_BASE_URL", "GROWDESK_ASR_API_KEY", "GROWDESK_ASR_MODEL", "GROWDESK_ASR_TIMEOUT_MS",
		"GROWDESK_AI_PROVIDER", "GROWDESK_AI_BASE_URL", "GROWDESK_AI_API_KEY", "GROWDESK_AI_MODEL", "GROWDESK_AI_TIMEOUT_MS",
		"GROWDESK_AI_FIXTURE_RESPONSE", "GROWDESK_AI_FIXTURE_TEXT", "GROWDESK_ASR_FIXTURE_TEXT",
		"AI_BASE_URL", "AI_API_KEY", "AI_MODEL", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL", "OPENROUTER_API_KEY", "OPENROUTER_MODEL",
	} {
		t.Setenv(name, "")
	}
}

func TestSpeechMissingConfigurationDoesNotInventTranscript(t *testing.T) {
	clearSpeechTestEnvironment(t)
	_, err := nativeSpeechConfiguration()
	var failure *nativeProviderError
	if !errors.As(err, &failure) || failure.Code != "ASR_PROVIDER_NOT_CONFIGURED" {
		t.Fatalf("missing speech configuration = %v, want explicit ASR_PROVIDER_NOT_CONFIGURED", err)
	}
}

func TestPassportSpeechCanTranscribeBeforeMissingChatConfiguration(t *testing.T) {
	clearSpeechTestEnvironment(t)
	calls := 0
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/v1/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer test_asr_key" {
			t.Errorf("unexpected isolated ASR request %s", r.URL.Path)
		}
		_, _ = io.WriteString(w, `{"text":"test spoken text"}`)
	}))
	defer provider.Close()
	t.Setenv("GROWDESK_ASR_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_ASR_BASE_URL", provider.URL+"/v1/audio/transcriptions")
	t.Setenv("GROWDESK_ASR_API_KEY", "test_asr_key")
	var events []Object
	// A nil DB proves this missing-chat path cannot reach a history/record write.
	(&Server{}).processVoiceTurn(context.Background(), nil, "", "", "test_turn", []byte("test wav"),
		func(raw any) error { events = append(events, raw.(Object)); return nil },
		func([]byte) error { t.Fatal("unexpected TTS on a missing chat configuration"); return nil },
		&passportPlaybackControl{}, nil, &passportPending[pendingCardProposal]{})
	if calls != 1 || len(events) != 2 || events[0]["type"] != "asr.final" || events[0]["text"] != "test spoken text" ||
		events[1]["code"] != "AI_PROVIDER_NOT_CONFIGURED" {
		t.Fatalf("speech/chat separation: calls=%d events=%#v", calls, events)
	}
}

func TestPassportCancelledVoiceCannotEmitStaleProviderErrors(t *testing.T) {
	clearSpeechTestEnvironment(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	(&Server{}).processVoiceTurn(ctx, nil, "", "", "test_old_turn", []byte("test wav"),
		func(any) error { t.Fatal("cancelled turn emitted a stale result/error"); return nil },
		func([]byte) error { t.Fatal("cancelled turn emitted audio"); return nil },
		&passportPlaybackControl{}, nil, &passportPending[pendingCardProposal]{})
}

func TestSpeechExplicitHTTPConfigurationRejectsInvalidInputs(t *testing.T) {
	for _, endpoint := range []string{"", "file:///tmp/test", "https://test:password@example.invalid/v1", "https://example.invalid/v1?key=test", "https://example.invalid/v1#test"} {
		t.Run(endpoint, func(t *testing.T) {
			clearSpeechTestEnvironment(t)
			t.Setenv("GROWDESK_ASR_PROVIDER", "openai-compatible")
			t.Setenv("GROWDESK_ASR_BASE_URL", endpoint)
			t.Setenv("GROWDESK_ASR_API_KEY", "test_asr_key")
			_, err := nativeSpeechConfiguration()
			var failure *nativeProviderError
			if !errors.As(err, &failure) || failure.Code != "ASR_PROVIDER_CONFIG_INVALID" || strings.Contains(err.Error(), "password") {
				t.Fatalf("invalid speech config = %v", err)
			}
		})
	}
}

func TestLegacyExplicitChatEnvironmentCompatibility(t *testing.T) {
	clearSpeechTestEnvironment(t)
	t.Setenv("AI_BASE_URL", "https://test-provider.invalid/v1")
	t.Setenv("AI_API_KEY", "test_chat_key")
	t.Setenv("AI_MODEL", "test_chat_model")
	c, err := nativeProviderConfiguration()
	if err != nil || c.Endpoint != "https://test-provider.invalid/v1/chat/completions" || c.Model != "test_chat_model" || c.APIKey != "test_chat_key" {
		t.Fatalf("legacy explicit chat config rejected: %#v %v", c, err)
	}
}

func TestChatKeyAloneDoesNotChooseAnUnconfiguredProvider(t *testing.T) {
	clearSpeechTestEnvironment(t)
	t.Setenv("AI_API_KEY", "test_chat_key")
	_, err := nativeProviderConfiguration()
	var failure *APIError
	if !errors.As(err, &failure) || failure.Code != "AI_PROVIDER_NOT_CONFIGURED" {
		t.Fatalf("a key alone chose an unconfigured provider: %v", err)
	}
}

func TestSpeechSubmissionPreservesMissingConfiguration503(t *testing.T) {
	err := speechSubmissionError(providerFailure("ASR_PROVIDER_NOT_CONFIGURED", "Speech is not configured", false))
	app := normalizedError(err)
	if app.Status != 503 || app.Code != "ASR_PROVIDER_NOT_CONFIGURED" {
		t.Fatalf("speech preflight became an opaque error: %#v", app)
	}
}

func TestChatConfigurationAloneDoesNotImplySpeechSupport(t *testing.T) {
	clearSpeechTestEnvironment(t)
	t.Setenv("GROWDESK_AI_PROVIDER", "compat")
	t.Setenv("GROWDESK_AI_BASE_URL", "https://test-chat.invalid/v1")
	t.Setenv("GROWDESK_AI_API_KEY", "test_chat_key")
	_, err := nativeSpeechConfiguration()
	var failure *nativeProviderError
	if !errors.As(err, &failure) || failure.Code != "ASR_PROVIDER_NOT_CONFIGURED" {
		t.Fatalf("chat-only endpoint was assumed to provide speech: %v", err)
	}
	t.Setenv("GROWDESK_ASR_PROVIDER", "shared")
	c, err := nativeSpeechConfiguration()
	if err != nil || c.Endpoint != "https://test-chat.invalid/v1/chat/completions" {
		t.Fatalf("explicit shared speech configuration = %#v, %v", c, err)
	}
}

func TestChatExplicitNewConfigurationWinsOverLegacy(t *testing.T) {
	clearSpeechTestEnvironment(t)
	t.Setenv("AI_BASE_URL", "https://test-legacy.invalid/v1")
	t.Setenv("AI_API_KEY", "test_legacy_key")
	t.Setenv("AI_MODEL", "test_legacy_model")
	t.Setenv("GROWDESK_AI_PROVIDER", "compat")
	t.Setenv("GROWDESK_AI_BASE_URL", "https://test-new.invalid/v1")
	t.Setenv("GROWDESK_AI_API_KEY", "test_new_key")
	t.Setenv("GROWDESK_AI_MODEL", "test_new_model")
	c, err := nativeProviderConfiguration()
	if err != nil || c.Endpoint != "https://test-new.invalid/v1/chat/completions" || c.Model != "test_new_model" || c.APIKey != "test_new_key" {
		t.Fatalf("explicit new provider lost precedence: %#v %v", c, err)
	}
}
