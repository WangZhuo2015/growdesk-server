package backend

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestPassportAgentRejectsNon2xxEvenWithChoices(t *testing.T) {
	for _, status := range []int{401, 403, 429, 502} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"must-not-accept-test"}}],"error":"test_private_error"}`)
		}))
		c := nativeProviderConfig{Mode: "openai-compatible", Endpoint: server.URL, APIKey: "test_key", Timeout: time.Second}
		_, err := (&Server{}).callPassportAgent(context.Background(), c, "", "test_baby", "test baby", "test text", nil)
		server.Close()
		var failure *nativeProviderError
		if !errors.As(err, &failure) || !strings.HasPrefix(failure.Code, "AI_PROVIDER_") || strings.Contains(err.Error(), "test_private_error") {
			t.Fatalf("HTTP %d accepted or leaked a provider response: %v", status, err)
		}
	}
}

func TestPassportAgentMissingFixtureCannotInventFeeding(t *testing.T) {
	answer, err := (&Server{}).callPassportAgent(context.Background(), nativeProviderConfig{Mode: "fixture"}, "", "test_baby", "test baby", "test text", nil)
	var failure *nativeProviderError
	if !errors.As(err, &failure) || failure.Code != "AI_PROVIDER_NOT_CONFIGURED" || len(answer.Actions) != 0 {
		t.Fatalf("missing explicit fixture invented a feeding: %#v %v", answer, err)
	}
}

func TestPassportAgentDeadlineIsVisibleAsTypedTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	<-ctx.Done()
	event := passportAIErrorEvent(ctx.Err())
	if event["code"] != "AI_PROVIDER_TIMEOUT" {
		t.Fatalf("deadline became a generic failure: %#v", event)
	}
}

func TestPassportCancelledAfterAnswerCannotPublishPendingCard(t *testing.T) {
	clearSpeechTestEnvironment(t)
	t.Setenv("GROWDESK_AI_PROVIDER", "fixture")
	t.Setenv("GROWDESK_ASR_FIXTURE_TEXT", "test spoken text")
	t.Setenv("GROWDESK_AI_FIXTURE_RESPONSE", `{"text":"test answer","actions":[{"actionId":"11111111-1111-4111-8111-111111111111","entityType":"feeding","operation":"create","summary":"test proposal","payload":{"type":"formula","amountMl":"1"}}]}`)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var pending passportPending[pendingCardProposal]
	(&Server{}).processVoiceTurn(ctx, &PassportPrincipal{BabyID: "test_baby"}, "", "test baby", "test_turn", []byte("test wav"),
		func(raw any) error {
			event := raw.(Object)
			if event["type"] == "assistant.final" {
				cancel()
			}
			if event["type"] == "card.present" || event["type"] == "tts.start" {
				t.Fatal("cancelled turn published a pending card/audio")
			}
			return nil
		}, func([]byte) error { t.Fatal("cancelled turn sent audio"); return nil }, &passportPlaybackControl{}, nil, &pending)
	if pending.load() != nil {
		t.Fatal("cancelled turn overwrote the pending proposal")
	}
}
