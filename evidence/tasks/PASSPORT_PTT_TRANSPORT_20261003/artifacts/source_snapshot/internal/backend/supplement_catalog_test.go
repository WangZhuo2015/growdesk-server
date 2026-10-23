package backend

import (
	"encoding/base64"
	"encoding/json"
	"math"
	"testing"
)

func TestSupplementCatalogRepresentations(t *testing.T) {
	row := Object{"id": "legacy_product-1", "family_id": "test_family", "name": "Test", "default_dose": json.Number("1.25000"),
		"is_active": true, "is_archived": true, "version": json.Number("3"), "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-01T00:00:00Z",
		"legacy_metadata": Object{"secret": "must not appear"}}
	dto := supplementProductDTO(row)
	if dto["defaultDose"] != "1.25" || dto["isActive"] != false || text(dto["version"]) != "3" { t.Fatalf("invalid projection: %v", dto) }
	if _, exists := dto["legacyMetadata"]; exists { t.Fatal("private metadata leaked") }
	if _, exists := dto["legacy_metadata"]; exists { t.Fatal("raw metadata leaked") }
	if value, exists := dto["notes"]; !exists || value != nil { t.Fatal("missing nullable notes") }
	schedule := supplementScheduleDTO(Object{"target_dose": json.Number("0.00000"), "custom_days_json": []any{}, "is_active": false}, row, false)
	if schedule["targetDose"] != "0" || schedule["isCompletedToday"] != false || schedule["isActive"] != false { t.Fatalf("zero/false lost: %v", schedule) }
	encoded, err := nullableJSONValue(nil)
	if err != nil || string(encoded) != "null" { t.Fatalf("JSON null changed: %s %v", encoded, err) }
}

func TestSupplementCursorAndVersion(t *testing.T) {
	raw := base64.RawURLEncoding.EncodeToString([]byte("2026-01-01T00:00:00.000Z|legacy_product-1"))
	_, id, err := supplementProductCursor(raw)
	if err != nil || id != "legacy_product-1" { t.Fatalf("legacy ID cursor rejected: %v", err) }
	for _, value := range []string{"bad", "", base64.RawURLEncoding.EncodeToString([]byte("2026-01-01|a|b")), base64.RawURLEncoding.EncodeToString([]byte("not-a-date|valid"))} {
		if _, _, err = supplementProductCursor(value); err == nil { t.Fatalf("invalid cursor accepted: %q", value) }
	}
	if n, err := nextCatalogVersion(Object{"version": 2}, Object{"baseVersion": json.Number("2")}); err != nil || n != 3 { t.Fatalf("CAS mismatch: %d %v", n, err) }
	for _, test := range []struct{ version int; body Object }{{2, Object{"baseVersion": 1}}, {math.MaxInt32, nil}, {0, nil}} {
		if _, err := nextCatalogVersion(Object{"version": test.version}, test.body); err == nil { t.Fatal("invalid version accepted") }
	}
}
