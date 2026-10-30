package backend

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func setOpenAIProviderEnv(t *testing.T) {
	t.Helper()
	for name, value := range map[string]string{
		"GROWDESK_AI_PROVIDER":         "openai",
		"GROWDESK_AI_API_KEY":          "",
		"GROWDESK_AI_API_KEY_FILE":     "",
		"OPENAI_API_KEY":               "",
		"AI_API_KEY":                   "",
		"GROWDESK_AI_BASE_URL":         "",
		"GROWDESK_AI_MODEL":            "",
		"GROWDESK_AI_TIMEOUT_MS":       "",
		"GROWDESK_AI_FIXTURE_RESPONSE": "",
		"GROWDESK_AI_FIXTURE_TEXT":     "",
		"GROWDESK_ASR_MODEL":           "",
		"GROWDESK_TTS_MODEL":           "",
	} {
		t.Setenv(name, value)
	}
}

func TestOpenAIProviderConfigurationAndOfficialURLAllowlist(t *testing.T) {
	setOpenAIProviderEnv(t)
	t.Setenv("OPENAI_API_KEY", "test_openai_key")
	t.Setenv("AI_API_KEY", "test_legacy_key_must_not_be_used")
	config, err := nativeProviderConfiguration()
	if err != nil {
		t.Fatal(err)
	}
	if config.Mode != "openai" || config.APIKey != "test_openai_key" || config.Endpoint != openAIResponsesURL || config.Model != "gpt-6-luna" || config.Timeout != 60*time.Second || config.ASRModel != "whisper-1" || config.TTSModel != "tts-1" {
		t.Fatalf("unexpected official OpenAI defaults: %+v", config)
	}

	t.Setenv("GROWDESK_AI_API_KEY", " test_growdesk_key ")
	t.Setenv("OPENAI_API_KEY", "test_openai_fallback_key")
	config, err = nativeProviderConfiguration()
	if err != nil || config.APIKey != "test_growdesk_key" {
		t.Fatalf("GROWDESK_AI_API_KEY should take precedence: %+v, %v", config, err)
	}

	for _, baseURL := range []string{
		"https://api.openai.com", "https://api.openai.com/", "https://api.openai.com/v1", "https://api.openai.com/v1/", "https://api.openai.com/v1/responses",
	} {
		t.Setenv("GROWDESK_AI_BASE_URL", baseURL)
		config, err = nativeProviderConfiguration()
		if err != nil || config.Endpoint != openAIResponsesURL {
			t.Errorf("approved base URL %q was not normalized: endpoint=%q error=%v", baseURL, config.Endpoint, err)
		}
	}
	for _, baseURL := range []string{
		"http://api.openai.com", "https://evil.example", "https://api.openai.com:443", "https://user@api.openai.com",
		"https://api.openai.com/v1/chat/completions", "https://api.openai.com/v1/responses/", "https://api.openai.com/v1?x=1",
		"https://api.openai.com/v1#fragment", "https://api.openai.com/v1#", "https://api.openai.com/v1?", "https://api.openai.com/%76%31",
	} {
		t.Setenv("GROWDESK_AI_BASE_URL", baseURL)
		if _, err = nativeProviderConfiguration(); err == nil {
			t.Errorf("unapproved base URL was accepted: %q", baseURL)
		}
	}
}

func TestOpenAIProviderRequiresOfficialKeyAndKeepsCompatFallback(t *testing.T) {
	setOpenAIProviderEnv(t)
	t.Setenv("AI_API_KEY", "test_legacy_key")
	t.Setenv("GROWDESK_AI_FIXTURE_RESPONSE", "fixture must not be used")
	if _, err := nativeProviderConfiguration(); err == nil {
		t.Fatal("official OpenAI provider accepted a legacy key or fixture")
	} else {
		var api *APIError
		if !errors.As(err, &api) || api.Status != 503 {
			t.Fatalf("missing official key should produce explicit 503: %v", err)
		}
	}

	t.Setenv("GROWDESK_AI_BASE_URL", "https://compat.example/v1")
	for _, mode := range []string{"compat", "openai-compatible"} {
		t.Setenv("GROWDESK_AI_PROVIDER", mode)
		config, err := nativeProviderConfiguration()
		if err != nil || config.Mode != "openai-compatible" || config.APIKey != "test_legacy_key" || config.Timeout != 10*time.Second {
			t.Fatalf("compat behavior changed for %s: %+v, %v", mode, config, err)
		}
	}
}

