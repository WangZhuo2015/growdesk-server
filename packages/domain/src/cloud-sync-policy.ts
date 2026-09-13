import type { UserPrincipal } from './index.js';

/** Loaded from the server transaction, never constructed from client-supplied status. */
export interface CloudSyncBinding {
  readonly id: string;
  readonly userId: string;
  readonly installationId: string;
  readonly localVaultId: string;
  readonly familyId: string;
  readonly status: 'pending' | 'active' | 'paused' | 'revoked';
  readonly generation: number;
  readonly consentVersion: string;
}
export interface SyncRequestContext {
  readonly bindingId: string;
  /** Principal and installation must come from verified first-party credentials. */
  readonly principal: UserPrincipal;
  readonly installationId: string;
  readonly localVaultId: string;
  readonly familyId: string;
  readonly generation: number;
  readonly operation: 'pull' | 'push';
}
export type SyncDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code:
      'SYNC_NOT_ENABLED' | 'SYNC_SCOPE_MISMATCH' | 'SYNC_STALE_GENERATION' |
      'SYNC_CONSENT_REQUIRED' | 'SYNC_OPERATION_INVALID' | 'FAMILY_ACCESS_DENIED' | 'FAMILY_WRITE_DENIED' };

/**
 * Optional-sync policy only; not a substitute for authentication or SQL locking.
 * Call after rereading binding/membership in the same transaction as the command.
 * No binding (including an ordinary authenticated login) means no cloud sync.
 * An allowed binding is not permission to read every baby in its family:
 * commands and feed projections must additionally verify current BabyMember access.
 */
export function authorizeCloudSync(
  binding: CloudSyncBinding | undefined,
  request: SyncRequestContext,
  requiredConsentVersion: string,
): SyncDecision {
  if (request.operation !== 'pull' && request.operation !== 'push') {
    return { allowed: false, code: 'SYNC_OPERATION_INVALID' };
  }
  if (!binding || binding.status !== 'active') return { allowed: false, code: 'SYNC_NOT_ENABLED' };
  if (binding.id !== request.bindingId || binding.userId !== request.principal.userId || binding.installationId !== request.installationId ||
      binding.localVaultId !== request.localVaultId || binding.familyId !== request.familyId) {
    return { allowed: false, code: 'SYNC_SCOPE_MISMATCH' };
  }
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
      request.generation !== binding.generation) return { allowed: false, code: 'SYNC_STALE_GENERATION' };
  if (!requiredConsentVersion || binding.consentVersion !== requiredConsentVersion) {
    return { allowed: false, code: 'SYNC_CONSENT_REQUIRED' };
  }
  const member = request.principal.familyMemberships.find(m => m.familyId === binding.familyId);
  if (!member || member.status !== 'active' || !['admin', 'member', 'viewer'].includes(member.role)) {
    return { allowed: false, code: 'FAMILY_ACCESS_DENIED' };
  }
  if (request.operation === 'push' && member.role !== 'admin' && member.role !== 'member') {
    return { allowed: false, code: 'FAMILY_WRITE_DENIED' };
  }
  return { allowed: true };
}
