package backend

import (
	"math/big"
	"testing"
	"time"
)

func TestNutritionAgeUsesEachLocalCalendarDay(t *testing.T) {
	cases := []struct {
		birth, date string
		months      int
		group       string
		known       bool
	}{
		{"2026-01-31", "2026-06-30", 5, "0-6m", true},
		{"2026-01-31", "2026-07-31", 6, "6-12m", true},
		{"2024-02-29", "2025-02-28", 12, "1-3y", true},
		{"2026-01-01", "2029-02-01", 37, "unsupported_over_36m", true},
		{"", "2026-07-31", 0, "unknown_age", false},
		{"not-a-date", "2026-07-31", 0, "unknown_age", false},
		{"2026-02-30", "2026-07-31", 0, "unknown_age", false},
		{"2026-01-01", "2026-02-30", 0, "unknown_age", false},
		{"2026-08-01", "2026-07-31", 0, "unknown_age", false},
	}
	for _, tc := range cases {
		gotMonths, gotKnown := nutritionAgeMonths(tc.birth, tc.date)
		if gotMonths != tc.months || gotKnown != tc.known {
			t.Errorf("nutritionAgeMonths(%q, %q) = (%d, %v), want (%d, %v)", tc.birth, tc.date, gotMonths, gotKnown, tc.months, tc.known)
		}
		if got := ageGroupForNutritionAge(gotMonths, gotKnown); got != tc.group {
			t.Errorf("ageGroupForNutritionAge(%d, %v) = %q, want %q", gotMonths, gotKnown, got, tc.group)
		}
	}
}

func TestNutritionUnknownAgeDoesNotAssignAgeBasedReferenceValues(t *testing.T) {
	date := time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC)
	dateRange, err := makeNutritionDateRange(date, date, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	inputs := nutritionInputs{familyID: "test_family", babyID: "test_baby", birthDate: "2026-08-01", timeZone: "UTC"}
	day := buildNutritionDay(inputs, "2026-07-31", dateRange, nutritionReferenceVersion)
	if day["ageMonths"] != nil || day["ageGroup"] != "unknown_age" {
		t.Fatalf("pre-birth day must have unknown age, got age=%v group=%v", day["ageMonths"], day["ageGroup"])
	}
	for _, raw := range day["nutrients"].([]Object) {
		if raw["targetAmount"] != nil || raw["targetType"] != nil || raw["ulAmount"] != nil || raw["knownSubtotalAchievementRate"] != nil || raw["knownProductAmountExceedsUL"] != nil {
			t.Fatalf("unknown age received age-dependent reference values for %s: %v", raw["nutrientId"], raw)
		}
	}
	coverage := obj(day["coverage"])
	unknownAgeNote := false
	for _, note := range coverage["notes"].([]string) {
		if note == "Age is unknown for this day; age-specific intake references and UL comparisons are withheld." {
			unknownAgeNote = true
		}
	}
	if !unknownAgeNote {
		t.Fatalf("unknown age explanation missing from day coverage notes: %v", coverage)
	}
}

func TestNutritionUnitConversionsAreExplicit(t *testing.T) {
	cases := []struct {
		id, from, to, amount, want string
	}{
		{"vitamin_d", "mcg", "IU", "25", "1000"},
		{"vitamin_a", "IU", "mcg RAE", "100", "30"},
		{"iron", "g", "mg", "0.25", "250"},
		{"energy_kcal", "kcal", "kJ", "1", "4.184"},
	}
	for _, tc := range cases {
		amount, _ := new(big.Rat).SetString(tc.amount)
		got, ok := convertNutritionUnit(tc.id, amount, tc.from, tc.to)
		if !ok || got.RatString() != mustRatString(t, tc.want) {
			t.Errorf("convertNutritionUnit(%s, %s -> %s) = %v, %v; want %s", tc.id, tc.from, tc.to, got, ok, tc.want)
		}
	}
	if _, ok := convertNutritionUnit("calcium", big.NewRat(1, 1), "IU", "mg"); ok {
		t.Fatal("unsupported nutrient unit conversion was accepted")
	}
	if _, ok := supplementRecordDose(Object{"amount": "1 drop"}); ok {
		t.Fatal("a free-text amount with an unparsed unit was treated as an exact dose")
	}
}

