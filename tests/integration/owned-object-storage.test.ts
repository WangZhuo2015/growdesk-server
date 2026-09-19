/** Real AWS SDK/HTTP round trip against the runner's exclusive MinIO child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { S3Client, CreateBucketCommand, DeleteBucketCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { requireTestObjectStorage, requireTestDatabaseUrl } from '../../packages/testkit/src/environment.js';
import { AwsS3StorageDriver } from '../../apps/api/src/storage/s3-storage-service.js';
import { createDatabaseContext } from '../../packages/database/src/client.js';
import { buildApiApp } from '../../apps/api/src/app.js';

test('owned S3 uses real signed PUT, private objects, checksum validation and physical deletion', async (t) => {
  const manifest = fs.realpathSync(process.env.BOOT02_RUN_FILE || '');
  const root = path.dirname(manifest);
  const stat = fs.statSync(manifest);
  assert.equal(path.dirname(root), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(root).startsWith('growdesk-integration-'));
  assert.equal(stat.uid, process.getuid?.());
  assert.equal(stat.mode & 0o077, 0);
  const run = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(run.directory, root);
  const identity = requireTestObjectStorage(run.s3, run.token);
  process.kill(identity.pid, 0);
  const config = { ...identity, forcePathStyle: true };
  const client = new S3Client({ endpoint: identity.endpoint, region: identity.region, forcePathStyle: true,
    credentials: { accessKeyId: identity.accessKeyId, secretAccessKey: identity.secretAccessKey } });
  const driver = new AwsS3StorageDriver(config);
  const dbUrl = requireTestDatabaseUrl(`postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    { host: '127.0.0.1', port: run.pgPort, database: run.database, role: run.user, password: run.password });
  const database = createDatabaseContext({ url: dbUrl });
  const app = buildApiApp({ databaseContext: database, storageDriver: driver, jwtSecret: 'test_object_storage_jwt_secret_0123456789' });
  t.after(async () => {
    await app.close();
    await database.close();
    client.destroy();
  });
  const ownership = await database.pool.query("SELECT current_user AS role, current_setting('cluster_name') AS token");
  assert.equal(ownership.rows[0].role, run.user);
  assert.equal(ownership.rows[0].token, run.token);
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  const uploadedKeys = new Set<string>();
  const userIds: string[] = [];
  const familyIds: string[] = [];
  // Actual 1x1 PNG, not text labelled as an image.
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const objectKey = `test_${run.token}/pixel.png`;
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  await client.send(new CreateBucketCommand({ Bucket: identity.bucket }));
  try {
    uploadedKeys.add(objectKey);
    const upload = await driver.generatePresignedUploadUrl({ objectKey, mimeType: 'image/png', byteSize: bytes.length });
    assert.equal(new URL(upload.uploadUrl).origin, identity.endpoint);
    const sent = await fetch(upload.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes });
    assert.equal(sent.status, 200);
    const verified = await driver.verifyUploadedObject({ objectKey, expectedSha256: sha, expectedByteSize: bytes.length });
    assert.equal(verified.valid, true);
    assert.equal((await driver.verifyUploadedObject({ objectKey, expectedSha256: '0'.repeat(64), expectedByteSize: bytes.length })).valid, false);
    assert.equal((await driver.verifyUploadedObject({ objectKey, expectedSha256: sha, expectedByteSize: bytes.length + 1 })).valid, false);
    const anonymous = await fetch(`${identity.endpoint}/${identity.bucket}/${objectKey}`);
    assert.equal(anonymous.status, 403, 'private object must reject anonymous requests');
    const stored = await client.send(new GetObjectCommand({ Bucket: identity.bucket, Key: objectKey }));
    assert.deepEqual(Buffer.from(await stored.Body!.transformToByteArray()), bytes);
    await driver.deleteObject(objectKey);
    await assert.rejects(client.send(new HeadObjectCommand({ Bucket: identity.bucket, Key: objectKey })),
      (error: any) => error.$metadata?.httpStatusCode === 404);
    await driver.deleteObject(objectKey); // S3 delete is idempotent.

    const api = async (method: string, route: string, token?: string, body?: unknown) => fetch(origin + route, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const tokens: string[] = [];
    for (const suffix of ['a', 'b']) {
      const response = await api('POST', '/api/v1/auth/register', undefined, {
        username: `test_s3_${run.token}_${suffix}`, password: 'TestStoragePassword123!', displayName: `test_storage_${suffix}`,
      });
      assert.equal(response.status, 201, 'synthetic registration failed');
      const registered: any = await response.json();
      tokens.push(registered.data.accessToken);
      userIds.push(registered.data.user.id);
      const familiesResponse = await api('GET', '/api/v1/families', tokens.at(-1));
      assert.equal(familiesResponse.status, 200);
      const families: any = await familiesResponse.json();
      assert.equal(families.data.length, 1);
      familyIds.push(families.data[0].id);
    }
    const [tokenA, tokenB] = tokens;
    const babyResponse = await api('POST', `/api/v1/families/${familyIds[0]}/babies`, tokenA,
      { name: 'test_storage_baby', gender: 'girl', birthDate: '2026-01-01' });
    assert.equal(babyResponse.status, 201);
    const baby: any = await babyResponse.json();
    const pendingResponse = await api('POST', '/api/v1/attachments', tokenA, {
      purpose: 'medical_report', mimeType: 'image/png', byteSize: bytes.length, sha256: sha,
      ownerScope: { familyId: familyIds[0], babyId: baby.data.id },
    });
    assert.equal(pendingResponse.status, 201);
    const pending: any = await pendingResponse.json();
    const attachment = pending.data;
    uploadedKeys.add(attachment.objectKey);
    assert.equal(new URL(attachment.uploadUrl).origin, identity.endpoint);
    assert.equal((await fetch(attachment.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes })).status, 200);
    const attPath = `/api/v1/attachments/${attachment.id}`;
    assert.equal((await api('POST', `${attPath}/complete`, tokenB, { sha256: sha, byteSize: bytes.length })).status, 403);
    const invalidComplete = await api('POST', `${attPath}/complete`, tokenA, { sha256: '0'.repeat(64), byteSize: bytes.length });
    assert.ok([400, 422].includes(invalidComplete.status));
    assert.notEqual((await database.prisma.attachment.findUniqueOrThrow({ where: { id: attachment.id } })).status, 'ready');
    assert.equal((await api('POST', `${attPath}/complete`, tokenA, { sha256: sha, byteSize: bytes.length })).status, 200);
    assert.equal((await api('GET', `${attPath}/content`)).status, 401);
    assert.equal((await api('GET', `${attPath}/content`, tokenB)).status, 403);
    assert.equal((await api('DELETE', attPath, tokenB)).status, 403);
    assert.equal((await api('GET', `${attPath}/download-url`, tokenA)).status, 404, 'private reads must not expose reusable signed URLs');
    const content = await api('GET', `${attPath}/content`, tokenA);
    assert.equal(content.status, 200);
    assert.equal(content.headers.get('content-type'), 'image/png');
    assert.equal(content.headers.get('content-length'), String(bytes.length));
    assert.equal(content.headers.get('cache-control'), 'private, no-store');
    assert.equal(content.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await content.arrayBuffer()), bytes);
    assert.equal((await fetch(`${identity.endpoint}/${identity.bucket}/${attachment.objectKey}`)).status, 403);
    // Missing storage bytes must not be presented as a successful empty image.
    await driver.deleteObject(attachment.objectKey);
    const missingContent = await api('GET', `${attPath}/content`, tokenA);
    assert.equal(missingContent.status, 503);
    assert.match(missingContent.headers.get('content-type') || '', /application\/json/);
    assert.equal((await fetch(attachment.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes })).status, 200);
    const recoveredContent = await api('GET', `${attPath}/content`, tokenA);
    assert.equal(recoveredContent.status, 200);
    assert.deepEqual(Buffer.from(await recoveredContent.arrayBuffer()), bytes);
    assert.equal((await api('DELETE', attPath, tokenA)).status, 200);
    await assert.rejects(client.send(new HeadObjectCommand({ Bucket: identity.bucket, Key: attachment.objectKey })),
      (error: any) => error.$metadata?.httpStatusCode === 404);
    assert.equal((await api('GET', `${attPath}/content`, tokenA)).status, 404);
  } finally {
    for (const key of uploadedKeys) await driver.deleteObject(key);
    await client.send(new DeleteBucketCommand({ Bucket: identity.bucket }));
    await database.prisma.family.deleteMany({ where: { id: { in: familyIds } } });
    await database.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});
