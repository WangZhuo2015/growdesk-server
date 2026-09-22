import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import { MockStorageDriver } from "../../apps/api/src/storage/s3-storage-service.js";

interface Run { directory: string; token: string; database: string; user: string; password: string; pgPort: number }
function readRun(): Run {
  const file = process.env.BOOT02_RUN_FILE;
  assert.ok(file, "Managed integration runner required");
  const real = fs.realpathSync(file);
  const root = path.dirname(real);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith("growdesk-integration-"));
  assert.equal(fs.statSync(real).mode & 0o077, 0);
  assert.equal(fs.statSync(real).uid, process.getuid?.());
  return JSON.parse(fs.readFileSync(real, "utf8")) as Run;
}

test("legacy upload resolver enforces live object permissions", async t => {
  const run = readRun();
  const database = createDatabaseContext({ url: requireTestDatabaseUrl(
    `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    { host: "127.0.0.1", port: run.pgPort, database: run.database, role: run.user, password: run.password },
  ) });
  const app = buildApiApp({ databaseContext: database, jwtSecret: "test_legacy_upload_access_secret_32_chars", storageDriver: new MockStorageDriver() });
  const users: string[] = [], families: string[] = [], mappings: string[] = [];
  t.after(async () => {
    try {
      await database.prisma.legacyIdempotencyMapping.deleteMany({ where: { id: { in: mappings } } });
      await database.prisma.family.deleteMany({ where: { id: { in: families } } });
      await database.prisma.user.deleteMany({ where: { id: { in: users }, username: { startsWith: "test_legacy_upload_" } } });
    } finally { await app.close(); await database.close(); }
  });
  const ownership = await database.pool.query<{ role: string; token: string; db: string }>("SELECT current_user AS role,current_setting('cluster_name') AS token,current_database() AS db");
  assert.deepEqual(ownership.rows[0], { role: run.user, token: run.token, db: run.database });

  async function register() {
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: {
      username: `test_legacy_upload_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
      password: "TestOnlyPassword123!", displayName: "test_legacy_upload_owner",
    } });
    assert.equal(response.statusCode, 201, response.payload);
    const account = response.json<{ data: { user: { id: string }; accessToken: string } }>().data;
    users.push(account.user.id);
    const familyResponse = await app.inject({ method: "GET", url: "/api/v1/families", headers: { authorization: `Bearer ${account.accessToken}` } });
    assert.equal(familyResponse.statusCode, 200);
    const family = familyResponse.json<{ data: Array<{ id: string }> }>().data[0];
    assert.ok(family);
    families.push(family.id);
    return { userId: account.user.id, token: account.accessToken, familyId: family.id };
  }
  const a = await register(), b = await register();
  const babyResponse = await app.inject({ method: "POST", url: `/api/v1/families/${a.familyId}/babies`,
    headers: { authorization: `Bearer ${a.token}` }, payload: { name: "test_legacy_upload_baby", gender: "girl", birthDate: "2026-01-01" } });
  assert.equal(babyResponse.statusCode, 201, babyResponse.payload);
  const babyId = babyResponse.json<{ data: { id: string } }>().data.id;
  const legacyPath = `/uploads/test_${randomUUID()}.png`;
  const ids: string[] = [];
  async function mappedAttachment() {
    const id = randomUUID();
    await database.prisma.attachment.create({ data: { id, familyId: a.familyId, babyId,
      uploaderId: a.userId, purpose: "medical_report", mimeType: "image/png", byteSize: 1,
      sha256: "a".repeat(64), objectKey: `test_legacy_upload/${id}.png`, status: "ready" } });
    const mappingId = randomUUID();
    await database.prisma.legacyIdempotencyMapping.create({ data: {
      id: mappingId, targetEntityType: "attachment_reference", targetEntityId: randomUUID(),
      sourceKey: `test_legacy_upload/${mappingId}`, status: "mapped", sourceSystem: "test_legacy_upload",
      sourceBatchId: "b".repeat(64), sourceTable: "MedicalReport", sourceId: randomUUID(),
      sourceHash: "c".repeat(64), mappingVersion: "attachment-reference-backfill-v1",
      metadata: { sourcePath: `public${legacyPath}`, attachmentId: id, storageState: "ready" },
    } });
    mappings.push(mappingId); ids.push(id); return id;
  }
  const id = await mappedAttachment();
  const request = (token?: string, requestedPath = legacyPath) => app.inject({ method: "GET",
    url: `/api/v1/web/attachments/resolve-legacy?path=${encodeURIComponent(requestedPath)}`,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  await t.test("authentication, unknown paths and foreign families", async () => {
    assert.equal((await request()).statusCode, 401);
    assert.equal((await request(b.token)).statusCode, 404);
    assert.equal((await request(a.token, "/uploads/test_unknown.png")).statusCode, 404);
    const own = await request(a.token);
    assert.equal(own.statusCode, 200, own.payload);
    assert.deepEqual(own.json(), { data: { id } });
  });
  await t.test("unsafe path fails without local filesystem fallback", async () => {
    assert.equal((await request(a.token, "/uploads/../private.png")).statusCode, 400);
    assert.equal((await request(a.token, "/uploads/%2e%2e/private.png")).statusCode, 400);
  });
  await t.test("old credentials cannot resolve an object after baby access is revoked", async () => {
    await database.prisma.babyMember.updateMany({ where: { userId: a.userId, babyId }, data: { status: "revoked" } });
    assert.equal((await request(a.token)).statusCode, 404);
    await database.prisma.babyMember.updateMany({ where: { userId: a.userId, babyId }, data: { status: "active" } });
    assert.equal((await request(a.token)).statusCode, 200);
  });
  await t.test("deleted and ambiguous mappings cannot be guessed", async () => {
    await database.prisma.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
    assert.equal((await request(a.token)).statusCode, 404);
    await database.prisma.attachment.update({ where: { id }, data: { deletedAt: null } });
    const second = await mappedAttachment();
    assert.equal((await request(a.token)).statusCode, 404);
    await database.prisma.attachment.update({ where: { id: second }, data: { deletedAt: new Date() } });
    assert.equal((await request(a.token)).statusCode, 200);
  });
});
