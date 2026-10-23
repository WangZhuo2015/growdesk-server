package backend

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPassportASRRejectsNon2xxEvenWhenBodyLooksLikeTranscript(t *testing.T) {
	tests := []struct {
		name      string
		status    int
		code      string
		retryable bool
	}{
		{name: "unauthorized", status: http.StatusUnauthorized, code: "ASR_PROVIDER_AUTH_FAILED"},
		{name: "forbidden", status: http.StatusForbidden, code: "ASR_PROVIDER_AUTH_FAILED"},
		{name: "not found", status: http.StatusNotFound, code: "ASR_PROVIDER_HTTP_ERROR"},
		{name: "rate limited", status: http.StatusTooManyRequests, code: "ASR_PROVIDER_HTTP_ERROR", retryable: true},
		{name: "server error", status: http.StatusBadGateway, code: "ASR_PROVIDER_HTTP_ERROR", retryable: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v1/audio/transcriptions" {
					t.Errorf("provider request = %s %s, want POST /v1/audio/transcriptions", r.Method, r.URL.Path)
				}
				if got := r.Header.Get("Authorization"); got != "Bearer virtual-test-key" {
					t.Errorf("authorization header = %q, want virtual test key", got)
				}
				if !strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/form-data;") {
					t.Errorf("content type = %q, want multipart form", r.Header.Get("Content-Type"))
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.status)
				_, _ = io.WriteString(w, `{"text":"must-not-be-accepted","error":{"message":"provider-private-secret"}}`)
			}))
			defer server.Close()

			config := nativeProviderConfig{
				Mode:     "openai-compatible",
				Endpoint: server.URL + "/v1/chat/completions",
				APIKey:   "virtual-test-key",
				ASRModel: "test-asr-model",
				Timeout:  time.Second,
			}
			transcript, err := (&Server{}).transcribePassportWav(context.Background(), config, []byte("test wav"))
			if err == nil {
				t.Fatalf("non-2xx HTTP %d accepted transcript %q", tt.status, transcript)
			}
			if transcript != "" {
				t.Fatalf("non-2xx HTTP %d returned transcript %q", tt.status, transcript)
			}
			var providerErr *nativeProviderError
			if !errors.As(err, &providerErr) {
				t.Fatalf("error %T %v is not a typed provider failure", err, err)
			}
			if providerErr.Code != tt.code {
				t.Fatalf("provider code = %q, want %q", providerErr.Code, tt.code)
			}
			if !strings.Contains(providerErr.Message, fmt.Sprintf("HTTP %d", tt.status)) {
				t.Fatalf("provider message %q omits exact HTTP status", providerErr.Message)
			}
			if strings.Contains(providerErr.Message, "provider-private-secret") {
				t.Fatalf("provider response body leaked in error message: %q", providerErr.Message)
			}
			if providerErr.Retryable != tt.retryable {
				t.Fatalf("retryable = %v, want %v", providerErr.Retryable, tt.retryable)
			}
			event := passportASRErrorEvent(err)
			if event["code"] != tt.code || !strings.Contains(text(event["message"]), fmt.Sprintf("HTTP %d", tt.status)) {
				t.Fatalf("device error event did not preserve the safe cause: %#v", event)
			}
			if strings.Contains(text(event["message"]), "provider-private-secret") {
				t.Fatalf("provider response body leaked to device error event: %#v", event)
			}
		})
	}
}

func TestPassportASRFixtureRequiresExplicitValidTranscript(t *testing.T) {
	config := nativeProviderConfig{Mode: "fixture"}
	t.Setenv("GROWDESK_ASR_FIXTURE_TEXT", "")
	transcript, err := (&Server{}).transcribePassportWav(context.Background(), config, []byte("test wav"))
	var providerErr *nativeProviderError
	if transcript != "" || !errors.As(err, &providerErr) || providerErr.Code != "ASR_PROVIDER_NOT_CONFIGURED" {
		t.Fatalf("missing fixture returned transcript %q, error %#v; want explicit ASR_PROVIDER_NOT_CONFIGURED", transcript, err)
	}

	t.Setenv("GROWDESK_ASR_FIXTURE_TEXT", " \t\n ")
	transcript, err = (&Server{}).transcribePassportWav(context.Background(), config, []byte("test wav"))
	providerErr = nil
	if transcript != "" || !errors.As(err, &providerErr) || providerErr.Code != "ASR_PROVIDER_NO_SPEECH" {
		t.Fatalf("whitespace fixture returned transcript %q, error %#v; want no-speech rejection", transcript, err)
	}

	t.Setenv("GROWDESK_ASR_FIXTURE_TEXT", "test transcript")
	transcript, err = (&Server{}).transcribePassportWav(context.Background(), config, []byte("test wav"))
	if err != nil || transcript != "test transcript" {
		t.Fatalf("valid explicit fixture = %q, %v; want the fixture text", transcript, err)
	}
}

func TestValidateASRTranscriptRejectsOversizedText(t *testing.T) {
	transcript, err := validateASRTranscript(strings.Repeat("x", 256*1024+1))
	var providerErr *nativeProviderError
	if transcript != "" || !errors.As(err, &providerErr) || providerErr.Code != "ASR_PROVIDER_INVALID_RESPONSE" {
		t.Fatalf("oversized transcript returned %d bytes and error %#v; want bounded invalid response", len(transcript), err)
	}
}

func TestPassportASRAcceptsSuccessfulTranscript(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"text":"test transcript"}`)
	}))
	defer server.Close()

	config := nativeProviderConfig{
		Mode:     "openai-compatible",
		Endpoint: server.URL + "/v1/chat/completions",
		APIKey:   "virtual-test-key",
		ASRModel: "test-asr-model",
		Timeout:  time.Second,
	}
	transcript, err := (&Server{}).transcribePassportWav(context.Background(), config, []byte("test wav"))
	if err != nil || transcript != "test transcript" {
		t.Fatalf("successful response = %q, %v; want test transcript", transcript, err)
	}
}
