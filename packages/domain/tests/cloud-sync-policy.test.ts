import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorizeCloudSync, type CloudSyncBinding, type SyncRequestContext } from '../src/cloud-sync-policy.js';
const binding: CloudSyncBinding = {
  id: 'test_binding', userId: 'test_user', installationId: 'test_device', localVaultId: 'test_vault',
  familyId: 'test_family', status: 'active', generation: 2, consentVersion: 'sync-v1',
};
const request: SyncRequestContext = {
  bindingId: 'test_binding',
  principal: { userId: 'test_user', username: 'test_user', sessionId: 'test_session',
    familyMemberships: [{ familyId: 'test_family', role: 'member', status: 'active' }] },
  installationId: 'test_device', localVaultId: 'test_vault', familyId: 'test_family', generation: 2, operation: 'push',
};
test('login without an active binding does not enable sync', () => {
  assert.deepEqual(authorizeCloudSync(undefined, request, 'sync-v1'), { allowed: false, code: 'SYNC_NOT_ENABLED' });
});
test('unexpected runtime operation fails closed even with a valid binding', () => {
  const unvalidated = { ...request, operation: 'delete' } as unknown as SyncRequestContext;
  assert.deepEqual(authorizeCloudSync(binding, unvalidated, 'sync-v1'), { allowed: false, code: 'SYNC_OPERATION_INVALID' });
});
test('unknown runtime family role cannot read cloud data', () => {
  const unvalidated = { ...request, operation: 'pull', principal: { ...request.principal,
    familyMemberships: [{ familyId: 'test_family', role: 'unknown', status: 'active' }] } } as unknown as SyncRequestContext;
  assert.deepEqual(authorizeCloudSync(binding, unvalidated, 'sync-v1'), { allowed: false, code: 'FAMILY_ACCESS_DENIED' });
});
for (const status of ['pending','paused','revoked'] as const) {
  test(`${status} rejects upload and download`, () => {
    for (const operation of ['pull','push'] as const) {
      assert.equal(authorizeCloudSync({ ...binding, status }, { ...request, operation }, 'sync-v1').allowed, false);
    }
  });
}
for (const key of ['bindingId','installationId','localVaultId','familyId'] as const) {
  test(`switching ${key} cannot reuse an old binding`, () => {
    assert.equal(authorizeCloudSync(binding, { ...request, [key]: 'test_other' }, 'sync-v1').allowed, false);
  });
}
test('switching accounts cannot reuse an active binding', () => {
  assert.equal(authorizeCloudSync(binding, { ...request, principal: { ...request.principal, userId: 'test_other' } }, 'sync-v1').allowed, false);
});
test('late requests from a previous generation are rejected after re-enable', () => {
  assert.deepEqual(authorizeCloudSync(binding, { ...request, generation: 1 }, 'sync-v1'), { allowed: false, code: 'SYNC_STALE_GENERATION' });
});
test('expired consent does not silently approve a new policy', () => {
  assert.deepEqual(authorizeCloudSync(binding, request, 'sync-v2'), { allowed: false, code: 'SYNC_CONSENT_REQUIRED' });
});
test('removed family membership rejects a still-active binding', () => {
  assert.deepEqual(authorizeCloudSync(binding, { ...request, principal: { ...request.principal, familyMemberships: [] } }, 'sync-v1'), { allowed: false, code: 'FAMILY_ACCESS_DENIED' });
});
for (const status of ['invited', 'revoked'] as const) {
  test(`${status} family membership cannot sync`, () => {
    const unqualified: SyncRequestContext = { ...request, principal: { ...request.principal,
      familyMemberships: [{ familyId: 'test_family', role: 'member', status }] } };
    assert.deepEqual(authorizeCloudSync(binding, { ...unqualified, operation: 'pull' }, 'sync-v1'),
      { allowed: false, code: 'FAMILY_ACCESS_DENIED' });
    assert.deepEqual(authorizeCloudSync(binding, { ...unqualified, operation: 'push' }, 'sync-v1'),
      { allowed: false, code: 'FAMILY_ACCESS_DENIED' });
  });
}
test('viewer can pull but cannot upload; consenting member can upload', () => {
  const viewer: SyncRequestContext = { ...request, principal: { ...request.principal,
    familyMemberships: [{ familyId: 'test_family', role: 'viewer', status: 'active' }] } };
  assert.equal(authorizeCloudSync(binding, { ...viewer, operation: 'pull' }, 'sync-v1').allowed, true);
  assert.deepEqual(authorizeCloudSync(binding, viewer, 'sync-v1'), { allowed: false, code: 'FAMILY_WRITE_DENIED' });
  assert.equal(authorizeCloudSync(binding, request, 'sync-v1').allowed, true);
});
