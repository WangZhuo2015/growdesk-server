import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireTestObjectStorage } from '../src/environment.js';

const token = 'a'.repeat(32);
const owned = { endpoint: 'http://127.0.0.1:19001', bucket: `test-s3-${token}`, region: 'us-east-1',
  accessKeyId: 'test_' + 'b'.repeat(24), secretAccessKey: 'c'.repeat(48), pid: 12345 };

test('object storage guard admits only the manifest-bound loopback test namespace', () => {
  assert.equal(requireTestObjectStorage(owned, token), owned);
  for (const patch of [
    { endpoint: 'https://161.33.201.230:19001' }, { endpoint: 'http://localhost:19001' },
    { endpoint: 'http://127.0.0.1:19001/?redirect=production' }, { endpoint: 'http://127.0.0.1:19001/other' },
    { endpoint: 'http://user:password@127.0.0.1:19001' }, { bucket: 'growdesk-production' },
    { bucket: 'test-s3-' + 'd'.repeat(32) }, { accessKeyId: 'production' }, { secretAccessKey: '' }, { pid: 0 },
  ]) assert.throws(() => requireTestObjectStorage({ ...owned, ...patch }, token), /TEST_S3_GUARD/);
});
