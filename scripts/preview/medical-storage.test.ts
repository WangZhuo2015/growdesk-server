import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { buildApiApp } from '../../apps/api/src/app.js';
import { createDatabaseContext, parseDatabaseConfig } from '@growdesk/database';

const target = parseDatabaseConfig(process.env.DATABASE_URL, 'test');
assert.equal(target.database, 'test_growdesk_preview');
assert.equal(target.port, 55432);
assert.equal(process.env.S3_ENDPOINT, 'http://127.0.0.1:59000');

test('real preview PG and S3 preserve medical items, enforce attachment scope and versioned edits', async t => {
  const db = createDatabaseContext({ url: target.url });
  const app = buildApiApp({ databaseContext: db, jwtSecret: process.env.JWT_SECRET, redisUrl: process.env.REDIS_URL });
  const users: string[] = [], families: string[] = [], attachments: { id: string; headers: { authorization: string } }[] = [];
  t.after(async () => {
    try {
      for (const a of attachments) await app.inject({ method: 'DELETE', url: `/api/v1/attachments/${a.id}`, headers: a.headers });
      await db.prisma.family.deleteMany({ where: { id: { in: families } } });
      await db.prisma.user.deleteMany({ where: { id: { in: users }, username: { startsWith: 'test_preview_medical_' } } });
    } finally { await app.close(); await db.close(); }
  });
  async function tenant() {
    const registration = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: `test_preview_medical_${randomUUID().slice(0, 8)}`, displayName: 'test_preview_medical', password: 'TestPreviewPassword123!' } });
    assert.equal(registration.statusCode, 201, registration.payload);
    const auth = registration.json().data;
    users.push(auth.user.id);
    const headers = { authorization: `Bearer ${auth.accessToken}` };
    const listing = await app.inject({ url: '/api/v1/families', headers });
    const familyId = listing.json().data[0].id; families.push(familyId);
    await db.prisma.family.update({ where: { id: familyId }, data: { name: `test_family_${familyId}` } });
    const baby = await app.inject({ method: 'POST', url: `/api/v1/families/${familyId}/babies`, headers, payload: { name: 'test_baby_medical', birthDate: '2026-01-01', gender: 'girl' } });
    assert.equal(baby.statusCode, 201, baby.payload);
    return { headers, familyId, babyId: baby.json().data.id };
  }
  const a = await tenant(), b = await tenant();
  const bytes = Buffer.from('test_private_object_payload');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const created = await app.inject({ method: 'POST', url: '/api/v1/attachments', headers: a.headers, payload: { purpose: 'medical_report', mimeType: 'image/png', byteSize: bytes.length, sha256, ownerScope: { familyId: a.familyId, babyId: a.babyId } } });
  assert.equal(created.statusCode, 201, created.payload);
  const attachment = created.json().data; attachments.push({ id: attachment.id, headers: a.headers });
  assert.equal((await fetch(attachment.uploadUrl, { method: 'PUT', headers: { 'content-type': 'image/png' }, body: bytes })).status, 200);
  const complete = await app.inject({ method: 'POST', url: `/api/v1/attachments/${attachment.id}/complete`, headers: a.headers, payload: { sha256, byteSize: bytes.length } });
  assert.equal(complete.statusCode, 200, complete.payload);
  const content = await app.inject({ url: `/api/v1/attachments/${attachment.id}/content`, headers: a.headers });
  assert.equal(content.statusCode, 200, content.payload);
  assert.equal(content.headers['content-type'], 'image/png');
  assert.deepEqual(Buffer.from(content.payload), bytes);
  assert.equal((await app.inject({ url: `/api/v1/attachments/${attachment.id}/content`, headers: b.headers })).statusCode, 403);
  const items = [{ id: 'test_item', name: 'test_indicator', value: '12.3', unit: 'test_unit', status: 'normal', interpretation: 'test_preserved' }];
  const path = `/api/v1/babies/${a.babyId}/medical-reports`;
  const report = await app.inject({ method: 'POST', url: path, headers: { ...a.headers, 'idempotency-key': randomUUID() }, payload: { reportDate: '2026-09-14', title: 'test_report', items, attachmentIds: [attachment.id], growthData: { weightKg: '8.10' } } });
  assert.equal(report.statusCode, 201, report.payload);
  const record = report.json().data;
  assert.deepEqual(record.items, items);
  assert.equal(await db.prisma.growthMeasurement.count({ where: { babyId: a.babyId } }), 1);
  const foreign = await app.inject({ method: 'POST', url: `/api/v1/babies/${b.babyId}/medical-reports`, headers: b.headers, payload: { reportDate: '2026-09-14', title: 'test_cross_scope', attachmentIds: [attachment.id] } });
  assert.equal(foreign.statusCode, 404, foreign.payload);
  const update = await app.inject({ method: 'PATCH', url: `${path}/${record.id}`, headers: a.headers, payload: { baseVersion: record.version, items: [{ ...items[0], value: '14.5' }] } });
  assert.equal(update.statusCode, 200, update.payload);
  assert.equal(update.json().data.items[0].value, '14.5');
  const staleDelete = await app.inject({ method: 'DELETE', url: `${path}/${record.id}`, headers: a.headers, payload: { baseVersion: record.version } });
  assert.equal(staleDelete.statusCode, 409, staleDelete.payload);
  const deleted = await app.inject({ method: 'DELETE', url: `${path}/${record.id}`, headers: a.headers, payload: { baseVersion: update.json().data.version } });
  assert.equal(deleted.statusCode, 200, deleted.payload);
  assert.equal(await db.prisma.timelineEntry.count({ where: { entityId: record.id, deletedAt: null } }), 0);
});
