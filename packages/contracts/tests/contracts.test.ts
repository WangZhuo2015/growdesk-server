import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "@sinclair/typebox/value";
import * as contracts from "../src/index.js";
import { generateCanonicalOpenApi } from "../../../scripts/contract-generator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// A megabyte string diff hides the changed field in CI output. This is only
// bounded diagnostic context: the original byte-for-byte assertion stays below.
function firstContractDifference(left: unknown, right: unknown, location = "$"): string | null {
  if (Object.is(left, right)) return null;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return `${location}: array lengths ${left.length} != ${right.length}`;
    for (let i = 0; i < left.length; i++) {
      const difference = firstContractDifference(left[i], right[i], `${location}[${i}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object" &&
      !Array.isArray(left) && !Array.isArray(right)) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const child = `${location}[${JSON.stringify(key)}]`;
      if (!Object.hasOwn(a, key)) return `${child}: missing from stored snapshot`;
      if (!Object.hasOwn(b, key)) return `${child}: absent from generated contract`;
      const difference = firstContractDifference(a[key], b[key], child);
      if (difference) return difference;
    }
    return null;
  }
  const preview = (value: unknown) => String(JSON.stringify(value)).slice(0, 160);
  return `${location}: stored ${preview(left)} != generated ${preview(right)}`;
}

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

  test("Native family snapshot pages use the existing worker projection envelope", () => {
    const route = contracts.ROUTE_DEFINITIONS.find(
      (item) => item.operationId === "getFamilySnapshotPage"
    );
    assert.ok(route, "snapshot page download operation must be declared");
    assert.equal(route.method, "GET");
    assert.equal(
      route.path,
      "/api/v1/sync/families/:familyId/snapshots/:snapshotId/pages/:page"
    );
    assert.ok(route.params);
    assert.equal(
      Value.Check(route.params, {
        familyId: "123e4567-e89b-12d3-a456-426614174001",
        snapshotId: "123e4567-e89b-12d3-a456-426614174002",
        page: "0",
      }),
      true
    );
    assert.equal(
      Value.Check(route.params, {
        familyId: "123e4567-e89b-12d3-a456-426614174001",
        snapshotId: "123e4567-e89b-12d3-a456-426614174002",
        page: "-1",
      }),
      false
    );

    assert.equal(
      Value.Check(contracts.SyncSnapshotPageResponseSchema, {
        data: {
          snapshotId: "123e4567-e89b-12d3-a456-426614174002",
          page: 0,
          pageCount: 1,
          highWater: "42",
          content: {
            entityType: "baby",
            data: [{ id: "123e4567-e89b-12d3-a456-426614174003" }],
          },
          contentJSON: '{"data":[{"id":"123e4567-e89b-12d3-a456-426614174003"}],"entityType":"baby"}',
          sha256: "a".repeat(64),
        },
      }),
      true
    );
    assert.equal(
      Value.Check(contracts.SyncSnapshotPageResponseSchema, {
        data: {
          snapshotId: "123e4567-e89b-12d3-a456-426614174002",
          page: 0,
          pageCount: 1,
          highWater: "42",
          content: { entityType: "baby", data: [] },
          contentJSON: '{"data":[],"entityType":"baby"}',
          sha256: "not-a-sha256",
        },
      }),
      false
    );

    const snapshotMetadata = {
      id: "123e4567-e89b-12d3-a456-426614174002",
      scope: "family",
      epoch: "123e4567-e89b-12d3-a456-426614174003",
      highWater: "42",
      pageCount: 1,
      expiresAt: "2026-10-03T12:00:00.000Z",
    };
    assert.equal(
      Value.Check(contracts.SyncSnapshotSchema, {
        ...snapshotMetadata,
        status: "ready",
        nextCursor: "opaque-signed-cursor",
      }),
      true
    );
    assert.equal(
      Value.Check(contracts.SyncSnapshotSchema, {
        ...snapshotMetadata,
        status: "ready",
      }),
      false
    );
    assert.equal(
      Value.Check(contracts.SyncSnapshotSchema, {
        ...snapshotMetadata,
        status: "queued",
      }),
      true
    );
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
    assert.ok(generated.paths);
    const pathItem = generated.paths["/api/v1/attachments/{id}/content"] as {
      get: { responses: Record<string, { content: Record<string, { schema: { $ref?: string } }> }> };
    };
    const operation = pathItem.get;
    const success = operation.responses["200"];
    assert.ok(success);
    const successContent = success.content;

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
    const forbidden = operation.responses["403"]?.content["application/json"];
    assert.ok(forbidden);
    assert.equal(forbidden.schema.$ref, "#/components/schemas/ApiErrorEnvelope");
  });

  test("account export declares typed status, JSON download, and integrity headers", async () => {
    const statusRoute = contracts.ROUTE_DEFINITIONS.find(
      (item) => item.operationId === "getUserExportStatus"
    );
    const downloadRoute = contracts.ROUTE_DEFINITIONS.find(
      (item) => item.operationId === "downloadUserExport"
    );
    assert.ok(statusRoute);
    assert.ok(downloadRoute);
    assert.equal(statusRoute.method, "GET");
    assert.equal(statusRoute.path, "/api/v1/me/exports/:id/status");
    assert.ok(Object.hasOwn(statusRoute.responses, 404));
    assert.equal(downloadRoute.method, "GET");
    assert.equal(downloadRoute.path, "/api/v1/me/exports/:id");
    assert.deepEqual(downloadRoute.responseContentTypes?.[200], ["application/json"]);
    assert.ok(downloadRoute.responseHeaders?.[200]?.["Content-Disposition"]);
    assert.ok(downloadRoute.responseHeaders?.[200]?.["X-Content-SHA256"]);

    const generated = await generateCanonicalOpenApi();
    const paths = generated.paths as Record<string, Record<string, {
      responses?: Record<string, {
        headers?: Record<string, { schema?: { pattern?: string } }>;
        content?: Record<string, { schema?: {
          $ref?: string;
          type?: string;
          required?: string[];
          properties?: Record<string, { enum?: number[] }>;
        } }>;
      }>;
    }>>;
    const download = paths["/api/v1/me/exports/{id}"]?.get;
    assert.ok(download);
    const success = download.responses?.["200"];
    assert.ok(success);
    const fileSchema = success.content?.["application/json"]?.schema;
    assert.equal(fileSchema?.type, "object");
    assert.ok(fileSchema?.required?.includes("schemaVersion"));
    assert.deepEqual(fileSchema?.properties?.schemaVersion?.enum, [1]);
    assert.equal(success.headers?.["X-Content-SHA256"]?.schema?.pattern, "^[a-f0-9]{64}$");
    assert.ok(success.headers?.["Content-Disposition"]?.schema);
    assert.ok(paths["/api/v1/me/exports/{id}/status"]?.get?.responses?.["200"]);

    assert.equal(Value.Check(contracts.UserExportTaskStatusResponseSchema, {
      data: {
        taskId: "123e4567-e89b-12d3-a456-426614174001",
        status: "succeeded",
        attempt: 1,
        createdAt: "2026-10-03T10:00:00.000Z",
        updatedAt: "2026-10-03T10:01:00.000Z",
        expiresAt: "2026-10-03T11:01:00.000Z",
      },
    }), true);
  });

  test("medical OCR contract documents the optional idempotency key and provider failure", async () => {
    const route = contracts.ROUTE_DEFINITIONS.find((item) => item.operationId === "createMedicalOcrRun");
    assert.ok(route);
    const header = route.headers?.properties?.["Idempotency-Key"] as {
      minLength?: number;
      maxLength?: number;
    } | undefined;
    assert.ok(header);
    assert.equal(header.minLength, 1);
    assert.equal(header.maxLength, 200);
    assert.equal(route.headers?.required?.includes("Idempotency-Key") ?? false, false);
    assert.ok(Object.hasOwn(route.responses, 503));
    const headers = route.headers;
    assert.ok(headers);
    assert.equal(Value.Check(headers, {}), true);
    assert.equal(Value.Check(headers, { "Idempotency-Key": "test_key" }), true);
    assert.equal(Value.Check(headers, { "Idempotency-Key": "" }), false);
    assert.equal(Value.Check(headers, { "Idempotency-Key": "k".repeat(201) }), false);

    const generated = await generateCanonicalOpenApi();
    const operation = (generated.paths as Record<string, Record<string, unknown>>)["/api/v1/medical/ocr-runs"]?.post as {
      parameters?: Array<{ name?: string; in?: string; required?: boolean; schema?: { minLength?: number; maxLength?: number } }>;
      responses?: Record<string, unknown>;
    } | undefined;
    assert.ok(operation);
    const idempotencyHeader = operation.parameters?.find((item) => item.name === "Idempotency-Key" && item.in === "header");
    assert.ok(idempotencyHeader);
    assert.equal(idempotencyHeader.required, false);
    assert.equal(idempotencyHeader.schema?.minLength, 1);
    assert.equal(idempotencyHeader.schema?.maxLength, 200);
    assert.ok(operation.responses?.["503"]);
  });

  test("Canonical OpenAPI 3.0.3 spec matches contracts/openapi.json with zero diff", async () => {
    const generated = await generateCanonicalOpenApi();
    const diskPath = path.join(root, "contracts", "openapi.json");
    const diskContent = await fs.readFile(diskPath, "utf8");
    const generatedContent = JSON.stringify(generated, null, 2) + "\n";

    if (diskContent !== generatedContent) {
      console.error("OPENAPI_DRIFT:", firstContractDifference(JSON.parse(diskContent), generated) ?? "formatting or property order differs");
    }
    assert.equal(
      diskContent,
      generatedContent,
      "Drift detected between generated OpenAPI spec and contracts/openapi.json"
    );
  });
});
