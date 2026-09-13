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

test("SH-04SU: Supplement Record Pipeline suite", async (t) => {
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

  // Ensure all migrations up to 202609120007_care_supplement are applied
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
  const { rows: sleepRows } = await ctx.pool.query("SELECT to_regclass('public.sleep_records') as exists");
  if (!sleepRows[0]?.exists) {
    await ctx.pool.query(sleepSql);
  }

  const foodSql = fs.readFileSync("prisma/migrations/202609120006_care_food/migration.sql", "utf8");
  const { rows: foodRows } = await ctx.pool.query("SELECT to_regclass('public.food_records') as exists");
  if (!foodRows[0]?.exists) {
    await ctx.pool.query(foodSql);
  }

  const supplementSql = fs.readFileSync("prisma/migrations/202609120007_care_supplement/migration.sql", "utf8");
  const { rows: suppRows } = await ctx.pool.query("SELECT to_regclass('public.supplement_records') as exists");
  if (!suppRows[0]?.exists) {
    await ctx.pool.query(supplementSql);
  }

  // Identities
  const userAName = `test_supp_a_${Date.now()}`;
  const userBName = `test_supp_b_${Date.now()}`;
  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";
  let babyBId = "";

  let record1Id = "";
  let record1Version = "1";

  await t.test("Setup: Register User A and User B, create families and babies", async () => {
    // 1. Register User A
    const regResA = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userAName,
        password: "ValidPassword123!",
        displayName: "User A",
      },
    });
    assert.strictEqual(regResA.statusCode, 201);
    tokenA = regResA.json<{ data: { accessToken: string } }>().data.accessToken;

    const famResA = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const famListA = famResA.json<{ data: Array<{ id: string }> }>().data;
    assert.ok(famListA[0]);
    familyAId = famListA[0].id;

    // 3. Create Baby A
    const babyResA = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyAId}/babies`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        name: "Baby A",
        birthDate: "2025-01-01",
        gender: "girl",
      },
    });
    assert.strictEqual(babyResA.statusCode, 201);
    babyAId = babyResA.json().data.id;

    // 4. Register User B
    const regResB = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userBName,
        password: "ValidPassword123!",
        displayName: "User B",
      },
    });
    assert.strictEqual(regResB.statusCode, 201);
    tokenB = regResB.json<{ data: { accessToken: string } }>().data.accessToken;

    const famResB = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${tokenB}` },
    });
    const famListB = famResB.json<{ data: Array<{ id: string }> }>().data;
    assert.ok(famListB[0]);
    familyBId = famListB[0].id;

    // 6. Create Baby B
    const babyResB = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyBId}/babies`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
      payload: {
        name: "Baby B",
        birthDate: "2025-02-01",
        gender: "boy",
      },
    });
    assert.strictEqual(babyResB.statusCode, 201);
    babyBId = babyResB.json().data.id;
  });

  const fixedOccurredAt = new Date().toISOString();

  await t.test("SU-01: Create supplement record with timeline projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/supplement`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": "idemp-supp-create-01",
      },
      payload: {
        supplementName: "Vitamin D3",
        occurredAt: fixedOccurredAt,
        amount: "400 IU",
        notes: "Morning drop",
      },
    });

    assert.strictEqual(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.data.id);
    record1Id = body.data.id;
    assert.strictEqual(body.data.babyId, babyAId);
    assert.strictEqual(body.data.familyId, familyAId);
    assert.strictEqual(body.data.supplementName, "Vitamin D3");
    assert.strictEqual(body.data.amount, "400 IU");
    assert.strictEqual(body.data.notes, "Morning drop");
    assert.strictEqual(body.data.version, "1");
    record1Version = body.data.version;

    // Verify timeline projection in database
    const { rows: tlRows } = await ctx.pool.query(
      `SELECT * FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'supplement'`,
      [record1Id]
    );
    assert.strictEqual(tlRows.length, 1);
    assert.strictEqual(tlRows[0].baby_id, babyAId);
    assert.strictEqual(tlRows[0].family_id, familyAId);
    assert.strictEqual(tlRows[0].deleted_at, null);
  });

  await t.test("SU-02: Idempotency replay with same key returns cached result", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/supplement`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": "idemp-supp-create-01",
      },
      payload: {
        supplementName: "Vitamin D3",
        occurredAt: fixedOccurredAt,
        amount: "400 IU",
        notes: "Morning drop",
      },
    });

    assert.strictEqual(res.statusCode, 201);
    const body = res.json();
    assert.strictEqual(body.data.id, record1Id);
    assert.strictEqual(body.data.supplementName, "Vitamin D3");
  });

  await t.test("SU-03: Reusing Idempotency-Key with different payload triggers 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/supplement`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": "idemp-supp-create-01",
      },
      payload: {
        supplementName: "DHA Drops",
        occurredAt: new Date().toISOString(),
        amount: "1 ml",
      },
    });

    assert.strictEqual(res.statusCode, 409);
    const body = res.json();
    assert.strictEqual(body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  await t.test("SU-04: Keyset pagination works stably across supplement records", async () => {
    // Create 3 more records with distinct timestamps
    for (let i = 1; i <= 3; i++) {
      const pastTime = new Date(Date.now() - i * 3600000).toISOString();
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/babies/${babyAId}/records/supplement`,
        headers: {
          authorization: `Bearer ${tokenA}`,
          "idempotency-key": `idemp-supp-batch-${i}`,
        },
        payload: {
          supplementName: `Supplement #${i}`,
          occurredAt: pastTime,
          amount: `${i} drops`,
        },
      });
      assert.strictEqual(res.statusCode, 201);
    }

    // List with limit=2
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/supplement?limit=2`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(page1Res.statusCode, 200);
    const page1 = page1Res.json<{
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    }>();
    assert.strictEqual(page1.data.length, 2);
    assert.ok(page1.page.nextCursor);

    // List page 2 using cursor
    const page2Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/supplement?limit=2&cursor=${encodeURIComponent(page1.page.nextCursor!)}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(page2Res.statusCode, 200);
    const page2 = page2Res.json<{
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    }>();
    assert.strictEqual(page2.data.length, 2);

    // Check no duplicate IDs between pages
    const idsPage1 = new Set(page1.data.map((r: { id: string }) => r.id));
    for (const r of page2.data) {
      assert.strictEqual(idsPage1.has(r.id), false);
    }
  });

  await t.test("SU-05: Optimistic locking detects concurrency conflicts on baseVersion", async () => {
    // Get single record
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/supplement/${record1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(getRes.statusCode, 200);
    const current = getRes.json().data;
    assert.strictEqual(current.version, record1Version);

    // Attempt update with wrong baseVersion
    const wrongVersionRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/supplement/${record1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        baseVersion: "999",
        supplementName: "Conflicting Supplement",
      },
    });
    assert.strictEqual(wrongVersionRes.statusCode, 409);
    assert.strictEqual(wrongVersionRes.json().error.code, "CONCURRENCY_CONFLICT");

    // Valid update with matching baseVersion
    const validUpdateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/supplement/${record1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        baseVersion: record1Version,
        supplementName: "Vitamin D3 + K2",
        amount: "600 IU",
      },
    });
    assert.strictEqual(validUpdateRes.statusCode, 200);
    const updated = validUpdateRes.json().data;
    assert.strictEqual(updated.supplementName, "Vitamin D3 + K2");
    assert.strictEqual(updated.amount, "600 IU");
    assert.strictEqual(updated.version, "2");
    record1Version = updated.version;
  });

  await t.test("SU-06: User B cannot access or modify Baby A's supplement records (403)", async () => {
    // User B attempts to read Baby A's record
    const readRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/supplement/${record1Id}`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });
    assert.strictEqual(readRes.statusCode, 403);
    assert.strictEqual(readRes.json().error.code, "FAMILY_ACCESS_DENIED");

    // User B attempts to update Baby A's record
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/supplement/${record1Id}`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
      payload: {
        baseVersion: record1Version,
        supplementName: "Hacked Supplement",
      },
    });
    assert.strictEqual(updateRes.statusCode, 403);
    assert.strictEqual(updateRes.json().error.code, "FAMILY_ACCESS_DENIED");

    // User B attempts to list Baby A's supplement records
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/supplement`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });
    assert.strictEqual(listRes.statusCode, 403);
    assert.strictEqual(listRes.json().error.code, "FAMILY_ACCESS_DENIED");
  });

  await t.test("SU-07: Delete supplement record soft-deletes and removes active timeline projection", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/records/supplement/${record1Id}?baseVersion=${record1Version}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(delRes.statusCode, 200);
    const delBody = delRes.json();
    assert.strictEqual(delBody.data.id, record1Id);
    assert.strictEqual(delBody.data.deleted, true);

    // Reading deleted record returns 404
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/supplement/${record1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(getRes.statusCode, 404);

    // Verify timeline projection is soft deleted (deleted_at IS NOT NULL)
    const { rows: tlRows } = await ctx.pool.query(
      `SELECT deleted_at FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'supplement'`,
      [record1Id]
    );
    assert.strictEqual(tlRows.length, 1);
    assert.notStrictEqual(tlRows[0].deleted_at, null);
  });
});
