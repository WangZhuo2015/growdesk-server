package backend

import (
	"encoding/json"
	"fmt"
	"sync"
	"testing"
)

func TestPassportConfirmedActionID(t *testing.T) {
	cases := []struct {
		name  string
		frame string
		valid bool
	}{
		{"device frame", `{"actionIds":["test_action"]}`, true},
		{"missing action IDs", `{}`, false},
		{"legacy singular property", `{"actionId":"test_action"}`, false},
		{"null", `{"actionIds":null}`, false},
		{"empty", `{"actionIds":[]}`, false},
		{"different action", `{"actionIds":["test_other"]}`, false},
		{"extra action", `{"actionIds":["test_action","test_other"]}`, false},
		{"duplicate action", `{"actionIds":["test_action","test_action"]}`, false},
		{"scalar", `{"actionIds":"test_action"}`, false},
		{"number", `{"actionIds":[1]}`, false},
		{"object", `{"actionIds":[{"id":"test_action"}]}`, false},
		{"whitespace changes identity", `{"actionIds":[" test_action "]}`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var frame map[string]any
			if err := json.Unmarshal([]byte(tc.frame), &frame); err != nil {
				t.Fatal(err)
			}
			id, err := passportConfirmedActionID(frame["actionIds"], "test_action")
			if (err == nil) != tc.valid {
				t.Fatalf("id=%q err=%v, want valid=%v", id, err, tc.valid)
			}
			if tc.valid && id != "test_action" {
				t.Fatalf("non-canonical action ID: %q", id)
			}
			if !tc.valid && id != "" {
				t.Fatalf("invalid confirmation returned an action: %q", id)
			}
		})
	}
	if _, err := passportConfirmedActionID([]any{""}, ""); err == nil {
		t.Fatal("an empty expected action must not authorize confirmation")
	}
}

func TestPassportPendingConfirmationPreservesReplacement(t *testing.T) {
	type proposal struct{ entityType string }
	var pending passportPending[proposal]
	if pending.load() != nil {
		t.Fatal("zero-value pending state should be empty")
	}
	old := &proposal{entityType: "sleep"}
	next := &proposal{entityType: "diaper"}
	pending.store(old)
	confirmed := pending.load()
	// A voice worker publishes while the older confirmation is in-flight.
	pending.store(next)
	if pending.clear(confirmed) {
		t.Fatal("confirming an old card must not clear its replacement")
	}
	if pending.load() != next {
		t.Fatal("the replacement card was lost")
	}
	if confirmed.entityType != "sleep" {
		t.Fatal("the receipt must use the confirmed snapshot's entity type")
	}
	if !pending.clear(next) || pending.load() != nil {
		t.Fatal("confirming the current card should clear it")
	}
}

func TestPassportPendingConcurrentAccess(t *testing.T) {
	type proposal struct{ id string }
	var pending passportPending[proposal]
	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(worker int) {
			defer wg.Done()
			for i := 0; i < 1000; i++ {
				pending.store(&proposal{id: fmt.Sprintf("test_%d_%d", worker, i)})
				if snapshot := pending.load(); snapshot != nil {
					if snapshot.id == "" {
						t.Error("published an incomplete proposal")
					}
					pending.clear(snapshot)
				}
			}
		}(worker)
	}
	wg.Wait()
}
