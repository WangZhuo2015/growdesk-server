package backend

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestNativeProviderRecordsActualModel(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer test_fake_key" {
				t.Error("wrong provider credentials")
			}
			if streaming {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = w.Write([]byte("data: {\"model\":\"test_actual_model\",\"choices\":[{\"delta\":{\"content\":\"test reply\"}}]}\n\ndata: [DONE]\n\n"))
			} else {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"model":"test_actual_model","choices":[{"message":{"content":"test reply"}}]}`))
			}
		}))
		config := nativeProviderConfig{Mode: "openai-compatible", Endpoint: provider.URL + "/test", APIKey: "test_fake_key", Model: "test_requested_alias", Timeout: time.Second}
		answer, err := callNativeAI(context.Background(), config, "test_session", "test_baby", "test prompt", nil, nil)
		provider.Close()
		if err != nil {
			t.Fatal(err)
		}
		info := nativeModelInfo(config, answer)
		if info["model"] != "test_actual_model" || info["provider"] != "127.0.0.1" || info["modelBasis"] != "provider_response" {
			t.Fatal(info)
		}
	}
}

func TestNativeModelInfoOmitsCredentialsAndPrivateURL(t *testing.T) {
	info := nativeModelInfo(nativeProviderConfig{Mode: "openai-compatible", Endpoint: "https://test_user:test_password@example.test/private?token=test_secret", APIKey: "test_key", Model: "test_model"}, nativeAIResult{})
	raw, err := jsonText(info)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"test_user", "test_password", "private", "test_secret", "test_key"} {
		if strings.Contains(raw, secret) {
			t.Fatal("private configuration exposed")
		}
	}
	if info["model"] != "test_model" || info["provider"] != "example.test" || info["modelBasis"] != "requested" {
		t.Fatal(info)
	}
}

func TestNativeModelEchoRejectsSecretsURLsControlsAndOverlongValues(t *testing.T) {
	config := nativeProviderConfig{Mode: "openai-compatible", Endpoint: "https://provider.example/v1/chat/completions", APIKey: "test_private_key", Model: "test_requested_model"}
	for _, echo := range []string{
		"test_private_key_echo",
		"https://provider.example/model?token=test_private_key",
		"https:provider.example/model",
		"mailto:test@example.test",
		"custom+scheme://provider.example/model",
		"provider.example/path/model",
		"test_model\nInjected: test_private_key",
		strings.Repeat("x", 201),
	} {
		info := nativeModelInfo(config, nativeAIResult{Model: echo})
		if info["model"] != "test_requested_model" || info["modelBasis"] != "requested" {
			t.Fatalf("unsafe echo was not replaced: %#v", info)
		}
		raw, err := jsonText(info)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(raw, "test_private_key") || strings.Contains(raw, echo) {
			t.Fatal("untrusted echo entered public provenance")
		}
	}
}

func TestNativeModelEchoAllowsOpaqueSlashAndColonIdentifiers(t *testing.T) {
	config := nativeProviderConfig{Mode: "openai-compatible", Endpoint: "https://provider.example/v1/chat/completions", APIKey: "test_private_key", Model: "test_requested_model"}
	for _, echo := range []string{"org/model:latest", "gpt-4o:2026-10", "vendor/path/model:preview", "vendor.example:model/path"} {
		info := nativeModelInfo(config, nativeAIResult{Model: echo})
		if info["model"] != echo || info["modelBasis"] != "provider_response" {
			t.Fatalf("opaque model ID was rejected: %q: %#v", echo, info)
		}
	}
}

func TestLlmModelInfoFromToolsJsonKeepsHistoryMetadataOutOfToolList(t *testing.T) {
	info := llmModelInfoFromToolsJSON(`[ {"type":"llm_model","llm":{"source":"api","provider":"test.provider","model":"test_actual_model","modelBasis":"provider_response"}}, {"actionId":"test_action"} ]`)
	if info["model"] != "test_actual_model" || info["modelBasis"] != "provider_response" {
		t.Fatal(info)
	}
	if got := llmModelInfoFromToolsJSON(`[{"actionId":"test_action"}]`); got != nil {
		t.Fatalf("legacy tool trace should have null model info: %#v", got)
	}
	if got := llmModelInfoFromToolsJSON(`not-json`); got != nil {
		t.Fatalf("invalid legacy toolsJson should remain readable with null model info: %#v", got)
	}
}

func TestPassportASRUsesProviderEchoOrMarksRequestedModel(t *testing.T) {
	for _, tc := range []struct {
		name, response, wantModel, wantBasis string
	}{
		{"provider echo", `{"text":"test transcript","model":"test_actual_asr"}`, "test_actual_asr", "provider_response"},
		{"requested fallback", `{"text":"test transcript"}`, "test_requested_asr", "requested"},
		{"unsafe echo fallback", `{"text":"test transcript","model":"https://test.provider/model?key=test_private_key"}`, "test_requested_asr", "requested"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/audio/transcriptions" || r.Header.Get("Authorization") != "Bearer test_private_key" {
					t.Errorf("unexpected request: %s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()
			config := nativeProviderConfig{Mode: "openai-compatible", Endpoint: server.URL + "/v1/chat/completions", APIKey: "test_private_key", ASRModel: "test_requested_asr", Timeout: time.Second}
			var responseModel string
			transcript, err := (&Server{}).transcribePassportWav(context.Background(), config, []byte("test_audio"), func(model string) { responseModel = model })
			if err != nil || transcript != "test transcript" {
				t.Fatalf("transcribe: %q %v", transcript, err)
			}
			info := nativeASRModelInfo(config, responseModel)
			if info["model"] != tc.wantModel || info["modelBasis"] != tc.wantBasis {
				t.Fatal(info)
			}
			raw, err := jsonText(info)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(raw, "test_private_key") {
				t.Fatal("ASR metadata leaked configured credentials")
			}
		})
	}
	info := nativeTTSModelInfo(nativeProviderConfig{Mode: "openai-compatible", Endpoint: "https://test.provider/v1/chat/completions", TTSModel: "test_requested_tts"})
	if info["model"] != "test_requested_tts" || info["modelBasis"] != "requested" {
		t.Fatal(info)
	}
}
