package backend

import (
	"encoding/json"
	"testing"
)

func TestVaccineRecordProjectionPreservesPendingState(t *testing.T) {
	row := Object{"administered_date": "2026-05-02", "scheduled_date": nil, "completed_date": nil,
		"is_completed": false, "version": json.Number("1"), "dose_number": nil, "caregiver_id": "private"}
	value := vaccineRecordDTO(row)
	if value["scheduledDate"] != "2026-05-02" || value["completedDate"] != nil || value["isCompleted"] != false { t.Fatal(value) }
	if value["version"] != "1" || value["doseNumber"] != nil { t.Fatal(value) }
	if _, leaked := value["caregiverId"]; leaked { t.Fatal("private caregiver projection leaked") }
	selection := vaccineSelectionDTO(Object{"selected": false, "completed": false, "version": 1, "dose_number": 1})
	if selection["selected"] != false || selection["completed"] != false { t.Fatal(selection) }
}

func TestVaccineCatalogIsExplicitAndDetached(t *testing.T) {
	value := vaccineCatalogItem(Object{"id": "test_vaccine", "legacy_metadata": Object{"private": true}, "doses": []any{
		map[string]any{"id": "test_dose", "dose_volume_ml": json.Number("0.50000"), "legacy_metadata": Object{"private": true}},
	}})
	if _, exists := value["legacyMetadata"]; exists { t.Fatal("private vaccine archive exposed") }
	dose := value["doses"].([]Object)[0]
	if dose["doseVolumeMl"] != "0.5" { t.Fatal(dose) }
	if _, exists := dose["legacyMetadata"]; exists { t.Fatal("private dose archive exposed") }
	rules := nativeVaccineEngineRules()
	if len(rules) != 8 { t.Fatal("incomplete pinned rule snapshot") }
	rules[0]["description"] = "modified response"
	rules[0]["sourceRefs"].([]string)[0] = "modified source"
	again := nativeVaccineEngineRules()
	if again[0]["description"] == "modified response" || again[0]["sourceRefs"].([]string)[0] == "modified source" { t.Fatal("global reference mutated") }
	defaults := defaultVaccineSchedule()
	if len(defaults) != 9 || defaults[0]["recommendedAgeMonths"] != 0 { t.Fatal(defaults) }
	defaults[0]["name"] = "modified response"
	if defaultVaccineSchedule()[0]["name"] == "modified response" { t.Fatal("global default mutated") }
}
