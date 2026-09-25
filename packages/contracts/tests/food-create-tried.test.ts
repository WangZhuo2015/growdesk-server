import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "@sinclair/typebox/value";
import { CreateFoodLibraryItemRequestSchema } from "../src/nutrition.js";

const item = {
  name: "Test Food",
  category: "test",
  allergenRisk: "low",
  recommendedAgeMonths: 6,
};

test("food creation keeps absent, false and true tried states without coercion", () => {
  assert.equal(Value.Check(CreateFoodLibraryItemRequestSchema, item), true);
  for (const tried of [false, true]) {
    const body = { ...item, tried };
    assert.equal(Value.Check(CreateFoodLibraryItemRequestSchema, body), true);
    assert.equal(body.tried, tried);
  }
  for (const tried of [null, "false", "true", 0, 1, [], {}]) {
    assert.equal(Value.Check(CreateFoodLibraryItemRequestSchema, { ...item, tried }), false);
  }
});
