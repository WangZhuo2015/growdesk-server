import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";

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

test("SH-04S: Sleep Record Pipeline suite", async (t) => {
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
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret,
  });

  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  // Ensure all migrations up to 202609120005_care_sleep are applied to test database
  const identitySql = fs.readFileSync("prisma/migrations/202609120001_identity/migration.sql", "utf8");
  const { rows: idRows } = await ctx.pool.query("SELECT to_regclass('public.users') as exists");
  if (!idRows[0]?.exists) {
    await ctx.pool.query(identitySql);
  }

  const foundationSql = fs.readFileSync("prisma/migrations/202609120002_foundation/migration.sql", "utf8");
  const { rows: fRows } = await ctx.pool.query("SELECT to_regclass('public.device_sessions') as exists");
  if (!fRows[0]?.exists) {
    await ctx.pool.query(foundationSql);
  }

  const feedingSql = fs.readFileSync("prisma/migrations/202609120003_care_feeding/migration.sql", "utf8");
  const { rows: feedRows } = await ctx.pool.query("SELECT to_regclass('public.formula_products') as exists");
  if (!feedRows[0]?.exists) {
    await ctx.pool.query(feedingSql);
  }

  const diaperSql = fs.readFileSync("prisma/migrations/202609120004_care_diaper/migration.sql", "utf8");
  const { rows: diaperRows } = await ctx.pool.query("SELECT to_regclass('public.diaper_records') as exists");
  if (!diaperRows[0]?.exists) {
    await ctx.pool.query(diaperSql);
  }

  const sleepSql = fs.readFileSync("prisma/migrations/202609120005_care_sleep/migration.sql", "utf8");
  const { rows: checkRows } = await ctx.pool.query("SELECT to_regclass('public.sleep_records') as exists");
  if (!checkRows[0]?.exists) {
    await ctx.pool.query(sleepSql);
  }

  // Identities
  const userAName = `test_sleep_a_${Date.now()}`;
  const userBName = `test_sleep_b_${Date.now()}`;
  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";
  let babyBId = "";

  let ongoingSleepId = "";
  const fixedIdempotencyKey = `sleep-idemp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Setup: Register User A (Family A, Baby A)
  await t.test("Setup: Register User A and create Baby A", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userAName,
        password: "Password123!",
        displayName: "Sleep User A",
      },
    });
    assert.equal(regRes.statusCode, 201);
    tokenA = regRes.json<{ data: { accessToken: string } }>().data.accessToken;

    const famRes = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const famListA = famRes.json<{ data: Array<{ id: string }> }>().data;
    assert.ok(famListA[0]);
    familyAId = famListA[0].id;

    const babyRes = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyAId}/babies`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: "test_sleep_baby_a",
        birthDate: "2026-01-01",
        gender: "girl",
      },
    });
    assert.equal(babyRes.statusCode, 201, `Create baby A failed: ${babyRes.payload}`);
    babyAId = babyRes.json<{ data: { id: string } }>().data.id;
  });

  // Setup: Register User B (Family B, Baby B)
  await t.test("Setup: Register User B and create Baby B", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userBName,
        password: "Password123!",
        displayName: "Sleep User B",
      },
    });
    assert.equal(regRes.statusCode, 201);
    tokenB = regRes.json<{ data: { accessToken: string } }>().data.accessToken;

    const famRes = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const famListB = famRes.json<{ data: Array<{ id: string }> }>().data;
    assert.ok(famListB[0]);
    familyBId = famListB[0].id;

    const babyRes = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyBId}/babies`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        name: "test_sleep_baby_b",
        birthDate: "2026-02-01",
        gender: "boy",
      },
    });
    assert.equal(babyRes.statusCode, 201, `Create baby B failed: ${babyRes.payload}`);
    babyBId = babyRes.json<{ data: { id: string } }>().data.id;
  });

  // S-01: Create ongoing sleep (endedAt: null) creates entity and timeline projection
  await t.test("S-01: Create ongoing sleep record with timeline projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/sleep`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        sleepType: "nap",
        startedAt: "2026-09-12T13:00:00.000Z",
        notes: "Afternoon nap started",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{
      data: {
        id: string;
        sleepType: string;
        startedAt: string;
        endedAt: string | null;
        nightWakingCount: number;
        version: string;
      };
    }>();

    assert.ok(body.data.id);
    assert.equal(body.data.sleepType, "nap");
    assert.equal(body.data.endedAt, null);
    assert.equal(body.data.nightWakingCount, 0);
    assert.equal(body.data.version, "1");
    ongoingSleepId = body.data.id;

    // Verify timeline projection entry
    const { rows: tlRows } = await ctx.pool.query(
      `SELECT * FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'sleep'`,
      [ongoingSleepId]
    );
    assert.equal(tlRows.length, 1);
    assert.equal(tlRows[0].family_id, familyAId);
    assert.equal(tlRows[0].baby_id, babyAId);
  });

  // S-02: Creating second active sleep while first is ongoing fails with 409 ACTIVE_SLEEP_EXISTS
  await t.test("S-02: Creating second active sleep while first ongoing fails with 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/sleep`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        sleepType: "nap",
        startedAt: "2026-09-12T13:30:00.000Z",
      },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "ACTIVE_SLEEP_EXISTS");
  });

  // S-03: Idempotent replay with same key returns cached ongoing sleep
  await t.test("S-03: Idempotency replay returns cached ongoing sleep", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/sleep`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        sleepType: "nap",
        startedAt: "2026-09-12T13:00:00.000Z",
        notes: "Afternoon nap started",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ data: { id: string; version: string } }>();
    assert.equal(body.data.id, ongoingSleepId);
    assert.equal(body.data.version, "1");
  });

  // S-04: End sleep session via PATCH with endedAt
  await t.test("S-04: End sleep session via PATCH with endedAt", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/sleep/${ongoingSleepId}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        baseVersion: "1",
        endedAt: "2026-09-12T14:30:00.000Z",
        notes: "Woke up refreshed after 1.5h nap",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      data: {
        id: string;
        endedAt: string;
        version: string;
        notes: string;
      };
    }>();
    assert.equal(body.data.endedAt, "2026-09-12T14:30:00.000Z");
    assert.equal(body.data.version, "2");
    assert.equal(body.data.notes, "Woke up refreshed after 1.5h nap");
  });

  // S-05: Concurrency conflict 409 when two devices try to end sleep with same baseVersion
  await t.test("S-05: Concurrency conflict 409 on outdated baseVersion", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/sleep/${ongoingSleepId}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        baseVersion: "1", // already bumped to 2
        endedAt: "2026-09-12T14:45:00.000Z",
      },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "CONCURRENCY_CONFLICT");
  });

  // S-06: Create finished sleep directly with cross-midnight interval
  await t.test("S-06: Create finished sleep with cross-midnight interval", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/sleep`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        sleepType: "night",
        startedAt: "2026-09-11T21:00:00.000Z",
        endedAt: "2026-09-12T06:30:00.000Z",
        nightWakingCount: 2,
        notes: "Woke up twice for milk",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{
      data: {
        sleepType: string;
        startedAt: string;
        endedAt: string;
        nightWakingCount: number;
      };
    }>();
    assert.equal(body.data.sleepType, "night");
    assert.equal(body.data.nightWakingCount, 2);
  });

  // S-07: Invalid interval (endedAt < startedAt) rejected with 400
  await t.test("S-07: Invalid interval (endedAt < startedAt) rejected with 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/sleep`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        sleepType: "nap",
        startedAt: "2026-09-12T15:00:00.000Z",
        endedAt: "2026-09-12T14:00:00.000Z", // before startedAt!
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "INVALID_SLEEP_INTERVAL");
  });

  // S-08: Keyset pagination works stably across sleep records
  await t.test("S-08: Keyset pagination works stably across sleep records", async () => {
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/sleep?limit=1`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.equal(page1Res.statusCode, 200);
    const page1 = page1Res.json<{
      data: Array<{ id: string; startedAt: string }>;
      page: { nextCursor: string | null };
    }>();
    assert.equal(page1.data.length, 1);
    assert.ok(page1.page.nextCursor);

    const page2Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/sleep?limit=1&cursor=${encodeURIComponent(page1.page.nextCursor!)}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.equal(page2Res.statusCode, 200);
    const page2 = page2Res.json<{
      data: Array<{ id: string; startedAt: string }>;
    }>();
    assert.equal(page2.data.length, 1);
    assert.notEqual(page1.data[0]?.id, page2.data[0]?.id);
  });

  // S-09: Multi-tenant cross-baby isolation
  await t.test("S-09: Multi-tenant cross-baby isolation", async () => {
    // User B tries to read Baby A's sleep records
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/sleep`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });
    assert.equal(listRes.statusCode, 403);

    // User B tries to get specific sleep record of Baby A
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/sleep/${ongoingSleepId}`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });
    assert.equal(getRes.statusCode, 403);

    // User B tries to create sleep record for Baby A
    const createRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/sleep`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
      payload: {
        sleepType: "nap",
        startedAt: "2026-09-12T16:00:00.000Z",
      },
    });
    assert.equal(createRes.statusCode, 403);
  });

  // S-10: Soft-delete removes record and timeline projection
  await t.test("S-10: Soft-delete removes record and timeline projection", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/records/sleep/${ongoingSleepId}?baseVersion=2`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.equal(delRes.statusCode, 200);
    const delBody = delRes.json<{ data: { id: string; deleted: boolean } }>();
    assert.equal(delBody.data.id, ongoingSleepId);
    assert.equal(delBody.data.deleted, true);

    // Verify record is no longer retrievable via GET
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/sleep/${ongoingSleepId}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.equal(getRes.statusCode, 404);

    // Verify timeline projection entry was soft-deleted (deleted_at is set)
    const { rows: tlRows } = await ctx.pool.query(
      `SELECT * FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'sleep'`,
      [ongoingSleepId]
    );
    assert.equal(tlRows.length, 1);
    assert.ok(tlRows[0].deleted_at !== null);

    // Verify active timeline excludes soft-deleted record
    const { rows: activeTlRows } = await ctx.pool.query(
      `SELECT * FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'sleep' AND deleted_at IS NULL`,
      [ongoingSleepId]
    );
    assert.equal(activeTlRows.length, 0);
  });
});
