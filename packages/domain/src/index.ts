export type FamilyRole = "admin" | "member" | "viewer";
export type BabyRole = FamilyRole;
export type MembershipStatus = "invited" | "active" | "revoked";

/** The independent family-level membership and its management role. */
export interface FamilyMember {
  readonly userId: string;
  readonly familyId: string;
  readonly role: FamilyRole;
  readonly status: MembershipStatus;
}

/** The family membership projected into a verified principal. */
export interface FamilyMembership {
  readonly familyId: string;
  readonly role: FamilyRole;
  /** Current status projected from the verified FamilyMember row. */
  readonly status: MembershipStatus;
}

export interface Baby {
  readonly id: string;
  readonly familyId: string;
}

/** Explicit user-to-baby access; family membership alone never implies this row. */
export interface BabyMember {
  readonly userId: string;
  readonly babyId: string;
  readonly familyId: string;
  readonly role: BabyRole;
  readonly status: MembershipStatus;
}

export interface UserPrincipal {
  readonly userId: string;
  readonly username: string;
  readonly sessionId: string;
  readonly deviceLabel?: string;
  readonly familyMemberships: ReadonlyArray<FamilyMembership>;
  /**
   * Loaded from the current transaction for baby-scoped decisions. It is
   * optional only to keep the optional-sync binding gate source-compatible;
   * record access fails closed when it is absent.
   */
  readonly babyMemberships?: ReadonlyArray<BabyMember>;
}

export type BabyAccessAction = "read" | "write" | "manage";

export interface BabyAccessContext {
  /** Scope supplied by the route or command, never by activeBabyId. */
  readonly familyId: string;
  readonly babyId: string;
  /** Baby row reread from the current transaction; never a request-body object. */
  readonly loadedBaby: Baby;
}

export type BabyAccessCode =
  | "FAMILY_ACCESS_DENIED"
  | "BABY_ACCESS_DENIED"
  | "BABY_SCOPE_MISMATCH"
  | "BABY_ACTION_INVALID"
  | "BABY_WRITE_DENIED"
  | "BABY_MANAGE_DENIED";

export type BabyAccessDecision =
  | { readonly allowed: true; readonly membership: BabyMember }
  | { readonly allowed: false; readonly code: BabyAccessCode };

function isActiveFamilyMembership(membership: FamilyMembership): boolean {
  return membership.status === "active" && isFamilyRole(membership.role);
}

function isFamilyRole(role: unknown): role is FamilyRole {
  return role === "admin" || role === "member" || role === "viewer";
}

function isBabyRole(role: unknown): role is BabyRole {
  return role === "admin" || role === "member" || role === "viewer";
}

function isMembershipStatus(status: unknown): status is MembershipStatus {
  return status === "invited" || status === "active" || status === "revoked";
}

function isSameBaby(member: BabyMember, baby: Baby): boolean {
  return typeof member.userId === "string" && member.userId.length > 0 &&
    typeof member.babyId === "string" &&
    typeof member.familyId === "string" &&
    isBabyRole(member.role) &&
    member.babyId === baby.id &&
    member.familyId === baby.familyId;
}

/** Return the current active row for this user and baby, if one exists. */
export function activeBabyMemberFor(principal: UserPrincipal, baby: Baby): BabyMember | undefined {
  return principal.babyMemberships?.find((member) =>
    member.userId === principal.userId && member.status === "active" && isSameBaby(member, baby));
}

/** Database uniqueness is `(userId,babyId)`; this helper makes the invariant testable before persistence. */
export function babyMemberKey(userId: string, babyId: string): string {
  return `${userId}\u0000${babyId}`;
}

