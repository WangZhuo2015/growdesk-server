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

test("SH-04F: Feeding Record Pipeline & Formula Products suite", async (t) => {
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

  // Ensure all migrations up to 202609120003_care_feeding are applied to test database
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

  // Identities
  const userAName = `test_feed_a_${Date.now()}`;
  const userBName = `test_feed_b_${Date.now()}`;
  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";

  let formulaProductId = "";
  let feedingRecordId = "";
  const fixedIdempotencyKey = `idemp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

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

  // FP-01: Create formula product for Family A
  await t.test("FP-01: Create formula product in Family A catalog", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyAId}/nutrition/products`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        brand: "Aptamil",
        name: "Essensis Organic Stage 1",
        stage: "Stage 1",
        scoopGrams: "4.5",
        waterMlPerScoop: "30.0",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ data: { id: string; brand: string; name: string } }>();
    assert.ok(body.data.id);
    assert.equal(body.data.brand, "Aptamil");
    formulaProductId = body.data.id;
  });

  // FP-02: List formula products and verify tenant isolation
  await t.test("FP-02: List formula products adheres to family boundary", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/families/${familyAId}/nutrition/products`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = listRes.json<{ data: Array<{ id: string }> }>();
    assert.equal(listBody.data.length, 1);
    assert.ok(listBody.data[0]);
    assert.equal(listBody.data[0].id, formulaProductId);

    // User B from Family B cannot list Family A's products
    const crossRes = await app.inject({
      method: "GET",
      url: `/api/v1/families/${familyAId}/nutrition/products`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(crossRes.statusCode, 403);
  });

  // FEED-01: User A creates feeding record with formulaProductId and Idempotency-Key
  await t.test("FEED-01: Create feeding record creates entity and atomic timeline projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/feeding`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        feedingType: "formula",
        occurredAt: "2026-09-12T08:00:00.000Z",
        amountMl: "120.0",
        formulaProductId,
        spitUp: false,
        notes: "Morning bottle feeding",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ data: { id: string; feedingType: string; amountMl: string; version: string } }>();
    assert.ok(body.data.id);
    feedingRecordId = body.data.id;
    assert.equal(body.data.feedingType, "formula");
    assert.equal(body.data.amountMl, "120");
    assert.equal(body.data.version, "1");

    // Verify timeline entry was created atomically
    const timelineRows = await ctx.prisma.timelineEntry.findMany({
      where: {
        familyId: familyAId,
        babyId: babyAId,
        entityType: "feeding",
        entityId: feedingRecordId,
      },
    });
    assert.equal(timelineRows.length, 1);
    assert.ok(timelineRows[0]);
    assert.equal(timelineRows[0].version, 1);
    assert.equal(timelineRows[0].deletedAt, null);
  });

  // FEED-02: Idempotent replay returns cached result
  await t.test("FEED-02: Same Idempotency-Key and payload returns replayed result", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/feeding`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        feedingType: "formula",
        occurredAt: "2026-09-12T08:00:00.000Z",
        amountMl: "120.0",
        formulaProductId,
        spitUp: false,
        notes: "Morning bottle feeding",
      },
    });
    assert.ok(res.statusCode === 200 || res.statusCode === 201);
    const body = res.json<{ data: { id: string } }>();
    assert.equal(body.data.id, feedingRecordId);

    // Check count in DB is still 1
    const count = await ctx.prisma.feedingRecord.count({
      where: { id: feedingRecordId },
    });
    assert.equal(count, 1);
  });

  // FEED-03: Key reuse with different payload triggers 409
  await t.test("FEED-03: Reusing Idempotency-Key with different payload triggers 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/feeding`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        feedingType: "breast",
        occurredAt: "2026-09-12T08:30:00.000Z",
        leftMinutes: 15,
        rightMinutes: 10,
      },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  // FEED-04: Cross-family formula product rejected with 400
  await t.test("FEED-04: Formula product from another family is rejected", async () => {
    // Create product in Family B
    const prodBRes = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyBId}/nutrition/products`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        brand: "Hipp",
        name: "Bio Combiotik Stage 1",
      },
    });
    const productBId = prodBRes.json<{ data: { id: string } }>().data.id;

    // User A tries to use productBId for Baby A in Family A
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/feeding`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        feedingType: "formula",
        occurredAt: "2026-09-12T09:00:00.000Z",
        amountMl: "90.0",
        formulaProductId: productBId,
      },
    });
    assert.equal(res.statusCode, 400);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "FORMULA_PRODUCT_NOT_FOUND");
  });

  // FEED-05: Keyset pagination
  await t.test("FEED-05: Keyset pagination works stably", async () => {
    // Insert 2 more records for Baby A
    await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/feeding`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        feedingType: "breast",
        occurredAt: "2026-09-12T10:00:00.000Z",
        leftMinutes: 20,
        rightMinutes: 15,
      },
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/feeding`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        feedingType: "bottle",
        occurredAt: "2026-09-12T12:00:00.000Z",
        amountMl: "150.0",
      },
    });

    // Page 1 with limit 2
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/feeding?limit=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(page1Res.statusCode, 200);
    const page1 = page1Res.json<{ data: Array<{ id: string }>; page: { nextCursor: string | null } }>();
    assert.equal(page1.data.length, 2);
    assert.ok(page1.page.nextCursor);

    // Page 2 using nextCursor
    const page2Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/feeding?limit=2&cursor=${encodeURIComponent(page1.page.nextCursor!)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(page2Res.statusCode, 200);
    const page2 = page2Res.json<{ data: Array<{ id: string }>; page: { nextCursor: string | null } }>();
    assert.ok(page2.data.length >= 1);
    assert.ok(page1.data[0]);
    assert.ok(page2.data[0]);
    assert.notEqual(page1.data[0].id, page2.data[0].id);
  });

  // FEED-06: Optimistic locking on update
  await t.test("FEED-06: Optimistic locking detects concurrency conflicts", async () => {
    // Successful update with baseVersion "1"
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/feeding/${feedingRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "1",
        amountMl: "140.0",
        notes: "Updated: baby drank 140ml",
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const updated = updateRes.json<{ data: { version: string; amountMl: string } }>();
    assert.equal(updated.data.version, "2");
    assert.equal(updated.data.amountMl, "140");

    // Stale update with baseVersion "1" fails with 409
    const staleRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/feeding/${feedingRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "1",
        amountMl: "160.0",
      },
    });
    assert.equal(staleRes.statusCode, 409);
    const staleBody = staleRes.json<{ error: { code: string } }>();
    assert.equal(staleBody.error.code, "CONCURRENCY_CONFLICT");
  });

  // FEED-07: Multi-tenant cross-baby isolation
  await t.test("FEED-07: User B cannot access or modify Baby A's feeding records", async () => {
    // GET Baby A's record with User B token fails with 403 or 404
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/feeding/${feedingRecordId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.ok(getRes.statusCode === 403 || getRes.statusCode === 404);

    // PATCH Baby A's record with User B token fails
    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/feeding/${feedingRecordId}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        baseVersion: "2",
        notes: "Malicious update",
      },
    });
    assert.ok(patchRes.statusCode === 403 || patchRes.statusCode === 404);

    // DELETE Baby A's record with User B token fails
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/records/feeding/${feedingRecordId}?baseVersion=2`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.ok(deleteRes.statusCode === 403 || deleteRes.statusCode === 404);
  });

  // FEED-08: Soft-delete feeding record
  await t.test("FEED-08: Delete feeding record soft-deletes and removes timeline projection", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/records/feeding/${feedingRecordId}?baseVersion=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(delRes.statusCode, 200);

    // Subsequent GET returns 404
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/feeding/${feedingRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(getRes.statusCode, 404);

    // In DB, deletedAt is set
    const dbRow = await ctx.prisma.feedingRecord.findUnique({
      where: { id: feedingRecordId },
    });
    assert.ok(dbRow?.deletedAt);

    // Timeline entry is soft deleted
    const timelineRow = await ctx.prisma.timelineEntry.findUnique({
      where: {
        uq_timeline_entries_entity: {
          familyId: familyAId,
          babyId: babyAId,
          entityType: "feeding",
          entityId: feedingRecordId,
        },
      },
    });
    assert.ok(timelineRow?.deletedAt);
  });
});
