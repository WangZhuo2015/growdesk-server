import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSupplementNutrients } from "../src/services/supplement-nutrients.js";

test("legacy supplement nutrient aliases and units normalize deterministically", () => {
  assert.deepEqual(normalizeSupplementNutrients({
    vitaminD: 400,
    "vitamin-a": { amount: 125.678, unit: "mcg RAE" },
    calcium: { amount: 100 },
    invalidNegative: -1,
    invalidShape: "100",
  }), {
    vitamin_d: { amount: 400, unit: "IU" },
    vitamin_a: { amount: 125.68, unit: "mcg RAE" },
    calcium: { amount: 100, unit: "mg" },
  });
});