func TestNutritionDaySeparatesCalculatedEstimatedAndUnknown(t *testing.T) {
	date := "2026-07-31"
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	day := time.Date(2026, 7, 31, 0, 0, 0, 0, loc)
	dateRange, err := makeNutritionDateRange(day, day, "Asia/Shanghai")
	if err != nil {
		t.Fatal(err)
	}
	inputs := nutritionInputs{
		familyID: "test_family_nutrition", babyID: "test_baby_nutrition", birthDate: "2026-01-31", timeZone: "Asia/Shanghai",
		feedings: []Object{
			{"id": "test_formula_record", "feeding_type": "formula", "amount_ml": "100", "occurred_at": time.Date(2026, 7, 31, 8, 0, 0, 0, loc), "formula_product_id": "test_formula"},
			{"id": "test_breast_record", "feeding_type": "bottle", "amount_ml": "50", "occurred_at": time.Date(2026, 7, 31, 9, 0, 0, 0, loc)},
		},
		supps: []Object{{"id": "test_supplement_record", "product_id": "test_d3", "dose": "0.5", "unit_name": "drops", "occurred_at": time.Date(2026, 7, 31, 10, 0, 0, 0, loc)}},
		foods: []Object{{"id": "test_food_record", "record_date": date, "food_item_ids": []any{"food_egg"}, "portion_description": "half"}},
		formulas: []Object{{"id": "test_formula", "family_id": "test_family_nutrition", "name": "test formula", "serving_size_unit": "per_100ml_prepared", "nutrients_json": Object{
			"protein":   Object{"amount": "4", "unit": "g"},
			"vitamin_d": Object{"amount": "1", "unit": "mcg"},
		}}},
		products: []Object{{"id": "test_d3", "family_id": "test_family_nutrition", "name": "test D3", "unit_name": "drops", "nutrients_json": Object{
			"vitamin_d": Object{"amount": "100", "unit": "mcg"},
		}}},
		foodNames: map[string]string{"food_egg": "Egg"},
		foodPlan:  Object{"plan_data": Object{}},
	}
	result := buildNutritionDay(inputs, date, dateRange, nutritionReferenceVersion)
	if result["ageMonths"] != 6 || result["ageGroup"] != "6-12m" {
		t.Fatalf("day age must use the local calendar date: age=%v group=%v", result["ageMonths"], result["ageGroup"])
	}
	if result["localDayStartAt"] != "2026-07-30T16:00:00.000Z" || result["localDayEndExclusiveAt"] != "2026-07-31T16:00:00.000Z" {
		t.Fatalf("local day bounds do not honor family timezone: %v %v", result["localDayStartAt"], result["localDayEndExclusiveAt"])
	}
	protein := nutritionByID(t, result, "protein")
	assertNutritionDecimal(t, protein["formulaCalculatedAmount"], "4")
	assertNutritionDecimal(t, protein["breastmilkEstimatedAmount"], "0.55")
	assertNutritionDecimal(t, protein["foodEstimatedAmount"], "3.15")
	assertNutritionDecimal(t, protein["knownSubtotalAmount"], "7.7")
	coverage := obj(protein["coverage"])
	if coverage["status"] != "partial" || integer(coverage["unknownSourceCount"]) == 0 {
		t.Fatalf("missing nutrients must remain visible as unknown coverage: %v", coverage)
	}
	vitaminD := nutritionByID(t, result, "vitamin_d")
	assertNutritionDecimal(t, vitaminD["formulaCalculatedAmount"], "40")
	assertNutritionDecimal(t, vitaminD["supplementCalculatedAmount"], "2000")
	assertNutritionDecimal(t, vitaminD["breastmilkEstimatedAmount"], "5")
	assertNutritionDecimal(t, vitaminD["foodEstimatedAmount"], "20")
	if vitaminD["knownProductAmountExceedsUL"] != true {
		t.Fatal("known product amount should be compared against the legacy UL value")
	}
	if nutritionReferenceDTO()["validationStatus"] != "legacy_values_not_independently_cross_checked" {
		t.Fatal("legacy reference values must not claim clinical validation")
	}
}

