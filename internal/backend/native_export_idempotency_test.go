package backend

import (
	"strings"
	"testing"
)

func TestNativeExportIdempotencyKeyValidation(t *testing.T) {
	tests := []struct {
		name    string
		values  []string
		wantKey string
		wantErr bool
	}{
		{name: "omitted remains backward compatible"},
		{name: "uuid key accepted", values: []string{"3b7f3d30-9f74-4f52-b8c8-6579b98e3ac0"}, wantKey: "3b7f3d30-9f74-4f52-b8c8-6579b98e3ac0"},
		{name: "safe namespaced key accepted", values: []string{"ios.export:retry_1"}, wantKey: "ios.export:retry_1"},
		{name: "empty supplied key rejected", values: []string{""}, wantErr: true},
		{name: "spaces rejected", values: []string{"two words"}, wantErr: true},
		{name: "unsupported punctuation rejected", values: []string{"key/part"}, wantErr: true},
		{name: "overlong key rejected", values: []string{strings.Repeat("k", 129)}, wantErr: true},
		{name: "duplicate key headers rejected", values: []string{"first", "second"}, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			key, err := nativeExportIdempotencyKey(test.values)
			if test.wantErr {
				if err == nil || normalizedError(err).Status != 400 {
					t.Fatalf("expected HTTP 400, got key=%q err=%v", key, err)
				}
				return
			}
			if err != nil || key != test.wantKey {
				t.Fatalf("got key=%q err=%v, want %q", key, err, test.wantKey)
			}
		})
	}
}

func TestNativeExportRequestHashIncludesFutureBody(t *testing.T) {
	missingBody, err := nativeExportRequestHash(nil)
	if err != nil {
		t.Fatal(err)
	}
	emptyBody, err := nativeExportRequestHash(Object{})
	if err != nil {
		t.Fatal(err)
	}
	if missingBody != emptyBody {
		t.Fatal("missing body and an explicit empty object must share one canonical request hash")
	}

	first, err := nativeExportRequestHash(Object{"format": "json", "includeAttachments": false})
	if err != nil {
		t.Fatal(err)
	}
	unchanged, err := nativeExportRequestHash(Object{"includeAttachments": false, "format": "json"})
	if err != nil {
		t.Fatal(err)
	}
	changed, err := nativeExportRequestHash(Object{"format": "json", "includeAttachments": true})
	if err != nil {
		t.Fatal(err)
	}
	if first != unchanged {
		t.Fatal("JSON object key order changed the canonical request hash")
	}
	if first == changed {
		t.Fatal("changed export body reused the previous request hash")
	}
}

func TestNativeExportBabyScopeAndSanitizedFailure(t *testing.T) {
	pages := []nativeSnapshotPage{
		{EntityType: "baby", Data: []Object{{"id": "44444444-4444-4444-8444-444444444444"}}},
		{EntityType: "feeding", Data: []Object{{"id": "55555555-5555-4555-8555-555555555555"}}},
	}
	babies, err := nativeExportBabyIDs(pages)
	if err != nil || len(babies) != 1 || babies[0] != "44444444-4444-4444-8444-444444444444" {
		t.Fatalf("authorized baby projection was not extracted: babies=%v err=%v", babies, err)
	}
	empty, err := nativeExportBabyIDs([]nativeSnapshotPage{{EntityType: "baby", Data: []Object{}}})
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("empty baby scope must be an explicit empty list: babies=%v err=%v", empty, err)
	}
	if _, err = nativeExportBabyIDs([]nativeSnapshotPage{{EntityType: "baby", Data: []Object{{"id": "not-a-uuid"}}}}); err == nil {
		t.Fatal("invalid baby id must fail closed")
	}
	if got := safeNativeExportErrorCode(Object{"error_details": Object{"code": "EXPORT_TOO_LARGE", "message": "safe"}}); got != "EXPORT_TOO_LARGE" {
		t.Fatalf("known public export error was not retained: %q", got)
	}
	if got := safeNativeExportErrorCode(Object{"error_details": Object{"code": "DATABASE_PASSWORD", "message": "never expose this"}}); got != "EXPORT_FAILED" {
		t.Fatalf("unknown/internal failure was not sanitized: %q", got)
	}
}

func TestNativeExportPayloadScopesMatchVersionedFile(t *testing.T) {
	payload := Object{
		"schemaVersion": 1,
		"families": []any{Object{
			"familyId":  "66666666-6666-4666-8666-666666666666",
			"epoch":     "77777777-7777-4777-8777-777777777777",
			"highWater": "12",
			"pages":     []any{Object{"entityType": "baby", "data": []any{Object{"id": "88888888-8888-4888-8888-888888888888"}}}},
		}},
	}
	scopes, err := nativeExportPayloadScopes(payload)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("failed to derive private access scope from export file: scopes=%+v err=%v", scopes, err)
	}
	want := nativeExportFamily{
		ID: "66666666-6666-4666-8666-666666666666", Epoch: "77777777-7777-4777-8777-777777777777",
		HighWater: "12", BabyIDs: []string{"88888888-8888-4888-8888-888888888888"},
	}
	if scopes[0].ID != want.ID || scopes[0].Epoch != want.Epoch || scopes[0].HighWater != want.HighWater || !sameIDs(scopes[0].BabyIDs, want.BabyIDs) {
		t.Fatalf("unexpected extracted scopes: %+v", scopes[0])
	}
	for _, invalid := range []string{"-1", "not-a-position"} {
		bad := Object{
			"schemaVersion": 1,
			"families": []any{Object{
				"familyId":  "66666666-6666-4666-8666-666666666666",
				"epoch":     "77777777-7777-4777-8777-777777777777",
				"highWater": invalid,
				"pages":     []any{},
			}},
		}
		if _, err = nativeExportPayloadScopes(bad); err == nil {
			t.Fatalf("invalid highWater %q must fail closed", invalid)
		}
	}
}
