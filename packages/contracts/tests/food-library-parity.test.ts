import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import {
  CreateFoodLibraryItemRequestSchema,
  FoodLibraryItemSchema,
  FamilyFoodStatusResponseSchema,
  UpdateFamilyFoodStatusRequestSchema,
} from "../src/nutrition.js";

test("custom food create preserves the legacy icon and first-added fields", () => {
  const request = {
    familyId: "00000000-0000-4000-8000-000000000001",
    name: "Test Pear",
    icon: "🍐",
    category: "fruit",
    allergenRisk: "low",
    recommendedAgeMonths: 6,
    status: "tried",
    tried: true,
    firstAddedDate: "2026-10-03",
    acceptance: 3,
  };
  assert.equal(Value.Check(CreateFoodLibraryItemRequestSchema, request), true);

  const response = {
    id: "custom_00000000-0000-4000-8000-000000000001",
    name: request.name,
    icon: request.icon,
    category: request.category,
    foodGroup: null,
    status: "tried",
    firstAddedDate: request.firstAddedDate,
    acceptance: 3,
    allergenRisk: request.allergenRisk,
    recommendedAgeMonths: 6,
    recommendedFromMonth: null,
    recommendedToMonth: null,
    exactMonthEvidence: false,
    guidance: null,
    isCommonAllergen: null,
    allergenIntroductionGuidance: null,
    highRiskInfantNeedsMedicalAdvice: null,
    chokingRisk: false,
    chokingNotes: null,
    preparation: [],
    avoidBeforeMonths: null,
    nutrition: [],
    textureByAge: [],
    notes: null,
    sourceRefs: [],
    nutritionBasis: null,
    nutrientsJson: null,
    version: 1,
    familyStatus: {
      tried: true,
      status: "tried",
      firstAddedDate: request.firstAddedDate,
      acceptance: 3,
      reaction: null,
      version: 1,
    },
  };
  assert.equal(Value.Check(FoodLibraryItemSchema, response), true);
});

test("family-shared food status requires CAS and keeps explicit clears", () => {
  const initial = { status: "tried", firstAddedDate: null, acceptance: 0, baseVersion: 0 };
  assert.equal(Value.Check(UpdateFamilyFoodStatusRequestSchema, initial), true);
  assert.equal(Value.Check(UpdateFamilyFoodStatusRequestSchema, { ...initial, baseVersion: -1 }), false);
  assert.equal(Value.Check(UpdateFamilyFoodStatusRequestSchema, { ...initial, acceptance: 6 }), false);

  const result = {
    data: {
      id: "00000000-0000-4000-8000-000000000002",
      familyId: "00000000-0000-4000-8000-000000000001",
      foodId: "food_egg",
      tried: false,
      status: "to_try",
      firstAddedDate: null,
      acceptance: 0,
      reaction: null,
      version: 2,
      updatedAt: "2026-10-03T12:00:00.000Z",
    },
  };
  assert.equal(Value.Check(FamilyFoodStatusResponseSchema, result), true);
});
