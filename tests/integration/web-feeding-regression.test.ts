/** Run only via scripts/test-integration.py, after its baseline suites. Never connect to a supplied production URL. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";

interface OwnedRun { directory: string; database: string; user: string; password: string; pgPort: number }
function readOwnedRun(): OwnedRun {
  if (!process.env.BOOT02_RUN_FILE) throw new Error("Use the managed isolated integration runner");
  const file = fs.realpathSync(process.env.BOOT02_RUN_FILE);
  const parent = path.dirname(file);
  const stat = fs.statSync(file);
  if (path.dirname(parent) !== fs.realpathSync(os.tmpdir()) || !path.basename(parent).startsWith("growdesk-integration-") || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) {
    throw new Error("Unsafe integration manifest");
  }
  const run = JSON.parse(fs.readFileSync(file, "utf8")) as OwnedRun;
  if (run.directory !== parent || !run.database.startsWith("test_") || !run.user.startsWith("test_")) throw new Error("Not an owned test tenant");
  return run;
}

test("Web feeding: mixed records, client versions, scope binding and 200-row pagination", async t => {
  const run = readOwnedRun();
  const url = requireTestDatabaseUrl(`postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`, {
    host: "127.0.0.1", port: run.pgPort, database: run.database, role: run.user, password: run.password,
  });
  const ctx = createDatabaseContext({ url });
  const app = buildApiApp({ databaseContext: ctx, jwtSecret: "test_web_bridge_secret_at_least_32_characters" });
  const families: string[] = [];
  const users: string[] = [];
  t.after(async () => {
    try {
      // Only IDs captured from this test's registration responses may be removed.
      if (families.length) await ctx.prisma.family.deleteMany({ where: { id: { in: families } } });
      if (users.length) await ctx.prisma.user.deleteMany({ where: { id: { in: users }, username: { startsWith: "test_web_bridge_" } } });
    } finally { await app.close(); await ctx.close(); }
  });
  await ctx.pool.query(fs.readFileSync("prisma/migrations/202609130012_legacy_mixed_feeding/migration.sql", "utf8"));

  async function tenant(label: string) {
    const registration = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: {
      username: `test_web_bridge_${label}_${randomUUID().slice(0, 8)}`,
      password: "TestPassword123!", displayName: `test_web_bridge_${label}`,
    } });
    assert.equal(registration.statusCode, 201, registration.payload);
    const auth = registration.json<{ data: { accessToken: string; user: { id: string } } }>().data;
    users.push(auth.user.id);
    const headers = { authorization: `Bearer ${auth.accessToken}` };
    const list = await app.inject({ method: "GET", url: "/api/v1/families", headers });
    assert.equal(list.statusCode, 200, list.payload);
    const family = list.json<{ data: Array<{ id: string }> }>().data[0];
    assert.ok(family); families.push(family.id);
    const created = await app.inject({ method: "POST", url: `/api/v1/families/${family.id}/babies`, headers, payload: {
      name: `test_baby_web_bridge_${label}`, gender: "girl", birthDate: "2026-01-01",
    } });
    assert.equal(created.statusCode, 201, created.payload);
    return { headers, familyId: family.id, babyId: created.json<{ data: { id: string } }>().data.id };
  }
  const a = await tenant("a"); const b = await tenant("b");
  const pathA = `/api/v1/babies/${a.babyId}/records/feeding`;
  const created = await app.inject({ method: "POST", url: pathA, headers: { ...a.headers, "idempotency-key": randomUUID() }, payload: {
    feedingType: "mixed", occurredAt: "2026-09-13T03:00:00Z", amountMl: "60.5", leftMinutes: 7, rightMinutes: 4,
  } });
  assert.equal(created.statusCode, 201, created.payload);
  const record = created.json<{ data: { id: string; version: string; feedingType: string; leftMinutes: number } }>().data;
  assert.equal(record.feedingType, "mixed"); assert.equal(record.leftMinutes, 7);
  const recordUrl = `${pathA}/${record.id}`;

  await t.test("a valid own-baby path cannot be used to mutate another family's record ID", async () => {
    const foreignPath = `/api/v1/babies/${b.babyId}/records/feeding/${record.id}`;
    const patch = await app.inject({ method: "PATCH", url: foreignPath, headers: b.headers, payload: { baseVersion: record.version, notes: "test_forbidden" } });
    assert.ok([403, 404].includes(patch.statusCode), patch.payload);
    const deletion = await app.inject({ method: "DELETE", url: `${foreignPath}?baseVersion=${record.version}`, headers: b.headers });
    assert.ok([403, 404].includes(deletion.statusCode), deletion.payload);
    const unchanged = await app.inject({ method: "GET", url: recordUrl, headers: a.headers });
    assert.equal(unchanged.statusCode, 200); assert.equal(unchanged.json<{ data: { version: string } }>().data.version, record.version);
  });

  await t.test("stale deletes conflict; correct deletes and idempotent replays succeed", async () => {
    const updated = await app.inject({ method: "PATCH", url: recordUrl, headers: a.headers, payload: { baseVersion: record.version, notes: "test_updated" } });
    assert.equal(updated.statusCode, 200, updated.payload);
    const currentVersion = updated.json<{ data: { version: string } }>().data.version;
    const stale = await app.inject({ method: "DELETE", url: `${recordUrl}?baseVersion=${record.version}`, headers: a.headers });
    assert.equal(stale.statusCode, 409, stale.payload);
    const missing = await app.inject({ method: "DELETE", url: recordUrl, headers: a.headers });
    assert.equal(missing.statusCode, 400, missing.payload);
    const key = randomUUID();
    const deletion = { method: "DELETE" as const, url: `${recordUrl}?baseVersion=${currentVersion}`, headers: { ...a.headers, "idempotency-key": key } };
    const first = await app.inject(deletion); const replay = await app.inject(deletion);
    assert.equal(first.statusCode, 200, first.payload); assert.equal(replay.statusCode, 200, replay.payload);
    assert.deepEqual(replay.json(), first.json());
  });

  await t.test("a 200-row page advertises and returns its 201st row on the next page", async () => {
    // Owned test fixtures only; API writes and their UoW behavior are exercised above.
    const fixtureIds = Array.from({ length: 201 }, () => randomUUID());
    await ctx.prisma.feedingRecord.createMany({ data: fixtureIds.map(id => ({
      id, familyId: a.familyId, babyId: a.babyId, feedingType: "formula", occurredAt: new Date("2026-09-13T04:00:00Z"),
    })) });
    const page1Response = await app.inject({ method: "GET", url: `${pathA}?limit=200`, headers: a.headers });
    assert.equal(page1Response.statusCode, 200, page1Response.payload);
    const page1 = page1Response.json<{ data: Array<{ id: string }>; page: { nextCursor: string | null } }>();
    assert.equal(page1.data.length, 200); assert.ok(page1.page.nextCursor);
    const page2Response = await app.inject({ method: "GET", url: `${pathA}?limit=200&cursor=${encodeURIComponent(page1.page.nextCursor)}`, headers: a.headers });
    assert.equal(page2Response.statusCode, 200, page2Response.payload);
    const page2 = page2Response.json<{ data: Array<{ id: string }>; page: { nextCursor: string | null } }>();
    assert.equal(page2.data.length, 1); assert.equal(page2.page.nextCursor, null);
    assert.deepEqual(new Set([...page1.data, ...page2.data].map(item => item.id)), new Set(fixtureIds));
  });
});
