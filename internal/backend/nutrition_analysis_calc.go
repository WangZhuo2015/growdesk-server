package backend

import (
	"encoding/json"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"time"
)

type nutritionMeasurement struct {
	amount *big.Rat
	unit   string
}

type nutritionSource struct {
	id          string
	name        string
	kind        string
	amount      *big.Rat
	unit        string
	basis       string
	assumptions []string
}

type nutritionNutrientSum struct {
	formula, supplement, breastmilk, food *big.Rat
	calculatedSources                     map[string]bool
	estimatedSources                      map[string]bool
	unknownSources                        map[string]bool
	sources                               []nutritionSource
}

type nutritionDayCoverage struct {
	calculatedSources map[string]bool
	estimatedSources  map[string]bool
	unknownSources    map[string]bool
	unsupportedUnits  map[string]bool
	unsupportedFoods  map[string]bool
	notes             map[string]bool
}

type nutritionDaySummary struct {
	values                                                 map[string]*nutritionNutrientSum
	cover                                                  nutritionDayCoverage
	formulaMl, breastmilkRecordedMl, breastmilkEstimatedMl *big.Rat
	feedingCount, supplementCount, foodRecordCount         int
	foodsLogged                                            map[string]bool
}

func newNutritionDaySummary() *nutritionDaySummary {
	values := make(map[string]*nutritionNutrientSum)
	for _, id := range referenceNutrientIDs() {
		values[id] = &nutritionNutrientSum{
			formula: new(big.Rat), supplement: new(big.Rat), breastmilk: new(big.Rat), food: new(big.Rat),
			calculatedSources: map[string]bool{}, estimatedSources: map[string]bool{}, unknownSources: map[string]bool{},
		}
	}
	return &nutritionDaySummary{
		values:    values,
		cover:     nutritionDayCoverage{calculatedSources: map[string]bool{}, estimatedSources: map[string]bool{}, unknownSources: map[string]bool{}, unsupportedUnits: map[string]bool{}, unsupportedFoods: map[string]bool{}, notes: map[string]bool{}},
		formulaMl: new(big.Rat), breastmilkRecordedMl: new(big.Rat), breastmilkEstimatedMl: new(big.Rat),
		foodsLogged: map[string]bool{},
	}
}

func (d *nutritionDaySummary) add(nutrientID, sourceID, sourceName, sourceType string, amount *big.Rat, unit, basis string, assumptions []string) {
	value := d.values[nutrientID]
	if value == nil {
		return
	}
	if amount == nil {
		amount = new(big.Rat)
	}
	var target *big.Rat
	if basis == "product_calculation" {
		value.calculatedSources[sourceID] = true
		d.cover.calculatedSources[sourceID] = true
		switch sourceType {
		case "formula":
			target = value.formula
		case "supplement":
			target = value.supplement
		}
	} else {
		value.estimatedSources[sourceID] = true
		d.cover.estimatedSources[sourceID] = true
		switch sourceType {
		case "breastmilk":
			target = value.breastmilk
		case "food":
			target = value.food
		}
	}
	if target != nil {
		target.Add(target, amount)
	}
	value.sources = append(value.sources, nutritionSource{
		id: sourceID, name: sourceName, kind: sourceType, amount: new(big.Rat).Set(amount), unit: unit,
		basis: basis, assumptions: append([]string{}, assumptions...),
	})
}

func (d *nutritionDaySummary) unknown(nutrientID, sourceID, note string) {
	if value := d.values[nutrientID]; value != nil {
		value.unknownSources[sourceID] = true
	}
	d.cover.unknownSources[sourceID] = true
	if note != "" {
		d.cover.notes[note] = true
	}
}

func (d *nutritionDaySummary) unknownAll(sourceID, note string) {
	for nutrientID := range d.values {
		d.unknown(nutrientID, sourceID, note)
	}
}

func (d *nutritionDaySummary) unsupportedUnit(sourceID, nutrientID string) {
	d.cover.unsupportedUnits[sourceID+":"+nutrientID] = true
}

func (d *nutritionDaySummary) unsupportedFood(sourceID string) {
	d.cover.unsupportedFoods[sourceID] = true
}