func TestOpenAIProviderKeyFileIsExplicitBoundedAndLowerPriority(t *testing.T) {
	setOpenAIProviderEnv(t)
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "test_virtual_api_key")
	if err := os.WriteFile(keyPath, []byte("  virtual-provider-key\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GROWDESK_AI_API_KEY_FILE", keyPath)
	config, err := nativeProviderConfiguration()
	if err != nil || config.APIKey != "virtual-provider-key" {
		t.Fatalf("explicit key file was not trimmed and loaded: %+v, %v", config, err)
	}

	missingPath := filepath.Join(dir, "test_missing_key_file")
	t.Setenv("GROWDESK_AI_API_KEY", "test_primary_inline_key")
	t.Setenv("OPENAI_API_KEY", "test_secondary_inline_key")
	t.Setenv("GROWDESK_AI_API_KEY_FILE", missingPath)
	config, err = nativeProviderConfiguration()
	if err != nil || config.APIKey != "test_primary_inline_key" {
		t.Fatalf("primary inline key did not take precedence over file: %+v, %v", config, err)
	}
	t.Setenv("GROWDESK_AI_API_KEY", "")
	config, err = nativeProviderConfiguration()
	if err != nil || config.APIKey != "test_secondary_inline_key" {
		t.Fatalf("secondary inline key did not take precedence over file: %+v, %v", config, err)
	}
	t.Setenv("OPENAI_API_KEY", "")

	emptyPath := filepath.Join(dir, "test_empty_key")
	blankPath := filepath.Join(dir, "test_blank_key")
	whitespacePath := filepath.Join(dir, "test_whitespace_key")
	controlPath := filepath.Join(dir, "test_control_key")
	oversizedPath := filepath.Join(dir, "test_oversized_key")
	for path, contents := range map[string]string{
		emptyPath:      "",
		blankPath:      " \t\r\n ",
		whitespacePath: "test_key with_internal_space",
		controlPath:    "test_control\x00key",
		oversizedPath:  strings.Repeat("x", maxOpenAIAPIKeyFileBytes+1),
	} {
		if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	nonRegularPath := filepath.Join(dir, "test_key_directory")
	if err := os.Mkdir(nonRegularPath, 0700); err != nil {
		t.Fatal(err)
	}
	invalidPaths := []string{missingPath, emptyPath, blankPath, whitespacePath, controlPath, oversizedPath, nonRegularPath}
	for _, path := range invalidPaths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			t.Setenv("GROWDESK_AI_API_KEY_FILE", path)
			_, err := nativeProviderConfiguration()
			var api *APIError
			if !errors.As(err, &api) || api.Status != 500 || api.Code != "AI_PROVIDER_CONFIG_INVALID" {
				t.Fatalf("invalid key file should produce generic configuration error: %v", err)
			}
			if strings.Contains(err.Error(), path) || strings.Contains(err.Error(), "test_key with_internal_space") || strings.Contains(err.Error(), "test_control") {
				t.Fatalf("key file path or content leaked: %v", err)
			}
		})
	}

	maxSizePath := filepath.Join(dir, "test_max_size_key")
	if err := os.WriteFile(maxSizePath, []byte(strings.Repeat("x", maxOpenAIAPIKeyFileBytes)), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GROWDESK_AI_API_KEY_FILE", maxSizePath)
	config, err = nativeProviderConfiguration()
	if err != nil || len(config.APIKey) != maxOpenAIAPIKeyFileBytes {
		t.Fatalf("maximum permitted key file size was rejected: len=%d error=%v", len(config.APIKey), err)
	}
}

