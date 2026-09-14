import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import { canonicalJsonStringify } from "../../packages/contracts/src/common.js";

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

test("SH-07: AI Sessions, Runs & Lifecycle suite", async (t) => {
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
  const previousProvider = process.env.GROWDESK_AI_PROVIDER;
  const previousFixture = process.env.GROWDESK_AI_FIXTURE_TEXT;
  process.env.GROWDESK_AI_PROVIDER = "fixture";
  process.env.GROWDESK_AI_FIXTURE_TEXT = "integration fixture";
  t.after(() => {
    if (previousProvider === undefined) delete process.env.GROWDESK_AI_PROVIDER;
    else process.env.GROWDESK_AI_PROVIDER = previousProvider;
    if (previousFixture === undefined) delete process.env.GROWDESK_AI_FIXTURE_TEXT;
    else process.env.GROWDESK_AI_FIXTURE_TEXT = previousFixture;
  });
  const ctx = createDatabaseContext({ url });
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret,
  });

  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  // Ensure all migrations up to 202609130011_tasks_and_ai are applied
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
      // Ignore if table/type already exists
    }
  }

  let tokenA = "";
  let familyAId = "";
  let babyAId = "";
  let tokenB = "";
  let familyBId = "";
  let babyBId = "";

  const stamp = Date.now();
  const userA = `test_ai_a_${stamp}`;
  const userB = `test_ai_b_${stamp}`;

  await t.test("Setup: Register User A and User B, create families and babies", async () => {
    // User A
    const regResA = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userA,
        password: "Password123!",
        displayName: "User A",
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
    familyAId = famListA[0].id;

    const babyResA = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyAId}/babies`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        name: "Baby A",
        birthDate: "2025-06-01",
        gender: "girl",
      },
    });
    assert.equal(babyResA.statusCode, 201, `Create baby failed: ${babyResA.payload}`);
    babyAId = babyResA.json<{ data: { id: string } }>().data.id;

    // User B
    const regResB = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: userB,
        password: "Password123!",
        displayName: "User B",
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
    familyBId = famListB[0].id;

    const babyResB = await app.inject({
      method: "POST",
      url: `/api/v1/families/${familyBId}/babies`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        name: "Baby B",
        birthDate: "2025-07-01",
        gender: "boy",
      },
    });
    assert.equal(babyResB.statusCode, 201, `Create baby failed: ${babyResB.payload}`);
    babyBId = babyResB.json<{ data: { id: string } }>().data.id;
  });

  let sessionAId = "";
  let runAId = "";

  await t.test("AI-01: Create AI session and list messages", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/ai/sessions",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        babyId: babyAId,
        title: "成长记录问答",
      },
    });

    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.payload);
    assert.ok(body.data.id);
    assert.equal(body.data.title, "成长记录问答");
    assert.equal(body.data.babyId, babyAId);
    sessionAId = body.data.id;

    // List sessions
    const listRes = await app.inject({
      method: "GET",
      url: "/api/v1/ai/sessions",
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.payload);
    assert.ok(listBody.data.length >= 1);
    assert.equal(listBody.data[0].id, sessionAId);
  });

  await t.test("AI-02: Create AI run returns 202 with unified TaskExecution and AiRun", async () => {
    const clientMsgId = crypto.randomUUID();
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${sessionAId}/runs`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        clientMessageId: clientMsgId,
        message: "宝宝今天喝了 150ml 奶粉，帮我记录一下",
      },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.payload);
    assert.ok(body.data.id);
    assert.equal(body.data.status, "queued");
    assert.equal(body.data.sessionId, sessionAId);
    runAId = body.data.id;

    // Verify message was recorded in session
    const msgRes = await app.inject({
      method: "GET",
      url: `/api/v1/ai/sessions/${sessionAId}/messages`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(msgRes.statusCode, 200);
    const msgBody = JSON.parse(msgRes.payload);
    assert.equal(msgBody.data.length, 1);
    assert.equal(msgBody.data[0].content, "宝宝今天喝了 150ml 奶粉，帮我记录一下");
    assert.equal(msgBody.data[0].role, "user");

    // Verify task_executions and task_outbox exist in database
    const taskRows = await ctx.pool.query(
      "SELECT * FROM task_executions WHERE id = $1",
      [runAId]
    );
    assert.equal(taskRows.rowCount, 1);
    assert.equal(taskRows.rows[0].kind, "ai_chat_run");
    assert.equal(taskRows.rows[0].status, "queued");

    const outboxRows = await ctx.pool.query(
      "SELECT * FROM task_outbox WHERE aggregate_id = $1",
      [runAId]
    );
    assert.equal(outboxRows.rowCount, 1);
    assert.equal(outboxRows.rows[0].dispatch_state, "active");
  });

  await t.test("AI-03: Get AI run status matches current state", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/ai/runs/${runAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.payload);
    assert.equal(body.data.id, runAId);
    assert.equal(body.data.status, "queued");
  });

  const testActionId = crypto.randomUUID();
  const testPlanActions = [
    {
      actionId: testActionId,
      entityType: "feeding",
      operation: "create",
      summary: "记录配方奶 150ml",
      payload: {
        feedingType: "formula",
        occurredAt: new Date().toISOString(),
        amountMl: "150.0",
      },
    },
  ];
  const testPlanHash = crypto.createHash("sha256").update(canonicalJsonStringify(testPlanActions)).digest("hex");

  await t.test("AI-04: Confirming proposed actions requires awaiting_confirmation state", async () => {
    // Attempting to confirm while queued fails with 409
    const failRes = await app.inject({
      method: "POST",
      url: `/api/v1/ai/runs/${runAId}/confirm`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        planHash: testPlanHash,
        actionIds: [testActionId],
      },
    });
    assert.equal(failRes.statusCode, 409);

    // Simulate worker parking the task with a proposed plan
    const proposedPlan = {
      planHash: testPlanHash,
      actions: testPlanActions,
      expiresAt: new Date(Date.now() + 1800_000).toISOString(),
    };

    await ctx.pool.query(
      `UPDATE task_executions SET status = 'awaiting_confirmation' WHERE id = $1`,
      [runAId]
    );
    await ctx.pool.query(
      `UPDATE ai_runs SET proposed_plan = $2 WHERE id = $1`,
      [runAId, JSON.stringify(proposedPlan)]
    );

    // Verify GET reflects awaiting_confirmation
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/ai/runs/${runAId}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(getRes.statusCode, 200);
    assert.equal(JSON.parse(getRes.payload).data.status, "awaiting_confirmation");

    // Now confirm succeeds
    const confirmRes = await app.inject({
      method: "POST",
      url: `/api/v1/ai/runs/${runAId}/confirm`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        planHash: testPlanHash,
        actionIds: [testActionId],
      },
    });
    assert.equal(confirmRes.statusCode, 200);
    const confirmBody = JSON.parse(confirmRes.payload);
    assert.equal(confirmBody.data.status, "succeeded");
    assert.equal(confirmBody.data.appliedActionCount, 1);

    // Verify task_executions is updated
    const taskRows = await ctx.pool.query(
      "SELECT status FROM task_executions WHERE id = $1",
      [runAId]
    );
    assert.equal(taskRows.rows[0].status, "succeeded");
  });

  await t.test("AI-05: Cancelling run updates task state", async () => {
    // Create a new run to cancel
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${sessionAId}/runs`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        clientMessageId: crypto.randomUUID(),
        message: "计算一下最近体重的百分位",
      },
    });
    assert.equal(res.statusCode, 202);
    const newRunId = JSON.parse(res.payload).data.id;

    const cancelRes = await app.inject({
      method: "POST",
      url: `/api/v1/ai/runs/${newRunId}/cancel`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(cancelRes.statusCode, 200);
    assert.deepEqual(JSON.parse(cancelRes.payload), { data: { success: true } });

    // Verify cancel request is recorded in database
    const taskRows = await ctx.pool.query(
      "SELECT cancel_requested_at FROM task_executions WHERE id = $1",
      [newRunId]
    );
    assert.ok(taskRows.rows[0].cancel_requested_at);
  });

  await t.test("AI-06: Retrying failed run increments attempt and re-enqueues", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/ai/sessions/${sessionAId}/runs`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        clientMessageId: crypto.randomUUID(),
        message: "失败任务重试测试",
      },
    });
    const runId = JSON.parse(res.payload).data.id;

    // Simulate task failure on attempt 1
    await ctx.pool.query(
      "UPDATE task_executions SET status = 'failed', attempt = 1, error_details = '{\"code\":\"MODEL_TIMEOUT\"}'::jsonb WHERE id = $1",
      [runId]
    );

    const retryRes = await app.inject({
      method: "POST",
      url: `/api/v1/ai/runs/${runId}/retry`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(retryRes.statusCode, 202);
    const retryBody = JSON.parse(retryRes.payload);
    assert.equal(retryBody.data.status, "queued");
    assert.equal(retryBody.data.newAttempt, 2);

    const taskRows = await ctx.pool.query(
      "SELECT status, attempt FROM task_executions WHERE id = $1",
      [runId]
    );
    assert.equal(taskRows.rows[0].status, "queued");
    assert.equal(taskRows.rows[0].attempt, 2);
  });

  await t.test("AI-07: User B cannot access, read or confirm User A's AI run (404/403)", async () => {
    // User B trying to access User A's run -> 404
    const getRes = await app.inject({
      method: "GET",
      url: `/api/v1/ai/runs/${runAId}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(getRes.statusCode, 404);

    // User B trying to confirm User A's run -> 404
    const confirmRes = await app.inject({
      method: "POST",
      url: `/api/v1/ai/runs/${runAId}/confirm`,
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        planHash: testPlanHash,
        actionIds: [testActionId],
      },
    });
    assert.equal(confirmRes.statusCode, 404);
  });

  await t.test("AI-08: Voice Run creation and Baby access validation", async () => {
    const attachmentId = crypto.randomUUID();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/voice/runs",
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        babyId: babyAId,
        attachmentId,
        clientRequestId: crypto.randomUUID(),
      },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.payload);
    assert.ok(body.data.runId);
    assert.equal(body.data.status, "queued");

    // User B trying to queue voice run for Baby A fails with 403
    const forbiddenRes = await app.inject({
      method: "POST",
      url: "/api/v1/voice/runs",
      headers: { authorization: `Bearer ${tokenB}` },
      payload: {
        babyId: babyAId,
        attachmentId,
        clientRequestId: crypto.randomUUID(),
      },
    });
    assert.equal(forbiddenRes.statusCode, 403);
  });

  await t.test("AI-09: Daily summary creation and listing with tenant boundary", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/daily-summaries/runs`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {
        targetDate: "2026-09-12",
      },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.payload);
    assert.ok(body.data.runId);
    assert.equal(body.data.status, "queued");

    // Insert a completed daily summary row directly into daily_summaries to test GET
    await ctx.pool.query(
      `INSERT INTO daily_summaries (id, baby_id, family_id, target_date, content, version)
       VALUES ($1, $2, $3, $4, $5, 1)`,
      [
        crypto.randomUUID(),
        babyAId,
        familyAId,
        "2026-09-12",
        "宝宝今天喝奶 750ml，睡眠 13 小时，精神状态良好。",
      ]
    );

    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/daily-summaries`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    assert.equal(listRes.statusCode, 200);
    const listBody = JSON.parse(listRes.payload);
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].targetDate, "2026-09-12");
    assert.ok(listBody.data[0].content.includes("750ml"));

    // User B cannot list Baby A's daily summaries (403)
    const forbiddenRes = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${babyAId}/daily-summaries`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    assert.equal(forbiddenRes.statusCode, 403);
  });
});