func buildNutritionDay(inputs nutritionInputs, date string, dateRange nutritionDateRange, _ string) Object {
	d := newNutritionDaySummary()
	age, ageKnown := nutritionAgeMonths(inputs.birthDate, date)
	group := ageGroupForNutritionAge(age, ageKnown)
	var ageValue any
	if ageKnown {
		ageValue = age
	}
	formulaMap := map[string]Object{}
	supplementMap := map[string]Object{}
	for _, row := range inputs.formulas {
		formulaMap[text(row["id"])] = row
	}
	for _, row := range inputs.products {
		supplementMap[text(row["id"])] = row
	}
	defaultFormulaID := nutritionPlanDefaultFormulaID(inputs.foodPlan)
	defaultFormula, defaultOK := selectDefaultFormula(inputs.formulas, defaultFormulaID)

	for _, record := range inputs.feedings {
		occurred, err := asTime(record["occurred_at"])
		if err != nil || occurred.In(dateRange.loc).Format("2006-01-02") != date {
			continue
		}
		d.feedingCount++
		id := text(record["id"])
		amount, amountOK := nutritionRat(record["amount_ml"])
		amountInvalid := amountOK && amount.Sign() < 0
		if !amountOK || amountInvalid {
			amount = new(big.Rat)
			amountOK = false
		}
		switch text(record["feeding_type"]) {
		case "formula":
			if amountOK {
				d.formulaMl.Add(d.formulaMl, amount)
			}
			product, found := selectedFormula(record, formulaMap, defaultFormula, defaultOK)
			if !amountOK {
				d.unknownAll(id, "A formula feeding has no recorded milliliter amount.")
			} else if !found {
				d.unknownAll(id, "A formula feeding could not be bound to a same-family formula product.")
			} else {
				addFormulaNutrition(d, id, record, product, amount, inputs.foodPlan, group)
			}
		case "bottle":
			if amountOK {
				d.breastmilkRecordedMl.Add(d.breastmilkRecordedMl, amount)
				addBreastmilkNutrition(d, id, "Bottle-fed breast milk", amount, []string{"Milk volume was recorded; the composition values are legacy estimates."}, group)
			} else {
				d.unknownAll(id, "A bottle-fed breast-milk record has no recorded volume.")
			}
		case "breast":
			volume := amount
			assumptions := []string{"Breast-milk nutrient composition comes from the legacy reference table."}
			if !amountOK {
				if amountInvalid {
					d.unknownAll(id, "Direct breastfeeding has a negative recorded volume; no estimate was substituted.")
					continue
				}
				var estimateOK bool
				volume, estimateOK = estimateNursingVolume(record)
				if !estimateOK {
					d.unknownAll(id, "Direct breastfeeding has neither a recorded volume nor nursing duration.")
					continue
				}
				assumptions = append(assumptions, "Volume was estimated from recorded nursing duration using the legacy Web curve.")
				d.breastmilkEstimatedMl.Add(d.breastmilkEstimatedMl, volume)
			} else {
				d.breastmilkRecordedMl.Add(d.breastmilkRecordedMl, volume)
				assumptions = append(assumptions, "Recorded milk volume is combined with an estimated breast-milk composition.")
			}
			addBreastmilkNutrition(d, id, "Direct breastfeeding", volume, assumptions, group)
		case "mixed":
			if amountOK {
				d.formulaMl.Add(d.formulaMl, amount)
				product, found := selectedFormula(record, formulaMap, defaultFormula, defaultOK)
				if found {
					addFormulaNutrition(d, id, record, product, amount, inputs.foodPlan, group)
				} else {
					d.unknownAll(id, "A mixed feeding could not be bound to a same-family formula product.")
				}
			} else {
				d.unknownAll(id, "A mixed feeding has no recorded formula milliliter amount.")
			}
			volume, estimateOK := estimateNursingVolume(record)
			if estimateOK {
				d.breastmilkEstimatedMl.Add(d.breastmilkEstimatedMl, volume)
				addBreastmilkNutrition(d, id, "Mixed direct breastfeeding", volume, []string{"Nursing volume was estimated from duration using the legacy Web curve.", "Breast-milk nutrient composition comes from the legacy reference table."}, group)
			} else if integer(record["left_minutes"])+integer(record["right_minutes"]) > 0 {
				d.unknownAll(id, "Mixed feeding nursing duration could not be converted to a volume.")
			}
		default:
			d.unknownAll(id, "Feeding type is not supported by the nutrition calculator.")
		}
	}

	for _, record := range inputs.supps {
		occurred, err := asTime(record["occurred_at"])
		if err != nil || occurred.In(dateRange.loc).Format("2006-01-02") != date {
			continue
		}
		d.supplementCount++
		id := text(record["id"])
		product, found := selectedSupplement(record, inputs.products, supplementMap)
		if !found {
			d.unknownAll(id, "A supplement record could not be resolved to one same-family product.")
			continue
		}
		dose, doseOK := supplementRecordDose(record)
		if !doseOK {
			d.unknownAll(id, "A supplement record has no numeric dose in its dose or amount field.")
			continue
		}
		recordedUnit := strings.TrimSpace(text(record["unit_name"]))
		productUnit := strings.TrimSpace(text(product["unit_name"]))
		if recordedUnit != "" && productUnit != "" && !strings.EqualFold(recordedUnit, productUnit) {
			d.unknownAll(id, "A supplement record unit does not match its product unit.")
			continue
		}
		profile, invalidIDs, ok := parseNutritionProfile(product["nutrients_json"])
		if !ok {
			d.unknownAll(id, "A supplement product has no usable nutrient profile.")
			continue
		}
		doseName := text(product["name"])
		if doseName == "" {
			doseName = text(record["supplement_name"])
		}
		sourceName := doseName + " (" + ratDecimal(dose, 3) + " " + productUnit + ")"
		for _, nutrientID := range referenceNutrientIDs() {
			measurement, present := profile[nutrientID]
			if !present {
				d.unknown(nutrientID, id, "The supplement nutrient profile does not declare this nutrient.")
				continue
			}
			if invalidIDs[nutrientID] {
				d.unknown(nutrientID, id, "The supplement nutrient value or unit is invalid.")
				d.unsupportedUnit(id, nutrientID)
				continue
			}
			expected := nutritionCanonicalUnit(nutrientID, group)
			converted, convertedOK := convertNutritionUnit(nutrientID, measurement.amount, measurement.unit, expected)
			if !convertedOK {
				d.unknown(nutrientID, id, "The supplement nutrient unit is not supported for conversion.")
				d.unsupportedUnit(id, nutrientID)
				continue
			}
			amount := new(big.Rat).Mul(converted, dose)
			d.add(nutrientID, id, sourceName, "supplement", amount, expected, "product_calculation",
				nutritionConversionAssumptions(nutrientID, measurement.unit, expected))
		}
		for nutrientID := range invalidIDs {
			d.unsupportedUnit(id, nutrientID)
		}
	}

	for _, record := range inputs.foods {
		if text(record["record_date"]) != date {
			continue
		}
		d.foodRecordCount++
		recordID := text(record["id"])
		items, ok := record["food_item_ids"].([]any)
		if !ok || len(items) == 0 {
			continue
		}
		portion, multiplier, assumptions, portionOK := foodPortion(record["portion_description"])
		for index, rawItem := range items {
			foodID := strings.TrimSpace(text(rawItem))
			if foodID == "" {
				continue
			}
			foodName := inputs.foodNames[foodID]
			if foodName == "" {
				foodName = foodID
			}
			d.foodsLogged[foodName] = true
			sourceID := recordID + ":" + strconv.Itoa(index) + ":" + foodID
			if !portionOK {
				d.unknownAll(sourceID, "A food record's portion description is not a supported serving estimate.")
				d.unsupportedFood(sourceID)
				continue
			}
			profile := legacyObject(legacyObject(nutritionReference["foods"])[foodID])
			if len(profile) == 0 {
				d.unknownAll(sourceID, "A food-library item has no nutrient profile in the legacy reference dataset.")
				d.unsupportedFood(sourceID)
				continue
			}
			for _, nutrientID := range referenceNutrientIDs() {
				measurementObj := legacyObject(profile[nutrientID])
				if len(measurementObj) == 0 {
					d.unknown(nutrientID, sourceID, "The legacy food profile does not declare this nutrient.")
					continue
				}
				amount, amountOK := nutritionRat(measurementObj["amount"])
				unit := text(measurementObj["unit"])
				if !amountOK || amount.Sign() < 0 || unit == "" {
					d.unknown(nutrientID, sourceID, "The legacy food nutrient value or unit is invalid.")
					d.unsupportedUnit(sourceID, nutrientID)
					continue
				}
				expected := nutritionCanonicalUnit(nutrientID, group)
				converted, convertedOK := convertNutritionUnit(nutrientID, amount, unit, expected)
				if !convertedOK {
					d.unknown(nutrientID, sourceID, "The legacy food nutrient unit is not supported for conversion.")
					d.unsupportedUnit(sourceID, nutrientID)
					continue
				}
				value := new(big.Rat).Mul(converted, multiplier)
				sourceAssumptions := append(append([]string{}, assumptions...), nutritionConversionAssumptions(nutrientID, unit, expected)...)
				d.add(nutrientID, sourceID, "Food: "+foodName+" ("+portion+")", "food", value, expected, "legacy_estimate", sourceAssumptions)
			}
		}
	}

	day, err := time.Parse("2006-01-02", date)
	if err != nil {
		day = dateRange.from
	}
	localStart := time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, dateRange.loc)
	coverage := nutritionCoverageDTO(d)
	if !ageKnown {
		coverage["notes"] = append(coverage["notes"].([]string), "Age is unknown for this day; age-specific intake references and UL comparisons are withheld.")
	}
	return Object{
		"babyId": inputs.babyID, "familyId": inputs.familyID, "date": date, "timeZone": inputs.timeZone,
		"localDayStartAt":        iso(localStart),
		"localDayEndExclusiveAt": iso(localStart.AddDate(0, 0, 1)),
		"ageMonths":              ageValue, "ageGroup": group,
		"referenceDataset": nutritionReferenceDTO(),
		"summary": Object{
			"formulaMl": ratDecimal(d.formulaMl, 3), "breastmilkRecordedMl": ratDecimal(d.breastmilkRecordedMl, 3),
			"breastmilkEstimatedMl": ratDecimal(d.breastmilkEstimatedMl, 3),
			"knownMilkSubtotalMl":   ratDecimal(new(big.Rat).Add(new(big.Rat).Add(d.formulaMl, d.breastmilkRecordedMl), d.breastmilkEstimatedMl), 3),
			"supplementRecordCount": d.supplementCount, "foodRecordCount": d.foodRecordCount,
			"foodsLogged": sortedBoolKeys(d.foodsLogged),
		},
		"coverage":  coverage,
		"nutrients": nutritionNutrientDTOs(d, group),
	}
}