func TestCallNativeAIUsesOfficialResponsesRequestAndStreamingOutput(t *testing.T) {
	var deltas strings.Builder
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/responses" {
			t.Errorf("unexpected request target %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test_virtual_openai_key" {
			t.Errorf("virtual provider key missing: %q", r.Header.Get("Authorization"))
		}
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
		}
		instructions, _ := request["instructions"].(string)
		if request["model"] != "gpt-6-luna" || request["stream"] != true || request["store"] != false || !strings.Contains(instructions, "Actions are proposals only") || request["input"] != "test user message" {
			t.Errorf("unexpected Responses request: %#v", request)
		}
		if _, ok := request["messages"]; ok {
			t.Error("legacy chat messages were sent to Responses")
		}
		if _, ok := request["metadata"]; ok {
			t.Error("legacy metadata was sent to Responses")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w,
			"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"test \"}\n\n"+
				"event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"answer\"}\n\n"+
				"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"test answer\"}]}],\"model\":\"gpt-6-luna-2026-10-30\",\"usage\":{\"input_tokens\":12,\"output_tokens\":2}}}\n\n")
	}))
	defer server.Close()

	config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL + "/v1/responses", APIKey: "test_virtual_openai_key", Model: "gpt-6-luna", Timeout: time.Second}
	result, err := callNativeAI(context.Background(), config, "test_session", "", "test user message", []string{"test_attachment_id_not_metadata"}, func(piece string) error {
		deltas.WriteString(piece)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "test answer" || result.Model != "gpt-6-luna-2026-10-30" || deltas.String() != "test answer" || integer(result.Usage["input_tokens"]) != 12 || integer(result.Usage["output_tokens"]) != 2 {
		t.Fatalf("unexpected Responses result: %+v deltas=%q", result, deltas.String())
	}
}

func TestCallNativeResponsesParsesNonStreamingResponse(t *testing.T) {
	var delta string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"{\"text\":\"test structured answer\",\"actions\":[]}"}]}],"model":"gpt-6-luna-test","usage":{"input_tokens":7,"output_tokens":4}}`)
	}))
	defer server.Close()
	config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL + "/responses", APIKey: "test_virtual_key", Model: "gpt-6-luna", Timeout: time.Second}
	result, err := callNativeResponses(context.Background(), config, "test instructions", []Object{{"type": "input_text", "text": "test"}}, func(piece string) error {
		delta = piece
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "test structured answer" || result.Model != "gpt-6-luna-test" || delta != result.Text || integer(result.Usage["input_tokens"]) != 7 || integer(result.Usage["output_tokens"]) != 4 {
		t.Fatalf("unexpected non-stream result: %+v delta=%q", result, delta)
	}
}

func TestNativeResponsesRejectsTruncatedStructuredJSONAfterCompleted(t *testing.T) {
	for _, transport := range []string{"json", "sse"} {
		for _, sample := range []struct {
			name    string
			content string
		}{
			{name: "plain-envelope", content: `{"text":"partial"`},
			{name: "closed-fence", content: "```json\n{\"text\":\"partial\"```"},
			{name: "open-fence", content: "```json\n{\"text\":\"partial\""},
		} {
			t.Run(transport+"-"+sample.name, func(t *testing.T) {
				content := sample.content
				response := Object{
					"status": "completed",
					"output": []any{Object{"type": "message", "content": []any{Object{"type": "output_text", "text": content}}}},
					"model":  "gpt-6-luna-test",
					"usage":  Object{"input_tokens": 3, "output_tokens": 1},
				}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
					if transport == "json" {
						w.Header().Set("Content-Type", "application/json")
						data, err := jsonBytes(response)
						if err != nil {
							t.Errorf("encode response: %v", err)
							return
						}
						_, _ = w.Write(data)
						return
					}
					w.Header().Set("Content-Type", "text/event-stream")
					delta, err := jsonBytes(Object{"type": "response.output_text.delta", "delta": content})
					if err != nil {
						t.Errorf("encode delta: %v", err)
						return
					}
					completed, err := jsonBytes(Object{"type": "response.completed", "response": response})
					if err != nil {
						t.Errorf("encode completed event: %v", err)
						return
					}
					_, _ = fmt.Fprintf(w, "event: response.output_text.delta\ndata: %s\n\nevent: response.completed\ndata: %s\n\n", delta, completed)
				}))
				defer server.Close()
				config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL, APIKey: "test_virtual_key", Model: "gpt-6-luna", Timeout: time.Second}
				var deltas strings.Builder
				_, err := callNativeResponses(context.Background(), config, "test", "test", func(piece string) error {
					deltas.WriteString(piece)
					return nil
				})
				var failure *nativeProviderError
				if !errors.As(err, &failure) || failure.Code != "AI_PROVIDER_INVALID_RESPONSE" {
					t.Fatalf("completed response with truncated structured output was accepted: %v", err)
				}
				if deltas.Len() != 0 {
					t.Fatalf("truncated structured output leaked to deltas: %q", deltas.String())
				}
			})
		}
	}
}

