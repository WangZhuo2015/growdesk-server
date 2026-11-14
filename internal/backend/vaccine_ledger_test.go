package backend

import (
	"testing"
	"time"
)

func TestVaccineLedgerRequiresActualEvidence(t *testing.T) {
	now := time.Date(2024, 6, 20, 4, 0, 0, 0, time.UTC)
	invalidBodies := []Object{
		{"recordStatus": "completed"},
		{"recordStatus": "completed", "scheduledDate": "2024-06-01"},
		{"recordStatus": "completed", "administeredDate": "2024-06-21"},
		{"recordStatus": "completed", "administeredDate": "2024-02-30"},
		{"recordStatus": "completed", "administeredDate": "2024-06-01", "completedDate": "2024-06-02"},
		{"recordStatus": "planned"},
		{"recordStatus": "planned", "administeredDate": "2024-06-01"},
		{"recordStatus": "planned", "scheduledDate": "2024-06-21", "administeredDate": "2024-06-01"},
	}
	for _, body := range invalidBodies {
		if _, err := vaccineLifecycleValues(body, nil, true, now); err == nil {
			t.Fatalf("accepted invalid ledger evidence: %#v", body)
		}
	}
	plan, err := vaccineLifecycleValues(Object{"recordStatus": "planned", "scheduledDate": "2024-07-01"}, nil, true, now)
	if err != nil || plan["administered_date"] != nil || plan["completed_date"] != nil || plan["is_completed"] != false {
		t.Fatalf("plan became an administration: %#v, %v", plan, err)
	}
	review, err := vaccineLifecycleValues(Object{"recordStatus": "needs_review"}, nil, true, now)
	if err != nil || review["administered_date"] != nil || review["scheduled_date"] != nil || review["is_completed"] != false {
		t.Fatalf("unknown source acquired a date: %#v, %v", review, err)
	}
	reported, err := vaccineLifecycleValues(Object{"recordStatus": "needs_review", "administeredDate": "9999-12-31", "completedDate": nil}, nil, true, now)
	if err != nil || reported["completed_date"] != nil || reported["is_completed"] != false {
		t.Fatalf("unverified date could not be preserved without completion: %#v, %v", reported, err)
	}
}

func TestVaccineLedgerPatchDoesNotPromoteAppointment(t *testing.T) {
	now := time.Date(2024, 6, 20, 4, 0, 0, 0, time.UTC)
	existing := Object{"record_status": "planned", "scheduled_date": "2024-06-10", "administered_date": nil, "is_completed": false}
	if _, err := vaccineLifecycleValues(Object{"recordStatus": "completed"}, existing, true, now); err == nil {
		t.Fatal("appointment date was reused as an actual date")
	}
	confirmed, err := vaccineLifecycleValues(Object{"recordStatus": "completed", "administeredDate": "2024-06-12"}, existing, true, now)
	if err != nil || testVaccineDate(confirmed["administered_date"]) != "2024-06-12" || testVaccineDate(confirmed["scheduled_date"]) != "2024-06-10" {
		t.Fatalf("explicit confirmation lost its dates: %#v, %v", confirmed, err)
	}
	confirmedRow := Object{"record_status": "completed", "is_completed": true, "administered_date": "2024-06-12", "scheduled_date": "2024-06-10"}
	corrected, err := vaccineLifecycleValues(Object{"completedDate": "2024-06-13"}, confirmedRow, true, now)
	if err != nil || testVaccineDate(corrected["administered_date"]) != "2024-06-13" {
		t.Fatalf("explicit completedDate correction was ignored: %#v, %v", corrected, err)
	}
}

func TestVaccineLedgerShanghaiCalendarBoundary(t *testing.T) {
	now := time.Date(2024, 6, 19, 17, 0, 0, 0, time.UTC)
	today, err := vaccineTodayShanghai(now)
	if err != nil || today != "2024-06-20" {
		t.Fatalf("wrong Shanghai calendar day: %q, %v", today, err)
	}
	date, err := parseVaccineDate("2024-06-20", "administeredDate")
	if err != nil || validateActualVaccineDate(date, now) != nil {
		t.Fatal("local today was rejected as a future date")
	}
}

func TestVaccineLedgerLegacyTransportDoesNotAlterStoredTruth(t *testing.T) {
	now := time.Date(2024, 6, 20, 4, 0, 0, 0, time.UTC)
	legacy, err := vaccineLifecycleValues(Object{"isCompleted": false, "administeredDate": "2024-07-01"}, nil, false, now)
	if err != nil || legacy["administered_date"] != nil || testVaccineDate(legacy["scheduled_date"]) != "2024-07-01" {
		t.Fatalf("legacy plan was not stored truthfully: %#v, %v", legacy, err)
	}
	stored := Object{"record_status": "planned", "is_completed": false, "administered_date": nil, "scheduled_date": "2024-07-01"}
	legacyDTO := vaccineRecordDTO(stored, false)
	ledgerDTO := vaccineRecordDTO(stored, true)
	if legacyDTO["administeredDate"] != "2024-07-01" || ledgerDTO["administeredDate"] != nil || legacy["administered_date"] != nil {
		t.Fatalf("representation changed storage or old decoder shape: %#v / %#v", legacyDTO, ledgerDTO)
	}
	if _, err := vaccineLifecycleValues(Object{"recordStatus": "needs_review"}, nil, false, now); err == nil {
		t.Fatal("legacy client accepted an undated review row")
	}
}

func testVaccineDate(value any) string {
	if date, ok := value.(time.Time); ok {
		return date.Format("2006-01-02")
	}
	return text(dateValue(value))
}

func TestVaccineLedgerPatchPreservesDetailsAndUnknownOrdinal(t *testing.T) {
	existing := Object{"manufacturer": "test_manufacturer", "batch_number": "TEST-LOT", "trace_code": "000000123", "dose_number": nil,
		"legacy_dose": "第2剂", "clinic": "test_clinic", "source_text": "test_source", "notes": "test_old"}
	patched := vaccineRecordFields(Object{"notes": "test_corrected"}, existing, false)
	for _, field := range []string{"manufacturer", "batch_number", "trace_code", "clinic", "source_text", "dose_number", "legacy_dose"} {
		if patched[field] != existing[field] {
			t.Fatalf("metadata %s lost: %#v", field, patched)
		}
	}
	if patched["notes"] != "test_corrected" || patched["dose_number"] != nil {
		t.Fatal("patch invented a dose or ignored the correction", patched)
	}
	row := Object{"record_status": "completed", "is_completed": true, "administered_date": "9999-12-31", "completed_date": "9999-12-31"}
	dto := vaccineRecordDTO(row, true)
	if dto["recordStatus"] != "needs_review" || dto["isCompleted"] != false || dto["completedDate"] != nil {
		t.Fatal("future historical evidence counted as completion", dto)
	}
}
