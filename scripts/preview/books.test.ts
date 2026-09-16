import test from 'node:test';
import assert from 'node:assert/strict';
import { previewFixture } from './fixture.js';
test('book favorites persist per family and reject stale or foreign writes', async t => {
  const { app, db, tenant } = await previewFixture(t, 'preview_books');
  const a = await tenant(), b = await tenant();
  const list = await app.inject({ url: `/api/v1/books?familyId=${a.familyId}`, headers: a.headers });
  assert.equal(list.statusCode, 200, list.payload);
  const book = list.json().data[0];
  assert.ok(book.details.sourceRefs.length > 0);
  const path = `/api/v1/books/${book.id}`;
  const write = await app.inject({ method: 'PATCH', url: path, headers: a.headers, payload: { familyId: a.familyId, baseVersion: book.version, isFavorite: true, readCount: 2 } });
  assert.equal(write.statusCode, 200, write.payload);
  const latest = (await app.inject({ url: `/api/v1/books?familyId=${a.familyId}`, headers: a.headers })).json().data.find((x: { id: string }) => x.id === book.id);
  assert.equal(latest.details.isFavorite, true); assert.equal(latest.details.readCount, 2);
  assert.equal((await app.inject({ method: 'PATCH', url: path, headers: a.headers, payload: { familyId: a.familyId, baseVersion: book.version, readCount: 3 } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'PATCH', url: path, headers: b.headers, payload: { familyId: a.familyId, isFavorite: false } })).statusCode, 403);
  assert.equal(await db.prisma.familyChange.count({ where: { familyId: a.familyId, entityType: 'book_status' } }), 1);
});
