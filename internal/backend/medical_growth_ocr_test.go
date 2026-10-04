package backend

import "testing"

func evidenceText(value string) Object {
	return Object{"value": value, "confidence": 0.95, "uncertainty": ""}
}

func evidenceDecimal(value, source, unit string) Object {
	return Object{"value": value, "sourceValue": source, "sourceUnit": unit, "confidence": 0.9, "uncertainty": ""}
}

func TestGeneratedTypedOCRDraftSchemas(t *testing.T) {
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	input := nativeTaskInput{Version: 1, UserID: "test_user", FamilyID: "test_family", BabyID: "test_baby", AttachmentIDs: []string{"00000000-0000-4000-8000-000000000001"}}

	medical := Object{
		"title":       evidenceText("检查报告"),
		"category":    Object{"value": "blood", "confidence": 0.9, "uncertainty": ""},
		"reportDate":  Object{"value": "2026-09-01", "confidence": 0.95, "uncertainty": ""},
		"hospital":    evidenceText("Test Hospital"),
		"department":  evidenceText("儿科"),
		"doctorNotes": evidenceText("原文备注"),
		"items": []any{Object{
			"name":           evidenceText("Hemoglobin"),
			"value":          Object{"value": "120", "confidence": 0.95, "uncertainty": ""},
			"unit":           evidenceText("g/L"),
			"referenceRange": evidenceText("110-150"),
			"status":         Object{"value": "normal", "confidence": 0.9, "uncertainty": ""},
			"interpretation": evidenceText("正常范围内"),
		}},
		"growthData": nil,
	}
	medicalSchema := contract.Document.Components.Schemas["MedicalOcrDraft"].Value
	medicalWithServerFields := copyObject(medical)
	medicalWithServerFields["schemaVersion"] = float64(1)
	medicalWithServerFields["kind"] = "medical"
	medicalWithServerFields["attachmentId"] = input.AttachmentIDs[0]
	medicalWithServerFields["modelSource"] = "fixture"
	medicalWithServerFields["sourceText"] = "Hemoglobin 120 g/L"
	if err := medicalSchema.VisitJSON(schemaJSONValue(medicalWithServerFields), wireFormats...); err != nil {
		t.Fatalf("generated medical contract schema rejected fixture: %v", err)
	}
	medicalDraft, err := canonicalTypedOCRDraft(contract, "medical_ocr", medical, input, "Hemoglobin 120 g/L", "fixture")
	if err != nil {
		t.Fatalf("valid generated medical OCR schema rejected: %v", err)
	}
	if text(medicalDraft["kind"]) != "medical" || text(medicalDraft["attachmentId"]) != input.AttachmentIDs[0] || text(medicalDraft["modelSource"]) != "fixture" {
		t.Fatal("server-owned OCR metadata was not canonicalized")
	}
	medical["providerUnknownField"] = "discarded values are not acceptable"
	if _, err = canonicalTypedOCRDraft(contract, "medical_ocr", medical, input, "Hemoglobin 120 g/L", "fixture"); err == nil {
		t.Fatal("unknown provider field was accepted")
	}
	delete(medical, "providerUnknownField")
	medical["category"] = Object{"value": "diagnosis", "confidence": 0.9, "uncertainty": ""}
	if _, err = canonicalTypedOCRDraft(contract, "medical_ocr", medical, input, "Hemoglobin 120 g/L", "fixture"); err == nil {
		t.Fatal("unknown medical category was accepted")
	}

	growth := Object{
		"measurementDate":     Object{"value": "2026-09-01", "confidence": 0.95, "uncertainty": ""},
		"weightKg":            evidenceDecimal("8.25", "8250", "g"),
		"heightCm":            evidenceDecimal("70.5", "70.5", "cm"),
		"headCircumferenceCm": evidenceDecimal("44.0", "44", "cm"),
	}
	if _, err = canonicalTypedOCRDraft(contract, "growth_ocr", growth, input, "体重 8250 g", "fixture"); err != nil {
		t.Fatalf("valid generated growth OCR schema rejected: %v", err)
	}
	growth["weightKg"] = Object{"value": "8.25", "sourceValue": "8250", "sourceUnit": "g", "confidence": 1.01, "uncertainty": ""}
	if _, err = canonicalTypedOCRDraft(contract, "growth_ocr", growth, input, "体重 8250 g", "fixture"); err == nil {
		t.Fatal("confidence above 1 was accepted")
	}
}

func TestTypedOCRAcceptsOnlyWorkerSupportedMIMEs(t *testing.T) {
	for kind, allowed := range map[string][]string{
		"medical_ocr": {"image/jpeg", "image/png", "image/webp", "application/pdf"},
		"growth_ocr":  {"image/jpeg", "image/png", "image/webp"},
	} {
		for _, mime := range allowed {
			if !supportedOCRMime(kind, mime) {
				t.Errorf("%s unexpectedly rejected %s", kind, mime)
			}
		}
	}
	for _, test := range []struct{ kind, mime string }{
		{"medical_ocr", "image/heic"}, {"medical_ocr", "audio/m4a"},
		{"growth_ocr", "application/pdf"}, {"growth_ocr", "image/heic"},
	} {
		if supportedOCRMime(test.kind, test.mime) {
			t.Errorf("%s unexpectedly accepted %s", test.kind, test.mime)
		}
	}
}