func nutritionCoverageDTO(d *nutritionDaySummary) Object {
	notes := sortedBoolKeys(d.cover.notes)
	if len(notes) == 0 {
		notes = []string{"Reported values represent only recorded sources; logging completeness is unverified."}
	}
	notes = append(notes, "Only nutrient IDs in the pinned legacy reference dataset are evaluated; other product profile keys are outside this calculation.")
	return Object{
		"feedingRecordCount": d.feedingCount, "supplementRecordCount": d.supplementCount, "foodRecordCount": d.foodRecordCount,
		"calculatedSourceCount": len(d.cover.calculatedSources), "estimatedSourceCount": len(d.cover.estimatedSources),
		"unknownSourceCount": len(d.cover.unknownSources), "unsupportedUnitCount": len(d.cover.unsupportedUnits),
		"unsupportedFoodCount": len(d.cover.unsupportedFoods), "logCompleteness": "unverified", "notes": notes,
	}
}

func nutritionNutrientDTOs(d *nutritionDaySummary, group string) []Object {
	result := make([]Object, 0, len(d.values))
	for _, id := range referenceNutrientIDs() {
		value := d.values[id]
		name, unit, category := nutritionName(id)
		if group != "unsupported_over_36m" {
			if def := nutritionDRIDefinition(id, group); len(def) > 0 {
				if text(def["name"]) != "" {
					name = text(def["name"])
				}
				if text(def["unit"]) != "" {
					unit = text(def["unit"])
				}
				if text(def["category"]) != "" {
					category = text(def["category"])
				}
			}
		}
		if category == "" {
			category = "other"
		}
		calculated := new(big.Rat).Add(value.formula, value.supplement)
		estimated := new(big.Rat).Add(value.breastmilk, value.food)
		subtotal := new(big.Rat).Add(calculated, estimated)
		def := nutritionDRIDefinition(id, group)
		target, targetType := nutritionTarget(def)
		ul := nutritionNullableAmount(def["ul"])
		var achievement any
		if target != nil && target.Sign() > 0 {
			achievement = ratDecimal(new(big.Rat).Mul(new(big.Rat).Quo(subtotal, target), big.NewRat(100, 1)), 1)
		}
		var calcUL any
		if ulValue, ok := nutritionRat(def["ul"]); ok && ulValue.Sign() > 0 {
			calcUL = calculated.Cmp(ulValue) > 0
		}
		status := "no_logged_source"
		calcCount, estimateCount, unknownCount := len(value.calculatedSources), len(value.estimatedSources), len(value.unknownSources)
		switch {
		case unknownCount > 0 && (calcCount > 0 || estimateCount > 0):
			status = "partial"
		case unknownCount > 0:
			status = "unknown"
		case calcCount > 0 && estimateCount > 0:
			status = "partial"
		case estimateCount > 0:
			status = "estimated"
		case calcCount > 0:
			status = "calculated"
		}
		sources := make([]Object, 0, len(value.sources))
		for _, source := range value.sources {
			sources = append(sources, Object{
				"sourceId": source.id, "sourceName": source.name, "sourceType": source.kind,
				"amount": ratDecimal(source.amount, 3), "unit": source.unit, "basis": source.basis,
				"assumptions": source.assumptions,
			})
		}
		result = append(result, Object{
			"nutrientId": id, "name": name, "unit": unit, "category": category,
			"formulaCalculatedAmount": ratDecimal(value.formula, 3), "supplementCalculatedAmount": ratDecimal(value.supplement, 3),
			"breastmilkEstimatedAmount": ratDecimal(value.breastmilk, 3), "foodEstimatedAmount": ratDecimal(value.food, 3),
			"calculatedAmount": ratDecimal(calculated, 3), "estimatedAmount": ratDecimal(estimated, 3),
			"knownSubtotalAmount": ratDecimal(subtotal, 3), "targetAmount": nutritionNullableAmount(target), "targetType": targetType,
			"ulAmount": ul, "knownSubtotalAchievementRate": achievement, "knownProductAmountExceedsUL": calcUL,
			"sources":  sources,
			"coverage": Object{"status": status, "calculatedSourceCount": calcCount, "estimatedSourceCount": estimateCount, "unknownSourceCount": unknownCount},
		})
	}
	return result
}

