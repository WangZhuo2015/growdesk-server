package backend

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestNutritionProfileJSONAcceptsSupportedAndFutureValues(t *testing.T) {
	profile := Object{
		"protein":         Object{"amount": "1.25", "unit": "g"},
		"vitamin_d":       Object{"amount": json.Number("0.5"), "unit": "mcg"},
		"future_nutrient": Object{"amount": 2, "unit": "mg"},
	}
	encoded, err := nutritionProfileJSON(profile)
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := encoded.(json.RawMessage)
	if !ok || !strings.Contains(string(raw), `"future_nutrient"`) {
		t.Fatalf("future nutrient was not preserved in JSONB input: %#v", encoded)
	}
	cleared, err := nutritionProfileJSON(nil)
	if err != nil || cleared != nil {
		t.Fatalf("null must clear the profile: value=%#v err=%v", cleared, err)
	}
}

func TestNutritionProfileJSONRejectsInvalidValues(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
	}{
		{"not an object", []any{"protein"}},
		{"negative amount", Object{"protein": Object{"amount": "-0.1", "unit": "g"}}},
		{"negative numeric amount", Object{"protein": Object{"amount": -1.0, "unit": "g"}}},
		{"invalid nutrient unit", Object{"protein": Object{"amount": 1, "unit": "bananas"}}},
		{"missing unit", Object{"protein": Object{"amount": 1}}},
		{"missing amount", Object{"protein": Object{"unit": "g"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := nutritionProfileJSON(tc.value); err == nil {
				t.Fatal("invalid profile was accepted")
			} else if e := normalizedError(err); e.Status != 400 {
				t.Fatalf("error=%+v, want HTTP 400", e)
			}
		})
	}
}
