package backend

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestPassportDigitalSilenceNeverReachesRecognizer(t *testing.T) {
	var calls atomic.Int32
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"text":"test recognition"}`))
	}))
	defer provider.Close()
	config := nativeProviderConfig{Mode: "openai-compatible", Endpoint: provider.URL + "/chat/completions", APIKey: "test_key", Timeout: time.Second}
	wav := buildWavFile(make([]byte, 32000), 16000, 1, 16)
	transcript, err := (&Server{}).transcribePassportWav(context.Background(), config, wav)
	var failure *nativeProviderError
	if transcript != "" || !errors.As(err, &failure) || failure.Code != "ASR_PROVIDER_NO_SPEECH" || calls.Load() != 0 {
		t.Fatalf("digital silence reached recognition: transcript=%q err=%v calls=%d", transcript, err, calls.Load())
	}
	// A nonzero sample passes only the exact-zero guard; this is no claim that
	// a one-bit signal is audible speech or that model recognition is accurate.
	wav[44] = 1
	transcript, err = (&Server{}).transcribePassportWav(context.Background(), config, wav)
	if err != nil || transcript != "test recognition" || calls.Load() != 1 {
		t.Fatalf("nonzero input was filtered: %q %v calls=%d", transcript, err, calls.Load())
	}
}

func TestPassportDigitalSilenceCannotPublishAConversationOrProposal(t *testing.T) {
	clearSpeechTestEnvironment(t)
	t.Setenv("GROWDESK_AI_PROVIDER", "fixture")
	t.Setenv("GROWDESK_ASR_FIXTURE_TEXT", "must not be recognized")
	t.Setenv("GROWDESK_AI_FIXTURE_RESPONSE", `{"text":"must not be answered","actions":[]}`)
	var events []Object
	var pending passportPending[pendingCardProposal]
	// An accidentally continued pipeline would hit the nil DB for this session.
	(&Server{}).processVoiceTurn(context.Background(), &PassportPrincipal{BabyID: "test_baby"}, "test_session", "test baby", "test_turn", buildWavFile(make([]byte, 32000), 16000, 1, 16),
		func(v any) error { events = append(events, v.(Object)); return nil },
		func([]byte) error { t.Fatal("silence emitted audio"); return nil }, &passportPlaybackControl{}, nil, &pending)
	if len(events) != 1 || events[0]["type"] != "error" || events[0]["code"] != "ASR_PROVIDER_NO_SPEECH" || events[0]["turnId"] != "test_turn" || pending.load() != nil {
		t.Fatalf("silence continued into the conversation: %#v", events)
	}
}

func TestPassportDigitalSilenceOnlyRecognizesTheCanonicalFormat(t *testing.T) {
	for _, wav := range [][]byte{nil, []byte("test input"), buildWavFile(make([]byte, 32000), 24000, 1, 16), buildWavFile([]byte{0}, 16000, 1, 16)} {
		if passportWavIsDigitalSilence(wav) {
			t.Fatal("noncanonical input classified as exact device silence")
		}
	}
}