func TestFormulaNutritionKeepsValidEntriesWhenLegacyMeasurementIsMalformed(t *testing.T) {
	day := time.Date(2026, 10, 2, 0, 0, 0, 0, time.UTC)
	dateRange, err := makeNutritionDateRange(day, day, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	inputs := nutritionInputs{
		familyID: "test_family_legacy_profile", babyID: "test_baby_legacy_profile",
		birthDate: "2026-01-01", timeZone: "UTC",
		feedings: []Object{{
			"id": "test_legacy_formula_record", "feeding_type": "formula", "amount_ml": "100",
			"occurred_at": day, "formula_product_id": "test_legacy_formula",
		}},
		formulas: []Object{{
			"id": "test_legacy_formula", "family_id": "test_family_legacy_profile",
			"name": "test legacy formula", "serving_size_unit": "per_100ml",
			"nutrients_json": Object{
				"protein":   Object{"amount": "2", "unit": "g", "source": "legacy_label"},
				"iron":      18,
				"vitamin_d": Object{"amount": "0.5", "unit": "mcg"},
			},
		}},
		foodPlan: Object{"plan_data": Object{}},
	}

	result := buildNutritionDay(inputs, "2026-10-02", dateRange, nutritionReferenceVersion)
	protein := nutritionByID(t, result, "protein")
	if obj(protein["coverage"])["status"] != "unknown" || integer(obj(protein["coverage"])["unknownSourceCount"]) != 1 {
		t.Fatalf("legacy extra measurement field must remain visible as unknown: %#v", protein)
	}
	if len(protein["sources"].([]Object)) != 0 {
		t.Fatalf("malformed protein entry must not be calculated: %#v", protein["sources"])
	}
	iron := nutritionByID(t, result, "iron")
	if obj(iron["coverage"])["status"] != "unknown" {
		t.Fatalf("legacy scalar iron entry must remain visible as unknown: %#v", iron)
	}
	vitaminD := nutritionByID(t, result, "vitamin_d")
	assertNutritionDecimal(t, vitaminD["formulaCalculatedAmount"], "20")
	if obj(vitaminD["coverage"])["status"] != "calculated" {
		t.Fatalf("valid nutrient in the same legacy profile must still calculate: %#v", vitaminD)
	}
}

func TestFamilyFoodProfileUsesMeasuredGramsAndSeparatesLegacyEstimate(t *testing.T) {
	date := "2026-07-31"
	dayTime := time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC)
	dateRange, err := makeNutritionDateRange(dayTime, dayTime, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	profile := Object{"protein": Object{"amount": "4.25", "unit": "g"}}
	inputs := nutritionInputs{
		familyID: "test_family_profile", babyID: "test_baby_profile", birthDate: "2026-01-31", timeZone: "UTC",
		foods:        []Object{{"id": "test_food_record", "record_date": date, "food_item_ids": []any{"custom_test_food"}, "food_amount_grams": "50"}},
		foodNames:    map[string]string{"custom_test_food": "Test Food"},
		foodProfiles: map[string]any{"custom_test_food": profile},
	}
	day := buildNutritionDay(inputs, date, dateRange, nutritionReferenceVersion)
	protein := nutritionByID(t, day, "protein")
	assertNutritionDecimal(t, protein["foodCalculatedAmount"], "2.125")
	assertNutritionDecimal(t, protein["foodEstimatedAmount"], "0")
	assertNutritionDecimal(t, protein["calculatedAmount"], "2.125")
	source := protein["sources"].([]Object)[0]
	if source["basis"] != "product_calculation" {
		t.Fatalf("measured per-100g calculation was not surfaced as calculated: %#v", source)
	}

	inputs.foods = []Object{{"id": "test_unmeasured_food", "record_date": date, "food_item_ids": []any{"custom_test_food"}, "portion_description": "all"}}
	unmeasured := nutritionByID(t, buildNutritionDay(inputs, date, dateRange, nutritionReferenceVersion), "protein")
	assertNutritionDecimal(t, unmeasured["foodCalculatedAmount"], "0")
	assertNutritionDecimal(t, unmeasured["foodEstimatedAmount"], "0")
	if integer(obj(unmeasured["coverage"])["unknownSourceCount"]) == 0 {
		t.Fatal("portion text must not be multiplied by a per-100g family profile without measured mass")
	}

	inputs.foods = []Object{{"id": "test_cleared_profile_food", "record_date": date, "food_item_ids": []any{"custom_test_food"}, "food_amount_grams": "50"}}
	inputs.foodProfiles["custom_test_food"] = nil
	cleared := nutritionByID(t, buildNutritionDay(inputs, date, dateRange, nutritionReferenceVersion), "protein")
	assertNutritionDecimal(t, cleared["foodCalculatedAmount"], "0")
	if integer(obj(cleared["coverage"])["unknownSourceCount"]) == 0 {
		t.Fatal("cleared family profile must not reuse stale nutrient values")
	}
}

func TestNutritionTrendsIncludeEmptyDaysAndEnforceCalendarDayLimit(t *testing.T) {
	from, _ := time.Parse("2006-01-02", "2026-03-07")
	to, _ := time.Parse("2006-01-02", "2026-03-09")
	dateRange, err := makeNutritionDateRange(from, to, "America/Los_Angeles")
	if err != nil || len(dateRange.dates) != 3 {
		t.Fatalf("DST-spanning 3-local-day range should be accepted: %v, %v", dateRange.dates, err)
	}
	inputs := nutritionInputs{familyID: "test_family", babyID: "test_baby", birthDate: "2026-01-01", timeZone: "America/Los_Angeles"}
	daily := make([]Object, 0, len(dateRange.dates))
	for _, date := range dateRange.dates {
		day := buildNutritionDay(inputs, date, dateRange, nutritionReferenceVersion)
		if nutritionByID(t, day, "protein")["coverage"].(Object)["status"] != "no_logged_source" {
			t.Fatalf("empty day %s should be explicitly marked as unlogged", date)
		}
		daily = append(daily, day)
	}
	proteinAverage := nutritionAverageByID(t, nutritionTrendAverages(daily), "protein")
	assertNutritionDecimal(t, proteinAverage["calculatedAmountPerDay"], "0")
	assertNutritionDecimal(t, proteinAverage["estimatedAmountPerDay"], "0")
	assertNutritionDecimal(t, proteinAverage["knownSubtotalPerDay"], "0")
	if got, known := nutritionAgeMonths(inputs.birthDate, dateRange.dates[0]); !known || got != 2 {
		t.Fatalf("daily trend age should be computed for the first date, got %d known=%v", got, known)
	}
	if proteinAverage["targetCoverageRatio"] != "1" || proteinAverage["averageKnownSubtotalAchievementRate"] == nil {
		t.Fatalf("fully target-covered days should expose coverage and achievement rate: %v", proteinAverage)
	}

	partialRange, err := makeNutritionDateRange(time.Date(2026, 1, 31, 0, 0, 0, 0, time.UTC), time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC), "UTC")
	if err != nil {
		t.Fatal(err)
	}
	partialInputs := nutritionInputs{familyID: "test_family", babyID: "test_baby", birthDate: "2023-01-01", timeZone: "UTC"}
	partialDaily := []Object{
		buildNutritionDay(partialInputs, partialRange.dates[0], partialRange, nutritionReferenceVersion),
		buildNutritionDay(partialInputs, partialRange.dates[1], partialRange, nutritionReferenceVersion),
	}
	partialProtein := nutritionAverageByID(t, nutritionTrendAverages(partialDaily), "protein")
	if partialProtein["targetDaysCount"] != 1 || partialProtein["targetCoverageRatio"] != "0.5" || partialProtein["averageKnownSubtotalAchievementRate"] != nil {
		t.Fatalf("achievement rate must be withheld when age-band targets do not cover every day: %v", partialProtein)
	}
	day90 := from.AddDate(0, 0, 89)
	if accepted, err := makeNutritionDateRange(from, day90, "UTC"); err != nil || len(accepted.dates) != 90 {
		t.Fatalf("90 calendar days should be accepted, got %d (%v)", len(accepted.dates), err)
	}
	day91 := from.AddDate(0, 0, 90)
	if _, err := makeNutritionDateRange(from, day91, "UTC"); err == nil {
		t.Fatal("91 calendar days should be rejected")
	}
}

