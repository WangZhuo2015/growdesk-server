package backend

import (
	"encoding/json"
	"errors"
	"testing"
	"time"
)

func TestPassportProposalProjectionRejectsMultipleActions(t *testing.T) {
	actions := []nativeAIAction{
		{
			ActionID:   "00000000-0000-4000-8000-000000000002",
			EntityType: "feeding",
			Operation:  "create",
			Summary:    "test feeding action",
			Payload:    Object{"type": "formula", "amountMl": "140"},
		},
		{
			ActionID:   "00000000-0000-4000-8000-000000000003",
			EntityType: "diaper",
			Operation:  "create",
			Summary:    "test diaper action",
			Payload:    Object{"type": "wet"},
		},
	}

	projection, err := projectPassportActions(actions)
	if projection != nil {
		t.Fatalf("multi-action response returned a partial card/confirmation: %+v", projection)
	}
	var providerErr *nativeProviderError
	if !errors.As(err, &providerErr) || providerErr.Code != "MULTI_ACTION_UNSUPPORTED" {
		t.Fatalf("got error %v, want visible MULTI_ACTION_UNSUPPORTED", err)
	}
}

func TestPassportCardPresentEventEchoesTurnID(t *testing.T) {
	const (
		turnID   = "turn-1727880000000-17"
		runID    = "00000000-0000-4000-8000-000000000001"
		planHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
		actionID = "00000000-0000-4000-8000-000000000002"
	)
	expiresAt := time.Date(2026, time.October, 2, 12, 0, 0, 0, time.UTC)
	card := PassportCard{
		SchemaVersion: 1,
		Kind:          "record_proposal",
		EntityType:    "feeding",
		Title:         "记录喂奶",
		Status:        "awaiting_confirmation",
		Fields:        []PassportCardField{{Label: "奶量", Value: "140", Unit: "mL"}},
	}

	payload, err := json.Marshal(passportCardPresentEvent(turnID, runID, card, planHash, actionID, expiresAt))
	if err != nil {
		t.Fatal(err)
	}
	var event map[string]any
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatal(err)
	}
	if event["type"] != "card.present" || event["turnId"] != turnID || event["runId"] != runID {
		t.Fatalf("card event lost turn/run correlation: %s", payload)
	}
	confirmation, ok := event["confirmation"].(map[string]any)
	if !ok || confirmation["planHash"] != planHash || confirmation["expiresAt"] != expiresAt.Format(time.RFC3339) {
		t.Fatalf("card event confirmation changed: %s", payload)
	}
	ids, ok := confirmation["actionIds"].([]any)
	if !ok || len(ids) != 1 || ids[0] != actionID {
		t.Fatalf("card event action binding changed: %s", payload)
	}
}
