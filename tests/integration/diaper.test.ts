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

test("SH-04D: Diaper Record Pipeline suite", async (t) => {
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

  // Ensure all migrations up to 202609120004_care_diaper are applied to test database
  const identitySql = fs.readFileSync("prisma/migrations/202609120001_identity/migration.sql", "utf8");
  const { rows: idRows } = await ctx.pool.query("SELECT to_regclass('public.users') as exists");
  if (!idRows[0]?.exists) {
    await ctx.pool.query(identitySql);
  }

  const foundationSql = fs.readFileSync("prisma/migrations/202609120002_foundation/migration.sql", "utf8");
  try {
    await ctx.pool.query(foundationSql);
  } catch {
    // Ignore concurrent application
  }

  const feedingSql = fs.readFileSync("prisma/migrations/202609120003_care_feeding/migration.sql", "utf8");
  try {
    await ctx.pool.query(feedingSql);
  } catch {
    // Ignore concurrent application
  }

  const diaperSql = fs.readFileSync("prisma/migrations/202609120004_care_diaper/migration.sql", "utf8");
  try {
    await ctx.pool.query(diaperSql);
  } catch {
    // Ignore concurrent application
  }

  // Identities
  const userAName = `test_diaper_a_${Date.now()}`;
  const userBName = `test_diaper_b_${Date.now()}`;
  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";

  let diaperRecordId = "";
  const fixedIdempotencyKey = `diaper-idemp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Setup: Register User A (Family A, Baby A)
  await t.test("Setup: Register User A and create Baby A", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userAName,
        password: "Password123!",
        displayName: "User A",
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
        name: "test_baby_a",
        gender: "girl",
        birthDate: "2026-01-01",
      },
    });
    assert.equal(babyRes.statusCode, 201, `Create baby failed: ${babyRes.payload}`);
    babyAId = babyRes.json<{ data: { id: string } }>().data.id;
  });

  // Setup: Register User B (Family B)
  await t.test("Setup: Register User B in separate Family B", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userBName,
        password: "Password123!",
        displayName: "User B",
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
    assert.notEqual(familyAId, familyBId);
  });

  // D-01: User A creates diaper record with Idempotency-Key
  await t.test("D-01: Create diaper record creates entity and atomic timeline projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/diaper`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        diaperType: "pee",
        occurredAt: "2026-09-12T09:00:00.000Z",
        notes: "Morning wet diaper",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ data: { id: string; diaperType: string; version: string } }>();
    assert.ok(body.data.id);
    diaperRecordId = body.data.id;
    assert.equal(body.data.diaperType, "pee");
    assert.equal(body.data.version, "1");

    // Verify timeline entry was created atomically
    const timelineRows = await ctx.prisma.timelineEntry.findMany({
      where: {
        familyId: familyAId,
        babyId: babyAId,
        entityType: "diaper",
        entityId: diaperRecordId,
      },
    });
    assert.equal(timelineRows.length, 1);
    assert.ok(timelineRows[0]);
    assert.equal(timelineRows[0].version, 1);
    assert.equal(timelineRows[0].deletedAt, null);
  });

  // D-02: Idempotent replay returns cached result
  await t.test("D-02: Same Idempotency-Key and payload returns replayed result", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/diaper`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        diaperType: "pee",
        occurredAt: "2026-09-12T09:00:00.000Z",
        notes: "Morning wet diaper",
      },
    });
    assert.ok(res.statusCode === 200 || res.statusCode === 201);
    const body = res.json<{ data: { id: string } }>();
    assert.equal(body.data.id, diaperRecordId);

    // Check count in DB is still 1
    const count = await ctx.prisma.diaperRecord.count({
      where: { id: diaperRecordId },
    });
    assert.equal(count, 1);
  });

  // D-03: Reusing Idempotency-Key with different payload triggers 409
  await t.test("D-03: Reusing Idempotency-Key with different payload triggers 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/diaper`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        diaperType: "poop",
        occurredAt: "2026-09-12T09:00:00.000Z",
        notes: "Changed payload",
      },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  // D-04: Keyset pagination works stably
  await t.test("D-04: Keyset pagination works stably", async () => {
    // Add 2 more diaper records with distinct times
    for (let i = 1; i <= 2; i++) {
      const addRes = await app.inject({
        method: "POST",
        url: `/api/v1/babies/${babyAId}/records/diaper`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {
          diaperType: "pee",
          occurredAt: `2026-09-12T1${i}:00:00.000Z`,
          notes: `Batch test ${i}`,
        },
      });
      assert.equal(addRes.statusCode, 201);
    }

    // Page 1: limit = 2
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/diaper?limit=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(page1Res.statusCode, 200);
    const page1 = page1Res.json<{ data: Array<{ id: string }>; page: { nextCursor: string | null } }>();
    assert.equal(page1.data.length, 2);
    assert.ok(page1.page.nextCursor);

    // Page 2 using nextCursor
    const page2Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/diaper?limit=2&cursor=${encodeURIComponent(page1.page.nextCursor!)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(page2Res.statusCode, 200);
    const page2 = page2Res.json<{ data: Array<{ id: string }>; page: { nextCursor: string | null } }>();
    assert.ok(page2.data.length >= 1);
    assert.ok(page1.data[0]);
    assert.ok(page2.data[0]);
    assert.notEqual(page1.data[0].id, page2.data[0].id);
  });

  // D-05: Optimistic locking on update
  await t.test("D-05: Optimistic locking detects concurrency conflicts", async () => {
    // Successful update with baseVersion "1"
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/diaper/${diaperRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "1",
        diaperType: "both",
        notes: "Updated: baby had both pee and poop",
        poopColor: "yellow",
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const updated = updateRes.json<{ data: { version: string; diaperType: string; poopColor: string | null } }>();
    assert.equal(updated.data.version, "2");
    assert.equal(updated.data.diaperType, "both");
    assert.equal(updated.data.poopColor, "yellow");

    // Stale update with baseVersion "1" fails with 409
    const staleRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/diaper/${diaperRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "1",
        diaperType: "pee",
      },
    });
    assert.equal(staleRes.statusCode, 409);
    const staleBody = staleRes.json<{ error: { code: string } }>();
    assert.equal(staleBody.error.code, "CONCURRENCY_CONFLICT");
  });

  // D-06: Multi-tenant cross-baby isolation
  await t.test("D-06: User B cannot access or modify Baby A's diaper records", async () => {
    // GET Baby A's record with User B token fails with 403 or 404
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/diaper/${diaperRecordId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.ok(getRes.statusCode === 403 || getRes.statusCode === 404);

    // PATCH Baby A's record with User B token fails
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/diaper/${diaperRecordId}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        baseVersion: "2",
        diaperType: "pee",
      },
    });
    assert.ok(patchRes.statusCode === 403 || patchRes.statusCode === 404);

    // DELETE Baby A's record with User B token fails
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/records/diaper/${diaperRecordId}?baseVersion=2`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.ok(delRes.statusCode === 403 || delRes.statusCode === 404);
  });

  // D-07: Delete diaper record soft-deletes and removes timeline projection
  await t.test("D-07: Delete diaper record soft-deletes and removes timeline projection", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/records/diaper/${diaperRecordId}?baseVersion=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(delRes.statusCode, 200);
    const delBody = delRes.json<{ data: { id: string; deleted: boolean } }>();
    assert.equal(delBody.data.deleted, true);
    assert.equal(delBody.data.id, diaperRecordId);

    // Record is no longer returned in GET
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/diaper/${diaperRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(getRes.statusCode, 404);

    // TimelineEntry has deletedAt set
    const timelineEntry = await ctx.prisma.timelineEntry.findUnique({
      where: {
        uq_timeline_entries_entity: {
          familyId: familyAId,
          babyId: babyAId,
          entityType: "diaper",
          entityId: diaperRecordId,
        },
      },
    });
    assert.ok(timelineEntry);
    assert.ok(timelineEntry.deletedAt !== null);
  });

  // D-08: Create poop diaper record with poopColor and poopConsistency
  await t.test("D-08: Create poop diaper record with color and consistency", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/diaper`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        diaperType: "poop",
        occurredAt: "2026-09-12T14:00:00.000Z",
        poopColor: "green",
        poopConsistency: "soft",
        notes: "Afternoon dirty diaper",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{
      data: {
        id: string;
        diaperType: string;
        poopColor: string | null;
        poopConsistency: string | null;
      };
    }>();
    assert.ok(body.data.id);
    assert.equal(body.data.diaperType, "poop");
    assert.equal(body.data.poopColor, "green");
    assert.equal(body.data.poopConsistency, "soft");
  });
});
