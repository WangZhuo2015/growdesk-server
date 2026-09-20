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

test("SH-09: durable RecordSnapshot delete/restore is scoped, atomic and replay safe", async (t) => {
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
  const ctx = createDatabaseContext({ url });
  const app = buildApiApp({ databaseContext: ctx, jwtSecret: "integration-test-auth-secret-min-32-chars-long!" });
  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  const stamp = Date.now();
  const userA = `test_snapshot_a_${stamp}`;
  const userB = `test_snapshot_b_${stamp}`;
  const register = async (username: string) => {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username, password: "ValidPassword123!", displayName: username } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ data: { accessToken: string } }>().data.accessToken;
  };
  const familyFor = async (token: string) => (await app.inject({ method: "GET", url: "/api/v1/families", headers: { authorization: `Bearer ${token}` } })).json<{ data: Array<{ id: string }> }>().data[0]!.id;
  const createBaby = async (token: string, familyId: string) => {
    const response = await app.inject({ method: "POST", url: `/api/v1/families/${familyId}/babies`, headers: { authorization: `Bearer ${token}` }, payload: { name: `test_snapshot_baby_${stamp}`, birthDate: "2025-01-01", gender: "girl" } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ data: { id: string } }>().data.id;
  };

  const tokenA = await register(userA);
  const familyAId = await familyFor(tokenA);
  const babyAId = await createBaby(tokenA, familyAId);
  const tokenB = await register(userB);

  const createFeeding = async (notes: string) => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/records/feeding`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { feedingType: "bottle", occurredAt: "2026-09-12T08:00:00.000Z", amountMl: "120", notes },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ data: { id: string; version: string } }>().data;
  };

  await t.test("delete captures the full row and accepts an absent body", async () => {
    const feeding = await createFeeding("test_snapshot_atomic");
    const response = await app.inject({ method: "DELETE", url: `/api/v1/babies/${babyAId}/record-snapshots/feeding/${feeding.id}`, headers: { authorization: `Bearer ${tokenA}` } });
    assert.equal(response.statusCode, 200, response.body);
    const snapshotId = response.json<{ data: { snapshotId: string; version: string } }>().data.snapshotId;
    assert.ok(snapshotId);
    const snapshot = await ctx.prisma.recordSnapshot.findUnique({ where: { id: snapshotId } });
    assert.equal(snapshot?.entityType, "feeding");
    assert.equal((snapshot?.payload as { notes?: string }).notes, "test_snapshot_atomic");
    assert.equal(snapshot?.payloadHash.length, 64);
    assert.equal((await ctx.prisma.feedingRecord.findUnique({ where: { id: feeding.id } }))?.deletedAt !== null, true);
  });

  await t.test("explicit restore survives service statelessness and is idempotent", async () => {
    const feeding = await createFeeding("test_snapshot_restore");
    const deleteResponse = await app.inject({ method: "DELETE", url: `/api/v1/babies/${babyAId}/record-snapshots/feeding/${feeding.id}`, headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": `test_snapshot_delete_${stamp}` }, payload: {} });
    assert.equal(deleteResponse.statusCode, 200, deleteResponse.body);
    const snapshotId = deleteResponse.json<{ data: { snapshotId: string } }>().data.snapshotId;
    const restoreResponse = await app.inject({ method: "POST", url: `/api/v1/babies/${babyAId}/record-snapshots/${snapshotId}/restore`, headers: { authorization: `Bearer ${tokenA}` }, payload: {} });
    assert.equal(restoreResponse.statusCode, 200, restoreResponse.body);
    assert.equal(restoreResponse.json<{ data: { restoredId: string } }>().data.restoredId, feeding.id);
    assert.equal((await ctx.prisma.feedingRecord.findUnique({ where: { id: feeding.id } }))?.deletedAt, null);
    const replay = await app.inject({ method: "POST", url: `/api/v1/babies/${babyAId}/record-snapshots/${snapshotId}/restore`, headers: { authorization: `Bearer ${tokenA}` }, payload: {} });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(replay.json<{ data: { replayed?: boolean } }>().data.replayed, true);
  });

  await t.test("same idempotency key replays the original delete result", async () => {
    const feeding = await createFeeding("test_snapshot_replay");
    const url = `/api/v1/babies/${babyAId}/record-snapshots/feeding/${feeding.id}`;
    const first = await app.inject({ method: "DELETE", url, headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": `test_snapshot_replay_${stamp}` }, payload: {} });
    const second = await app.inject({ method: "DELETE", url, headers: { authorization: `Bearer ${tokenA}`, "idempotency-key": `test_snapshot_replay_${stamp}` }, payload: {} });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json<{ data: { snapshotId: string } }>().data.snapshotId, first.json<{ data: { snapshotId: string } }>().data.snapshotId);
  });

  await t.test("concurrent explicit restores serialize into one restore and one replay", async () => {
    const feeding = await createFeeding("test_snapshot_concurrent_restore");
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${babyAId}/record-snapshots/feeding/${feeding.id}`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {},
    });
    assert.equal(deletion.statusCode, 200, deletion.body);
    const snapshotId = deletion.json<{ data: { snapshotId: string } }>().data.snapshotId;
    const restoreRequest = () => app.inject({
      method: "POST",
      url: `/api/v1/babies/${babyAId}/record-snapshots/${snapshotId}/restore`,
      headers: { authorization: `Bearer ${tokenA}` },
      payload: {},
    });
    const responses = await Promise.all([restoreRequest(), restoreRequest()]);
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    const replayFlags = responses.map((response) => response.json<{ data: { replayed?: boolean } }>().data.replayed === true);
    assert.deepEqual(replayFlags.sort(), [false, true]);
    assert.equal((await ctx.prisma.feedingRecord.findUnique({ where: { id: feeding.id } }))?.deletedAt, null);
  });

  await t.test("family scope and payload tamper are rejected", async () => {
    const crossFamily = await app.inject({ method: "GET", url: `/api/v1/babies/${babyAId}/record-snapshots`, headers: { authorization: `Bearer ${tokenB}` } });
    assert.equal(crossFamily.statusCode, 403, crossFamily.body);
    const feeding = await createFeeding("test_snapshot_tamper");
    const deletion = await app.inject({ method: "DELETE", url: `/api/v1/babies/${babyAId}/record-snapshots/feeding/${feeding.id}`, headers: { authorization: `Bearer ${tokenA}` }, payload: {} });
    const snapshotId = deletion.json<{ data: { snapshotId: string } }>().data.snapshotId;
    await ctx.prisma.recordSnapshot.update({ where: { id: snapshotId }, data: { payload: { tampered: true } } });
    const restore = await app.inject({ method: "POST", url: `/api/v1/babies/${babyAId}/record-snapshots/${snapshotId}/restore`, headers: { authorization: `Bearer ${tokenA}` }, payload: {} });
    assert.equal(restore.statusCode, 409, restore.body);
    assert.equal(restore.json<{ error: { code: string } }>().error.code, "SNAPSHOT_TAMPERED");
  });

  await t.test("food plan uses exact physical delete/restore semantics", async () => {
    const save = await app.inject({ method: "PUT", url: `/api/v1/babies/${babyAId}/food-plan`, headers: { authorization: `Bearer ${tokenA}` }, payload: { planData: { days: ["test_snapshot_day"] }, baseVersion: "0" } });
    assert.equal(save.statusCode, 200, save.body);
    const plan = save.json<{ data: { id: string; version: string } }>().data;
    const deletion = await app.inject({ method: "DELETE", url: `/api/v1/babies/${babyAId}/record-snapshots/food_plan/${plan.id}`, headers: { authorization: `Bearer ${tokenA}` }, payload: { baseVersion: plan.version } });
    assert.equal(deletion.statusCode, 200, deletion.body);
    const snapshotId = deletion.json<{ data: { snapshotId: string } }>().data.snapshotId;
    assert.equal(await ctx.prisma.babyFoodPlan.findUnique({ where: { id: plan.id } }), null);
    const restore = await app.inject({ method: "POST", url: `/api/v1/babies/${babyAId}/record-snapshots/${snapshotId}/restore`, headers: { authorization: `Bearer ${tokenA}` }, payload: {} });
    assert.equal(restore.statusCode, 200, restore.body);
    const restoredPlan = await ctx.prisma.babyFoodPlan.findUnique({ where: { id: plan.id } });
    assert.deepEqual(restoredPlan?.planData, { days: ["test_snapshot_day"] });
  });
});
