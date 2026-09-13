import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireTestDatabaseUrl } from '../src/environment.js';
const identity = { host: '127.0.0.1' as const, port: 55432, database: 'test_run_abc', role: 'test_runner', password: 'test_secret' };
const valid = 'postgresql://test_runner:test_secret@127.0.0.1:55432/test_run_abc?sslmode=disable';
test('accepts exact isolated runner connection', () => assert.equal(requireTestDatabaseUrl(valid, identity), valid));
for (const [name,url] of Object.entries({
  sqlite: 'file:./prod.db', productionHost: valid.replace('127.0.0.1','production.invalid'),
  unknownHost: valid.replace('127.0.0.1','localhost'), wrongRole: valid.replace('test_runner:', 'admin:'),
  wrongDatabase: valid.replace('/test_run_abc','/production_test_archive'), wrongPort: valid.replace(':55432/',':5432/'),
  queryBypass: valid+'&host=production.invalid', wrongSecret: valid.replace('test_secret','SYNTHETIC_SECRET'),
})) {
  test(`rejects ${name} before any connection and without exposing secret`, () => {
    assert.throws(() => requireTestDatabaseUrl(url,identity), (e: Error) =>
      e.message.startsWith('TEST_DATABASE_GUARD:') && !e.message.includes('SYNTHETIC_SECRET') && !e.message.includes('test_secret'));
  });
}
