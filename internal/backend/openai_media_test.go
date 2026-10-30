package backend

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestOfficialPassportResponsesKeepsHistoryAndProposals(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/responses" || r.Header.Get("Authorization") != "Bearer test_official_key" {
			t.Errorf("unexpected official request: %s", r.URL.Path)
		}
		var body Object
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		input, _ := body["input"].([]any)
		if len(input) != 3 || text(obj(input[0])["role"]) != "user" || text(obj(input[1])["role"]) != "assistant" || text(obj(input[2])["content"]) != "test_new_message" {
			t.Errorf("history was not retained: %#v", input)
		}
		if body["store"] != false || body["messages"] != nil || body["metadata"] != nil || !strings.Contains(text(body["instructions"]), "proposals only") {
			t.Error("incorrect official request contract")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(Object{
			"status": "completed", "model": "gpt-6-luna", "usage": Object{"total_tokens": 12},
			"output": []Object{{"type": "message", "role": "assistant", "content": []Object{{"type": "output_text", "text": `{"text":"test_proposal","actions":[{"actionId":"b6ec8bf5-a0a2-4bfe-b3a5-9cb84f3cb022","entityType":"feeding","operation":"create","summary":"test_feeding","payload":{"amountMl":"140"}}]}`}}}},
		})
	}))
	defer server.Close()
	config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL + "/v1/responses", APIKey: "test_official_key", Model: "gpt-6-luna", Timeout: time.Second}
	history := []Object{{"role": "user", "content": "test_previous_question"}, {"role": "assistant", "content": "test_previous_reply"}}
	result, err := (&Server{}).callPassportAgent(context.Background(), config, "test_session", "test_baby_id", "test_baby", "test_new_message", history)
	if err != nil || result.Text != "test_proposal" || len(result.Actions) != 1 || result.Model != "gpt-6-luna" {
		t.Fatalf("official passport result: %#v %v", result, err)
	}
	if len(history) != 2 {
		t.Fatal("provider changed caller history")
	}
}

func TestOfficialPassportAudioUsesSeparateEndpointsAndModels(t *testing.T) {
	var mu sync.Mutex
	paths := []string{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer test_official_key" {
			t.Error("missing test authorization")
		}
		switch r.URL.Path {
		case "/v1/audio/transcriptions":
			if err := r.ParseMultipartForm(1024); err != nil {
				t.Error(err)
			}
			if r.MultipartForm != nil {
				defer r.MultipartForm.RemoveAll()
			}
			if r.FormValue("model") != "whisper-1" {
				t.Error("ASR received the text model")
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"text":"test_transcript"}`)
		case "/v1/audio/speech":
			var body Object
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if body["model"] != "tts-1" || body["response_format"] != "pcm" {
				t.Error("TTS received the wrong model or format")
			}
			_, _ = w.Write([]byte{1, 2, 3, 4})
		default:
			t.Errorf("incorrect audio path: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	config := nativeProviderConfig{Mode: "openai", Endpoint: server.URL + "/v1/responses", APIKey: "test_official_key", Model: "gpt-6-luna", ASRModel: "whisper-1", TTSModel: "tts-1", Timeout: time.Second}
	serverInstance := &Server{}
	transcript, err := serverInstance.transcribePassportWav(context.Background(), config, []byte("test_wav"), nil)
	if err != nil || transcript != "test_transcript" {
		t.Fatalf("ASR: %q %v", transcript, err)
	}
	var pcm []byte
	serverInstance.streamTTS(context.Background(), config, "test_turn", "test_speech", func(any) error { return nil }, func(chunk []byte) error {
		pcm = append(pcm, chunk...)
		return nil
	})
	mu.Lock()
	defer mu.Unlock()
	if string(pcm) != string([]byte{1, 2, 3, 4}) || len(paths) != 2 {
		t.Fatalf("audio calls incomplete: %v %v", pcm, paths)
	}
}
