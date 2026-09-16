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

test("SH-06: Medical Reports, Vaccines & Notifications Pipeline suite", async (t) => {
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

  // Ensure all migrations up to 202609120010_attachments_medical_vaccines are applied
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
  ];

  for (const m of migrations) {
    const sql = fs.readFileSync(m, "utf8");
    try {
      await ctx.pool.query(sql);
    } catch {
      // Ignore existing
    }
  }

  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";
  let babyBId = "";

  const stamp = Date.now();
  const userA = `test_med_a_${stamp}`;
  const userB = `test_med_b_${stamp}`;

  await t.test("Setup: Register User A and User B, create babies", async () => {
    const regResA = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userA,
        password: "ValidPassword123!",
        displayName: "Caregiver Med A",
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
        name: "Baby Med A",
        birthDate: "2025-05-01",
        gender: "boy",
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
        displayName: "Caregiver Med B",
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

    const babyResB = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyBId}/babies`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        name: "Baby Med B",
        birthDate: "2025-07-01",
        gender: "girl",
      },
    });
    assert.equal(babyResB.statusCode, 201);
    babyBId = babyResB.json<{ data: { id: string } }>().data.id;
  });

  let report1Id = "";
  const idemKey = `med-key-${stamp}-1`;

  await t.test("MED-01: Create medical report and verify atomic timeline projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/medical/reports`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": idemKey,
      },
      payload: {
        reportDate: "2026-05-10",
        title: "6月龄健康体检与贫血筛查",
        hospital: "复旦大学附属儿科医院",
        department: "儿童保健科",
        diagnosis: "生长发育良好，血红蛋白偏低，建议加强铁剂与高铁米粉补充",
        notes: "医生嘱咐两周后复查血常规",
      },
    });

    assert.equal(res.statusCode, 201, `Failed: ${res.body}`);
    const body = JSON.parse(res.body);
    report1Id = body.data.id;
    assert.ok(report1Id);
    assert.equal(body.data.title, "6月龄健康体检与贫血筛查");
    assert.equal(body.data.version, "1");

    // Verify timeline projection
    const timelineRows = await ctx.prisma.timelineEntry.findMany({
      where: {
        familyId: familyAId,
        babyId: babyAId,
        entityType: "medical",
        entityId: report1Id,
        deletedAt: null,
      },
    });
    assert.equal(timelineRows.length, 1);
    assert.match(timelineRows[0]!.summary, /6月龄健康体检/);
  });

  await t.test("MED-02: Idempotency replay with same key returns cached result", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/medical/reports`,
      headers: {
        authorization: `Bearer ${tokenA}`,
        "idempotency-key": idemKey,
      },
      payload: {
        reportDate: "2026-05-10",
        title: "6月龄健康体检与贫血筛查",
      },
    });

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.data.id, report1Id);
  });

  await t.test("MED-03: Keyset pagination works stably across reports", async () => {
    // Create report 2 and report 3
    await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/medical/reports`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        reportDate: "2026-06-01",
        title: "幼儿急疹复诊",
      },
    });

    await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/medical/reports`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        reportDate: "2026-07-01",
        title: "发热血常规化验",
      },
    });

    // Fetch page 1 with limit 2
    const page1Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/medical/reports?limit=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(page1Res.statusCode, 200);
    const page1 = JSON.parse(page1Res.body);
    assert.equal(page1.data.length, 2);
    assert.ok(page1.page.nextCursor);

    // Fetch page 2
    const page2Res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/medical/reports?limit=2&cursor=${encodeURIComponent(page1.page.nextCursor)}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(page2Res.statusCode, 200);
    const page2 = JSON.parse(page2Res.body);
    assert.equal(page2.data.length, 1);
  });

  await t.test("MED-04: baseVersion optimistic concurrency conflict detection", async () => {
    // Update with wrong baseVersion
    const conflictRes = await app.inject({
      method: "PUT",
      url: `/api/v1/babies/${babyAId}/medical/reports/${report1Id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "99",
        title: "尝试冲突修改",
      },
    });
    assert.equal(conflictRes.statusCode, 409, `Conflict failed: ${conflictRes.body}`);

    // Update with correct baseVersion
    const validRes = await app.inject({
      method: "PUT",
      url: `/api/v1/babies/${babyAId}/medical/reports/${report1Id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        baseVersion: "1",
        title: "6月龄健康体检与贫血筛查(已复查)",
        notes: "复查血红蛋白恢复正常标准",
      },
    });
    assert.equal(validRes.statusCode, 200, `Valid update failed: ${validRes.body}`);
    const body = JSON.parse(validRes.body);
    assert.equal(body.data.version, "2");
    assert.equal(body.data.title, "6月龄健康体检与贫血筛查(已复查)");
  });

  await t.test("MED-05: User B cannot access Baby A's medical report", async () => {
    const resGet = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/medical/reports/${report1Id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resGet.statusCode, 403, `MED-05 GET failed: ${resGet.body}`);

    const resPut = await app.inject({
      method: "PUT",
      url: `/api/v1/babies/${babyAId}/medical/reports/${report1Id}`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        baseVersion: "2",
        title: "跨租户非法修改",
      },
    });
    assert.equal(resPut.statusCode, 403, `MED-05 PUT failed: ${resPut.body}`);
  });

  await t.test("MED-06: Delete medical report soft-deletes and removes timeline projection", async () => {
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/medical/reports/${report1Id}?baseVersion=2`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(delRes.statusCode, 200, `Delete failed: ${delRes.body}`);

    const deleted = await ctx.prisma.medicalReport.findUniqueOrThrow({ where: { id: report1Id } });
    assert.ok(deleted.deletedAt !== null);

    const timelineEntry = await ctx.prisma.timelineEntry.findFirst({
      where: {
        babyId: babyAId,
        entityType: "medical",
        entityId: report1Id,
        deletedAt: null,
      },
    });
    assert.equal(timelineEntry, null, "Timeline entry should be soft-deleted");
  });

  // Vaccines Suite
  await t.test("VAC-01: Get standard vaccine schedule returns recommendations", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/vaccines/schedule",
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 5);
    assert.ok(body.data.some((v: { vaccineCode: string }) => v.vaccineCode === "BCG"));
  });

  let vacRecordId = "";

  await t.test("VAC-02: Create vaccine record and verify atomic timeline projection", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/vaccines/records`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        vaccineCode: "HepB",
        administeredDate: "2025-05-01",
        clinic: "上海市徐汇区妇幼保健所",
        batchNumber: "HB20250401",
        notes: "第1剂乙肝疫苗，出生当日接种无异常",
      },
    });

    assert.equal(res.statusCode, 201, `Failed: ${res.body}`);
    const body = JSON.parse(res.body);
    vacRecordId = body.data.id;
    assert.ok(vacRecordId);
    assert.equal(body.data.vaccineCode, "HepB");

    // Verify timeline entry
    const timelineEntry = await ctx.prisma.timelineEntry.findFirst({
      where: {
        babyId: babyAId,
        entityType: "vaccine",
        entityId: vacRecordId,
        deletedAt: null,
      },
    });
    assert.ok(timelineEntry);
    assert.match(timelineEntry.summary, /HepB/);
  });

  await t.test("VAC-03: List vaccine records returns baby's vaccinations", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/vaccines/records`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.data.some((v: { id: string }) => v.id === vacRecordId));
  });

  await t.test("VAC-04: User B cannot access Baby A's vaccine records", async () => {
    const resList = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/vaccines/records`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resList.statusCode, 403);

    const resDel = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/vaccines/records/${vacRecordId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(resDel.statusCode, 403);
  });

  await t.test("VAC-05: Delete vaccine record removes record and timeline projection", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/vaccines/records/${vacRecordId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(res.statusCode, 200);

    const deleted = await ctx.prisma.vaccineRecord.findUniqueOrThrow({ where: { id: vacRecordId } });
    assert.ok(deleted.deletedAt !== null);

    const timelineEntry = await ctx.prisma.timelineEntry.findFirst({
      where: {
        babyId: babyAId,
        entityType: "vaccine",
        entityId: vacRecordId,
        deletedAt: null,
      },
    });
    assert.equal(timelineEntry, null);
  });

  // Notifications Suite
  await t.test("NOTIF-01: Push device registration and notification listing", async () => {
    const regRes = await app.inject({
      method: "PUT",
      url: "/api/v1/devices/install-ios-test-1/push",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        platform: "ios",
        environment: "sandbox",
        token: "apns_device_token_abc123",
        deviceLabel: "Mom's iPhone 16 Pro",
      },
    });
    assert.equal(regRes.statusCode, 200);

    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.body);
    assert.ok(Array.isArray(listBody.data));
  });
});