func nutritionTrendAverages(daily []Object) []Object {
	if len(daily) == 0 {
		return []Object{}
	}
	ids := referenceNutrientIDs()
	sums := map[string]struct {
		calculated, estimated, targets *big.Rat
		targetCount                    int
	}{}
	for _, id := range ids {
		sums[id] = struct {
			calculated, estimated, targets *big.Rat
			targetCount                    int
		}{calculated: new(big.Rat), estimated: new(big.Rat), targets: new(big.Rat)}
	}
	for _, day := range daily {
		rows, _ := day["nutrients"].([]Object)
		if rows == nil {
			if raw, ok := day["nutrients"].([]any); ok {
				rows = make([]Object, 0, len(raw))
				for _, value := range raw {
					rows = append(rows, obj(value))
				}
			}
		}
		for _, row := range rows {
			id := text(row["nutrientId"])
			current, ok := sums[id]
			if !ok {
				continue
			}
			calculated, _ := nutritionRat(row["calculatedAmount"])
			estimated, _ := nutritionRat(row["estimatedAmount"])
			current.calculated.Add(current.calculated, calculated)
			current.estimated.Add(current.estimated, estimated)
			if target, ok := nutritionRat(row["targetAmount"]); ok && target.Sign() > 0 {
				current.targets.Add(current.targets, target)
				current.targetCount++
			}
			sums[id] = current
		}
	}
	count := int64(len(daily))
	result := make([]Object, 0, len(ids))
	for _, id := range ids {
		current := sums[id]
		calculated := new(big.Rat).Quo(current.calculated, big.NewRat(count, 1))
		estimated := new(big.Rat).Quo(current.estimated, big.NewRat(count, 1))
		subtotal := new(big.Rat).Add(calculated, estimated)
		var averageTarget any
		var rate any
		coverage := new(big.Rat).Quo(big.NewRat(int64(current.targetCount), 1), big.NewRat(count, 1))
		if current.targetCount > 0 {
			target := new(big.Rat).Quo(current.targets, big.NewRat(int64(current.targetCount), 1))
			averageTarget = ratDecimal(target, 3)
			if current.targetCount == int(count) && target.Sign() > 0 {
				rate = ratDecimal(new(big.Rat).Mul(new(big.Rat).Quo(subtotal, target), big.NewRat(100, 1)), 1)
			}
		}
		_, unit, _ := nutritionName(id)
		result = append(result, Object{
			"nutrientId": id, "calculatedAmountPerDay": ratDecimal(calculated, 3),
			"estimatedAmountPerDay": ratDecimal(estimated, 3), "knownSubtotalPerDay": ratDecimal(subtotal, 3),
			"averageTargetAmount": averageTarget, "targetDaysCount": current.targetCount,
			"targetCoverageRatio":                 ratDecimal(coverage, 3),
			"averageKnownSubtotalAchievementRate": rate, "unit": unit,
		})
	}
	return result
}

