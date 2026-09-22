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

test("SH-04FO: Food Record Pipeline suite", async (t) => {
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

  // Ensure all migrations up to 202609120006_care_food are applied to test database
  const migrations = [
    "prisma/migrations/202609120001_identity/migration.sql",
    "prisma/migrations/202609120002_foundation/migration.sql",
    "prisma/migrations/202609120003_care_feeding/migration.sql",
    "prisma/migrations/202609120004_care_diaper/migration.sql",
    "prisma/migrations/202609120005_care_sleep/migration.sql",
    "prisma/migrations/202609120006_care_food/migration.sql",
    "prisma/migrations/202609190016_food_plan_version/migration.sql",
  ];

  for (const m of migrations) {
    const sql = fs.readFileSync(m, "utf8");
    await ctx.pool.query(sql).catch(() => {});
  }

  // Identities
  const userAName = `test_food_a_${Date.now()}`;
  const userBName = `test_food_b_${Date.now()}`;
  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";
  let babyBId = "";

  let foodRecordId = "";
  const fixedIdempotencyKey = `food-idemp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Setup: Register User A (Family A, Baby A)
  await t.test("Setup: Register User A and create Baby A", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userAName,
        password: "Password123!",
        displayName: "Food User A",
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
        name: "test_food_baby_a",
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
        displayName: "Food User B",
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
        name: "test_food_baby_b",
        birthDate: "2026-02-01",
        gender: "boy",
      },
    });
    assert.equal(babyRes.statusCode, 201, `Create baby B failed: ${babyRes.payload}`);
    babyBId = babyRes.json<{ data: { id: string } }>().data.id;
  });

  // FO-01: Create food record creates entity and timeline projection
  await t.test("FO-01: Create food record creates entity and timeline projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/food`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        recordDate: "2026-09-12",
        mealType: "lunch",
        occurredAt: "2026-09-12T12:30:00.000Z",
        foodItemIds: ["food_iron_cereal", "pumpkin_puree"],
        portionDescription: "half bowl (approx 60ml)",
        reaction: "like",
        notes: "Ate eagerly without spilling",
      },
    });
    assert.equal(res.statusCode, 201, `Create food record failed: ${res.payload}`);
    const body = res.json<{
      data: {
        id: string;
        recordDate: string;
        mealType: string;
        foodItemIds: string[];
        portionDescription: string | null;
        reaction: string | null;
        version: string;
      };
    }>();

    assert.ok(body.data.id);
    assert.equal(body.data.recordDate, "2026-09-12");
    assert.equal(body.data.mealType, "lunch");
    assert.deepEqual(body.data.foodItemIds, ["food_iron_cereal", "pumpkin_puree"]);
    assert.equal(body.data.reaction, "like");
    assert.equal(body.data.version, "1");
    foodRecordId = body.data.id;

    // Verify timeline projection entry
    const { rows: tlRows } = await ctx.pool.query(
      `SELECT * FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'food'`,
      [foodRecordId]
    );
    assert.equal(tlRows.length, 1);
    assert.equal(tlRows[0].family_id, familyAId);
    assert.equal(tlRows[0].baby_id, babyAId);
  });

  // FO-02: Same Idempotency-Key and payload returns replayed result
  await t.test("FO-02: Idempotent replay with same key returns cached result", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/food`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        recordDate: "2026-09-12",
        mealType: "lunch",
        occurredAt: "2026-09-12T12:30:00.000Z",
        foodItemIds: ["food_iron_cereal", "pumpkin_puree"],
        portionDescription: "half bowl (approx 60ml)",
        reaction: "like",
        notes: "Ate eagerly without spilling",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ data: { id: string; version: string } }>();
    assert.equal(body.data.id, foodRecordId);
    assert.equal(body.data.version, "1");
  });

  // FO-03: Reusing Idempotency-Key with different payload triggers 409
  await t.test("FO-03: Reusing Idempotency-Key with different payload triggers 409", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/food`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": fixedIdempotencyKey,
      },
      payload: {
        recordDate: "2026-09-12",
        mealType: "dinner", // Different meal type!
        foodItemIds: ["apple_puree"],
      },
    });
    assert.equal(res.statusCode, 409);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "IDEMPOTENCY_KEY_REUSED");
  });

  // FO-04: Keyset pagination works stably
  await t.test("FO-04: Keyset pagination works stably across food records", async () => {
    // Create second food record on earlier date
    await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/food`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        recordDate: "2026-09-11",
        mealType: "breakfast",
        foodItemIds: ["oatmeal"],
      },
    });

    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/food?limit=1`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(page1Res.statusCode, 200);
    const page1 = page1Res.json<{
      data: Array<{ id: string; recordDate: string }>;
      page: { nextCursor: string | null };
    }>();
    assert.equal(page1.data.length, 1);
    assert.ok(page1.page.nextCursor);

    const page2Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/food?limit=1&cursor=${encodeURIComponent(page1.page.nextCursor!)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(page2Res.statusCode, 200);
    const page2 = page2Res.json<{
      data: Array<{ id: string; recordDate: string }>;
    }>();
    assert.equal(page2.data.length, 1);
    assert.notEqual(page1.data[0]?.id, page2.data[0]?.id);
  });

  // FO-05: Optimistic locking detects concurrency conflicts on baseVersion
  await t.test("FO-05: Optimistic locking detects concurrency conflicts", async () => {
    // Update version 1 -> 2
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/food/${foodRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "1",
        portionDescription: "full bowl (approx 120ml)",
      },
    });
    assert.equal(updateRes.statusCode, 200);
    const updateBody = updateRes.json<{ data: { version: string } }>();
    assert.equal(updateBody.data.version, "2");

    // Second update with outdated baseVersion "1" fails with 409
    const conflictRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/food/${foodRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "1",
        portionDescription: "another update",
      },
    });
    assert.equal(conflictRes.statusCode, 409);
    const conflictBody = conflictRes.json<{ error: { code: string } }>();
    assert.equal(conflictBody.error.code, "CONCURRENCY_CONFLICT");
  });

  // FO-06: User B cannot access or modify Baby A's food records
  await t.test("FO-06: User B cannot access or modify Baby A's food records", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/food`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(listRes.statusCode, 403);

    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/food/${foodRecordId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(getRes.statusCode, 403);

    const patchRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${babyAId}/records/food/${foodRecordId}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { baseVersion: "2", notes: "Unauthorized" },
    });
    assert.equal(patchRes.statusCode, 403);
  });

  // FO-07: Delete food record soft-deletes and removes active timeline projection
  await t.test("FO-07: Delete food record soft-deletes and removes active timeline", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/records/food/${foodRecordId}?baseVersion=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(delRes.statusCode, 200);
    const delBody = delRes.json<{ data: { id: string; deleted: boolean } }>();
    assert.equal(delBody.data.id, foodRecordId);
    assert.equal(delBody.data.deleted, true);

    // Record is no longer retrievable via GET
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/records/food/${foodRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(getRes.statusCode, 404);

    // Timeline entry is marked deleted
    const { rows: tlRows } = await ctx.pool.query(
      `SELECT * FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'food'`,
      [foodRecordId]
    );
    assert.equal(tlRows.length, 1);
    assert.ok(tlRows[0].deleted_at !== null);

    // Active timeline returns 0
    const { rows: activeTlRows } = await ctx.pool.query(
      `SELECT * FROM timeline_entries WHERE entity_id = $1 AND entity_type = 'food' AND deleted_at IS NULL`,
      [foodRecordId]
    );
    assert.equal(activeTlRows.length, 0);
  });

  // FO-08: Food Library Items (create custom and list items)
  await t.test("FO-08: Food Library Items management", async () => {
    // Create custom food item in Family A
    const createRes = await app.inject({
      method: "POST",
      url: "/api/v1/food/items",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: "Grandma's Organic Mashed Sweet Potato",
        category: "vegetable",
        allergenRisk: "low",
        recommendedAgeMonths: 6,
      },
    });
    assert.equal(createRes.statusCode, 201, `Create food item failed: ${createRes.payload}`);
    const createdItem = createRes.json<{ id: string; name: string }>();
    assert.ok(createdItem.id);
    assert.equal(createdItem.name, "Grandma's Organic Mashed Sweet Potato");

    // List food items for User A includes the custom item
    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/food/items",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = listRes.json<{ data: Array<{ id: string; name: string }> }>();
    assert.ok(listBody.data.some((i) => i.id === createdItem.id));

    // Add User A to a second family. The omitted legacy scope must stop being
    // ambiguous, while an explicit authorized family continues to work.
    const inviteRes = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyBId}/invites`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { expiresInDays: 7 },
    });
    assert.equal(inviteRes.statusCode, 201, `Create family B invite failed: ${inviteRes.payload}`);
    const inviteCode = inviteRes.json<{ data: { inviteCode: string } }>().data.inviteCode;
    const joinRes = await app.inject({
      method: "POST",
      url: "/api/v1/families/join",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { inviteCode },
    });
    assert.equal(joinRes.statusCode, 200, `Join family B failed: ${joinRes.payload}`);

    const ambiguousList = await app.inject({
      method: "GET",
      url: "/api/v1/food/items",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(ambiguousList.statusCode, 400);
    assert.equal(ambiguousList.json<{ error: { code: string } }>().error.code, "FAMILY_SELECTION_REQUIRED");

    const familyAList = await app.inject({
      method: "GET",
      url: `/api/v1/food/items?familyId=${familyAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(familyAList.statusCode, 200);
    assert.ok(familyAList.json<{ data: Array<{ id: string }> }>().data.some((i) => i.id === createdItem.id));

    const familyBCreate = await app.inject({
      method: "POST",
      url: "/api/v1/food/items",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        familyId: familyBId,
        tried: true,
        name: "Family B custom food",
        category: "fruit",
        allergenRisk: "low",
        recommendedAgeMonths: 8,
      },
    });
    assert.equal(familyBCreate.statusCode, 201, `Create family B food failed: ${familyBCreate.payload}`);
    const familyBItem = familyBCreate.json<{ id: string; familyStatus?: { tried: boolean } }>();
    assert.equal(familyBItem.familyStatus?.tried, true);

    const familyAAfterBCreate = await app.inject({
      method: "GET",
      url: `/api/v1/food/items?familyId=${familyAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(familyAAfterBCreate.statusCode, 200);
    assert.ok(!familyAAfterBCreate.json<{ data: Array<{ id: string }> }>().data.some((i) => i.id === familyBItem.id));

    const familyBList = await app.inject({
      method: "GET",
      url: `/api/v1/food/items?familyId=${familyBId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(familyBList.statusCode, 200);
    const familyBItems = familyBList.json<{ data: Array<{ id: string; familyStatus?: { tried: boolean } }> }>().data;
    assert.ok(familyBItems.some((i) => i.id === familyBItem.id));
    assert.equal(familyBItems.find((i) => i.id === familyBItem.id)?.familyStatus?.tried, true);

    // A principal from another tenant cannot use an explicit familyId to
    // read or create in Family A.
    const crossFamilyList = await app.inject({
      method: "GET",
      url: `/api/v1/food/items?familyId=${familyAId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(crossFamilyList.statusCode, 403);
    const crossFamilyCreate = await app.inject({
      method: "POST",
      url: "/api/v1/food/items",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        familyId: familyAId,
        name: "Cross family food",
        category: "fruit",
        allergenRisk: "low",
        recommendedAgeMonths: 8,
      },
    });
    assert.equal(crossFamilyCreate.statusCode, 403);
  });

  // FO-09: Food Guidelines
  await t.test("FO-09: Food Guidelines returns age-stage guidance", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/food/guidelines",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{
      data: Array<{ monthAge: number; title: string; forbiddenFoods: string[] }>;
    }>();
    assert.ok(body.data.length >= 4);
    assert.ok(body.data.some((g) => g.monthAge === 6));
    assert.ok(body.data.some((g) => g.forbiddenFoods.includes("honey")));
  });

  // FO-10: Baby Food Plan
  await t.test("FO-10: Baby Food Plan save and get with tenant isolation", async () => {
    const emptyRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyBId}/food-plan`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(emptyRes.statusCode, 200);
    const emptyBody = emptyRes.json<{
      data: { id: string | null; babyId: string; planData: Record<string, unknown>; createdAt: string | null; version: string };
    }>();
    assert.equal(emptyBody.data.id, null);
    assert.equal(emptyBody.data.createdAt, null);
    assert.equal(emptyBody.data.version, "0");

    const [firstCreate, competingCreate] = await Promise.all([
      app.inject({
        method: "PUT",
        url: `/api/v1/babies/${babyBId}/food-plan`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { baseVersion: "0", planData: { week: "test_first_create" } },
      }),
      app.inject({
        method: "PUT",
        url: `/api/v1/babies/${babyBId}/food-plan`,
        headers: { authorization: `Bearer ${tokenB}` },
        payload: { baseVersion: "0", planData: { week: "test_competing_create" } },
      }),
    ]);
    assert.deepEqual(
      [firstCreate.statusCode, competingCreate.statusCode].sort((a, b) => a - b),
      [200, 409],
    );

    // Save food plan for Baby A
    const saveRes = await app.inject({
      method: "PUT",
      url: `/api/v1/babies/${babyAId}/food-plan`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "0",
        planData: {
          week: "2026-W37",
          days: {
            monday: ["iron_cereal", "avocado"],
            tuesday: ["iron_cereal", "pumpkin"],
          },
        },
      },
    });
    assert.equal(saveRes.statusCode, 200);
    const saveBody = saveRes.json<{
      data: { id: string; babyId: string; planData: { week: string }; createdAt: string; updatedAt: string; version: string };
    }>();
    assert.match(saveBody.data.id, /^[0-9a-f-]{36}$/i);
    assert.equal(saveBody.data.babyId, babyAId);
    assert.equal(saveBody.data.planData.week, "2026-W37");
    assert.match(saveBody.data.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(saveBody.data.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(saveBody.data.version, "1");

    const missingPrecondition = await app.inject({
      method: "PUT",
      url: `/api/v1/babies/${babyAId}/food-plan`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { planData: { week: "test_missing_base_version" } },
    });
    assert.equal(missingPrecondition.statusCode, 409, missingPrecondition.payload);

    // Get food plan for Baby A
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/food-plan`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(getRes.statusCode, 200);
    const getBody = getRes.json<{
      data: { id: string; babyId: string; planData: { week: string }; createdAt: string; version: string };
    }>();
    assert.equal(getBody.data.id, saveBody.data.id);
    assert.equal(getBody.data.planData.week, "2026-W37");
    assert.equal(getBody.data.createdAt, saveBody.data.createdAt);
    assert.equal(getBody.data.version, "1");

    // User B cannot access Baby A's food plan
    const forbiddenRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/food-plan`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(forbiddenRes.statusCode, 403);

    const forbiddenWriteRes = await app.inject({
      method: "PUT",
      url: `/api/v1/babies/${babyAId}/food-plan`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { baseVersion: "0", planData: { week: "test_cross_family_write" } },
    });
    assert.equal(forbiddenWriteRes.statusCode, 403);
  });

  await t.test("FO-11: stale full-plan writes conflict and retry preserves both changes", async () => {
    const initial = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/food-plan`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(initial.statusCode, 200);
    const initialBody = initial.json<{
      data: { id: string; planData: Record<string, unknown>; version: string };
    }>();
    assert.equal(initialBody.data.version, "1");

    const writerAPlan = {
      ...initialBody.data.planData,
      recipeDraft: "test_writer_a",
    };
    const writerBPlan = {
      ...initialBody.data.planData,
      supplementState: { defaultFormulaId: "test_formula_writer_b" },
    };
    const [writerA, writerB] = await Promise.all([
      app.inject({
        method: "PUT",
        url: `/api/v1/babies/${babyAId}/food-plan`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { baseVersion: initialBody.data.version, planData: writerAPlan },
      }),
      app.inject({
        method: "PUT",
        url: `/api/v1/babies/${babyAId}/food-plan`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { baseVersion: initialBody.data.version, planData: writerBPlan },
      }),
    ]);
    const statuses = [writerA.statusCode, writerB.statusCode].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);

    const winner = writerA.statusCode === 200 ? writerA : writerB;
    const stale = writerA.statusCode === 409 ? writerA : writerB;
    assert.equal(stale.statusCode, 409, stale.payload);
    const winnerBody = winner.json<{
      data: { id: string; babyId: string; planData: Record<string, unknown>; createdAt: string; version: string };
    }>();
    assert.equal(winnerBody.data.id, initialBody.data.id);
    assert.equal(winnerBody.data.version, "2");
    assert.match(winnerBody.data.createdAt, /^\d{4}-\d{2}-\d{2}T/);

    const mergedPlan = {
      ...winnerBody.data.planData,
      recipeDraft: "test_writer_a",
      supplementState: { defaultFormulaId: "test_formula_writer_b" },
    };
    const retry = await app.inject({
      method: "PUT",
      url: `/api/v1/babies/${babyAId}/food-plan`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { baseVersion: winnerBody.data.version, planData: mergedPlan },
    });
    assert.equal(retry.statusCode, 200, retry.payload);
    const retryBody = retry.json<{
      data: { id: string; planData: Record<string, unknown>; createdAt: string; version: string };
    }>();
    assert.equal(retryBody.data.id, initialBody.data.id);
    assert.equal(retryBody.data.version, "3");
    assert.equal(retryBody.data.planData.recipeDraft, "test_writer_a");
    assert.deepEqual(retryBody.data.planData.supplementState, { defaultFormulaId: "test_formula_writer_b" });
    assert.equal(retryBody.data.createdAt, winnerBody.data.createdAt);

    const final = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/food-plan`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(final.statusCode, 200);
    const finalBody = final.json<{
      data: { id: string; planData: Record<string, unknown>; createdAt: string; version: string };
    }>();
    assert.equal(finalBody.data.id, initialBody.data.id);
    assert.equal(finalBody.data.version, "3");
    assert.equal(finalBody.data.planData.recipeDraft, "test_writer_a");
    assert.deepEqual(finalBody.data.planData.supplementState, { defaultFormulaId: "test_formula_writer_b" });
    assert.equal(finalBody.data.createdAt, winnerBody.data.createdAt);
  });
});
