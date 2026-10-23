package backend

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func clearPassportTTSTestEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"GROWDESK_TTS_PROVIDER", "GROWDESK_TTS_BASE_URL", "GROWDESK_TTS_API_KEY", "GROWDESK_TTS_MODEL", "GROWDESK_TTS_VOICE", "GROWDESK_TTS_TIMEOUT_MS"} {
		t.Setenv(key, "")
	}
}

func TestPassportTTSConfigurationIsIndependentAndRequiresExplicitSharedProvider(t *testing.T) {
	clearPassportTTSTestEnv(t)
	common := nativeProviderConfig{Mode: "openai-compatible", Endpoint: "https://test-provider.invalid/v1/chat/completions", APIKey: "test_fake_ai_key", Timeout: time.Second}
	if _, err := passportTTSConfiguration(common); err == nil {
		t.Fatal("chat provider configuration silently inferred an audio route")
	}
	t.Setenv("GROWDESK_TTS_PROVIDER", "shared")
	config, err := passportTTSConfiguration(common)
	if err != nil || config.Endpoint != "https://test-provider.invalid/v1/audio/speech" || config.APIKey != common.APIKey || config.Model != "tts-1" || config.Voice != "alloy" {
		t.Fatalf("explicit shared compatible provider failed: %#v, %v", config, err)
	}

	t.Setenv("GROWDESK_TTS_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_TTS_BASE_URL", "https://test-tts.invalid/v2")
	t.Setenv("GROWDESK_TTS_API_KEY", "test_fake_tts_key")
	t.Setenv("GROWDESK_TTS_MODEL", "test-speech-model")
	t.Setenv("GROWDESK_TTS_VOICE", "test-voice")
	config, err = passportTTSConfiguration(nativeProviderConfig{Mode: "not-compatible"})
	if err != nil || config.Endpoint != "https://test-tts.invalid/v2/audio/speech" || config.APIKey != "test_fake_tts_key" || config.Model != "test-speech-model" || config.Voice != "test-voice" {
		t.Fatalf("separate TTS configuration failed: %#v, %v", config, err)
	}

	t.Setenv("GROWDESK_TTS_PROVIDER", "")
	t.Setenv("GROWDESK_TTS_BASE_URL", "")
	t.Setenv("GROWDESK_TTS_API_KEY", "")
	t.Setenv("GROWDESK_TTS_MODEL", "")
	t.Setenv("GROWDESK_TTS_VOICE", "")
	t.Setenv("GROWDESK_TTS_PROVIDER", "openai-compatible")
	t.Setenv("GROWDESK_TTS_BASE_URL", "https://other-provider.invalid/v1")
	if _, err = passportTTSConfiguration(nativeProviderConfig{Mode: "openai-compatible", Endpoint: "https://test-provider.invalid/v1/chat/completions", APIKey: "test_fake_common_key"}); err == nil {
		t.Fatal("common provider key was reused for a different TTS endpoint")
	}
	t.Setenv("GROWDESK_TTS_PROVIDER", "")
	t.Setenv("GROWDESK_TTS_BASE_URL", "https://TEST-PROVIDER.INVALID:443/v1")
	if config, err = passportTTSConfiguration(common); err != nil || config.APIKey != common.APIKey {
		t.Fatalf("same canonical endpoint did not reuse compatible provider config: %#v, %v", config, err)
	}
	t.Setenv("GROWDESK_TTS_BASE_URL", "")
	if _, err = passportTTSConfiguration(nativeProviderConfig{Mode: "vendor-specific", Endpoint: common.Endpoint, APIKey: common.APIKey}); err == nil {
		t.Fatal("non-compatible common provider was used as a TTS fallback")
	}

	t.Setenv("GROWDESK_TTS_PROVIDER", "fixture")
	if _, err = passportTTSConfiguration(nativeProviderConfig{Mode: "openai-compatible"}); err == nil {
		t.Fatal("TTS fixture was accepted without the explicit AI fixture mode")
	}
	if fixture, err := passportTTSConfiguration(nativeProviderConfig{Mode: "fixture", Fixture: `{"text":"test"}`}); err != nil || fixture.Mode != "fixture" {
		t.Fatalf("existing explicit fixture mode was rejected: %#v, %v", fixture, err)
	}
}

