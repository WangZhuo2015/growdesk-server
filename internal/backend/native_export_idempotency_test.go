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
