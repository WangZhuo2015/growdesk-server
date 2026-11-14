package backend

import (
	"encoding/json"
	"testing"
	"time"
)

func TestVaccineRecordProjectionPreservesPendingState(t *testing.T) {
	row := Object{"administered_date": "2026-05-02", "scheduled_date": nil, "completed_date": nil,
		"is_completed": false, "version": json.Number("1"), "dose_number": nil, "caregiver_id": "private"}
	value := vaccineRecordDTO(row)
	if value["scheduledDate"] != nil || value["completedDate"] != nil || value["isCompleted"] != false {
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

func TestVaccineBookletDoesNotInventUnknownFields(t *testing.T) {
	values, err := vaccineRecordValues(Object{"vaccineCode": "test_booklet", "administeredDate": "2026-04-03", "traceabilityCode": "00001234567890"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if values["dose_number"] != nil || values["scheduled_date"] != nil || values["manufacturer"] != nil {
		t.Fatal(values)
	}
	if values["traceability_code"] != "00001234567890" || values["completed_date"].(time.Time).Format("2006-01-02") != "2026-04-03" {
		t.Fatal(values)
	}
}

func TestVaccineBookletDateTransitionsRequireEvidence(t *testing.T) {
	plan := Object{"administered_date": "2026-08-01", "scheduled_date": "2026-08-01", "is_completed": false}
	rescheduled, err := vaccineRecordValues(Object{"scheduledDate": "2026-08-03"}, plan)
	if err != nil || rescheduled["administered_date"].(time.Time).Format("2006-01-02") != "2026-08-03" || rescheduled["completed_date"] != nil {
		t.Fatal(rescheduled, err)
	}
	invalid := []struct{ body, existing Object }{
		{Object{"vaccineCode": "test", "administeredDate": "2026-04", "isCompleted": true}, nil},
		{Object{"vaccineCode": "test", "administeredDate": "2026-02-30", "isCompleted": true}, nil},
		{Object{"vaccineCode": "test", "administeredDate": "2026-04-03", "isCompleted": false}, nil},
		{Object{"vaccineCode": "test", "administeredDate": "2026-04-03", "isCompleted": true, "completedDate": "2026-04-04"}, nil},
		{Object{"vaccineCode": "test", "administeredDate": "2026-04-03", "scheduledDate": "2026-04-03", "isCompleted": false, "completedDate": "2026-04-03"}, nil},
		{Object{"isCompleted": true}, plan},
	}
	for _, test := range invalid {
		if _, err := vaccineRecordValues(test.body, test.existing); err == nil {
			t.Fatalf("accepted ambiguous dates: %#v", test.body)
		}
	}
	values, err := vaccineRecordValues(Object{"isCompleted": true, "administeredDate": "2026-08-05", "doseNumber": nil, "clinic": nil}, plan)
	if err != nil {
		t.Fatal(err)
	}
	if values["scheduled_date"].(time.Time).Format("2006-01-02") != "2026-08-01" || values["completed_date"].(time.Time).Format("2006-01-02") != "2026-08-05" || values["dose_number"] != nil {
		t.Fatal(values)
	}
	if _, supplied := values["manufacturer"]; supplied {
		t.Fatal("omitted patch field would clear metadata")
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