func addBreastmilkNutrition(d *nutritionDaySummary, sourceID, name string, volume *big.Rat, assumptions []string, ageGroup string) {
	if volume == nil || volume.Sign() < 0 {
		d.unknownAll(sourceID, "Breast-milk volume could not be calculated.")
		return
	}
	profile := legacyObject(nutritionReference["breastmilkPer100ml"])
	for _, nutrientID := range referenceNutrientIDs() {
		entry := legacyObject(profile[nutrientID])
		if len(entry) == 0 {
			d.unknown(nutrientID, sourceID, "The legacy breast-milk composition table does not declare this nutrient.")
			continue
		}
		amount, ok := nutritionRat(entry["amount"])
		unit := text(entry["unit"])
		if !ok || amount.Sign() < 0 || unit == "" {
			d.unknown(nutrientID, sourceID, "The legacy breast-milk value or unit is invalid.")
			d.unsupportedUnit(sourceID, nutrientID)
			continue
		}
		expected := nutritionCanonicalUnit(nutrientID, ageGroup)
		converted, convertedOK := convertNutritionUnit(nutrientID, amount, unit, expected)
		if !convertedOK {
			d.unknown(nutrientID, sourceID, "The legacy breast-milk unit is not supported for conversion.")
			d.unsupportedUnit(sourceID, nutrientID)
			continue
		}
		value := new(big.Rat).Quo(new(big.Rat).Mul(converted, volume), big.NewRat(100, 1))
		sourceAssumptions := append(append([]string{}, assumptions...), nutritionConversionAssumptions(nutrientID, unit, expected)...)
		d.add(nutrientID, sourceID, name, "breastmilk", value, expected, "legacy_estimate", sourceAssumptions)
	}
}

