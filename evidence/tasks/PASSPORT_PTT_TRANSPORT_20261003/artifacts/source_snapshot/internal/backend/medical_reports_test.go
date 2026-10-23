package backend

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestMedicalDocumentReceiptsUseValidatedValues(t *testing.T) {
	cases := []struct{ raw, expected string }{
		{`{"title":"test","items":[{"value":1.0,"status":"normal","name":"test","id":"a"}],"reportDate":"2026-01-01"}`, `{"title":"test","items":[{"value":1,"status":"normal","name":"test","id":"a"}],"reportDate":"2026-01-01"}`},
		{`{"notes":"first","notes":"last","items":[0,false,null,[]]}`, `{"notes":"last","items":[0,false,null,[]]}`},
		{`{"items":{"b":-0,"10":1e1,"2":2,"01":3}}`, `{"items":{"2":2,"10":10,"b":0,"01":3}}`},
		{"{\"notes\":\"test\u2028line\u2029<&>\"}", "{\"notes\":\"test\u2028line\u2029<&>\"}"},
	}
	for _, test := range cases {
		var body Object
		if err := decodeJSON([]byte(test.raw), &body); err != nil { t.Fatal(err) }
		hash, err := documentBodyHash(&Request{RawBody: []byte(test.raw), Body: body})
		if err != nil || hash != hashText(test.expected) { t.Fatalf("receipt mismatch for %s: %s %v", test.raw, hash, err) }
	}
	r := &Request{RawBody: []byte(`{"title":"untrusted","injected":true,"items":[{"name":"untrusted","extra":true}]}`),
		Body: Object{"title": "validated", "items": []any{map[string]any{"name": "validated"}}}}
	hash, err := documentBodyHash(r)
	if err != nil || hash != hashText(`{"title":"validated","items":[{"name":"validated"}]}`) { t.Fatalf("raw input overrode validation: %v", err) }
	r.Body["newDefault"] = true
	if _, err := documentBodyHash(r); err == nil { t.Fatal("unknown default order accepted") }
}

func TestMedicalDTOHasNoPersistenceMetadata(t *testing.T) {
	row := Object{"id": "test_report", "report_date": "2026-05-02", "version": json.Number("3"),
		"items": "not-an-array", "caregiver_id": "private", "deleted_at": nil, "legacy_metadata": Object{"secret": true}}
	dto := medicalReportDTO(row)
	if dto["version"] != "3" || dto["reportDate"] != "2026-05-02" { t.Fatal(dto) }
	for _, key := range []string{"caregiverId", "caregiver_id", "deletedAt", "deleted_at", "legacy_metadata"} {
		if _, exists := dto[key]; exists { t.Fatalf("internal field leaked: %s", key) }
	}
	if data, ok := dto["items"].([]any); !ok || len(data) != 0 { t.Fatal("items must be []") }
	if data, ok := dto["attachmentIds"].([]any); !ok || len(data) != 0 { t.Fatal("attachments must be []") }
	if value, exists := dto["diagnosis"]; !exists || value != nil { t.Fatal("null diagnosis lost") }
}

func TestMedicalAliasesAreExactAndDoNotMutateContract(t *testing.T) {
	contract, err := LoadContract()
	if err != nil { t.Fatal(err) }
	s := &Server{Contract: contract}
	for _, test := range []struct{ method, path, op string }{
		{"GET", "/api/v1/babies/test_baby/medical/reports", "listMedicalReports"},
		{"POST", "/api/v1/babies/test_baby/medical/reports", "createMedicalReport"},
		{"GET", "/api/v1/babies/test_baby/medical/reports/test_report", "getMedicalReport"},
		{"PATCH", "/api/v1/babies/test_baby/medical/reports/test_report", "updateMedicalReport"},
		{"DELETE", "/api/v1/babies/test_baby/medical/reports/test_report", "deleteMedicalReport"},
	} {
		route, params := s.matchNativeRoute(test.method, test.path)
		if route == nil || route.OperationID != test.op || params["babyId"] != "test_baby" { t.Fatalf("alias mismatch: %+v", test) }
	}
	for _, path := range []string{"/api/v1/babies//medical/reports", "/api/v1/babies/test/medical/reports/x/extra", "/api/v1/babies/test/medical/reports/"} {
		if route, _ := s.matchNativeRoute(http.MethodGet, path); route != nil { t.Fatalf("invalid alias matched: %s", path) }
	}
	template := contract.ByID["getVaccineSchedule"]
	count := len(template.Operation.Parameters)
	global, params := s.matchNativeRoute(http.MethodGet, "/api/v1/vaccines/schedule")
	if global == nil || len(params) != 0 { t.Fatal("global public schedule alias requires fabricated baby") }
	for _, parameter := range global.Operation.Parameters {
		if parameter.Value != nil && parameter.Value.In == "path" { t.Fatal("global route inherited baby requirement") }
	}
	if len(template.Operation.Parameters) != count { t.Fatal("frozen contract mutated") }
}
