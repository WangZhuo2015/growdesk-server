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

test("SH-04TL: Unified Timeline Pipeline suite", async (t) => {
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

  // Ensure all migrations up to 202609120008_care_growth are applied
  const migrations = [
    "prisma/migrations/202609120001_identity/migration.sql",
    "prisma/migrations/202609120002_foundation/migration.sql",
    "prisma/migrations/202609120003_care_feeding/migration.sql",
    "prisma/migrations/202609120004_care_diaper/migration.sql",
    "prisma/migrations/202609120005_care_sleep/migration.sql",
    "prisma/migrations/202609120006_care_food/migration.sql",
    "prisma/migrations/202609120007_care_supplement/migration.sql",
    "prisma/migrations/202609120008_care_growth/migration.sql",
  ];

  for (const m of migrations) {
    const sql = fs.readFileSync(m, "utf8");
    try {
      await ctx.pool.query(sql);
    } catch {
      // Table may already exist in shared run, continue
    }
  }

  // Identities
  const userAName = `test_tl_a_${Date.now()}`;
  const userBName = `test_tl_b_${Date.now()}`;
  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";
  let babyBId = "";

  let feedingId = "";

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
    babyAId = babyResA.json<{ data: { id: string } }>().data.id;

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
    babyBId = babyResB.json<{ data: { id: string } }>().data.id;
  });

  await t.test("TL-01: Create events across 6 care domains and verify timeline projection", async () => {
    // 1. Feeding record
    const feedRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/feeding`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        feedingType: "formula",
        occurredAt: "2026-09-12T08:00:00.000Z",
        amountMl: "120.00",
      },
    });
    assert.strictEqual(feedRes.statusCode, 201);
    feedingId = feedRes.json<{ data: { id: string } }>().data.id;

    // 2. Diaper record
    const diaperRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/diaper`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        diaperType: "pee",
        occurredAt: "2026-09-12T09:00:00.000Z",
      },
    });
    assert.strictEqual(diaperRes.statusCode, 201);

    // 3. Sleep record
    const sleepRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/sleep`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        sleepType: "nap",
        startedAt: "2026-09-12T10:00:00.000Z",
      },
    });
    assert.strictEqual(sleepRes.statusCode, 201);

    // 4. Food record
    const foodRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/food`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        recordDate: "2026-09-12",
        mealType: "lunch",
        foodItemIds: [],
        occurredAt: "2026-09-12T12:00:00.000Z",
        portionDescription: "30g pumpkin puree",
      },
    });
    assert.strictEqual(foodRes.statusCode, 201);

    // 5. Supplement record
    const suppRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/supplement`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        supplementName: "Vitamin D3",
        occurredAt: "2026-09-12T14:00:00.000Z",
        amount: "400 IU",
      },
    });
    assert.strictEqual(suppRes.statusCode, 201);

    // 6. Growth measurement
    const growthRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/growth-measurements`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        measurementDate: "2026-09-12",
        weightKg: "7.80",
        heightCm: "68.5",
      },
    });
    assert.strictEqual(growthRes.statusCode, 201);

    // Query Unified Timeline
    const tlRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/timeline`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(tlRes.statusCode, 200);
    const tlBody = tlRes.json<{
      data: Array<{
        id: string;
        babyId: string;
        entityType: string;
        entityId: string;
        occurredAt: string;
        summary: string;
        version: string;
      }>;
    }>();

    assert.strictEqual(tlBody.data.length, 6);

    const entityTypes = new Set(tlBody.data.map((e) => e.entityType));
    assert.ok(entityTypes.has("feeding"));
    assert.ok(entityTypes.has("diaper"));
    assert.ok(entityTypes.has("sleep"));
    assert.ok(entityTypes.has("food"));
    assert.ok(entityTypes.has("supplement"));
    assert.ok(entityTypes.has("growth"));

    // Verify ordering: newest occurredAt first
    for (let i = 0; i < tlBody.data.length - 1; i++) {
      const cur = new Date(tlBody.data[i]!.occurredAt).getTime();
      const next = new Date(tlBody.data[i + 1]!.occurredAt).getTime();
      assert.ok(cur >= next, `Timeline entries should be sorted descending by occurredAt: ${cur} >= ${next}`);
    }
  });

  await t.test("TL-02: Keyset pagination works stably across multi-domain timeline entries", async () => {
    // List first 3 entries
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/timeline?limit=3`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(page1Res.statusCode, 200);
    const page1 = page1Res.json<{
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    }>();
    assert.strictEqual(page1.data.length, 3);
    assert.ok(page1.page.nextCursor);

    // List next 3 entries using cursor
    const page2Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/timeline?limit=3&cursor=${encodeURIComponent(page1.page.nextCursor!)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(page2Res.statusCode, 200);
    const page2 = page2Res.json<{
      data: Array<{ id: string }>;
      page: { nextCursor: string | null };
    }>();
    assert.strictEqual(page2.data.length, 3);

    // Verify disjoint sets (no duplicate entries)
    const p1Ids = new Set(page1.data.map((e) => e.id));
    for (const e of page2.data) {
      assert.strictEqual(p1Ids.has(e.id), false);
    }
  });

  await t.test("TL-03: Soft-deleting a care record removes it from timeline", async () => {
    // Soft delete the feeding record
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/records/feeding/${feedingId}?baseVersion=1`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(delRes.statusCode, 200);

    // Query timeline again
    const tlRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/timeline`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.strictEqual(tlRes.statusCode, 200);
    const tlBody = tlRes.json<{
      data: Array<{
        entityType: string;
        entityId: string;
      }>;
    }>();

    // Now 5 items remain, none with feedingId
    assert.strictEqual(tlBody.data.length, 5);
    const hasDeletedFeeding = tlBody.data.some((e) => e.entityId === feedingId);
    assert.strictEqual(hasDeletedFeeding, false);
  });

  await t.test("TL-04: Multi-tenant cross-baby isolation (403)", async () => {
    // User B attempts to query Baby A's timeline -> 403
    const crossRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/timeline`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.strictEqual(crossRes.statusCode, 403);
    assert.strictEqual(crossRes.json<{ error: { code: string } }>().error.code, "FAMILY_ACCESS_DENIED");

    // User B queries Baby B's timeline -> 200 with empty list
    const emptyRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyBId}/timeline`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.strictEqual(emptyRes.statusCode, 200);
    assert.strictEqual(emptyRes.json<{ data: unknown[] }>().data.length, 0);
  });
});