func addFormulaNutrition(d *nutritionDaySummary, recordID string, record, product Object, amountMl *big.Rat, foodPlan Object, ageGroup string) {
	profileRaw, hasOverride := customFormulaNutrientOverride(foodPlan, text(product["id"]))
	if !hasOverride {
		profileRaw = product["nutrients_json"]
	}
	profile, invalidIDs, profileOK := parseNutritionProfile(profileRaw)
	if !profileOK {
		d.unknownAll(recordID, "A formula product has no usable nutrient profile.")
		return
	}
	unit := strings.ToLower(strings.TrimSpace(text(product["serving_size_unit"])))
	var multiplier *big.Rat
	switch strings.ReplaceAll(strings.ReplaceAll(unit, "-", "_"), " ", "") {
	case "per_100g", "per100g", "per_100g_dry_powder", "per100g_dry_powder":
		ratio, ok := formulaGramsPerMl(product)
		if !ok {
			d.unknownAll(recordID, "A formula product in per-100g units has no usable reconstitution ratio.")
			return
		}
		multiplier = new(big.Rat).Quo(new(big.Rat).Mul(amountMl, ratio), big.NewRat(100, 1))
	case "per_100ml", "per100ml", "per_100ml_prepared", "per100ml_prepared":
		multiplier = new(big.Rat).Quo(amountMl, big.NewRat(100, 1))
	default:
		d.unknownAll(recordID, "Formula servingSizeUnit is not a supported per-100g or per-100ml basis.")
		return
	}
	productName := strings.TrimSpace(text(product["name"]))
	if productName == "" {
		productName = "Formula product"
	}
	assumptions := []string{"Nutrient amounts are calculated from the logged volume and the current family product profile; the server has no historical product-profile snapshot."}
	if hasOverride {
		assumptions = append(assumptions, "The family food-plan custom nutrient override was used.")
	}
	for _, nutrientID := range referenceNutrientIDs() {
		measurement, present := profile[nutrientID]
		if !present {
			d.unknown(nutrientID, recordID, "The formula nutrient profile does not declare this nutrient.")
			continue
		}
		if invalidIDs[nutrientID] {
			d.unknown(nutrientID, recordID, "The formula nutrient value or unit is invalid.")
			d.unsupportedUnit(recordID, nutrientID)
			continue
		}
		expected := nutritionCanonicalUnit(nutrientID, ageGroup)
		converted, convertedOK := convertNutritionUnit(nutrientID, measurement.amount, measurement.unit, expected)
		if !convertedOK {
			d.unknown(nutrientID, recordID, "The formula nutrient unit is not supported for conversion.")
			d.unsupportedUnit(recordID, nutrientID)
			continue
		}
		value := new(big.Rat).Mul(converted, multiplier)
		sourceAssumptions := append(append([]string{}, assumptions...), nutritionConversionAssumptions(nutrientID, measurement.unit, expected)...)
		d.add(nutrientID, recordID, productName+" ("+ratDecimal(amountMl, 3)+" ml)", "formula", value, expected, "product_calculation", sourceAssumptions)
	}
	for nutrientID := range invalidIDs {
		d.unsupportedUnit(recordID, nutrientID)
	}
}

func customFormulaNutrientOverride(foodPlan Object, productID string) (any, bool) {
	planData := legacyObject(foodPlan["plan_data"])
	supplementState := legacyObject(planData["supplementState"])
	custom := legacyObject(supplementState["customFormulaNutrients"])
	value, found := custom[productID]
	return value, found
}

func nutritionPlanDefaultFormulaID(foodPlan Object) string {
	planData := legacyObject(foodPlan["plan_data"])
	supplementState := legacyObject(planData["supplementState"])
	return text(supplementState["defaultFormulaId"])
}

func selectDefaultFormula(formulas []Object, configuredID string) (Object, bool) {
	if configuredID != "" {
		for _, row := range formulas {
			if text(row["id"]) == configuredID {
				return row, true
			}
		}
		return nil, false
	}
	var chosen Object
	for _, row := range formulas {
		if boolean(row["is_default"]) && !boolean(row["is_archived"]) && boolean(row["is_active"]) {
			if chosen != nil {
				return nil, false
			}
			chosen = row
		}
	}
	if chosen != nil {
		return chosen, true
	}
	return nil, false
}

func selectedFormula(record Object, formulas map[string]Object, fallback Object, fallbackOK bool) (Object, bool) {
	productID := text(record["formula_product_id"])
	if productID != "" {
		product, found := formulas[productID]
		return product, found
	}
	return fallback, fallbackOK
}

func formulaGramsPerMl(product Object) (*big.Rat, bool) {
	if ratio, ok := nutritionRat(product["reconstitution_ratio"]); ok && ratio.Sign() > 0 {
		return ratio, true
	}
	grams, gramsOK := nutritionRat(product["scoop_weight_g"])
	water, waterOK := nutritionRat(product["water_per_scoop_ml"])
	if !gramsOK || !waterOK || grams.Sign() <= 0 || water.Sign() <= 0 {
		return nil, false
	}
	return new(big.Rat).Quo(grams, water), true
}

func selectedSupplement(record Object, products []Object, byID map[string]Object) (Object, bool) {
	if productID := text(record["product_id"]); productID != "" {
		product, found := byID[productID]
		return product, found
	}
	name := strings.TrimSpace(text(record["supplement_name"]))
	var chosen Object
	for _, product := range products {
		if strings.EqualFold(strings.TrimSpace(text(product["name"])), name) {
			if chosen != nil {
				return nil, false
			}
			chosen = product
		}
	}
	return chosen, chosen != nil
}

