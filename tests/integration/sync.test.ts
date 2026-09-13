import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import { WorkerEngine } from "../../apps/worker/src/worker-engine.js";
import { encodeSyncCursor } from "../../packages/database/src/sync-cursor.js";

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
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error("Unsafe manifest permissions");
  return JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
}

test("SH-09: Local-First Sync Protocol & State Machine Suite", async (t) => {
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
    identity
  );

  const jwtSecret = "integration-test-auth-secret-min-32-chars-long!";
  const ctx = createDatabaseContext({ url });
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret,
  });

  const worker = new WorkerEngine({
    pool: ctx.pool,
    workerId: "test-sync-worker",
    leaseSeconds: 5,
  });

  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  // Ensure migrations are applied
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
    "prisma/migrations/202609130011_tasks_and_ai/migration.sql",
  ];

  for (const m of migrations) {
    const sql = fs.readFileSync(m, "utf8");
    try {
      await ctx.pool.query(sql);
    } catch {
      // Tables may already exist
    }
  }

  // Setup identities
  const user1Name = `test_sync_u1_${Date.now()}`;
  const user2Name = `test_sync_u2_${Date.now()}`;
  let token1 = "";
  let user1Id = "";
  let token2 = "";
  let user2Id = "";
  let familyId = "";
  let babyId1 = "";
  let babyId2 = "";

  const feedingCmdId = crypto.randomUUID();
  const feedingEntityId = crypto.randomUUID();
  const diaperCmdId = crypto.randomUUID();
  const diaperEntityId = crypto.randomUUID();
  const sleepCmdId = crypto.randomUUID();
  const sleepEntityId = crypto.randomUUID();
  const foodCmdId = crypto.randomUUID();
  const foodEntityId = crypto.randomUUID();
  const supplementCmdId = crypto.randomUUID();
  const supplementEntityId = crypto.randomUUID();
  const growthCmdId = crypto.randomUUID();
  const growthEntityId = crypto.randomUUID();
  const fixedOccurredAt = new Date().toISOString();

  let recordedFeedingCursor = "";

  await t.test("00. Setup: Register users, create family and baby memberships", async () => {
    // User 1
    const regRes1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: user1Name,
        password: "ValidPassword123!",
        displayName: "Sync User 1",
      },
    });
    assert.strictEqual(regRes1.statusCode, 201);
    const regData1 = regRes1.json<{ data: { accessToken: string; user: { id: string } } }>();
    token1 = regData1.data.accessToken;
    user1Id = regData1.data.user.id;

    // User 2
    const regRes2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: user2Name,
        password: "ValidPassword123!",
        displayName: "Sync User 2",
      },
    });
    assert.strictEqual(regRes2.statusCode, 201);
    const regData2 = regRes2.json<{ data: { accessToken: string; user: { id: string } } }>();
    token2 = regData2.data.accessToken;
    user2Id = regData2.data.user.id;

    // Get default Family for User 1
    const famRes = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(famRes.statusCode, 200);
    const famList = famRes.json<{ data: Array<{ id: string }> }>().data;
    assert.ok(famList[0]);
    familyId = famList[0].id;

    // Add User 2 to Family 1
    await ctx.prisma.familyMember.create({
      data: {
        id: crypto.randomUUID(),
        familyId,
        userId: user2Id,
        role: "member",
        status: "active",
      },
    });

    // Create Baby 1
    const babyRes1 = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyId}/babies`,
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        name: "Sync Baby One",
        birthDate: "2025-01-01",
        gender: "girl",
      },
    });
    assert.strictEqual(babyRes1.statusCode, 201);
    babyId1 = babyRes1.json<{ data: { id: string } }>().data.id;

    // Add User 2 as BabyMember for Baby 1
    await ctx.prisma.babyMember.create({
      data: {
        id: crypto.randomUUID(),
        familyId,
        babyId: babyId1,
        userId: user2Id,
        role: "member",
        status: "active",
      },
    });

    // Create Baby 2 (User 2 will NOT have access to Baby 2)
    const babyRes2 = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyId}/babies`,
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        name: "Sync Baby Two",
        birthDate: "2025-02-01",
        gender: "boy",
      },
    });
    assert.strictEqual(babyRes2.statusCode, 201);
    babyId2 = babyRes2.json<{ data: { id: string } }>().data.id;
  });

  await t.test("SYNC-01: Batch command execution creates multi-domain records and advances cursor", async () => {
    const batchPayload = {
      commands: [
        {
          commandId: feedingCmdId,
          familyId,
          babyId: babyId1,
          entityType: "feeding",
          entityId: feedingEntityId,
          operation: "create",
          baseVersion: null,
          payload: {
            feedingType: "formula",
            amountMl: "120",
            spitUp: false,
            occurredAt: fixedOccurredAt,
          },
          clientCreatedAt: fixedOccurredAt,
        },
        {
          commandId: diaperCmdId,
          familyId,
          babyId: babyId1,
          entityType: "diaper",
          entityId: diaperEntityId,
          operation: "create",
          baseVersion: null,
          payload: {
            diaperType: "wet",
            occurredAt: new Date().toISOString(),
          },
          clientCreatedAt: new Date().toISOString(),
        },
        {
          commandId: sleepCmdId,
          familyId,
          babyId: babyId1,
          entityType: "sleep",
          entityId: sleepEntityId,
          operation: "create",
          baseVersion: null,
          payload: {
            startTime: new Date(Date.now() - 3600000).toISOString(),
            endTime: new Date().toISOString(),
          },
          clientCreatedAt: new Date().toISOString(),
        },
        {
          commandId: foodCmdId,
          familyId,
          babyId: babyId1,
          entityType: "foodLog",
          entityId: foodEntityId,
          operation: "create",
          baseVersion: null,
          payload: {
            foodName: "Apple Puree",
            mealType: "lunch",
            occurredAt: new Date().toISOString(),
          },
          clientCreatedAt: new Date().toISOString(),
        },
        {
          commandId: supplementCmdId,
          familyId,
          babyId: babyId1,
          entityType: "supplementRecord",
          entityId: supplementEntityId,
          operation: "create",
          baseVersion: null,
          payload: {
            supplementName: "Vitamin D",
            dosage: "400 IU",
            occurredAt: new Date().toISOString(),
          },
          clientCreatedAt: new Date().toISOString(),
        },
        {
          commandId: growthCmdId,
          familyId,
          babyId: babyId1,
          entityType: "growthMeasurement",
          entityId: growthEntityId,
          operation: "create",
          baseVersion: null,
          payload: {
            weightKg: "7.5",
            heightCm: "68.0",
            measuredAt: new Date().toISOString(),
          },
          clientCreatedAt: new Date().toISOString(),
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync/commands",
      headers: { authorization: `Bearer ${token1}` },
      payload: batchPayload,
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json<{ data: { results: Array<{ status: string; version: string; familyCursor: string }> } }>();
    assert.strictEqual(body.data.results.length, 6);

    for (const r of body.data.results) {
      assert.strictEqual(r.status, "applied");
      assert.strictEqual(r.version, "1");
      assert.ok(BigInt(r.familyCursor) > 0n);
    }

    const firstResult = body.data.results[0];
    assert.ok(firstResult);
    recordedFeedingCursor = firstResult.familyCursor;

    // Verify records exist in database
    const feeding = await ctx.prisma.feedingRecord.findUnique({
      where: { id: feedingEntityId },
    });
    assert.ok(feeding);
    assert.strictEqual(feeding.feedingType, "formula");
    assert.strictEqual(feeding.version, 1);

    // Verify family_changes has rows
    const changes = await ctx.prisma.familyChange.findMany({
      where: { familyId },
      orderBy: { cursor: "asc" },
    });
    assert.strictEqual(changes.length, 6);
  });

  await t.test("SYNC-02: Command idempotency replay returns cached cursor and version", async () => {
    const replayPayload = {
      commands: [
        {
          commandId: feedingCmdId,
          familyId,
          babyId: babyId1,
          entityType: "feeding",
          entityId: feedingEntityId,
          operation: "create",
          baseVersion: null,
          payload: {
            feedingType: "formula",
            amountMl: "120",
            spitUp: false,
            occurredAt: fixedOccurredAt,
          },
          clientCreatedAt: fixedOccurredAt,
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync/commands",
      headers: { authorization: `Bearer ${token1}` },
      payload: replayPayload,
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json<{ data: { results: Array<{ status: string; commandId: string; version: string; familyCursor: string }> } }>();
    assert.strictEqual(body.data.results.length, 1);
    const item = body.data.results[0];
    assert.ok(item);
    assert.strictEqual(item.status, "replayed");
    assert.strictEqual(item.commandId, feedingCmdId);
    assert.strictEqual(item.version, "1");
    assert.strictEqual(item.familyCursor, recordedFeedingCursor);

    // Verify changes count did NOT increase
    const changesCount = await ctx.prisma.familyChange.count({
      where: { familyId },
    });
    assert.strictEqual(changesCount, 6);
  });

  await t.test("SYNC-03: Intra-batch duplicate entityId is rejected with 422 BATCH_DEPENDENCY_UNRESOLVED", async () => {
    const dupEntityId = crypto.randomUUID();
    const badBatch = {
      commands: [
        {
          commandId: crypto.randomUUID(),
          familyId,
          babyId: babyId1,
          entityType: "feeding",
          entityId: dupEntityId,
          operation: "create",
          baseVersion: null,
          payload: { feedingType: "breast", occurredAt: new Date().toISOString() },
          clientCreatedAt: new Date().toISOString(),
        },
        {
          commandId: crypto.randomUUID(),
          familyId,
          babyId: babyId1,
          entityType: "feeding",
          entityId: dupEntityId,
          operation: "update",
          baseVersion: "1",
          payload: { amountMl: "150" },
          clientCreatedAt: new Date().toISOString(),
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync/commands",
      headers: { authorization: `Bearer ${token1}` },
      payload: badBatch,
    });

    assert.strictEqual(res.statusCode, 422);
    const body = res.json<{ error: { code: string } }>();
    assert.strictEqual(body.error.code, "BATCH_DEPENDENCY_UNRESOLVED");
  });

  await t.test("SYNC-04: Optimistic concurrency conflict returns status: conflict with currentVersion", async () => {
    const conflictBatch = {
      commands: [
        {
          commandId: crypto.randomUUID(),
          familyId,
          babyId: babyId1,
          entityType: "feeding",
          entityId: feedingEntityId,
          operation: "update",
          baseVersion: "999", // Current version is 1
          payload: { amountMl: "180" },
          clientCreatedAt: new Date().toISOString(),
        },
      ],
    };

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sync/commands",
      headers: { authorization: `Bearer ${token1}` },
      payload: conflictBatch,
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json<{ data: { results: Array<{ status: string; conflict: { currentVersion: string }; version: string | null }> } }>();
    assert.strictEqual(body.data.results.length, 1);
    const item = body.data.results[0];
    assert.ok(item);
    assert.strictEqual(item.status, "conflict");
    assert.strictEqual(item.conflict.currentVersion, "1");
    assert.strictEqual(item.version, null);
  });

  await t.test("SYNC-05: Family incremental change feed pagination and mode transition", async () => {
    // Page 1: limit 2
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?limit=2`,
      headers: { authorization: `Bearer ${token1}` },
    });

    assert.strictEqual(page1Res.statusCode, 200);
    const page1 = page1Res.json<{ changes: unknown[]; hasMore: boolean; nextCursor: string }>();
    assert.strictEqual(page1.changes.length, 2);
    assert.strictEqual(page1.hasMore, true);
    assert.ok(page1.nextCursor);

    // Page 2: fetch next with limit 2
    const page2Res = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?cursor=${encodeURIComponent(page1.nextCursor)}&limit=2`,
      headers: { authorization: `Bearer ${token1}` },
    });

    assert.strictEqual(page2Res.statusCode, 200);
    const page2 = page2Res.json<{ changes: unknown[]; hasMore: boolean; nextCursor: string }>();
    assert.strictEqual(page2.changes.length, 2);
    assert.strictEqual(page2.hasMore, true);

    // Page 3: fetch remaining with limit 10
    const page3Res = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?cursor=${encodeURIComponent(page2.nextCursor)}&limit=10`,
      headers: { authorization: `Bearer ${token1}` },
    });

    assert.strictEqual(page3Res.statusCode, 200);
    const page3 = page3Res.json<{ changes: unknown[]; hasMore: boolean; nextCursor: string }>();
    assert.strictEqual(page3.changes.length, 2);
    assert.strictEqual(page3.hasMore, false); // All 6 changes consumed

    // Tail polling: verify empty when no new changes
    const tailRes1 = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?cursor=${encodeURIComponent(page3.nextCursor)}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(tailRes1.statusCode, 200);
    const tail1 = tailRes1.json<{ changes: unknown[]; hasMore: boolean; nextCursor: string }>();
    assert.strictEqual(tail1.changes.length, 0);
    assert.strictEqual(tail1.hasMore, false);

    // Now write a 7th change
    const newCmdId = crypto.randomUUID();
    const newEntityId = crypto.randomUUID();
    await app.inject({
      method: "POST",
      url: "/api/v1/sync/commands",
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        commands: [
          {
            commandId: newCmdId,
            familyId,
            babyId: babyId1,
            entityType: "diaper",
            entityId: newEntityId,
            operation: "create",
            baseVersion: null,
            payload: { diaperType: "dry", occurredAt: new Date().toISOString() },
            clientCreatedAt: new Date().toISOString(),
          },
        ],
      },
    });

    // Poll with tail cursor: new change should be discovered
    const tailRes2 = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?cursor=${encodeURIComponent(tail1.nextCursor)}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(tailRes2.statusCode, 200);
    const tail2 = tailRes2.json<{ changes: Array<{ entityId: string }> }>();
    assert.strictEqual(tail2.changes.length, 1);
    const firstTailChange = tail2.changes[0];
    assert.ok(firstTailChange);
    assert.strictEqual(firstTailChange.entityId, newEntityId);
  });

  await t.test("SYNC-06: Epoch mismatch returns 410 SYNC_RESET_REQUIRED", async () => {
    const forgedCursor = encodeSyncCursor(
      {
        scope: "family",
        scopeId: familyId,
        epoch: "00000000-0000-0000-0000-000000000000", // Outdated epoch
        position: "1",
        highWater: "10",
        mode: "page",
        schemaVersion: 1,
      },
      process.env.SESSION_SECRET || "growdesk-default-sync-cursor-hmac-secret-32ch"
    );

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?cursor=${encodeURIComponent(forgedCursor)}`,
      headers: { authorization: `Bearer ${token1}` },
    });

    assert.strictEqual(res.statusCode, 410);
    const body = res.json<{ error: { code: string } }>();
    assert.strictEqual(body.error.code, "SYNC_RESET_REQUIRED");
  });

  await t.test("SYNC-07: Cursor tampering and cross-family cursor throws 400 INVALID_SYNC_CURSOR", async () => {
    // 1. Tampered signature with valid payload structure
    const validPayload = Buffer.from(
      JSON.stringify({
        scope: "family",
        scopeId: familyId,
        epoch: "test-epoch",
        position: "1",
        highWater: "5",
        mode: "page",
        schemaVersion: 1,
      })
    ).toString("base64url");
    const tamperedCursor = `${validPayload}.invalid_signature`;

    const res1 = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?cursor=${encodeURIComponent(tamperedCursor)}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(res1.statusCode, 400);
    assert.strictEqual(res1.json<{ error: { code: string } }>().error.code, "INVALID_SYNC_CURSOR");

    // 2. Cursor for Family 1 sent to Family 2
    const otherFamRes = await app.inject({
      method: "POST",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${token1}` },
      payload: { name: "Other Family" },
    });
    const otherFamilyId = otherFamRes.json<{ data: { id: string } }>().data.id;

    const validFam1Cursor = encodeSyncCursor(
      {
        scope: "family",
        scopeId: familyId,
        epoch: "test-epoch",
        position: "1",
        highWater: "5",
        mode: "page",
        schemaVersion: 1,
      },
      process.env.SESSION_SECRET || "growdesk-default-sync-cursor-hmac-secret-32ch"
    );

    const res2 = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${otherFamilyId}/changes?cursor=${encodeURIComponent(validFam1Cursor)}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(res2.statusCode, 400);
    assert.strictEqual(res2.json<{ error: { code: string } }>().error.code, "INVALID_SYNC_CURSOR");
  });

  await t.test("SYNC-08: BabyMember revocation filters out baby changes from feed", async () => {
    // Write a record for Baby 2 (which User 2 cannot access)
    const baby2EntityId = crypto.randomUUID();
    await app.inject({
      method: "POST",
      url: "/api/v1/sync/commands",
      headers: { authorization: `Bearer ${token1}` },
      payload: {
        commands: [
          {
            commandId: crypto.randomUUID(),
            familyId,
            babyId: babyId2,
            entityType: "feeding",
            entityId: baby2EntityId,
            operation: "create",
            baseVersion: null,
            payload: { feedingType: "breast", occurredAt: new Date().toISOString() },
            clientCreatedAt: new Date().toISOString(),
          },
        ],
      },
    });

    // User 1 queries family changes: sees Baby 2 change
    const u1Res = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?limit=100`,
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(u1Res.statusCode, 200);
    const u1Changes = u1Res.json<{ changes: Array<{ entityId: string }> }>().changes;
    assert.ok(u1Changes.some((c) => c.entityId === baby2EntityId));

    // User 2 queries family changes: MUST NOT see Baby 2 change!
    const u2Res = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/changes?limit=100`,
      headers: { authorization: `Bearer ${token2}` },
    });
    assert.strictEqual(u2Res.statusCode, 200);
    const u2Changes = u2Res.json<{ changes: Array<{ entityId: string }> }>().changes;
    assert.ok(!u2Changes.some((c) => c.entityId === baby2EntityId));
  });

  await t.test("SYNC-09: User changes feed pagination", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/sync/me/changes",
      headers: { authorization: `Bearer ${token1}` },
    });

    assert.strictEqual(res.statusCode, 200);
    const body = res.json<{ scope: string; epoch: string; nextCursor: string; hasMore: boolean }>();
    assert.strictEqual(body.scope, "user");
    assert.ok(body.epoch);
    assert.ok(body.nextCursor);
    assert.strictEqual(typeof body.hasMore, "boolean");
  });

  await t.test("SYNC-10: Bootstrap snapshot queueing and background processing", async () => {
    // 1. Request snapshot (202 Accepted)
    const snapReqRes = await app.inject({
      method: "POST",
      url: `/api/v1/sync/families/${familyId}/snapshots`,
      headers: { authorization: `Bearer ${token1}` },
    });

    assert.strictEqual(snapReqRes.statusCode, 202);
    const snapReqBody = snapReqRes.json<{ data: { snapshotId: string; status: string } }>();
    const snapshotId = snapReqBody.data.snapshotId;
    assert.ok(snapshotId);
    assert.strictEqual(snapReqBody.data.status, "queued");

    // 2. Verify snapshot status is queued
    const statusRes1 = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/snapshots/${snapshotId}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(statusRes1.statusCode, 200);
    assert.strictEqual(statusRes1.json<{ data: { status: string } }>().data.status, "queued");

    // 3. Find task execution in database and process with worker
    const task = await ctx.prisma.taskExecution.findFirst({
      where: {
        kind: "sync_snapshot_family",
        ownerScope: familyId,
        status: "queued",
      },
      orderBy: { createdAt: "desc" },
    });
    assert.ok(task);

    const workerResult = await worker.processTask(task.id, { snapshotId });
    assert.strictEqual(workerResult.status, "succeeded");

    // 4. Verify snapshot status is now ready
    const statusRes2 = await app.inject({
      method: "GET",
      url: `/api/v1/sync/families/${familyId}/snapshots/${snapshotId}`,
      headers: { authorization: `Bearer ${token1}` },
    });
    assert.strictEqual(statusRes2.statusCode, 200);
    const snapData = statusRes2.json<{ data: { status: string; pageCount: number } }>().data;
    assert.strictEqual(snapData.status, "ready");
    assert.strictEqual(snapData.pageCount, 1);
  });
});