func TestPassportTTSEndpointRejectsCredentialsAndQuery(t *testing.T) {
	for _, raw := range []string{
		"https://test_user:test_pass@test.invalid/v1",
		"https://test.invalid/v1?token=test_private",
		"file:///tmp/test",
		"https://test.invalid/v1#fragment",
	} {
		if _, err := passportTTSEndpoint(raw); err == nil {
			t.Errorf("unsafe TTS endpoint accepted: %q", raw)
		}
	}
}

type passportTTSRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip passportTTSRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

type passportTTSObservedBody struct {
	reader io.Reader
	closed atomic.Bool
}

func (body *passportTTSObservedBody) Read(p []byte) (int, error) { return body.reader.Read(p) }
func (body *passportTTSObservedBody) Close() error {
	body.closed.Store(true)
	return nil
}

type passportTTSObservedTransport struct {
	passportTTSRoundTripper
	closedIdle atomic.Bool
}

func (transport *passportTTSObservedTransport) CloseIdleConnections() {
	transport.closedIdle.Store(true)
}

func TestPassportTTSProviderStatusIsSanitizedAndClosesResources(t *testing.T) {
	body := &passportTTSObservedBody{reader: strings.NewReader(`{"text":"plausible but invalid transcript","secret":"test_private_response"}`)}
	transport := &passportTTSObservedTransport{
		passportTTSRoundTripper: func(request *http.Request) (*http.Response, error) {
			if request.Header.Get("Authorization") != "Bearer test_fake_tts_key" {
				t.Error("TTS authorization header was not set")
			}
			return &http.Response{StatusCode: http.StatusUnauthorized, Header: make(http.Header), Body: body, Request: request}, nil
		},
	}
	client := &http.Client{Transport: transport}
	request, err := http.NewRequest(http.MethodPost, "https://test-provider.invalid/v1/audio/speech", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer test_fake_tts_key")
	_, err = synthesizePassportTTSWithClient(context.Background(), passportTTSConfig{}, request, client)
	var providerErr *nativeProviderError
	if !errors.As(err, &providerErr) || providerErr.Code != "TTS_PROVIDER_AUTH_FAILED" {
		t.Fatalf("unexpected provider error: %#v", err)
	}
	if strings.Contains(err.Error(), "test_private_response") || strings.Contains(err.Error(), "test_fake_tts_key") {
		t.Fatalf("provider details leaked in error: %v", err)
	}
	if !body.closed.Load() || !transport.closedIdle.Load() {
		t.Fatalf("response/client resources were not closed: body=%v idle=%v", body.closed.Load(), transport.closedIdle.Load())
	}
	if event := passportTTSErrorEvent("test_turn", err); event["code"] != "TTS_PROVIDER_AUTH_FAILED" || event["turnId"] != "test_turn" {
		t.Fatalf("device-facing error event lost TTS status: %#v", event)
	}
}

func TestPassportTTSPCMValidationRejectsMalformedBodies(t *testing.T) {
	testCases := []struct {
		name        string
		contentType string
		body        []byte
	}{
		{name: "empty"},
		{name: "odd PCM", contentType: "audio/pcm", body: []byte{1, 2, 3}},
		{name: "oversize PCM", contentType: "audio/pcm", body: bytes.Repeat([]byte{1, 2}, maxPassportTTSOutputBytes/2+1)},
		{name: "JSON", contentType: "application/json", body: []byte(`{"error":"test_private"}`)},
		{name: "WAV instead of raw PCM", contentType: "audio/wav", body: []byte("RIFF0000WAVE")},
		{name: "network-order L16", contentType: "audio/L16", body: []byte{1, 2}},
		{name: "wrong sample rate", contentType: "audio/pcm; rate=16000", body: []byte{1, 2}},
		{name: "stereo", contentType: "audio/pcm; channels=2", body: []byte{1, 2}},
		{name: "big endian", contentType: "audio/pcm; endianness=big", body: []byte{1, 2}},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if testCase.contentType != "" {
					w.Header().Set("Content-Type", testCase.contentType)
				}
				_, _ = w.Write(testCase.body)
			}))
			defer server.Close()
			config := passportTTSConfig{Mode: "openai-compatible", Endpoint: server.URL, APIKey: "test_fake_key", Timeout: time.Second}
			pcm, err := synthesizePassportTTS(context.Background(), config, "test words")
			var providerErr *nativeProviderError
			if pcm != nil || !errors.As(err, &providerErr) || providerErr.Code != "TTS_PROVIDER_INVALID_RESPONSE" {
				t.Fatalf("invalid PCM accepted: len=%d err=%v", len(pcm), err)
			}
		})
	}
}

