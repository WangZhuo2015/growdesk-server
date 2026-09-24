/** Run only through scripts/test-integration.py against its owned PostgreSQL instance. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";

interface OwnedRun {
  directory: string;
  database: string;
  user: string;
  password: string;
  pgPort: number;
  redisPort: number;
}

function readOwnedRun(): OwnedRun {
  const manifest = process.env.BOOT02_RUN_FILE;
  if (!manifest) throw new Error("Integration tests require the managed test runner");
  const real = fs.realpathSync(manifest);
  const parent = path.dirname(real);
  const stat = fs.statSync(real);
  if (
    path.dirname(parent) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(parent).startsWith("growdesk-integration-") ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077)
  ) throw new Error("Unsafe integration manifest");
  const run = JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
  if (run.directory !== parent || run.database !== "test_growdesk_integration" || run.user !== "test_runner") {
    throw new Error("Not an owned test database");
  }
  return run;
}

test("AgentVoiceLog routes persist history and enforce baby/family membership", async (t) => {
  const run = readOwnedRun();
  const database = createDatabaseContext({
    url: requireTestDatabaseUrl(
      `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
      { host: "127.0.0.1", port: run.pgPort, database: run.database, role: run.user, password: run.password },
    ),
  });
  const app = buildApiApp({ databaseContext: database, jwtSecret: "test_voice_logs_secret_at_least_32_characters" });
  const familyIds: string[] = [];
  const userIds: string[] = [];

  t.after(async () => {
    try {
      if (familyIds.length) await database.prisma.family.deleteMany({ where: { id: { in: familyIds } } });
      if (userIds.length) {
        await database.prisma.user.deleteMany({
          where: { id: { in: userIds }, username: { startsWith: "test_voice_logs_" } },
        });
      }
    } finally {
      await app.close();
      await database.close();
    }
  });

  async function register(label: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: `test_voice_logs_${label}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        password: "TestPassword123!",
        displayName: `test_voice_logs_${label}`,
      },
    });
    assert.equal(response.statusCode, 201, response.payload);
    const auth = response.json<{ data: { accessToken: string; user: { id: string } } }>().data;
    userIds.push(auth.user.id);
    const headers = { authorization: `Bearer ${auth.accessToken}` };
    const families = await app.inject({ method: "GET", url: "/api/v1/families", headers });
    assert.equal(families.statusCode, 200, families.payload);
    const familyId = families.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    assert.ok(familyId);
    familyIds.push(familyId);
    return { headers, familyId };
  }

  const owner = await register("owner");
  const other = await register("other");
  const babyResponse = await app.inject({
    method: "POST",
    url: `/api/v1/families/${owner.familyId}/babies`,
    headers: owner.headers,
    payload: { name: "test_voice_logs_baby", birthDate: "2026-01-01", gender: "girl" },
  });
  assert.equal(babyResponse.statusCode, 201, babyResponse.payload);
  const babyId = babyResponse.json<{ data: { id: string } }>().data.id;

  const create = await app.inject({
    method: "POST",
    url: "/api/v1/voice/logs",
    headers: owner.headers,
    payload: {
      babyId,
      prompt: "test_voice_prompt",
      reply: "test_voice_reply",
      isAsync: true,
      isFastPath: false,
      acknowledged: false,
    },
  });
  assert.equal(create.statusCode, 201, create.payload);
  const created = create.json<{ data: { id: string; userId: string; familyId: string; babyId: string; acknowledged: boolean; baby: { nickname: string } } }>().data;
  assert.equal(created.familyId, owner.familyId);
  assert.equal(created.babyId, babyId);
  assert.equal(created.acknowledged, false);
  assert.equal(created.baby.nickname, "test_voice_logs_baby");

  const listed = await app.inject({ method: "GET", url: "/api/v1/voice/logs?limit=20", headers: owner.headers });
  assert.equal(listed.statusCode, 200, listed.payload);
  assert.deepEqual(listed.json<{ data: Array<{ id: string }> }>().data.map((row) => row.id), [created.id]);

  const unread = await app.inject({ method: "GET", url: "/api/v1/voice/logs?unreadAsync=true", headers: owner.headers });
  assert.equal(unread.statusCode, 200, unread.payload);
  assert.equal(unread.json<{ data: { id: string } | null }>().data?.id, created.id);

  const foreignList = await app.inject({ method: "GET", url: "/api/v1/voice/logs", headers: other.headers });
  assert.equal(foreignList.statusCode, 200, foreignList.payload);
  assert.deepEqual(foreignList.json<{ data: unknown[] }>().data, []);
  const foreignGet = await app.inject({ method: "GET", url: `/api/v1/voice/logs/${created.id}`, headers: other.headers });
  assert.equal(foreignGet.statusCode, 404, foreignGet.payload);
  const foreignAck = await app.inject({ method: "PATCH", url: `/api/v1/voice/logs/${created.id}`, headers: other.headers, payload: { acknowledged: true } });
  assert.equal(foreignAck.statusCode, 404, foreignAck.payload);
  const foreignCreate = await app.inject({ method: "POST", url: "/api/v1/voice/logs", headers: other.headers, payload: {
    babyId, prompt: "test_foreign_prompt", reply: "test_foreign_reply",
  } });
  assert.equal(foreignCreate.statusCode, 403, foreignCreate.payload);

  const ack = await app.inject({ method: "PATCH", url: `/api/v1/voice/logs/${created.id}`, headers: owner.headers, payload: { acknowledged: true } });
  assert.equal(ack.statusCode, 200, ack.payload);
  const unreadAfterAck = await app.inject({ method: "GET", url: "/api/v1/voice/logs?unreadAsync=true", headers: owner.headers });
  assert.equal(unreadAfterAck.statusCode, 200, unreadAfterAck.payload);
  assert.equal(unreadAfterAck.json<{ data: unknown | null }>().data, null);

  await t.test("revoked baby access removes old history from every operation", async () => {
    const ownerUser = await database.prisma.user.findUniqueOrThrow({ where: { id: userIds[0] }, select: { id: true } });
    await database.prisma.babyMember.updateMany({ where: { babyId, userId: ownerUser.id }, data: { status: "revoked", deletedAt: new Date() } });
    const hiddenList = await app.inject({ method: "GET", url: "/api/v1/voice/logs", headers: owner.headers });
    assert.equal(hiddenList.statusCode, 200, hiddenList.payload);
    assert.deepEqual(hiddenList.json<{ data: unknown[] }>().data, []);
    const hiddenGet = await app.inject({ method: "GET", url: `/api/v1/voice/logs/${created.id}`, headers: owner.headers });
    assert.equal(hiddenGet.statusCode, 404, hiddenGet.payload);
    const hiddenAck = await app.inject({ method: "PATCH", url: `/api/v1/voice/logs/${created.id}`, headers: owner.headers, payload: { acknowledged: false } });
    assert.equal(hiddenAck.statusCode, 404, hiddenAck.payload);
  });
});
