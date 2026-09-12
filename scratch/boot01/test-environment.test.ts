import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyDatabaseUrl, type TestEnvironment } from './test-environment.js';
const env: TestEnvironment = {
  directory: '/not-used', token: 'a'.repeat(32), pgPort: 55432, redisPort: 56379,
  user: 'test_boot01', database: 'test_growdesk_boot01', password: 'b'.repeat(48),
};
const valid = `postgresql://${env.user}:${env.password}@127.0.0.1:${env.pgPort}/${env.database}?sslmode=disable`;
test('only exact owned connection identity is accepted', () => assert.equal(verifyDatabaseUrl(valid, env), valid));
for (const [name, url] of Object.entries({
  role: valid.replace('test_boot01:', 'another_test_user:'),
  port: valid.replace(':55432/', ':5432/'),
  host: valid.replace('127.0.0.1', 'localhost'),
  database: valid.replace('/test_growdesk_boot01', '/production_test_archive'),
  protocol: valid.replace('postgresql:', 'https:'),
  driverHostOverride: valid + '&host=example.invalid',
  driverUserOverride: valid + '&user=admin',
  wrongPassword: valid.replace(env.password, 'SYNTHETIC_SECRET'),
  malformed: 'not a url SYNTHETIC_SECRET',
})) {
  test(`reject ${name} without leaking input`, () => {
    assert.throws(() => verifyDatabaseUrl(url, env), (error: Error) => {
      assert.match(error.message, /Guard:/);
      assert.ok(!error.message.includes('SYNTHETIC_SECRET'));
      assert.ok(!error.message.includes(env.password));
      return true;
    });
  });
}