export function hasUniqueBabyMembers(members: ReadonlyArray<BabyMember>): boolean {
  const keys = new Set<string>();
  for (const member of members) {
    const key = babyMemberKey(member.userId, member.babyId);
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

export function isBabyMemberConsistent(member: BabyMember, baby: Baby): boolean {
  return isSameBaby(member, baby);
}

function isBabyAccessContext(value: unknown): value is BabyAccessContext {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as {
    familyId?: unknown;
    babyId?: unknown;
    loadedBaby?: unknown;
  };
  if (typeof candidate.familyId !== "string" || typeof candidate.babyId !== "string" ||
      typeof candidate.loadedBaby !== "object" || candidate.loadedBaby === null) return false;
  const baby = candidate.loadedBaby as { id?: unknown; familyId?: unknown };
  return typeof baby.id === "string" && typeof baby.familyId === "string";
}

/**
 * Check a baby-scoped record operation. Both current family qualification and
 * an active BabyMember row are required; a family admin is not implicitly a
 * baby admin or record reader.
 */
export function authorizeBabyAccess(
  principal: UserPrincipal,
  context: BabyAccessContext,
  action: BabyAccessAction,
): BabyAccessDecision {
  if (!isBabyAccessContext(context)) return { allowed: false, code: "BABY_SCOPE_MISMATCH" };
  if (action !== "read" && action !== "write" && action !== "manage") {
    return { allowed: false, code: "BABY_ACTION_INVALID" };
  }
  if (context.familyId !== context.loadedBaby.familyId || context.babyId !== context.loadedBaby.id) {
    return { allowed: false, code: "BABY_SCOPE_MISMATCH" };
  }

  const familyMember = principal.familyMemberships.find((membership) =>
    membership.familyId === context.familyId && isActiveFamilyMembership(membership));
  if (!familyMember) return { allowed: false, code: "FAMILY_ACCESS_DENIED" };

  const babyMember = activeBabyMemberFor(principal, context.loadedBaby);
  if (!babyMember) return { allowed: false, code: "BABY_ACCESS_DENIED" };

  if (action === "write" && (familyMember.role === "viewer" || (babyMember.role !== "admin" && babyMember.role !== "member"))) {
    return { allowed: false, code: "BABY_WRITE_DENIED" };
  }
  if (action === "manage" && (familyMember.role === "viewer" || babyMember.role !== "admin")) {
    return { allowed: false, code: "BABY_MANAGE_DENIED" };
  }
  return { allowed: true, membership: babyMember };
}

export function canInviteBabyMember(principal: UserPrincipal, context: BabyAccessContext): boolean {
  return authorizeBabyAccess(principal, context, "manage").allowed;
}

/**
 * Revoke/demote operations must leave one active baby admin. The check is
 * pure and is repeated after locking the family state in the write transaction.
 * Both member lists must be reread in that transaction; a BabyMember row
 * without its matching current FamilyMember cannot satisfy the safeguard.
 */
export function canRevokeBabyMember(
  principal: UserPrincipal,
  context: BabyAccessContext,
  target: BabyMember,
  currentMembers: ReadonlyArray<BabyMember>,
  currentFamilyMembers: ReadonlyArray<FamilyMember>,
): boolean {
  if (!canInviteBabyMember(principal, context) || !isSameBaby(target, context.loadedBaby)) return false;
  if (!isMembershipStatus(target.status) || !isBabyRole(target.role)) return false;
  if (target.status !== "active" || target.role !== "admin") return true;
  return currentMembers.some((member) =>
    member.status === "active" &&
    member.role === "admin" &&
    isSameBaby(member, context.loadedBaby) &&
    member.userId !== target.userId &&
    currentFamilyMembers.some((familyMember) =>
      familyMember.userId === member.userId &&
      familyMember.familyId === context.familyId &&
      familyMember.status === "active" &&
      isFamilyRole(familyMember.role) &&
      familyMember.role !== "viewer"));
}

export interface SecurityPolicy {
  /** Family container metadata only; it does not authorize baby records/feed rows. */
  canViewFamily(principal: UserPrincipal, familyId: string): boolean;
  canManageFamily(principal: UserPrincipal, familyId: string): boolean;
  canReadRecord(principal: UserPrincipal, context: BabyAccessContext): boolean;
  canWriteRecord(principal: UserPrincipal, context: BabyAccessContext): boolean;
  canManageBabyMembership(principal: UserPrincipal, context: BabyAccessContext): boolean;
  /** Filter one already paged DB result; repositories must do SQL authorization and pagination. */
  visibleBabyIdsForFamily(principal: UserPrincipal, familyId: string, babies: ReadonlyArray<Baby>): string[];
}

export const defaultSecurityPolicy: SecurityPolicy = {
  canViewFamily(principal, familyId) {
    return principal.familyMemberships.some((membership) =>
      membership.familyId === familyId && isActiveFamilyMembership(membership));
  },
  canManageFamily(principal, familyId) {
    return principal.familyMemberships.some((membership) =>
      membership.familyId === familyId && isActiveFamilyMembership(membership) && membership.role === "admin");
  },
  canReadRecord(principal, context) {
    return authorizeBabyAccess(principal, context, "read").allowed;
  },
  canWriteRecord(principal, context) {
    return authorizeBabyAccess(principal, context, "write").allowed;
  },
  canManageBabyMembership(principal, context) {
    return authorizeBabyAccess(principal, context, "manage").allowed;
  },
  visibleBabyIdsForFamily(principal, familyId, babies) {
    if (!defaultSecurityPolicy.canViewFamily(principal, familyId)) return [];
    const seen = new Set<string>();
    const visible: string[] = [];
    for (const baby of babies) {
      if (seen.has(baby.id)) continue;
      const context: BabyAccessContext = { familyId, babyId: baby.id, loadedBaby: baby };
      if (authorizeBabyAccess(principal, context, "read").allowed) {
        seen.add(baby.id);
        visible.push(baby.id);
      }
    }
    return visible;
  },
};

export { authorizeCloudSync } from "./cloud-sync-policy.js";
export type { CloudSyncBinding, SyncRequestContext, SyncDecision } from "./cloud-sync-policy.js";
