import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  if (
    path.dirname(parent) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(parent).startsWith("growdesk-integration-")
  ) {
    throw new Error("Integration manifest is outside its private run");
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw new Error("Unsafe manifest permissions");
  }
  return JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
}

test("SH-04G: Growth photo attachment scope and deletion references", async (t) => {
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
  const ctx = createDatabaseContext({ url });
  const storage = new MockStorageDriver();
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret: "integration-test-auth-secret-min-32-chars-long!",
    storageDriver: storage,
  });
  const userIds: string[] = [];
  const familyIds: string[] = [];

  t.after(async () => {
    try {
      if (familyIds.length > 0) {
        await ctx.prisma.family.deleteMany({ where: { id: { in: familyIds } } });
      }
      if (userIds.length > 0) {
        await ctx.prisma.user.deleteMany({ where: { id: { in: userIds } } });
      }
    } finally {
      await app.close();
      await ctx.close();
    }
  });

  for (const table of ["users", "families", "family_members", "babies", "baby_members", "attachments", "growth_measurements"]) {
    const schema = await ctx.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [table],
    );
    assert.equal(schema.rowCount, 1, `managed database is missing public.${table}`);
  }

  const stamp = Date.now();
  const register = async (suffix: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: `test_growth_attachment_${suffix}_${stamp}`,
        password: "ValidPassword123!",
        displayName: `test_growth_attachment_${suffix}`,
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const auth = response.json<{ data: { accessToken: string; user: { id: string } } }>().data;
    userIds.push(auth.user.id);
    return auth.accessToken;
  };

  const tokenA = await register("a");
  const tokenB = await register("b");
  const getFamily = async (token: string) => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.statusCode, 200, response.body);
    const familyId = response.json<{ data: Array<{ id: string }> }>().data[0]!.id;
    familyIds.push(familyId);
    return familyId;
  };
  const familyAId = await getFamily(tokenA);
  const familyBId = await getFamily(tokenB);

  const createBaby = async (token: string, familyId: string, name: string) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyId}/babies`,
      headers: { authorization: `Bearer ${token}` },
      payload: { name, birthDate: "2025-01-01", gender: "girl" },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ data: { id: string } }>().data.id;
  };
  const babyAId = await createBaby(tokenA, familyAId, "test_growth_attachment_baby_a");
  const babyA2Id = await createBaby(tokenA, familyAId, "test_growth_attachment_baby_a2");
  const babyBId = await createBaby(tokenB, familyBId, "test_growth_attachment_baby_b");

  const createAttachment = async (params: {
    token: string;
    familyId: string;
    babyId: string;
    purpose: "growth_photo" | "medical_report";
    mimeType: string;
    complete?: boolean;
  }) => {
    const payload = Buffer.from(`test-growth-attachment-${params.purpose}-${params.mimeType}`);
    const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { authorization: `Bearer ${params.token}` },
      payload: {
        purpose: params.purpose,
        mimeType: params.mimeType,
        byteSize: payload.byteLength,
        sha256,
        ownerScope: { familyId: params.familyId, babyId: params.babyId },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json<{ data: { id: string } }>().data.id;
    const attachment = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id } });
    if (params.complete !== false) {
      storage.simulateUpload(attachment.objectKey, payload, params.mimeType);
      const completed = await app.inject({
        method: "POST",
        url: `/api/v1/attachments/${id}/complete`,
        headers: { authorization: `Bearer ${params.token}` },
        payload: { sha256, byteSize: payload.byteLength },
      });
      assert.equal(completed.statusCode, 200, completed.body);
    }
    return id;
  };

  const createGrowth = async (token: string, babyId: string, attachmentId: string | null, key: string) =>
    app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyId}/growth-measurements`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": key,
      },
      payload: {
        measurementDate: "2025-06-01",
        weightKg: "7.50",
        attachmentId,
      },
    });

  await t.test("same baby can create/read/update a growth photo reference", async () => {
    const firstAttachmentId = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyAId,
      purpose: "growth_photo",
      mimeType: "image/png",
    });
    const created = await createGrowth(tokenA, babyAId, firstAttachmentId, "growth-photo-scope-create");
    assert.equal(created.statusCode, 201, created.body);
    const createdData = created.json<{ data: { id: string; attachmentId: string | null; version: string } }>().data;
    assert.equal(createdData.attachmentId, firstAttachmentId);
    assert.equal(createdData.version, "1");

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${createdData.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(read.statusCode, 200, read.body);
    assert.equal(read.json<{ data: { attachmentId: string | null } }>().data.attachmentId, firstAttachmentId);

    const secondAttachmentId = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyAId,
      purpose: "growth_photo",
      mimeType: "image/jpeg",
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${createdData.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { baseVersion: "1", attachmentId: secondAttachmentId },
    });
    assert.equal(updated.statusCode, 200, updated.body);
    const updatedData = updated.json<{ data: { attachmentId: string | null; version: string } }>().data;
    assert.equal(updatedData.attachmentId, secondAttachmentId);
    assert.equal(updatedData.version, "2");

    const invalidUpdateAttachmentId = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyAId,
      purpose: "medical_report",
      mimeType: "image/png",
    });
    const invalidUpdate = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${createdData.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { baseVersion: "2", attachmentId: invalidUpdateAttachmentId },
    });
    assert.equal(invalidUpdate.statusCode, 400, invalidUpdate.body);
  });

  await t.test("cross scope and invalid attachment states are rejected", async () => {
    const babyAttachment = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyA2Id,
      purpose: "growth_photo",
      mimeType: "image/png",
    });
    const crossBaby = await createGrowth(tokenA, babyAId, babyAttachment, "growth-photo-cross-baby");
    assert.equal(crossBaby.statusCode, 403, crossBaby.body);

    const familyAttachment = await createAttachment({
      token: tokenB,
      familyId: familyBId,
      babyId: babyBId,
      purpose: "growth_photo",
      mimeType: "image/png",
    });
    const crossFamily = await createGrowth(tokenA, babyAId, familyAttachment, "growth-photo-cross-family");
    assert.equal(crossFamily.statusCode, 403, crossFamily.body);

    const wrongPurpose = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyAId,
      purpose: "medical_report",
      mimeType: "image/png",
    });
    const wrongPurposeResult = await createGrowth(tokenA, babyAId, wrongPurpose, "growth-photo-wrong-purpose");
    assert.equal(wrongPurposeResult.statusCode, 400, wrongPurposeResult.body);

    const wrongMime = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyAId,
      purpose: "growth_photo",
      mimeType: "application/pdf",
    });
    const wrongMimeResult = await createGrowth(tokenA, babyAId, wrongMime, "growth-photo-wrong-mime");
    assert.equal(wrongMimeResult.statusCode, 400, wrongMimeResult.body);

    const pending = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyAId,
      purpose: "growth_photo",
      mimeType: "image/png",
      complete: false,
    });
    const pendingResult = await createGrowth(tokenA, babyAId, pending, "growth-photo-pending");
    assert.equal(pendingResult.statusCode, 400, pendingResult.body);

    const deleted = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyAId,
      purpose: "growth_photo",
      mimeType: "image/png",
    });
    const deletedResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${deleted}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(deletedResponse.statusCode, 200, deletedResponse.body);
    const deletedResult = await createGrowth(tokenA, babyAId, deleted, "growth-photo-deleted");
    assert.equal(deletedResult.statusCode, 400, deletedResult.body);
  });

  await t.test("growth references block attachment delete until detached", async () => {
    const attachmentId = await createAttachment({
      token: tokenA,
      familyId: familyAId,
      babyId: babyAId,
      purpose: "growth_photo",
      mimeType: "image/png",
    });
    const created = await createGrowth(tokenA, babyAId, attachmentId, "growth-photo-delete-reference");
    assert.equal(created.statusCode, 201, created.body);
    const createdData = created.json<{ data: { id: string; version: string } }>().data;

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(blocked.statusCode, 409, blocked.body);

    const detached = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${createdData.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { baseVersion: createdData.version, attachmentId: null },
    });
    assert.equal(detached.statusCode, 200, detached.body);

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(removed.statusCode, 200, removed.body);
  });
});