func TestPassportTTSTimeoutAndCancellation(t *testing.T) {
	releaseTimeoutHandler := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		select {
		case <-request.Context().Done():
		case <-releaseTimeoutHandler:
		}
	}))
	defer server.Close()
	defer close(releaseTimeoutHandler)
	config := passportTTSConfig{Mode: "openai-compatible", Endpoint: server.URL, APIKey: "test_fake_key", Timeout: 100 * time.Millisecond}
	_, err := synthesizePassportTTS(context.Background(), config, "test words")
	var providerErr *nativeProviderError
	if !errors.As(err, &providerErr) || providerErr.Code != "TTS_PROVIDER_TIMEOUT" {
		t.Fatalf("provider timeout was not typed: %v", err)
	}

	started := make(chan struct{})
	releaseCancelHandler := make(chan struct{})
	cancelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		close(started)
		select {
		case <-request.Context().Done():
		case <-releaseCancelHandler:
		}
	}))
	defer cancelServer.Close()
	defer close(releaseCancelHandler)
	ctx, cancel := context.WithCancel(context.Background())
	cancelConfig := config
	cancelConfig.Endpoint = cancelServer.URL
	done := make(chan error, 1)
	go func() {
		_, requestErr := synthesizePassportTTS(ctx, cancelConfig, "test words")
		done <- requestErr
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("cancellation request did not reach the virtual provider")
	}
	cancel()
	select {
	case err = <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("caller cancellation was not preserved: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancelled TTS request did not stop")
	}
}

func TestPassportTTSFailureDoesNotStartPlayback(t *testing.T) {
	clearPassportTTSTestEnv(t)
	t.Setenv("GROWDESK_TTS_PROVIDER", "shared")
	for _, testCase := range []struct {
		name        string
		status      int
		contentType string
		body        []byte
		wantCode    string
	}{
		{name: "HTTP failure", status: http.StatusBadGateway, body: []byte("test_private_provider_response"), wantCode: "TTS_PROVIDER_HTTP_ERROR"},
		{name: "malformed PCM", status: http.StatusOK, contentType: "audio/pcm", body: []byte{1, 2, 3}, wantCode: "TTS_PROVIDER_INVALID_RESPONSE"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				if testCase.contentType != "" {
					w.Header().Set("Content-Type", testCase.contentType)
				}
				w.WriteHeader(testCase.status)
				_, _ = w.Write(testCase.body)
			}))
			defer server.Close()
			common := nativeProviderConfig{Mode: "openai-compatible", Endpoint: server.URL + "/v1/chat/completions", APIKey: "test_fake_key", Timeout: time.Second}
			var events []Object
			var audio [][]byte
			(&Server{}).streamPassportTTS(context.Background(), common, "test_turn", "test spoken text", func(value any) error {
				events = append(events, obj(value))
				return nil
			}, func(value []byte) error {
				audio = append(audio, append([]byte(nil), value...))
				return nil
			})
			if len(events) != 1 || events[0]["type"] != "error" || events[0]["code"] != testCase.wantCode || len(audio) != 0 {
				t.Fatalf("failed provider incorrectly started playback: events=%#v audio=%d", events, len(audio))
			}
		})
	}
}

