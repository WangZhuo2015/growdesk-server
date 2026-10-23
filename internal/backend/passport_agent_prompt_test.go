package backend

import (
	"strings"
	"testing"
)

func TestPassportModelCannotChooseRecordIdentityOrOperation(t *testing.T) {
	raw := `{"text":"test proposal","actions":[{"actionId":"model-chosen-value","entityType":"feeding","operation":"create","summary":"test summary","payload":{"feedingType":"bottle","occurredAt":"2026-10-03T17:00:00Z","amountMl":"120"}}]}`
	first, err := parsePassportAssistant(raw)
	if err != nil || len(first.Actions) != 1 || !actionUUID.MatchString(first.Actions[0].ActionID) {
		t.Fatalf("server did not assign record identity: %#v %v", first, err)
	}
	second, err := parsePassportAssistant(strings.Replace(raw, `"actionId":"model-chosen-value",`, "", 1))
	if err != nil || len(second.Actions) != 1 || first.Actions[0].ActionID == second.Actions[0].ActionID {
		t.Fatalf("missing model id failed or server id was reused: %#v %v", second, err)
	}
	for _, operation := range []string{"update", "delete", "restore", ""} {
		_, err := parsePassportAssistant(strings.Replace(raw, `"operation":"create"`, `"operation":"`+operation+`"`, 1))
		if err == nil {
			t.Fatalf("model operation %q accepted", operation)
		}
	}
}

func TestPassportModelReplyKeepsReadonlyAndRejectsMultipleRecords(t *testing.T) {
	for _, raw := range []string{"test plain answer", `{"text":"test answer","actions":[]}`} {
		out, err := parsePassportAssistant(raw)
		if err != nil || out.Text == "" || len(out.Actions) != 0 {
			t.Fatalf("readonly answer rejected: %#v %v", out, err)
		}
	}
	_, err := parsePassportAssistant(`{"text":"test multiple","actions":[{},{}]}`)
	if err == nil {
		t.Fatal("multiple records accepted")
	}
}