func TestNativeResponsesStructuredJSONIsReleasedAsParsedText(t *testing.T) {
	structured := `{"text":"test proposed summary","actions":[{"actionId":"123e4567-e89b-42d3-a456-426614174000","entityType":"feeding","operation":"create","summary":"Add a test feeding","payload":{"amountMl":100}}]}`
	encodeEvent := func(eventType string, payload Object) string {
		t.Helper()
		data, err := jsonBytes(payload)
		if err != nil {
			t.Fatal(err)
		}
		return "event: " + eventType + "\ndata: " + string(data) + "\n\n"
	}
	parts := []string{structured[:len(structured)/3], structured[len(structured)/3 : 2*len(structured)/3], structured[2*len(structured)/3:]}
	var stream strings.Builder
	for _, part := range parts {
		stream.WriteString(encodeEvent("response.output_text.delta", Object{"type": "response.output_text.delta", "delta": part}))
	}
	response := Object{
		"status": "completed",
		"output": []any{Object{"type": "message", "content": []any{Object{"type": "output_text", "text": structured}}}},
		"model":  "gpt-6-luna-test",
		"usage":  Object{"input_tokens": 20, "output_tokens": 12},
	}
	stream.WriteString(encodeEvent("response.completed", Object{"type": "response.completed", "response": response}))

	var deltas []string
	result, err := readNativeResponsesStream(strings.NewReader(stream.String()), func(piece string) error {
		deltas = append(deltas, piece)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Text != "test proposed summary" || len(result.Actions) != 1 || result.Actions[0].Operation != "create" {
		t.Fatalf("structured response was not parsed: %+v", result)
	}
	if strings.Join(deltas, "") != result.Text || len(deltas) != 1 || deltas[0] != result.Text {
		t.Fatalf("structured stream emitted the JSON envelope instead of parsed text: deltas=%q result=%q", deltas, result.Text)
	}
}

func TestNativeResponsesPlainTextEmitsBeforeCompletion(t *testing.T) {
	type outcome struct {
		result nativeAIResult
		err    error
	}
	callbackSeen := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := w.(http.Flusher)
		if !ok {
			t.Error("test server does not support streaming flush")
			return
		}
		writeEvent := func(eventType string, payload Object) {
			data, err := jsonBytes(payload)
			if err != nil {
				t.Errorf("encode event: %v", err)
				return
			}
			_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", eventType, data)
			flusher.Flush()
		}
		writeEvent("response.output_text.delta", Object{"type": "response.output_text.delta", "delta": "test "})
		select {
		case piece := <-callbackSeen:
			if piece != "test " {
				t.Errorf("first callback contained %q", piece)
			}
		case <-time.After(time.Second):
			t.Error("plain text delta was not emitted before the completed event")
			return
		}
		writeEvent("response.output_text.delta", Object{"type": "response.output_text.delta", "delta": "answer"})
		response := Object{
			"status": "completed",
			"output": []any{Object{"type": "message", "content": []any{Object{"type": "output_text", "text": "test answer"}}}},
			"model":  "gpt-6-luna-test",
			"usage":  Object{"input_tokens": 2, "output_tokens": 2},
		}
		writeEvent("response.completed", Object{"type": "response.completed", "response": response})
	}))
	defer server.Close()
	config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL, APIKey: "test_virtual_key", Model: "gpt-6-luna", Timeout: 2 * time.Second}
	done := make(chan outcome, 1)
	var deltas strings.Builder
	go func() {
		result, err := callNativeResponses(context.Background(), config, "test", "test", func(piece string) error {
			deltas.WriteString(piece)
			select {
			case callbackSeen <- piece:
			default:
			}
			return nil
		})
		done <- outcome{result: result, err: err}
	}()
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatal(got.err)
		}
		if got.result.Text != "test answer" || deltas.String() != got.result.Text {
			t.Fatalf("plain stream did not preserve incremental output: result=%q deltas=%q", got.result.Text, deltas.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("provider response did not complete after receiving the first delta callback")
	}
}