func TestNutritionInvalidRecordedVolumeIsNotReplacedByAnEstimate(t *testing.T) {
	day := time.Date(2026, 7, 31, 0, 0, 0, 0, time.UTC)
	dateRange, err := makeNutritionDateRange(day, day, "UTC")
	if err != nil {
		t.Fatal(err)
	}
	inputs := nutritionInputs{
		familyID: "test_family", babyID: "test_baby", birthDate: "2026-01-01", timeZone: "UTC",
		feedings: []Object{{"id": "test_bad_breast", "feeding_type": "breast", "amount_ml": "-1",
			"left_minutes": 8, "right_minutes": 0, "occurred_at": day}},
	}
	result := buildNutritionDay(inputs, "2026-07-31", dateRange, nutritionReferenceVersion)
	assertNutritionDecimal(t, result["summary"].(Object)["breastmilkEstimatedMl"], "0")
	if integer(result["coverage"].(Object)["unknownSourceCount"]) == 0 {
		t.Fatal("negative recorded volume should be represented as unknown")
	}
}

func nutritionByID(t *testing.T, analysis Object, id string) Object {
	t.Helper()
	rows, ok := analysis["nutrients"].([]Object)
	if !ok {
		t.Fatalf("nutrients have type %T", analysis["nutrients"])
	}
	for _, row := range rows {
		if row["nutrientId"] == id {
			return row
		}
	}
	t.Fatalf("nutrient %q is missing", id)
	return nil
}

func nutritionAverageByID(t *testing.T, averages []Object, id string) Object {
	t.Helper()
	for _, row := range averages {
		if row["nutrientId"] == id {
			return row
		}
	}
	t.Fatalf("average nutrient %q is missing", id)
	return nil
}

func assertNutritionDecimal(t *testing.T, raw any, expected string) {
	t.Helper()
	got, ok := nutritionRat(raw)
	want, wantOK := new(big.Rat).SetString(expected)
	if !ok || !wantOK || got.Cmp(want) != 0 {
		t.Fatalf("decimal = %v (ok %v), want %s", raw, ok, expected)
	}
}

func mustRatString(t *testing.T, value string) string {
	t.Helper()
	rational, ok := new(big.Rat).SetString(value)
	if !ok {
		t.Fatalf("invalid test rational %q", value)
	}
	return rational.RatString()
}
