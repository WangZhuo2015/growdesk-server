package backend

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestVaccineRecordProjectionPreservesPendingState(t *testing.T) {
	row := Object{"administered_date": "2026-05-02", "scheduled_date": nil, "completed_date": nil,
		"is_completed": false, "version": json.Number("1"), "dose_number": nil, "caregiver_id": "private"}
	value := vaccineRecordDTO(row)
	if value["scheduledDate"] != "2026-05-02" || value["completedDate"] != nil || value["isCompleted"] != false {
		t.Fatal(value)
	}
	if value["version"] != "1" || value["doseNumber"] != nil {
		t.Fatal(value)
	}
	if _, leaked := value["caregiverId"]; leaked {
		t.Fatal("private caregiver projection leaked")
	}
	selection := vaccineSelectionDTO(Object{"selected": false, "completed": false, "version": 1, "dose_number": 1})
	if selection["selected"] != false || selection["completed"] != false {
		t.Fatal(selection)
	}
}

func TestUpdateVaccineRecordContractRequiresVersionAndReceiptKey(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	route := contract.ByID["updateVaccineRecord"]
	if route == nil || route.Method != "PATCH" || route.Path != "/api/v1/babies/{babyId}/vaccines/records/{id}" {
		t.Fatalf("unexpected vaccine update operation: %+v", route)
	}

	request, err := http.NewRequest(http.MethodPatch, "http://127.0.0.1/api/v1/babies/11111111-1111-4111-8111-111111111111/vaccines/records/22222222-2222-4222-8222-222222222222", nil)
	if err != nil {
		t.Fatal(err)
	}
	params := map[string]string{
		"babyId": "11111111-1111-4111-8111-111111111111",
		"id":     "22222222-2222-4222-8222-222222222222",
	}
	if err := route.Validate(request, params, Object{"baseVersion": "1", "notes": "test note"}); err == nil {
		t.Fatal("missing Idempotency-Key was accepted")
	}
	request.Header.Set("Idempotency-Key", "test_vaccine_update")
	if err := route.Validate(request, params, Object{"notes": "test note"}); err == nil {
		t.Fatal("missing baseVersion was accepted")
	}
	if err := route.Validate(request, params, Object{"baseVersion": "1", "notes": "test note"}); err != nil {
		t.Fatalf("valid vaccine update body was rejected: %v", err)
	}
	if err := route.Validate(request, params, Object{"baseVersion": "1", "notes": "test note", "unknown": true}); err == nil {
		t.Fatal("unknown update field was accepted")
	}
}

func TestVaccineDateInputRejectsCalendarInvalidDate(t *testing.T) {
	if _, err := vaccineDateInput("2026-02-28", "completedDate"); err != nil {
		t.Fatalf("valid date rejected: %v", err)
	}
	if _, err := vaccineDateInput("2026-02-30", "completedDate"); err == nil {
		t.Fatal("invalid calendar date accepted")
	}
}

func TestVaccineCatalogIsExplicitAndDetached(t *testing.T) {
	value := vaccineCatalogItem(Object{"id": "test_vaccine", "legacy_metadata": Object{"private": true}, "doses": []any{
		map[string]any{"id": "test_dose", "dose_volume_ml": json.Number("0.50000"), "legacy_metadata": Object{"private": true}},
	}})
	if _, exists := value["legacyMetadata"]; exists {
		t.Fatal("private vaccine archive exposed")
	}
	dose := value["doses"].([]Object)[0]
	if dose["doseVolumeMl"] != "0.5" {
		t.Fatal(dose)
	}
	if _, exists := dose["legacyMetadata"]; exists {
		t.Fatal("private dose archive exposed")
	}
	rules := nativeVaccineEngineRules()
	if len(rules) != 8 {
		t.Fatal("incomplete pinned rule snapshot")
	}
	rules[0]["description"] = "modified response"
	rules[0]["sourceRefs"].([]string)[0] = "modified source"
	again := nativeVaccineEngineRules()
	if again[0]["description"] == "modified response" || again[0]["sourceRefs"].([]string)[0] == "modified source" {
		t.Fatal("global reference mutated")
	}
	defaults := defaultVaccineSchedule()
	if len(defaults) != 9 || defaults[0]["recommendedAgeMonths"] != 0 {
		t.Fatal(defaults)
	}
	defaults[0]["name"] = "modified response"
	if defaultVaccineSchedule()[0]["name"] == "modified response" {
		t.Fatal("global default mutated")
	}
}
