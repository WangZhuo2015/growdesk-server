package backend

import (
	"encoding/json"
	"math/big"
	"strings"
)

// nutritionProfileJSON validates the numeric label values before they become
// a public family catalog profile. Unknown nutrient IDs are retained for
// forward compatibility; the versioned analysis reports them as out of scope.
func nutritionProfileJSON(raw any) (any, error) {
	if raw == nil {
		return nil, nil
	}
	var profile Object
	switch value := raw.(type) {
	case Object:
		profile = value
	case map[string]any:
		profile = Object(value)
	default:
		return nil, invalid("nutrientsJson must be an object or null")
	}
	if len(profile) > 64 {
		return nil, invalid("nutrientsJson contains too many nutrient values")
	}
	known := make(map[string]bool, len(referenceNutrientIDs()))
	for _, id := range referenceNutrientIDs() {
		known[id] = true
	}
	for id, rawMeasurement := range profile {
		measurement := legacyObject(rawMeasurement)
		amount, amountOK := nutritionRat(measurement["amount"])
		unit := strings.TrimSpace(text(measurement["unit"]))
		if len(measurement) != 2 || !amountOK || amount.Sign() < 0 || unit == "" {
			return nil, invalid("nutrientsJson contains an invalid amount or unit")
		}
		nutrientID := normalizeNutritionID(id)
		if !known[nutrientID] {
			continue
		}
		unitSupported := false
		for _, group := range []string{"0-6m", "6-12m", "1-3y"} {
			target := nutritionCanonicalUnit(nutrientID, group)
			if target == "" {
				continue
			}
			if _, ok := convertNutritionUnit(nutrientID, big.NewRat(1, 1), unit, target); ok {
				unitSupported = true
				break
			}
		}
		if !unitSupported {
			return nil, invalid("nutrientsJson contains an unsupported unit for " + nutrientID)
		}
	}
	encoded, err := jsonBytes(profile)
	if err != nil {
		return nil, invalid("nutrientsJson could not be encoded")
	}
	return json.RawMessage(encoded), nil
}
