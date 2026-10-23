package backend

import (
	"encoding/json"
	"strings"
	"testing"
)

const testPassportActionID = "11111111-1111-4111-8111-111111111111"

func newPassportCardTestServer(t *testing.T) *Server {
	t.Helper()
	contract, err := LoadContract()
	if err != nil {
		t.Fatal(err)
	}
	return &Server{Contract: contract}
}

func passportAction(entity string, payload Object) nativeAIAction {
	return nativeAIAction{ActionID: testPassportActionID, EntityType: entity, Operation: "create", Summary: "test proposal", Payload: payload}
}

func fieldByLabel(fields []PassportCardField, label string) (PassportCardField, bool) {
	for _, field := range fields {
		if field.Label == label {
			return field, true
		}
	}
	return PassportCardField{}, false
}

func TestPassportNormalizeValidateCardsMatchAllRecordContracts(t *testing.T) {
	server := newPassportCardTestServer(t)
	tests := []struct {
		name       string
		entity     string
		payload    Object
		canonical  string
		fieldLabel string
		fieldValue string
	}{
		{
			name:      "feeding schema and explicit timezone",
			entity:    "feeding",
			payload:   Object{"feedingType": "formula", "occurredAt": "2026-10-01T09:32:00+08:00", "amountMl": json.Number("120.0"), "familyId": "test_spoof", "source": "test_spoof", "formulaProductId": "test_spoof_formula"},
			canonical: "feeding", fieldLabel: "奶量", fieldValue: "120.0",
		},
		{
			name:      "sleep uses startedAt and endedAt",
			entity:    "sleep",
			payload:   Object{"sleepType": "nap", "startedAt": "2026-10-01T09:00:00Z", "endedAt": "2026-10-01T10:12:00Z"},
			canonical: "sleep", fieldLabel: "结束时间", fieldValue: "2026-10-01T10:12:00Z",
		},
		{
			name:      "diaper canonical enum",
			entity:    "diaper",
			payload:   Object{"diaperType": "both", "occurredAt": "2026-10-01T10:00:00Z"},
			canonical: "diaper", fieldLabel: "类型", fieldValue: "大小便",
		},
		{
			name:      "food alias and real catalog IDs",
			entity:    "foodLog",
			payload:   Object{"recordDate": "2026-10-01", "mealType": "snack", "foodItemIds": []any{"test_oatmeal", "test_pear"}, "portionDescription": "test_small"},
			canonical: "food", fieldLabel: "食物", fieldValue: "test_oatmeal, test_pear",
		},
		{
			name:      "supplement alias and dose",
			entity:    "supplementRecord",
			payload:   Object{"supplementName": "test_vitamin_d", "occurredAt": "2026-10-01T10:00:00Z", "dose": json.Number("2.5"), "unitName": "mL", "productId": "test_spoof_supplement"},
			canonical: "supplement", fieldLabel: "剂量", fieldValue: "2.5",
		},
		{
			name:      "growth alias and every measurement",
			entity:    "growthMeasurement",
			payload:   Object{"measurementDate": "2026-10-01", "weightKg": json.Number("8.2"), "heightCm": "68.5", "headCircumferenceCm": json.Number("44.1"), "attachmentId": "test_spoof_attachment"},
			canonical: "growth", fieldLabel: "头围", fieldValue: "44.1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			action, card, err := server.normalizeValidatePassportAction(passportAction(tc.entity, tc.payload))
			if err != nil {
				t.Fatalf("normalize proposal: %v", err)
			}
			if action.EntityType != tc.canonical || card.EntityType != tc.canonical {
				t.Fatalf("wire alias was not canonicalized: action=%q card=%q want=%q", action.EntityType, card.EntityType, tc.canonical)
			}
			field, ok := fieldByLabel(card.Fields, tc.fieldLabel)
			if !ok || field.Value != tc.fieldValue {
				t.Fatalf("card did not faithfully show %q=%q: %+v", tc.fieldLabel, tc.fieldValue, card.Fields)
			}
			if card.Footer != "按中间键确认" {
				t.Fatalf("card confirmation control is wrong: %q", card.Footer)
			}
			if len(card.Fields) > passportMaxCardFields {
				t.Fatalf("card exceeded field limit: %d", len(card.Fields))
			}
			for key := range action.Payload {
				if isPassportServerOwnedKey(key) {
					t.Errorf("model-controlled server field %q survived normalization", key)
				}
			}
			if _, exists := action.Payload["attachmentId"]; exists {
				t.Error("model-controlled growth attachment ID survived normalization")
			}
			for key, label := range map[string]string{"productId": "产品 ID", "formulaProductId": "配方产品 ID"} {
				if _, exists := action.Payload[key]; exists {
					t.Errorf("model-controlled product reference %q survived normalization", key)
				}
				if _, exists := fieldByLabel(card.Fields, label); exists {
					t.Errorf("card displayed unverified product reference %q", key)
				}
				if _, exists := passportConfirmationBody(action)[key]; exists {
					t.Errorf("confirmation body retained unverified product reference %q", key)
				}
			}
		})
	}
}

