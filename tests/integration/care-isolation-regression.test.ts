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
function ownedRun(): OwnedRun {
  if (!process.env.BOOT02_RUN_FILE) throw new Error("Use the managed isolated integration runner");
  const file = fs.realpathSync(process.env.BOOT02_RUN_FILE);
  const directory = path.dirname(file);
  const stat = fs.statSync(file);
  if (path.dirname(directory) !== fs.realpathSync(os.tmpdir()) || !path.basename(directory).startsWith("growdesk-integration-") || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error("Unsafe integration manifest");
  const run = JSON.parse(fs.readFileSync(file, "utf8")) as OwnedRun;
  if (run.directory !== directory || !run.database.startsWith("test_") || !run.user.startsWith("test_")) throw new Error("Not an owned test environment");
  return run;
}

interface Page { data: Array<{ id: string }>; page: { nextCursor: string | null } }
const cases = [
  { kind: "sleep", table: "sleep_records", columns: "sleep_type, started_at, ended_at", values: "'nap', '2026-09-10T01:00:00Z', '2026-09-10T02:00:00Z'", body: { sleepType: "nap", startedAt: "2026-09-10T01:00:00Z", endedAt: "2026-09-10T02:00:00Z" } },
  { kind: "diaper", table: "diaper_records", columns: "diaper_type, occurred_at", values: "'pee', '2026-09-10T01:00:00Z'", body: { diaperType: "pee", occurredAt: "2026-09-10T01:00:00Z" } },
  { kind: "food", table: "food_records", columns: "record_date, meal_type", values: "'2026-09-10', 'snack'", body: { recordDate: "2026-09-10", mealType: "snack", foodItemIds: [] } },
  { kind: "supplement", table: "supplement_records", columns: "supplement_name, occurred_at", values: "'test_supplement', '2026-09-10T01:00:00Z'", body: { supplementName: "test_supplement", occurredAt: "2026-09-10T01:00:00Z" } },
] as const;

test("care: scoped mutations, stale deletes and complete maximum-sized pages", async t => {
  const run = ownedRun();
  const url = requireTestDatabaseUrl(`postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`, {
    host: "127.0.0.1", port: run.pgPort, database: run.database, role: run.user, password: run.password,
  });
  const database = createDatabaseContext({ url });
  const app = buildApiApp({ databaseContext: database, jwtSecret: "test_care_scope_secret_at_least_32_characters" });
  const families: string[] = []; const users: string[] = [];
  t.after(async () => {
    try {
      await database.prisma.family.deleteMany({ where: { id: { in: families } } });
      await database.prisma.user.deleteMany({ where: { id: { in: users }, username: { startsWith: "test_care_" } } });
    } finally { await app.close(); await database.close(); }
  });
  async function tenant() {
    const registered = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: {
      username: `test_care_${randomUUID()}`, password: "TestCarePassword123!", displayName: "test_care_user",
    } });
    assert.equal(registered.statusCode, 201, registered.payload);
    const auth = registered.json<{ data: { accessToken: string; user: { id: string } } }>().data;
    users.push(auth.user.id);
    const headers = { authorization: `Bearer ${auth.accessToken}` };
    const familyResponse = await app.inject({ method: "GET", url: "/api/v1/families", headers });
    assert.equal(familyResponse.statusCode, 200, familyResponse.payload);
    const family = familyResponse.json<{ data: Array<{ id: string }> }>().data[0]!;
    families.push(family.id);
    const babyResponse = await app.inject({ method: "POST", url: `/api/v1/families/${family.id}/babies`, headers, payload: { name: "test_care_baby", gender: "other", birthDate: "2026-01-01" } });
    assert.equal(babyResponse.statusCode, 201, babyResponse.payload);
    return { headers, familyId: family.id, babyId: babyResponse.json<{ data: { id: string } }>().data.id };
  }
  const a = await tenant(); const b = await tenant();
  for (const domain of cases) {
    await t.test(`${domain.kind}: another tenant's record ID never authorizes an own-baby mutation`, async () => {
      const endpoint = `/api/v1/babies/${a.babyId}/records/${domain.kind}`;
      const creation = await app.inject({ method: "POST", url: endpoint, headers: a.headers, payload: domain.body });
      assert.equal(creation.statusCode, 201, creation.payload);
      const item = creation.json<{ data: { id: string; version: string } }>().data;
      const foreign = `/api/v1/babies/${b.babyId}/records/${domain.kind}/${item.id}`;
      const patched = await app.inject({ method: "PATCH", url: foreign, headers: b.headers, payload: { baseVersion: item.version, notes: "test_forbidden" } });
      assert.ok([403, 404].includes(patched.statusCode), patched.payload);
      const deleted = await app.inject({ method: "DELETE", url: `${foreign}?baseVersion=${item.version}`, headers: b.headers });
      assert.ok([403, 404].includes(deleted.statusCode), deleted.payload);
      const own = `${endpoint}/${item.id}`;
      const update = await app.inject({ method: "PATCH", url: own, headers: a.headers, payload: { baseVersion: item.version, notes: "test_legitimate" } });
      assert.equal(update.statusCode, 200, update.payload);
      const version = update.json<{ data: { version: string } }>().data.version;
      const stale = await app.inject({ method: "DELETE", url: `${own}?baseVersion=${item.version}`, headers: a.headers });
      assert.equal(stale.statusCode, 409, stale.payload);
      const good = await app.inject({ method: "DELETE", url: `${own}?baseVersion=${version}`, headers: a.headers });
      assert.equal(good.statusCode, 200, good.payload);
    });
    await t.test(`${domain.kind}: 401 equal-time records traverse 200/200/1 without loss`, async () => {
      const ids = Array.from({ length: 401 }, () => randomUUID());
      // Table and column fragments are static literals above, never user input.
      await database.pool.query(`INSERT INTO ${domain.table} (id, family_id, baby_id, ${domain.columns}, updated_at) SELECT id, $2, $3, ${domain.values}, CURRENT_TIMESTAMP FROM unnest($1::text[]) AS id`, [ids, a.familyId, a.babyId]);
      const received: string[] = []; let cursor: string | null = null;
      for (const expectedCount of [200, 200, 1]) {
        const query = new URLSearchParams({ limit: "200" });
        if (cursor) query.set("cursor", cursor);
        const response = await app.inject({ method: "GET", url: `/api/v1/babies/${a.babyId}/records/${domain.kind}?${query}`, headers: a.headers });
        assert.equal(response.statusCode, 200, response.payload);
        const page = response.json<Page>();
        assert.equal(page.data.length, expectedCount);
        received.push(...page.data.map(row => row.id));
        cursor = page.page.nextCursor;
        if (expectedCount === 200) assert.ok(cursor);
      }
      assert.equal(cursor, null);
      assert.equal(new Set(received).size, 401);
      assert.deepEqual(new Set(received), new Set(ids));
    });
  }
});
