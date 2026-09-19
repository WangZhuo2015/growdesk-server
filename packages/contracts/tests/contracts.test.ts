import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import * as contracts from "../src/index.js";
import { generateCanonicalOpenApi } from "../../../scripts/contract-generator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("GrowDesk Contracts Test Suite", () => {
  test("ApiErrorEnvelope schema validates standard error payload", () => {
    const validError = {
      error: {
        code: "VALIDATION_FAILED",
        message: "Request validation failed",
        details: [{ path: "/amountMl", message: "must match pattern" }],
        requestId: "req_test_123",
      },
    };

    assert.equal(Value.Check(contracts.ApiErrorEnvelopeSchema, validError), true);

    const invalidError = {
      error: {
        code: "NO_MESSAGE",
        // message missing
        requestId: "req_test_123",
      },
    };
    assert.equal(Value.Check(contracts.ApiErrorEnvelopeSchema, invalidError), false);
  });

  test("Feeding record creation payload validates correct input and rejects malformed fields", () => {
    const validPayload = {
      feedingType: "bottle",
      occurredAt: "2026-09-12T06:30:00.000Z",
      amountMl: "150.0",
      leftMinutes: null,
      rightMinutes: null,
      spitUp: false,
      formulaProductId: "prod_123",
      notes: "Afternoon feed",
      source: "ui_manual",
      sourceAgent: "Web",
    };

    assert.equal(Value.Check(contracts.CreateFeedingRequestSchema, validPayload), true);

    // Rejects invalid feedingType
    const invalidTypePayload = { ...validPayload, feedingType: "invalid_type" };
    assert.equal(Value.Check(contracts.CreateFeedingRequestSchema, invalidTypePayload), false);

    // Rejects notes exceeding 1000 characters
    const longNotesPayload = { ...validPayload, notes: "a".repeat(1001) };
    assert.equal(Value.Check(contracts.CreateFeedingRequestSchema, longNotesPayload), false);

    // Rejects negative leftMinutes
    const negativeMinutesPayload = { ...validPayload, leftMinutes: -5 };
    assert.equal(Value.Check(contracts.CreateFeedingRequestSchema, negativeMinutesPayload), false);
  });

  test("Sleep record creation payload validates correct input", () => {
    const validNap = {
      sleepType: "nap",
      startedAt: "2026-09-12T13:00:00.000Z",
      endedAt: "2026-09-12T14:30:00.000Z",
      nightWakingCount: 0,
      notes: null,
    };

    assert.equal(Value.Check(contracts.CreateSleepRequestSchema, validNap), true);

    const ongoingSleep = {
      sleepType: "night",
      startedAt: "2026-09-12T20:00:00.000Z",
      endedAt: null,
    };

    assert.equal(Value.Check(contracts.CreateSleepRequestSchema, ongoingSleep), true);

    const invalidType = { ...validNap, sleepType: "rest" };
    assert.equal(Value.Check(contracts.CreateSleepRequestSchema, invalidType), false);
  });

  test("Growth measurement schema enforces decimal strings", () => {
    const validMeasurement = {
      measurementDate: "2026-09-12",
      weightKg: "9.40",
      heightCm: "76.5",
      headCircumferenceCm: null,
      notes: "6-month checkup",
    };

    assert.equal(Value.Check(contracts.CreateGrowthMeasurementRequestSchema, validMeasurement), true);

    // Non-decimal string rejected
    const invalidWeight = { ...validMeasurement, weightKg: "heavy" };
    assert.equal(Value.Check(contracts.CreateGrowthMeasurementRequestSchema, invalidWeight), false);
  });

  test("Sync command batch schema validates offline mutations structure", () => {
    const validBatch = {
      commands: [
        {
          commandId: "e6134d24-01f7-4d6e-bb2f-a7984dbd7cbb",
          familyId: "123e4567-e89b-12d3-a456-426614174001",
          babyId: "123e4567-e89b-12d3-a456-426614174002",
          entityType: "feeding",
          entityId: "5e4db0f2-d737-459e-9fbd-867635326aca",
          operation: "create",
          baseVersion: null,
          clientCreatedAt: "2026-09-11T09:00:00.000Z",
          payload: {
            feedingType: "formula",
            occurredAt: "2026-09-11T09:00:00.000Z",
            amountMl: "120.0",
          },
        },
      ],
    };

    assert.equal(Value.Check(contracts.SyncCommandBatchRequestSchema, validBatch), true);
  });

  test("ROUTE_DEFINITIONS has unique operationIds and explicit status markings", () => {
    assert.ok(contracts.ROUTE_DEFINITIONS.length >= 80, `Expected >= 80 routes, got ${contracts.ROUTE_DEFINITIONS.length}`);

    const opIds = new Set<string>();
    for (const route of contracts.ROUTE_DEFINITIONS) {
      assert.ok(route.operationId, `Route ${route.method} ${route.path} missing operationId`);
      assert.ok(!opIds.has(route.operationId), `Duplicate operationId found: ${route.operationId}`);
      opIds.add(route.operationId);

      assert.ok(route.implementationStatus, `Route ${route.operationId} missing implementationStatus`);
      assert.ok(Object.keys(route.responses).length > 0, `Route ${route.operationId} has no responses`);
    }
  });

  test("attachment content is documented as binary media while errors remain JSON", async () => {
    const generated = await generateCanonicalOpenApi();
    const operation = generated.paths["/api/v1/attachments/{id}/content"].get;
    const successContent = operation.responses["200"].content;

    assert.deepEqual(Object.keys(successContent), [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "audio/m4a",
      "audio/wav",
      "audio/mpeg",
      "audio/mp4",
      "application/pdf",
    ]);
    assert.equal(successContent["application/json"], undefined);
    assert.equal(operation.responses["403"].content["application/json"].schema.$ref, "#/components/schemas/ApiErrorEnvelope");
  });

  test("Canonical OpenAPI 3.0.3 spec matches contracts/openapi.json with zero diff", async () => {
    const generated = await generateCanonicalOpenApi();
    const diskPath = path.join(root, "contracts", "openapi.json");
    const diskContent = await fs.readFile(diskPath, "utf8");
    const generatedContent = JSON.stringify(generated, null, 2) + "\n";

    assert.equal(
      diskContent,
      generatedContent,
      "Drift detected between generated OpenAPI spec and contracts/openapi.json"
    );
  });
});