func TestPassportNormalizeValidateRejectsUnrepresentableOrInvalidActions(t *testing.T) {
	server := newPassportCardTestServer(t)
	validFeeding := func() nativeAIAction {
		return passportAction("feeding", Object{"feedingType": "breast", "occurredAt": "2026-10-01T09:32:00Z"})
	}
	tests := []struct {
		name   string
		action nativeAIAction
	}{
		{name: "non UUID action", action: nativeAIAction{ActionID: "test_action", EntityType: "feeding", Operation: "create", Summary: "test", Payload: Object{"feedingType": "breast", "occurredAt": "2026-10-01T09:32:00Z"}}},
		{name: "update rejected", action: func() nativeAIAction { a := validFeeding(); a.Operation = "update"; return a }()},
		{name: "missing required schema field", action: passportAction("feeding", Object{"occurredAt": "2026-10-01T09:32:00Z"})},
		{name: "wrong schema enum", action: passportAction("diaper", Object{"diaperType": "dry", "occurredAt": "2026-10-01T09:32:00Z"})},
		{name: "food without a real item ID", action: passportAction("foodLog", Object{"recordDate": "2026-10-01", "mealType": "snack", "foodItemIds": []any{}})},
		{name: "blank food item ID", action: passportAction("foodLog", Object{"recordDate": "2026-10-01", "mealType": "snack", "foodItemIds": []any{" "}})},
		{name: "growth without measurements", action: passportAction("growthMeasurement", Object{"measurementDate": "2026-10-01"})},
		{name: "negative sleep interval", action: passportAction("sleep", Object{"sleepType": "nap", "startedAt": "2026-10-01T10:00:00Z", "endedAt": "2026-10-01T09:00:00Z"})},
		{name: "important value exceeds card bounds", action: passportAction("feeding", Object{"feedingType": "breast", "occurredAt": "2026-10-01T09:32:00Z", "notes": strings.Repeat("x", passportMaxCardValue+1)})},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, _, err := server.normalizeValidatePassportAction(tc.action); err == nil {
				t.Fatal("invalid proposal was accepted")
			}
		})
	}
}

func TestPassportCardLimitsAndNoSyntheticDefaults(t *testing.T) {
	server := newPassportCardTestServer(t)
	action, card, err := server.normalizeValidatePassportAction(passportAction("feeding", Object{
		"feedingType": "formula", "occurredAt": "2026-10-01T09:32:00Z", "amountMl": "140",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := action.Payload["spitUp"]; exists {
		t.Fatal("server schema default was added to the model proposal")
	}
	if _, exists := fieldByLabel(card.Fields, "吐奶"); exists {
		t.Fatal("card invented an explicit spit-up value")
	}
	tooMany := PassportCard{Title: "test", Footer: "test", Fields: make([]PassportCardField, passportMaxCardFields+1)}
	if err := validatePassportCardBounds(tooMany); err == nil {
		t.Fatal("card over the firmware field limit was accepted")
	}
}

func TestPassportDecimalNumberNormalizationPreservesDigits(t *testing.T) {
	cases := []struct{ input, want string }{
		{"1.0000000000000001", "1.0000000000000001"},
		{"9007199254740993", "9007199254740993"},
		{"-0.0", "-0.0"},
	}
	for _, tc := range cases {
		got, err := passportDecimalString(json.Number(tc.input))
		if err != nil || got != tc.want {
			t.Errorf("passportDecimalString(%q) = %q, %v; want %q", tc.input, got, err, tc.want)
		}
	}
	for _, rejected := range []string{"1.2e3", "1e-3"} {
		if _, err := passportDecimalString(json.Number(rejected)); err == nil {
			t.Errorf("scientific decimal %q was accepted", rejected)
		}
	}
	if _, err := passportDecimalString(float64(0.1)); err == nil {
		t.Fatal("floating-point decimal was accepted despite possible precision loss")
	}
}
