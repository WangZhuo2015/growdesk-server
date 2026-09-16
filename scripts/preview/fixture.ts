import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createDatabaseContext, parseDatabaseConfig } from '@growdesk/database';
import { buildApiApp } from '../../apps/api/src/app.js';
export async function previewFixture(t: TestContext, namespace: string) {
  assert.match(namespace, /^[a-z_]+$/);
  const target = parseDatabaseConfig(process.env.DATABASE_URL, 'test');
  assert.equal(target.port, 55432); assert.equal(target.database, 'test_growdesk_preview');
  const db = createDatabaseContext({ url: target.url });
  const app = buildApiApp({ databaseContext: db, jwtSecret: process.env.JWT_SECRET, redisUrl: process.env.REDIS_URL });
  const users: string[] = [], families: string[] = [];
  const prefix = `test_${namespace}_`;
  t.after(async () => {
    try {
      await db.prisma.family.deleteMany({ where: { id: { in: families } } });
      await db.prisma.user.deleteMany({ where: { id: { in: users }, username: { startsWith: prefix } } });
    } finally { await app.close(); await db.close(); }
  });
  const tenant = async () => {
    const r = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: prefix + randomUUID().slice(0, 8), displayName: prefix, password: 'TestPreviewPassword123!' } });
    assert.equal(r.statusCode, 201, r.payload);
    const { user, accessToken } = r.json().data; users.push(user.id);
    const headers = { authorization: `Bearer ${accessToken}` };
    const listing = await app.inject({ url: '/api/v1/families', headers });
    assert.equal(listing.statusCode, 200, listing.payload);
    const familyId = listing.json().data[0].id; families.push(familyId);
    await db.prisma.family.update({ where: { id: familyId }, data: { name: `test_family_${familyId}` } });
    const baby = await app.inject({ method: 'POST', url: `/api/v1/families/${familyId}/babies`, headers, payload: { name: `test_baby_${namespace}`, birthDate: '2026-01-01', gender: 'girl' } });
    assert.equal(baby.statusCode, 201, baby.payload);
    return { headers, userId: user.id as string, familyId: familyId as string, babyId: baby.json().data.id as string };
  };
  return { app, db, tenant };
}
