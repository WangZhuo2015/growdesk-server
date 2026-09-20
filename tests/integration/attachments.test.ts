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

class FailOnceDeleteStorageDriver extends MockStorageDriver {
  deleteAttempts = 0;
  failNextDelete = false;
  private blockedDeleteStarted: Promise<void> | undefined;
  private blockedDeleteRelease: Promise<void> | undefined;
  private resolveBlockedDeleteStarted: (() => void) | undefined;
  private resolveBlockedDeleteRelease: (() => void) | undefined;

  armBlockedDelete() {
    this.blockedDeleteStarted = new Promise<void>((resolve) => {
      this.resolveBlockedDeleteStarted = resolve;
    });
    this.blockedDeleteRelease = new Promise<void>((resolve) => {
      this.resolveBlockedDeleteRelease = resolve;
    });
  }

  async waitForBlockedDelete() {
    assert.ok(this.blockedDeleteStarted, "delete gate was not armed");
    await this.blockedDeleteStarted;
  }

  releaseBlockedDelete() {
    assert.ok(this.resolveBlockedDeleteRelease, "delete gate was not armed");
    this.resolveBlockedDeleteRelease();
  }

  override async deleteObject(objectKey: string): Promise<void> {
    this.deleteAttempts += 1;
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error("injected object-store delete failure");
    }
    if (this.blockedDeleteRelease) {
      const release = this.blockedDeleteRelease;
      this.resolveBlockedDeleteStarted?.();
      await release;
      this.blockedDeleteStarted = undefined;
      this.blockedDeleteRelease = undefined;
      this.resolveBlockedDeleteStarted = undefined;
      this.resolveBlockedDeleteRelease = undefined;
    }
    await super.deleteObject(objectKey);
  }
}

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
  const mockStorage = new FailOnceDeleteStorageDriver();
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret,
    storageDriver: mockStorage,
  });

  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  // The managed runner owns migrations. Fail clearly if this suite was started
  // against a database that does not contain the required schema.
  for (const table of [
    "users",
    "families",
    "family_members",
    "babies",
    "baby_members",
    "attachments",
    "medical_report_attachments",
  ]) {
    const schema = await ctx.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1",
      [table],
    );
    assert.equal(schema.rowCount, 1, `managed database is missing public.${table}`);
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
        displayName: "test_caregiver_att_a",
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
        name: "test_baby_att_a",
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
        displayName: "test_caregiver_att_b",
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

    const deleteAttemptsBeforeUnauthorizedRequest = mockStorage.deleteAttempts;
    const resDelete = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resDelete.statusCode, 403);
    assert.equal(
      mockStorage.deleteAttempts,
      deleteAttemptsBeforeUnauthorizedRequest,
      "cross-tenant rejection must happen before touching object storage",
    );
  });

  await t.test("ATT-07: Avatar references block deletion until detached", async () => {
    const avatarPayload = Buffer.from("simulated avatar image content");
    const avatarSha256 = crypto.createHash("sha256").update(avatarPayload).digest("hex");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        purpose: "avatar",
        mimeType: "image/png",
        byteSize: avatarPayload.byteLength,
        sha256: avatarSha256,
        ownerScope: { familyId: familyAId, babyId: babyAId },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const avatarAttachmentId = created.json<{ data: { id: string } }>().data.id;
    const avatarAttachment = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: avatarAttachmentId } });
    mockStorage.simulateUpload(avatarAttachment.objectKey, avatarPayload, "image/png");

    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${avatarAttachmentId}/complete`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sha256: avatarSha256, byteSize: avatarPayload.byteLength },
    });
    assert.equal(completed.statusCode, 200, completed.body);

    const attachAvatar = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { avatarUrl: `/api/attachments/${avatarAttachmentId}` },
    });
    assert.equal(attachAvatar.statusCode, 200, attachAvatar.body);

    const deleteAttemptsBeforeReference = mockStorage.deleteAttempts;
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${avatarAttachmentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(
      mockStorage.deleteAttempts,
      deleteAttemptsBeforeReference,
      "a referenced attachment must be rejected before object deletion",
    );
    const referenced = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: avatarAttachmentId } });
    assert.equal(referenced.deletedAt, null);

    const detachAvatar = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { avatarUrl: null },
    });
    assert.equal(detachAvatar.statusCode, 200, detachAvatar.body);
    assert.equal((await ctx.prisma.baby.findUniqueOrThrow({ where: { id: babyAId } })).avatarUrl, null,
      "JSON null must detach the avatar without coercion to an empty string");

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${avatarAttachmentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(removed.statusCode, 200, removed.body);
  });

  await t.test("ATT-08: Avatar assignment and deletion serialize on the attachment row", async () => {
    const racePayload = Buffer.from("serialized avatar image content");
    const raceSha256 = crypto.createHash("sha256").update(racePayload).digest("hex");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        purpose: "avatar",
        mimeType: "image/png",
        byteSize: racePayload.byteLength,
        sha256: raceSha256,
        ownerScope: { familyId: familyAId, babyId: babyAId },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const raceAttachmentId = created.json<{ data: { id: string } }>().data.id;
    const raceAttachment = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: raceAttachmentId } });
    mockStorage.simulateUpload(raceAttachment.objectKey, racePayload, "image/png");
    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${raceAttachmentId}/complete`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sha256: raceSha256, byteSize: racePayload.byteLength },
    });
    assert.equal(completed.statusCode, 200, completed.body);

    mockStorage.armBlockedDelete();
    const deletePromise = app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${raceAttachmentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    await mockStorage.waitForBlockedDelete();

    const attachPromise = app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { avatarUrl: `/api/attachments/${raceAttachmentId}` },
    });
    let observedRowLockWait = false;
    try {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const waiting = await ctx.pool.query(`SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND usename = current_user
            AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
            AND query LIKE '%FROM public.attachments%FOR UPDATE%'
            AND cardinality(pg_blocking_pids(pid)) > 0`);
        if (waiting.rowCount) { observedRowLockWait = true; break; }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    } finally { mockStorage.releaseBlockedDelete(); }

    const [deleted, attached] = await Promise.all([deletePromise, attachPromise]);
    assert.ok(observedRowLockWait, "avatar binding must actually wait on the PostgreSQL attachment lock");
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.equal(attached.statusCode, 403, attached.body);
    const raceRow = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: raceAttachmentId } });
    assert.ok(raceRow.deletedAt !== null);
    const babyAfterRace = await ctx.prisma.baby.findUniqueOrThrow({ where: { id: babyAId } });
    assert.equal(babyAfterRace.avatarUrl, null, "failed binding preserves the earlier explicit detach value");
  });

  await t.test("ATT-09: AI message image references block deletion until the message is removed", async () => {
    const imagePayload = Buffer.from("\x89PNG\r\n\x1a\nprivate ai input image");
    const imageSha256 = crypto.createHash("sha256").update(imagePayload).digest("hex");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/attachments",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        purpose: "ai_input",
        mimeType: "image/png",
        byteSize: imagePayload.byteLength,
        sha256: imageSha256,
        ownerScope: { familyId: familyAId, babyId: babyAId },
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const aiAttachmentId = created.json<{ data: { id: string } }>().data.id;
    const attachment = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: aiAttachmentId } });
    mockStorage.simulateUpload(attachment.objectKey, imagePayload, "image/png");
    const completed = await app.inject({
      method: "POST",
      url: `/api/v1/attachments/${aiAttachmentId}/complete`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { sha256: imageSha256, byteSize: imagePayload.byteLength },
    });
    assert.equal(completed.statusCode, 200, completed.body);

    const owner = await ctx.prisma.user.findUniqueOrThrow({ where: { username: userA } });
    const sessionId = `test_ai_attachment_session_${stamp}`;
    const messageId = `test_ai_attachment_message_${stamp}`;
    await ctx.prisma.aiSession.create({ data: { id: sessionId, userId: owner.id, babyId: babyAId, title: "test attachment reference" } });
    await ctx.prisma.aiChatMessage.create({ data: { id: messageId, sessionId, role: "user", content: "test image", image: `/api/attachments/${aiAttachmentId}` } });

    const deleteAttemptsBeforeReference = mockStorage.deleteAttempts;
    const blocked = await app.inject({ method: "DELETE", url: `/api/v1/attachments/${aiAttachmentId}`, headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(blocked.statusCode, 409, blocked.body);
    assert.equal(mockStorage.deleteAttempts, deleteAttemptsBeforeReference);

    await ctx.prisma.aiChatMessage.delete({ where: { id: messageId } });
    await ctx.prisma.aiSession.delete({ where: { id: sessionId } });
    const removed = await app.inject({ method: "DELETE", url: `/api/v1/attachments/${aiAttachmentId}`, headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(removed.statusCode, 200, removed.body);
  });

  await t.test("ATT-10: Delete failure remains retryable and success soft-deletes record", async () => {
    const deleteAttemptsBeforeFailure = mockStorage.deleteAttempts;
    mockStorage.failNextDelete = true;
    const failed = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    assert.equal(failed.statusCode, 503, failed.body);
    assert.equal(mockStorage.deleteAttempts, deleteAttemptsBeforeFailure + 1);
    const retryable = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: attachmentId } });
    assert.equal(retryable.deletedAt, null, "failed object deletion must not hide the attachment");

    const stillReadable = await app.inject({
      method: "GET",
      url: `/api/v1/attachments/${attachmentId}/content`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(stillReadable.statusCode, 200, stillReadable.payload);
    assert.deepEqual(Buffer.from(stillReadable.payload), testPayload);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/attachments/${attachmentId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(mockStorage.deleteAttempts, deleteAttemptsBeforeFailure + 2, "retry must call object storage again");
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
