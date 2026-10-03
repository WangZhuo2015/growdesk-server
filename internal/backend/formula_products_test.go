package backend

import "testing"

func TestFormulaUpdateRequiresBaseVersionForCalculationInputs(t *testing.T) {
	profile := Object{"protein": map[string]any{"amount": "10", "unit": "g"}}
	legacy := Object{"nutrients_json": nil}
	withProfile := Object{"nutrients_json": profile}

	for _, field := range []string{"nutrientsJson", "servingSizeUnit", "reconstitutionRatio"} {
		if !formulaUpdateRequiresBaseVersion(legacy, Object{field: "value"}) {
			t.Errorf("legacy formula update touching %s must require baseVersion", field)
		}
	}
	for _, field := range []string{"scoopGrams", "waterMlPerScoop"} {
		if formulaUpdateRequiresBaseVersion(legacy, Object{field: "4"}) {
			t.Errorf("profile-less legacy formula update touching %s should retain compatibility", field)
		}
		if !formulaUpdateRequiresBaseVersion(withProfile, Object{field: "4"}) {
			t.Errorf("profiled formula update touching %s must require baseVersion", field)
		}
	}
	if formulaUpdateRequiresBaseVersion(withProfile, Object{"brand": "test brand"}) {
		t.Fatal("unrelated brand metadata must not require the nutrition CAS")
	}
}
