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

test("SH-04G: Growth Measurement Pipeline & WHO Percentiles suite", async (t) => {
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
  const userAName = `test_growth_a_${Date.now()}`;
  const userBName = `test_growth_b_${Date.now()}`;
  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";
  let babyBId = "";

  let measurement1Id = "";
  let measurement1Version = "1";

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

    // 3. Create Baby A (girl)
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

    // 6. Create Baby B (boy)
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

  await t.test("G-01: Create growth measurement with timeline projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/growth-measurements`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": "idemp-growth-create-01",
      },
      payload: {
        measurementDate: "2025-06-01",
        weightKg: "7.50",
        heightCm: "67.2",
        headCircumferenceCm: "42.5",
        notes: "6-month checkup",
      },
    });

    assert.strictEqual(res.statusCode, 201);
    const body = res.json<{ data: { id: string; babyId: string; familyId: string; weightKg: string; heightCm: string; headCircumferenceCm: string; measurementDate: string; version: string } }>();
    assert.ok(body.data.id);
    measurement1Id = body.data.id;
    assert.strictEqual(body.data.babyId, babyAId);
    assert.strictEqual(body.data.familyId, familyAId);
    assert.strictEqual(body.data.measurementDate, "2025-06-01");
    assert.strictEqual(body.data.weightKg, "7.50");
    assert.strictEqual(body.data.heightCm, "67.2");
    assert.strictEqual(body.data.headCircumferenceCm, "42.5");
    assert.strictEqual(body.data.version, "1");
    measurement1Version = body.data.version;

    // Verify timeline projection in database
    const { rows: tlRows } = await ctx.pool.query(
      `SELECT * FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'growth'`,
      [measurement1Id]
    );
    assert.strictEqual(tlRows.length, 1);
    assert.strictEqual(tlRows[0].baby_id, babyAId);
    assert.strictEqual(tlRows[0].family_id, familyAId);
    assert.strictEqual(tlRows[0].deleted_at, null);
  });

  await t.test("G-02: Idempotency replay with same key returns cached result", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/growth-measurements`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": "idemp-growth-create-01",
      },
      payload: {
        measurementDate: "2025-06-01",
        weightKg: "7.50",
        heightCm: "67.2",
        headCircumferenceCm: "42.5",
        notes: "6-month checkup",
      },
    });

    assert.strictEqual(res.statusCode, 201);
    const body = res.json<{ data: { id: string; weightKg: string } }>();
    assert.strictEqual(body.data.id, measurement1Id);
    assert.strictEqual(body.data.weightKg, "7.50");
  });

  await t.test("G-03: Reusing Idempotency-Key with different payload triggers 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/growth-measurements`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": "idemp-growth-create-01",
      },
      payload: {
        measurementDate: "2025-07-01",
        weightKg: "8.10",
      },
    });

    assert.strictEqual(res.statusCode, 409);
    const body = res.json<{ error: { code: string } }>();
    assert.strictEqual(body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  await t.test("G-04: Keyset pagination works stably across growth measurements", async () => {
    // Create 3 more measurements on different dates
    for (let i = 1; i <= 3; i++) {
      const day = String(i + 1).padStart(2, "0");
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/babies/${babyAId}/growth-measurements`,
        headers: {
          authorization: `Bearer ${tokenA}`,
          "idempotency-key": `idemp-growth-batch-${i}`,
        },
        payload: {
          measurementDate: `2025-07-${day}`,
          weightKg: `${7.5 + i * 0.3}`,
          heightCm: `${67.2 + i * 1.0}`,
        },
      });
      assert.strictEqual(res.statusCode, 201);
    }

    // List with limit=2
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/growth-measurements?limit=2`,
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
      url: `/api/v1/babies/${babyAId}/growth-measurements?limit=2&cursor=${encodeURIComponent(page1.page.nextCursor!)}`,
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
    const idsPage1 = new Set(page1.data.map((r) => r.id));
    for (const r of page2.data) {
      assert.strictEqual(idsPage1.has(r.id), false);
    }
  });

  await t.test("G-05: Optimistic locking detects concurrency conflicts on baseVersion", async () => {
    // Get single measurement
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${measurement1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(getRes.statusCode, 200);
    const current = getRes.json<{ data: { version: string } }>().data;
    assert.strictEqual(current.version, measurement1Version);

    // Attempt update with wrong baseVersion
    const wrongVersionRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${measurement1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        baseVersion: "999",
        weightKg: "7.80",
      },
    });
    assert.strictEqual(wrongVersionRes.statusCode, 409);
    assert.strictEqual(wrongVersionRes.json<{ error: { code: string } }>().error.code, "CONCURRENCY_CONFLICT");

    // Valid update with matching baseVersion
    const validUpdateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${measurement1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
      payload: {
        baseVersion: measurement1Version,
        weightKg: "7.65",
        notes: "Adjusted weight",
      },
    });
    assert.strictEqual(validUpdateRes.statusCode, 200);
    const updated = validUpdateRes.json<{ data: { weightKg: string; version: string } }>().data;
    assert.strictEqual(updated.weightKg, "7.65");
    assert.strictEqual(updated.version, "2");
    measurement1Version = updated.version;
  });

  await t.test("G-06: User B cannot access or modify Baby A's growth measurements (403)", async () => {
    // User B attempts to read Baby A's measurement
    const readRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${measurement1Id}`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });
    assert.strictEqual(readRes.statusCode, 403);
    assert.strictEqual(readRes.json<{ error: { code: string } }>().error.code, "FAMILY_ACCESS_DENIED");

    // User B attempts to update Baby A's measurement
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${measurement1Id}`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
      payload: {
        baseVersion: measurement1Version,
        weightKg: "12.00",
      },
    });
    assert.strictEqual(updateRes.statusCode, 403);
    assert.strictEqual(updateRes.json<{ error: { code: string } }>().error.code, "FAMILY_ACCESS_DENIED");

    // User B attempts to list Baby A's growth measurements
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/growth-measurements`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });
    assert.strictEqual(listRes.statusCode, 403);
    assert.strictEqual(listRes.json<{ error: { code: string } }>().error.code, "FAMILY_ACCESS_DENIED");
  });

  await t.test("G-07: Delete growth measurement soft-deletes and removes active timeline projection", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${measurement1Id}?baseVersion=${measurement1Version}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(delRes.statusCode, 200);
    const delBody = delRes.json<{ data: { id: string; deleted: boolean } }>();
    assert.strictEqual(delBody.data.id, measurement1Id);
    assert.strictEqual(delBody.data.deleted, true);

    // Reading deleted measurement returns 404
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/growth-measurements/${measurement1Id}`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(getRes.statusCode, 404);

    // Verify timeline projection is soft deleted (deleted_at IS NOT NULL)
    const { rows: tlRows } = await ctx.pool.query(
      `SELECT deleted_at FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'growth'`,
      [measurement1Id]
    );
    assert.strictEqual(tlRows.length, 1);
    assert.notStrictEqual(tlRows[0].deleted_at, null);
  });

  await t.test("G-08: Get Growth Chart returns historical measurements overlaid with WHO percentiles", async () => {
    const chartRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/growth-chart`,
      headers: {
        authorization: `Bearer ${tokenA}`,
      },
    });
    assert.strictEqual(chartRes.statusCode, 200);
    const chartData = chartRes.json<{
      data: {
        measurements: Array<{ id: string; weightKg: string }>;
        whoPercentiles: {
          weightForAge: Array<{ monthAge: number; p50: string }>;
          heightForAge: Array<{ monthAge: number; p50: string }>;
          headCircumferenceForAge: Array<{ monthAge: number; p50: string }>;
        };
      };
    }>().data;

    // Remaining measurements for Baby A (3 active measurements since 1 was deleted)
    assert.strictEqual(chartData.measurements.length, 3);

    // WHO Percentiles: 37 data points (months 0 through 36) for girl
    assert.strictEqual(chartData.whoPercentiles.weightForAge.length, 37);
    assert.strictEqual(chartData.whoPercentiles.heightForAge.length, 37);
    assert.strictEqual(chartData.whoPercentiles.headCircumferenceForAge.length, 37);

    // Month 0 check for girl (weight median: 3.20 kg, length median: 49.1 cm)
    assert.strictEqual(chartData.whoPercentiles.weightForAge[0]?.monthAge, 0);
    assert.strictEqual(chartData.whoPercentiles.weightForAge[0]?.p50, "3.20");
    assert.strictEqual(chartData.whoPercentiles.heightForAge[0]?.p50, "49.1");

    // Also verify Baby B (boy) returns boy percentiles
    const chartResB = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyBId}/growth-chart`,
      headers: {
        authorization: `Bearer ${tokenB}`,
      },
    });
    assert.strictEqual(chartResB.statusCode, 200);
    const chartDataB = chartResB.json<{
      data: {
        whoPercentiles: {
          weightForAge: Array<{ monthAge: number; p50: string }>;
          heightForAge: Array<{ monthAge: number; p50: string }>;
        };
      };
    }>().data;
    // Month 0 check for boy (weight median: 3.30 kg, length median: 49.9 cm)
    assert.strictEqual(chartDataB.whoPercentiles.weightForAge[0]?.p50, "3.30");
    assert.strictEqual(chartDataB.whoPercentiles.heightForAge[0]?.p50, "49.9");
  });
});
