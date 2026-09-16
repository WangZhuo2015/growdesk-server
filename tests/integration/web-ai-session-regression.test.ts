import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import { WebAiSessionService } from "../../apps/api/src/services/web-ai-session-service.js";
import type { WebAiSession, WebAiMessage } from "@growdesk/contracts";

interface Run { directory: string; database: string; user: string; password: string; pgPort: number }
function ownedRun(): Run {
  const manifest = process.env.BOOT02_RUN_FILE;
  if (!manifest) throw new Error("Use the owned integration runner");
  const file = fs.realpathSync(manifest); const dir = path.dirname(file); const stat = fs.statSync(file);
  if (path.dirname(dir) !== fs.realpathSync(os.tmpdir()) || !path.basename(dir).startsWith("growdesk-integration-") || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe integration manifest");
  const run = JSON.parse(fs.readFileSync(file, "utf8")) as Run;
  if (run.directory !== dir || !run.database.startsWith("test_") || !run.user.startsWith("test_")) throw new Error("Not an owned database");
  return run;
}

test("durable Web AI: real HTTP, PostgreSQL ownership, restart and idempotency", async t => {
  const run = ownedRun();
  const url = requireTestDatabaseUrl(`postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`, {
    host: "127.0.0.1", port: run.pgPort, database: run.database, role: run.user, password: run.password,
  });
  const database = createDatabaseContext({ url });
  const app = buildApiApp({ databaseContext: database, jwtSecret: "test_web_ai_state_secret_at_least_32_characters" });
  const users: string[] = []; const families: string[] = [];
  t.after(async () => {
    try {
      await database.prisma.family.deleteMany({ where: { id: { in: families } } });
      await database.prisma.user.deleteMany({ where: { id: { in: users }, username: { startsWith: "test_webai_" } } });
    } finally { await app.close(); await database.close(); }
  });
  async function tenant() {
    const registration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username: `test_webai_${randomUUID()}`, password: "TestWebAiPassword123!", displayName: "test_web_ai_user" } });
    assert.equal(registration.statusCode, 201, registration.payload);
    const identity = registration.json<{ data: { user: { id: string }; accessToken: string } }>().data;
    users.push(identity.user.id);
    const headers = { authorization: `Bearer ${identity.accessToken}` };
    const familyResponse = await app.inject({ method: "GET", url: "/api/v1/families", headers });
    assert.equal(familyResponse.statusCode, 200, familyResponse.payload);
    const familyId = familyResponse.json<{ data: Array<{ id: string }> }>().data[0]!.id;
    families.push(familyId);
    const babyResponse = await app.inject({ method: "POST", url: `/api/v1/families/${familyId}/babies`, headers, payload: { name: "test_web_ai_baby", gender: "other", birthDate: "2026-01-01" } });
    assert.equal(babyResponse.statusCode, 201, babyResponse.payload);
    return { userId: identity.user.id, familyId, babyId: babyResponse.json<{ data: { id: string } }>().data.id, headers };
  }
  const a = await tenant(); const b = await tenant();
  const endpoint = "/api/v1/web/ai/sessions";
  let sessionId = "";
  await t.test("reject anonymous requests and foreign baby ownership", async () => {
    assert.equal((await app.inject({ method: "GET", url: endpoint })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: endpoint, headers: b.headers, payload: { babyId: a.babyId } })).statusCode, 403);
  });
  await t.test("create preserves context and scoped metadata", async () => {
    const created = await app.inject({ method: "POST", url: endpoint, headers: a.headers, payload: { babyId: a.babyId, title: "test_title", contextType: "food" } });
    assert.equal(created.statusCode, 201, created.payload);
    const session = created.json<{ data: WebAiSession }>().data;
    sessionId = session.id;
    assert.equal(session.userId, a.userId); assert.equal(session.contextType, "food");
    assert.deepEqual(session.messages, []);
  });
  const message = { id: randomUUID(), role: "user" as const, content: "test_question", image: null, toolsJson: null };
  await t.test("message replay is idempotent and differing content conflicts", async () => {
    const url = `${endpoint}/${sessionId}/messages`;
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: "POST", url, headers: a.headers, payload: message });
      assert.equal(response.statusCode, 201, response.payload);
      assert.equal(response.json<{ data: WebAiMessage }>().data.id, message.id);
    }
    assert.equal((await app.inject({ method: "POST", url, headers: a.headers, payload: { ...message, content: "test_changed" } })).statusCode, 409);
    const response = await app.inject({ method: "POST", url, headers: a.headers, payload: { id: randomUUID(), role: "assistant", content: "test_answer", toolsJson: "[]" } });
    assert.equal(response.statusCode, 201, response.payload);
  });
  await t.test("fresh service instance reads complete ordered history and list previews", async () => {
    const fresh = new WebAiSessionService(database.pool);
    const session = await fresh.get(a.userId, sessionId);
    assert.deepEqual(session.messages.map(m => m.content), ["test_question", "test_answer"]);
    assert.equal(session.messageCount, 2);
    const listResponse = await app.inject({ method: "GET", url: `${endpoint}?contextType=food&babyId=${a.babyId}`, headers: a.headers });
    assert.equal(listResponse.statusCode, 200, listResponse.payload);
    const list = listResponse.json<{ data: { total: number; sessions: WebAiSession[] } }>().data;
    assert.equal(list.total, 1); assert.equal(list.sessions[0]!.messageCount, 2);
    assert.equal(list.sessions[0]!.lastMessage!.content, "test_answer");
  });
  await t.test("foreign reads, renames, appends and deletes never reveal a session", async () => {
    assert.equal((await app.inject({ method: "GET", url: `${endpoint}/${sessionId}`, headers: b.headers })).statusCode, 404);
    assert.equal((await app.inject({ method: "PATCH", url: `${endpoint}/${sessionId}`, headers: b.headers, payload: { title: "test_forbidden" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `${endpoint}/${sessionId}/messages`, headers: b.headers, payload: message })).statusCode, 404);
    assert.equal((await app.inject({ method: "DELETE", url: `${endpoint}/${sessionId}`, headers: b.headers })).statusCode, 404);
    const list = await app.inject({ method: "GET", url: endpoint, headers: b.headers });
    assert.equal(list.json<{ data: { total: number } }>().data.total, 0);
  });
  await t.test("rename persists and revoked baby membership blocks existing credentials", async () => {
    const renamed = await app.inject({ method: "PATCH", url: `${endpoint}/${sessionId}`, headers: a.headers, payload: { title: "test_renamed" } });
    assert.equal(renamed.statusCode, 200, renamed.payload);
    assert.equal((await new WebAiSessionService(database.pool).get(a.userId, sessionId)).title, "test_renamed");
    await database.pool.query("UPDATE baby_members SET status='inactive' WHERE user_id=$1 AND baby_id=$2", [a.userId, a.babyId]);
    try {
      assert.equal((await app.inject({ method: "GET", url: `${endpoint}/${sessionId}`, headers: a.headers })).statusCode, 404);
      assert.equal((await app.inject({ method: "POST", url: `${endpoint}/${sessionId}/messages`, headers: a.headers, payload: { ...message, id: randomUUID() } })).statusCode, 404);
    } finally { await database.pool.query("UPDATE baby_members SET status='active' WHERE user_id=$1 AND baby_id=$2", [a.userId, a.babyId]); }
  });
  await t.test("explicit deletion removes stored history, without another instance resurrecting it", async () => {
    const deleted = await app.inject({ method: "DELETE", url: `${endpoint}/${sessionId}`, headers: a.headers });
    assert.equal(deleted.statusCode, 200, deleted.payload);
    assert.equal((await app.inject({ method: "GET", url: `${endpoint}/${sessionId}`, headers: a.headers })).statusCode, 404);
    const count = await database.pool.query<{ count: string }>("SELECT count(*) AS count FROM ai_messages WHERE session_id=$1", [sessionId]);
    assert.equal(count.rows[0]!.count, "0");
  });
});