func supplementRecordDose(record Object) (*big.Rat, bool) {
	if dose, ok := nutritionRat(record["dose"]); ok && dose.Sign() >= 0 {
		return dose, true
	}
	// A legacy free-text value such as "1 drop" has no safe dose basis. Accept
	// only a bare numeric fallback instead of silently ignoring a unit suffix.
	raw := strings.TrimSpace(text(record["amount"]))
	dose, ok := nutritionRat(raw)
	return dose, ok && dose.Sign() >= 0
}

func estimateNursingVolume(record Object) (*big.Rat, bool) {
	minutes := integer(record["left_minutes"]) + integer(record["right_minutes"])
	if minutes <= 0 {
		return nil, false
	}
	var volume int64
	switch {
	case minutes <= 10:
		volume = minutes * 5
		if volume > 60 {
			volume = 60
		}
	case minutes <= 20:
		volume = 50 + (minutes-10)*4
		if volume > 110 {
			volume = 110
		}
	default:
		volume = (180 + 5*(minutes-20) + 1) / 2 // legacy JS Math.round semantics for positive halves
		if volume > 160 {
			volume = 160
		}
	}
	return big.NewRat(volume, 1), true
}

func foodPortion(raw any) (string, *big.Rat, []string, bool) {
	value := strings.ToLower(strings.TrimSpace(text(raw)))
	if value == "" {
		return "most", big.NewRat(4, 5), []string{"No portion was recorded; the legacy Web default of most (0.8 serving) was applied as an estimate."}, true
	}
	if factor, ok := nutritionRat(legacyObject(nutritionReference["portionMultipliers"])[value]); ok && factor.Sign() >= 0 {
		return value, factor, []string{"Portion multiplier is a legacy Web serving estimate; no measured food mass is available."}, true
	}
	return value, nil, nil, false
}

func parseNutritionProfile(raw any) (map[string]nutritionMeasurement, map[string]bool, bool) {
	if raw == nil {
		return nil, nil, false
	}
	if encoded, ok := raw.(string); ok {
		var decoded any
		if decodeJSON([]byte(encoded), &decoded) != nil {
			return nil, nil, false
		}
		raw = decoded
	}
	input := legacyObject(raw)
	if len(input) == 0 {
		return nil, nil, false
	}
	measurements := map[string]nutritionMeasurement{}
	invalidIDs := map[string]bool{}
	knownIDs := map[string]bool{}
	for _, id := range referenceNutrientIDs() {
		knownIDs[id] = true
	}
	for key, rawValue := range input {
		id := normalizeNutritionID(key)
		if !knownIDs[id] {
			continue
		}
		value := legacyObject(rawValue)
		amount, amountOK := nutritionRat(value["amount"])
		unit := strings.TrimSpace(text(value["unit"]))
		if len(value) == 0 || !amountOK || amount.Sign() < 0 || unit == "" {
			invalidIDs[id] = true
			continue
		}
		measurements[id] = nutritionMeasurement{amount: amount, unit: unit}
	}
	return measurements, invalidIDs, true
}

func normalizeNutritionID(raw string) string {
	key := strings.ToLower(strings.TrimSpace(raw))
	key = strings.ReplaceAll(key, "-", "_")
	key = strings.ReplaceAll(key, " ", "_")
	switch key {
	case "vitamind":
		return "vitamin_d"
	case "vitamina":
		return "vitamin_a"
	case "vitaminc":
		return "vitamin_c"
	default:
		return key
	}
}

func nutritionRat(raw any) (*big.Rat, bool) {
	if raw == nil {
		return nil, false
	}
	switch value := raw.(type) {
	case *big.Rat:
		if value == nil {
			return nil, false
		}
		return new(big.Rat).Set(value), true
	case json.Number:
		raw = value.String()
	case int:
		raw = strconv.Itoa(value)
	case int64:
		raw = strconv.FormatInt(value, 10)
	case float64:
		if value != value {
			return nil, false
		}
		raw = strconv.FormatFloat(value, 'f', -1, 64)
	}
	value, ok := new(big.Rat).SetString(text(raw))
	return value, ok
}

