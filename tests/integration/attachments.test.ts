import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import { MockStorageDriver } from "../../apps/api/src/storage/s3-storage-service.js";

interface OwnedRun {
  directory: string;
  token: string;
  database: string;
  user: string;
  password: string;
  pgPort: number;
  redisPort: number;
}

function readRun(): OwnedRun {
  const file = process.env.BOOT02_RUN_FILE;
  if (!file) throw new Error("Integration tests require the managed test runner");
  const real = fs.realpathSync(file);
  const parent = path.dirname(real);
  if (path.dirname(parent) !== fs.realpathSync(os.tmpdir()) || !path.basename(parent).startsWith("growdesk-integration-")) {
    throw new Error("Integration manifest is outside its private run");
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("Unsafe manifest permissions");
  return JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
}

test("SH-06: S3 Attachments Pipeline suite", async (t) => {
  const run = readRun();
  const identity = {
    host: "127.0.0.1" as const,
    port: run.pgPort,
    database: run.database,
    role: run.user,
    password: run.password,
  };
  const url = requireTestDatabaseUrl(
    `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    identity,
  );

  const jwtSecret = "integration-test-auth-secret-min-32-chars-long!";
  const ctx = createDatabaseContext({ url });
  const mockStorage = new MockStorageDriver();
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret,
    storageDriver: mockStorage,
  });

  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  // Ensure all migrations up to 202609120010_attachments_medical_vaccines are applied
  const migrations = [
    "prisma/migrations/202609120001_identity/migration.sql",
    "prisma/migrations/202609120002_foundation/migration.sql",
    "prisma/migrations/202609120003_care_feeding/migration.sql",
    "prisma/migrations/202609120004_care_diaper/migration.sql",
    "prisma/migrations/202609120005_care_sleep/migration.sql",
    "prisma/migrations/202609120006_care_food/migration.sql",
    "prisma/migrations/202609120007_care_supplement/migration.sql",
    "prisma/migrations/202609120008_care_growth/migration.sql",
    "prisma/migrations/202609120009_bff_sessions/migration.sql",
    "prisma/migrations/202609120010_attachments_medical_vaccines/migration.sql",
  ];

  for (const m of migrations) {
    const sql = fs.readFileSync(m, "utf8");
    try {
      await ctx.pool.query(sql);
    } catch {
      // Table or type might already exist from previous suite, ignore
    }
  }

  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";

  const stamp = Date.now();
  const userA = `test_att_a_${stamp}`;
  const userB = `test_att_b_${stamp}`;

  await t.test("Setup: Register User A and User B", async () => {
    const regResA = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userA,
        password: "ValidPassword123!",
        displayName: "Caregiver Att A",
      },
    });
    assert.equal(regResA.statusCode, 201);
    tokenA = regResA.json<{ data: { accessToken: string } }>().data.accessToken;

    const famResA = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const famListA = famResA.json<{ data: Array<{ id: string }> }>().data;
    assert.ok(famListA[0]);
    familyAId = famListA[0]!.id;

    const babyResA = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyAId}/babies`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: "Baby Att A",
        birthDate: "2025-06-01",
        gender: "girl",
      },
    });
    assert.equal(babyResA.statusCode, 201);
    babyAId = babyResA.json<{ data: { id: string } }>().data.id;

    const regResB = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userB,
        password: "ValidPassword123!",
        displayName: "Caregiver Att B",
      },
    });
    assert.equal(regResB.statusCode, 201);
    tokenB = regResB.json<{ data: { accessToken: string } }>().data.accessToken;

    const famResB = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const famListB = famResB.json<{ data: Array<{ id: string }> }>().data;
    assert.ok(famListB[0]);
    familyBId = famListB[0]!.id;
  });

  let attachmentId = "";
  const testPayload = Buffer.from("simulated medical report image content 12345");
  const testSha256 = crypto.createHash("sha256").update(testPayload).digest("hex");
  const testByteSize = testPayload.byteLength;

  await t.test("ATT-01: Initialize attachment upload capability", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        purpose: "medical_report",
        mimeType: "image/jpeg",
        byteSize: testByteSize,
        sha256: testSha256,
        ownerScope: {
          familyId: familyAId,
          babyId: babyAId,
        },
      },
    });

    assert.equal(res.statusCode, 201, `Failed: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(body.data.id);
    assert.ok(body.data.uploadUrl);
    assert.ok(body.data.objectKey);
    assert.equal(body.data.status, "pending");
    attachmentId = body.data.id;
  });

  await t.test("ATT-02: Complete attachment with matching metadata marks ready", async () => {
    // Register the simulated upload in mock driver
    const att = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    mockStorage.simulateUpload(att.objectKey, testPayload, "image/jpeg");

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${attachmentId}/complete`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        sha256: testSha256,
        byteSize: testByteSize,
      },
    });

    assert.equal(res.statusCode, 200, `Failed: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.data.success, true);

    const updated = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    assert.equal(updated.status, "ready");
  });

  await t.test("ATT-03: Authorized content is streamed through the API", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    assert.equal(res.statusCode, 200, res.payload);
    assert.equal(res.headers["content-type"], "image/jpeg");
    assert.equal(res.headers["cache-control"], "private, no-store");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.deepEqual(Buffer.from(res.payload), testPayload);

    const legacy = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}/download-url`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(legacy.statusCode, 404, "signed read URL endpoint must stay closed");
  });

  await t.test("ATT-04: Mismatched checksum triggers 400 and marks attachment failed", async () => {
    // Create a second attachment
    const resCreate = await app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        purpose: "avatar",
        mimeType: "image/png",
        byteSize: 1024,
        sha256: "a".repeat(64),
        ownerScope: { familyId: familyAId },
      },
    });
    assert.equal(resCreate.statusCode, 201);
    const secondId = JSON.parse(resCreate.body).data.id;

    // Complete with wrong sha256
    const resComplete = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${secondId}/complete`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        sha256: "b".repeat(64),
        byteSize: 1024,
      },
    });

    assert.equal(resComplete.statusCode, 400);
    const updated = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: secondId } });
    assert.equal(updated.status, "failed");
  });

  await t.test("ATT-05: Cannot renew upload URL for ready attachment", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}/upload-url`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.match(body.error.message, /Cannot renew/);
  });

  await t.test("ATT-06: Cross-tenant isolation prevents User B access", async () => {
    const resComplete = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${attachmentId}/complete`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        sha256: testSha256,
        byteSize: testByteSize,
      },
    });
    assert.equal(resComplete.statusCode, 403);

    const resContent = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resContent.statusCode, 403);

    const resDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resDelete.statusCode, 403);
  });

  await t.test("ATT-07: Delete attachment soft-deletes record", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    assert.equal(res.statusCode, 200);
    const deleted = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    assert.ok(deleted.deletedAt !== null);

    const resContent = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(resContent.statusCode, 404);
  });
});