func TestPassportTTSValidPCMStreamsWithExistingWireFormat(t *testing.T) {
	clearPassportTTSTestEnv(t)
	t.Setenv("GROWDESK_TTS_PROVIDER", "shared")
	pcm := bytes.Repeat([]byte{0x34, 0x12}, 1010)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/v1/audio/speech" {
			t.Errorf("unexpected TTS endpoint: %s", request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer test_fake_key" {
			t.Error("wrong provider authorization")
		}
		var payload map[string]any
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Errorf("invalid TTS JSON: %v", err)
		}
		if payload["model"] != "tts-1" || payload["voice"] != "alloy" || payload["response_format"] != "pcm" || payload["input"] != "test spoken text" {
			t.Errorf("unexpected TTS request: %#v", payload)
		}
		w.Header().Set("Content-Type", "audio/pcm")
		_, _ = w.Write(pcm)
	}))
	defer server.Close()
	common := nativeProviderConfig{Mode: "openai-compatible", Endpoint: server.URL + "/v1/chat/completions", APIKey: "test_fake_key", Timeout: time.Second}
	var events []Object
	var audio [][]byte
	(&Server{}).streamPassportTTS(context.Background(), common, "test_turn", "test spoken text", func(value any) error {
		events = append(events, obj(value))
		return nil
	}, func(value []byte) error {
		audio = append(audio, append([]byte(nil), value...))
		return nil
	})
	if len(events) != 2 || events[0]["type"] != "tts.start" || events[1]["type"] != "tts.end" {
		t.Fatalf("unexpected event sequence: %#v", events)
	}
	format := obj(events[0]["audioFormat"])
	if format["codec"] != "pcm_s16le" || format["sampleRate"] != 24000 || format["channels"] != 1 {
		t.Fatalf("PCM wire format changed: %#v", format)
	}
	var joined []byte
	for _, chunk := range audio {
		if len(chunk) == 0 || len(chunk)%2 != 0 {
			t.Fatalf("invalid PCM chunk size: %d", len(chunk))
		}
		joined = append(joined, chunk...)
	}
	if !bytes.Equal(joined, pcm) || len(audio) != 2 {
		t.Fatalf("PCM stream mismatch: chunks=%d bytes=%d", len(audio), len(joined))
	}
}

func TestPassportTTSFixtureRequiresExistingOptInAndEmitsSilence(t *testing.T) {
	clearPassportTTSTestEnv(t)
	var events []Object
	var audio [][]byte
	(&Server{}).streamPassportTTS(context.Background(), nativeProviderConfig{Mode: "fixture", Fixture: `{"text":"test"}`}, "test_turn", "test words", func(value any) error {
		events = append(events, obj(value))
		return nil
	}, func(value []byte) error {
		audio = append(audio, append([]byte(nil), value...))
		return nil
	})
	if len(events) != 2 || events[0]["type"] != "tts.start" || events[1]["type"] != "tts.end" || len(audio) != 3 {
		t.Fatalf("explicit fixture output mismatch: events=%#v audio=%d", events, len(audio))
	}
	total := 0
	for _, chunk := range audio {
		if len(chunk)%2 != 0 {
			t.Fatal("fixture chunk was not aligned to PCM samples")
		}
		total += len(chunk)
		for _, sample := range chunk {
			if sample != 0 {
				t.Fatal("fixture audio was not silence")
			}
		}
	}
	if total != 4800 {
		t.Fatalf("fixture silence changed size: %d", total)
	}
}

func TestPassportTTSPacingMatchesPCMPlaybackDuration(t *testing.T) {
	if got := passportTTSChunkDuration(1920); got != 40*time.Millisecond {
		t.Fatalf("1920 PCM bytes should represent 40 ms, got %s", got)
	}
	if got := passportTTSChunkDuration(960); got != 20*time.Millisecond {
		t.Fatalf("960 PCM bytes should represent 20 ms, got %s", got)
	}
	if got := passportTTSPacingDelay(1920, 12*time.Millisecond); got != 28*time.Millisecond {
		t.Fatalf("write time was not included in the pacing interval: %s", got)
	}
	if got := passportTTSPacingDelay(1920, 45*time.Millisecond); got != 0 {
		t.Fatalf("slow writes should not add more pacing delay: %s", got)
	}
	if got := passportTTSChunkDuration(3); got != 0 {
		t.Fatalf("odd byte counts cannot form 16-bit PCM samples: %s", got)
	}
}

func TestPassportTTSCancelDuringPlaybackSendsNoStaleErrorOrEnd(t *testing.T) {
	clearPassportTTSTestEnv(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var events []Object
	firstChunk := true
	(&Server{}).streamPassportTTS(ctx, nativeProviderConfig{Mode: "fixture", Fixture: `{"text":"test"}`}, "test_turn", "test words", func(value any) error {
		events = append(events, obj(value))
		return nil
	}, func(value []byte) error {
		if firstChunk {
			firstChunk = false
			cancel()
		}
		return nil
	})
	if len(events) != 1 || events[0]["type"] != "tts.start" {
		t.Fatalf("cancelled playback emitted a stale error or end event: %#v", events)
	}
}