func convertNutritionUnit(nutrientID string, amount *big.Rat, sourceUnit, targetUnit string) (*big.Rat, bool) {
	if amount == nil || sourceUnit == "" || targetUnit == "" {
		return nil, false
	}
	source := normalizeNutritionUnit(sourceUnit)
	target := normalizeNutritionUnit(targetUnit)
	if source == target {
		return new(big.Rat).Set(amount), true
	}
	if nutrientID == "vitamin_d" {
		if (source == "mcg" || source == "iu") && (target == "iu" || target == "mcg") {
			if source == target {
				return new(big.Rat).Set(amount), true
			}
			if source == "mcg" && target == "iu" {
				return new(big.Rat).Mul(amount, big.NewRat(40, 1)), true
			}
			return new(big.Rat).Quo(amount, big.NewRat(40, 1)), true
		}
	}
	if nutrientID == "vitamin_a" && target == "mcgrae" && source == "iu" {
		return new(big.Rat).Mul(amount, big.NewRat(3, 10)), true
	}
	if source == "kcal" && target == "kj" {
		return new(big.Rat).Mul(amount, big.NewRat(4184, 1000)), true
	}
	if source == "kj" && target == "kcal" {
		return new(big.Rat).Mul(amount, big.NewRat(1000, 4184)), true
	}
	massScale := map[string]*big.Rat{"g": big.NewRat(1000000, 1), "mg": big.NewRat(1000, 1), "mcg": big.NewRat(1, 1)}
	sourceScale, sourceOK := massScale[source]
	targetScale, targetOK := massScale[target]
	if sourceOK && targetOK {
		return new(big.Rat).Quo(new(big.Rat).Mul(amount, sourceScale), targetScale), true
	}
	return nil, false
}

func normalizeNutritionUnit(raw string) string {
	unit := strings.ToLower(strings.TrimSpace(raw))
	unit = strings.ReplaceAll(unit, "μ", "mc")
	unit = strings.ReplaceAll(unit, "µ", "mc")
	unit = strings.ReplaceAll(unit, "ug", "mcg")
	unit = strings.ReplaceAll(unit, "微克", "mcg")
	unit = strings.ReplaceAll(unit, "毫克", "mg")
	unit = strings.ReplaceAll(unit, "克", "g")
	unit = strings.ReplaceAll(unit, "单位", "iu")
	unit = strings.ReplaceAll(unit, " ", "")
	unit = strings.ReplaceAll(unit, "-", "_")
	return unit
}

func nutritionConversionAssumptions(nutrientID, sourceUnit, targetUnit string) []string {
	if nutrientID == "vitamin_a" && normalizeNutritionUnit(sourceUnit) == "iu" && normalizeNutritionUnit(targetUnit) == "mcgrae" {
		return []string{"Vitamin A IU conversion uses the legacy Web value of 0.3 mcg RAE per IU; the source compound is not recorded."}
	}
	return nil
}

func nutritionAgeMonths(birthDate, date string) (int, bool) {
	birth, errBirth := time.Parse("2006-01-02", birthDate)
	target, errTarget := time.Parse("2006-01-02", date)
	if errBirth != nil || errTarget != nil || target.Before(birth) {
		return 0, false
	}
	months := (target.Year()-birth.Year())*12 + int(target.Month()-birth.Month())
	anchorDay := birth.Day()
	last := time.Date(target.Year(), target.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
	if anchorDay > last {
		anchorDay = last
	}
	if target.Day() < anchorDay {
		months--
	}
	if months < 0 {
		return 0, false
	}
	return months, true
}

func ageGroupForNutritionAge(months int, known bool) string {
	if !known {
		return "unknown_age"
	}
	switch {
	case months < 6:
		return "0-6m"
	case months < 12:
		return "6-12m"
	case months <= 36:
		return "1-3y"
	default:
		return "unsupported_over_36m"
	}
}

func nutritionCanonicalUnit(id, group string) string {
	if group != "unsupported_over_36m" {
		if value := text(nutritionDRIDefinition(id, group)["unit"]); value != "" {
			return value
		}
	}
	return text(legacyObject(legacyObject(nutritionReference["nutrientNames"])[id])["unit"])
}

func nutritionName(id string) (string, string, string) {
	meta := legacyObject(legacyObject(nutritionReference["nutrientNames"])[id])
	return text(meta["name"]), text(meta["unit"]), text(meta["category"])
}

func nutritionDRIDefinition(id, group string) Object {
	groupObject := legacyObject(legacyObject(nutritionReference["ageGroups"])[group])
	return legacyObject(legacyObject(groupObject["nutrients"])[id])
}

func nutritionTarget(def Object) (*big.Rat, any) {
	if amount, ok := nutritionRat(def["rni"]); ok && amount.Sign() > 0 {
		return amount, "RNI"
	}
	if amount, ok := nutritionRat(def["ai"]); ok && amount.Sign() > 0 {
		return amount, "AI"
	}
	return nil, nil
}

func nutritionNullableAmount(raw any) any {
	if value, ok := nutritionRat(raw); ok && value.Sign() > 0 {
		return ratDecimal(value, 3)
	}
	return nil
}

func ratDecimal(value *big.Rat, places int) string {
	if value == nil || value.Sign() == 0 {
		return "0"
	}
	result := value.FloatString(places)
	result = strings.TrimRight(strings.TrimRight(result, "0"), ".")
	if result == "" || result == "-0" {
		return "0"
	}
	return result
}

func sortedBoolKeys(values map[string]bool) []string {
	result := make([]string, 0, len(values))
	for value, enabled := range values {
		if enabled {
			result = append(result, value)
		}
	}
	sort.Strings(result)
	return result
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
