import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  CreateFormulaProductRequestSchema,
  CreateFoodLibraryItemRequestSchema,
  FormulaProductSchema,
  UpdateFoodLibraryItemRequestSchema,
  UpdateFormulaProductRequestSchema,
} from "../src/nutrition.js";
import { CreateFoodRequestSchema, FoodRecordSchema } from "../src/records.js";

const profile = {
  protein: { amount: 1.25, unit: "g" },
  vitamin_d: { amount: "0.25", unit: "mcg" },
  selenium: { amount: "1.5", unit: "mcg" },
};

test("formula create accepts a typed label profile and supported basis", () => {
  assert.equal(Value.Check(CreateFormulaProductRequestSchema, {
    brand: "Test brand",
    name: "test formula",
    scoopGrams: "4.3",
    waterMlPerScoop: "30",
    reconstitutionRatio: "0.13",
    servingSizeUnit: "per_100ml",
    nutrientsJson: profile,
  }), true);
  assert.equal(Value.Check(CreateFormulaProductRequestSchema, {
    brand: "Test brand", name: "test formula", nutrientsJson: null,
  }), true);
  assert.equal(Value.Check(CreateFormulaProductRequestSchema, {
    brand: "Test brand", name: "test formula", servingSizeUnit: "per_100kJ",
  }), true);
  assert.equal(Value.Check(CreateFormulaProductRequestSchema, {
    brand: "Test brand", name: "test formula", servingSizeUnit: "per_1kcal",
  }), false);
});

test("formula profile update requires a version field when supplied by caller", () => {
  assert.equal(Value.Check(UpdateFormulaProductRequestSchema, {
    nutrientsJson: profile, baseVersion: 2,
  }), true);
  assert.equal(Value.Check(UpdateFormulaProductRequestSchema, { nutrientsJson: null }), true);
});

test("formula product reads preserve legacy JSON while writes remain typed", () => {
  const rawLegacyProfile = {
    protein: { amount: 1.25, unit: "g", source: "legacy_label" },
    iron: 18,
    future_nutrient: ["legacy", "untyped"],
  };
  const response = {
    id: "00000000-0000-4000-8000-000000000001",
    familyId: "00000000-0000-4000-8000-000000000002",
    brand: "test brand",
    name: "test formula",
    stage: null,
    scoopGrams: "4.3",
    waterMlPerScoop: "30",
    reconstitutionRatio: "0.1433",
    servingSizeUnit: "per_100ml",
    nutrientsJson: rawLegacyProfile,
    notes: null,
    isActive: true,
    isDefault: false,
    isArchived: false,
    version: 1,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  assert.equal(Value.Check(FormulaProductSchema, response), true);
  assert.equal(Value.Check(FormulaProductSchema, { ...response, nutrientsJson: 7 }), true);
  assert.equal(Value.Check(FormulaProductSchema, { ...response, nutrientsJson: null }), true);
  assert.equal(Value.Check(CreateFormulaProductRequestSchema, {
    brand: "test brand", name: "test formula", nutrientsJson: rawLegacyProfile,
  }), false);
  assert.equal(Value.Check(UpdateFormulaProductRequestSchema, {
    baseVersion: 1, nutrientsJson: rawLegacyProfile,
  }), false);
});

test("food create and versioned profile update preserve clear semantics", () => {
  assert.equal(Value.Check(CreateFoodLibraryItemRequestSchema, {
    name: "test food", category: "fruit", allergenRisk: "low", recommendedAgeMonths: 6,
    nutritionBasis: "per_100g", nutrientsJson: profile,
  }), true);
  assert.equal(Value.Check(UpdateFoodLibraryItemRequestSchema, {
    nutrientsJson: null, baseVersion: 1,
  }), true);
  assert.equal(Value.Check(UpdateFoodLibraryItemRequestSchema, {
    nutrientsJson: profile,
  }), false);
});

test("measured food records carry an explicit decimal gram quantity", () => {
  assert.equal(Value.Check(CreateFoodRequestSchema, {
    recordDate: "2026-10-03", mealType: "lunch", foodItemIds: ["custom_test_food"], foodAmountGrams: "12.5",
  }), true);
  assert.equal(Value.Check(CreateFoodRequestSchema, {
    recordDate: "2026-10-03", mealType: "lunch", foodItemIds: ["custom_test_food"], foodAmountGrams: 12.5,
  }), false);
  assert.equal(Value.Check(FoodRecordSchema, {
    id: "00000000-0000-4000-8000-000000000001", familyId: "00000000-0000-4000-8000-000000000002",
    babyId: "00000000-0000-4000-8000-000000000003", recordDate: "2026-10-03", mealType: "lunch",
    occurredAt: null, foodItemIds: ["custom_test_food"], foodAmountGrams: "12.5", portionDescription: null,
    reaction: null, notes: null, version: "1", createdAt: "2026-10-03T12:00:00.000Z", updatedAt: "2026-10-03T12:00:00.000Z",
  }), true);
});

test("nutrition profile amounts reject negative and malformed nutrient entries", () => {
  for (const amount of [-1, "-1", "NaN", "1e3"]) {
    assert.equal(Value.Check(CreateFoodLibraryItemRequestSchema, {
      name: "test food", category: "fruit", allergenRisk: "low", recommendedAgeMonths: 6,
      nutrientsJson: { protein: { amount, unit: "g" } },
    }), false);
  }
  assert.equal(Value.Check(CreateFoodLibraryItemRequestSchema, {
    name: "test food", category: "fruit", allergenRisk: "low", recommendedAgeMonths: 6,
    nutrientsJson: { protein: { amount: 1, unit: "" } },
  }), false);
});