func TestCallNativeResponsesClassifiesHTTPFailuresWithoutLeakingBody(t *testing.T) {
	for _, tc := range []struct {
		status    int
		code      string
		retryable bool
	}{{http.StatusUnauthorized, "AI_PROVIDER_AUTH_FAILED", false}, {http.StatusTooManyRequests, "AI_PROVIDER_HTTP_ERROR", true}, {http.StatusServiceUnavailable, "AI_PROVIDER_HTTP_ERROR", true}} {
		t.Run(fmt.Sprint(tc.status), func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, "test_private_provider_error_body")
			}))
			defer server.Close()
			config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL, APIKey: "test_virtual_key", Model: "gpt-6-luna", Timeout: time.Second}
			_, err := callNativeResponses(context.Background(), config, "test", "test", nil)
			var failure *nativeProviderError
			if !errors.As(err, &failure) || failure.Code != tc.code || failure.Retryable != tc.retryable {
				t.Fatalf("unexpected provider classification: %v", err)
			}
			if strings.Contains(err.Error(), "test_private_provider_error_body") || strings.Contains(err.Error(), "test_virtual_key") {
				t.Fatal("provider error leaked response body or key")
			}
		})
	}
}

func TestNativeResponsesStreamRejectsUnsuccessfulTruncatedAndMalformedEvents(t *testing.T) {
	response := `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"test"}]}]}`
	completed := "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":" + response + "}\n\n"
	for _, tc := range []struct {
		name             string
		stream           string
		retryable        bool
		appendCompletion bool
	}{
		{name: "missing completed", stream: "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"test\"}\n\n", retryable: true},
		{name: "incomplete", stream: "event: response.incomplete\ndata: {\"type\":\"response.incomplete\"}\n\n", appendCompletion: true},
		{name: "failed", stream: "event: response.failed\ndata: {\"type\":\"response.failed\"}\n\n", appendCompletion: true},
		{name: "error", stream: "event: error\ndata: {\"type\":\"error\"}\n\n", appendCompletion: true},
		{name: "malformed", stream: "event: response.completed\ndata: {bad}\n\n", appendCompletion: true},
		{name: "unterminated completed frame", stream: strings.TrimSuffix(completed, "\n")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stream := tc.stream
			if tc.appendCompletion {
				stream += completed
			}
			_, err := readNativeResponsesStream(strings.NewReader(stream), nil)
			var failure *nativeProviderError
			if !errors.As(err, &failure) || failure.Retryable != tc.retryable {
				t.Fatalf("expected rejected stream with retryable=%v; got %v", tc.retryable, err)
			}
		})
	}
	if _, err := readNativeResponsesStream(strings.NewReader(strings.Repeat(": heartbeat\n", maxProviderResponse/11+2)), nil); err == nil {
		t.Fatal("oversized stream was accepted")
	}
}

func TestCallNativeResponsesCancellationAndTimeout(t *testing.T) {
	t.Run("caller cancellation", func(t *testing.T) {
		started := make(chan struct{})
		stopServer := make(chan struct{})
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			if flusher, ok := w.(http.Flusher); ok {
				flusher.Flush()
			}
			close(started)
			select {
			case <-r.Context().Done():
			case <-stopServer:
			}
		}))
		defer func() {
			close(stopServer)
			server.Close()
		}()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan error, 1)
		go func() {
			config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL, APIKey: "test_virtual_key", Model: "gpt-6-luna", Timeout: time.Second}
			_, err := callNativeResponses(ctx, config, "test", "test", nil)
			done <- err
		}()
		<-started
		cancel()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("caller cancellation was lost: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("cancelled provider call did not return")
		}
	})

	t.Run("provider timeout", func(t *testing.T) {
		stopServer := make(chan struct{})
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.Copy(io.Discard, r.Body)
			select {
			case <-r.Context().Done():
			case <-stopServer:
			}
		}))
		defer func() {
			close(stopServer)
			server.Close()
		}()
		config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL, APIKey: "test_virtual_key", Model: "gpt-6-luna", Timeout: 60 * time.Millisecond}
		_, err := callNativeResponses(context.Background(), config, "test", "test", nil)
		var failure *nativeProviderError
		if !errors.As(err, &failure) || failure.Code != "AI_PROVIDER_TIMEOUT" || !failure.Retryable {
			t.Fatalf("provider timeout classification was lost: %v", err)
		}
	})
}
