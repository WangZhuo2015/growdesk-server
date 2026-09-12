import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizeBabyAccess,
  babyMemberKey,
  canRevokeBabyMember,
  defaultSecurityPolicy,
  hasUniqueBabyMembers,
  isBabyMemberConsistent,
  type Baby,
  type BabyAccessContext,
  type FamilyMember,
  type BabyMember,
  type UserPrincipal,
} from "../src/index.js";

const familyA = "test_family_a";
const familyB = "test_family_b";
const babyA = { id: "test_baby_a", familyId: familyA } satisfies Baby;
const babyB = { id: "test_baby_b", familyId: familyA } satisfies Baby;
const babyOtherFamily = { id: "test_baby_other", familyId: familyB } satisfies Baby;

function member(
  userId: string,
  baby: Baby,
  role: BabyMember["role"] = "member",
  status: BabyMember["status"] = "active",
): BabyMember {
  return { userId, babyId: baby.id, familyId: baby.familyId, role, status };
}

function familyMember(
  userId: string,
  familyId = familyA,
  role: FamilyMember["role"] = "member",
  status: FamilyMember["status"] = "active",
): FamilyMember {
  return { userId, familyId, role, status };
}

function principal(
  userId = "test_user_a",
  familyId = familyA,
  familyRole: UserPrincipal["familyMemberships"][number]["role"] = "member",
  babyMemberships: ReadonlyArray<BabyMember> = [member(userId, babyA)],
): UserPrincipal {
  return {
    userId,
    username: `${userId}_username`,
    sessionId: "test_session_a",
    familyMemberships: [{ familyId, role: familyRole, status: "active" }],
    babyMemberships,
  };
}

function context(baby: Baby, familyId = baby.familyId): BabyAccessContext {
  return { familyId, babyId: baby.id, loadedBaby: baby };
}

test("one user can hold active memberships for multiple babies and families", () => {
  const user = "test_user_multi";
  const babyInB = { id: "test_baby_family_b", familyId: familyB } satisfies Baby;
  const current = principal(user, familyA, "member", [member(user, babyA), member(user, babyB), member(user, babyInB)]);
  const withFamilyB: UserPrincipal = {
    ...current,
    familyMemberships: [
      { familyId: familyA, role: "member", status: "active" },
      { familyId: familyB, role: "viewer", status: "active" },
    ],
  };
  assert.equal(defaultSecurityPolicy.canReadRecord(withFamilyB, context(babyA)), true);
  assert.equal(defaultSecurityPolicy.canReadRecord(withFamilyB, context(babyB)), true);
  assert.equal(defaultSecurityPolicy.canReadRecord(withFamilyB, context(babyInB)), true);
});

test("multiple caregivers can access the same baby through separate BabyMember rows", () => {
  const caregiver = principal("test_user_caregiver", familyA, "member", [member("test_user_caregiver", babyA)]);
  const secondCaregiver = principal("test_user_second", familyA, "member", [member("test_user_second", babyA)]);
  assert.equal(defaultSecurityPolicy.canReadRecord(caregiver, context(babyA)), true);
  assert.equal(defaultSecurityPolicy.canReadRecord(secondCaregiver, context(babyA)), true);
});

test("family admin without a BabyMember row cannot read or manage that baby", () => {
  const familyAdmin = principal("test_user_admin", familyA, "admin", []);
  const scope = context(babyA);
  assert.deepEqual(authorizeBabyAccess(familyAdmin, scope, "read"), {
    allowed: false,
    code: "BABY_ACCESS_DENIED",
  });
  assert.equal(defaultSecurityPolicy.canManageFamily(familyAdmin, familyA), true);
  assert.equal(defaultSecurityPolicy.canManageBabyMembership(familyAdmin, scope), false);
});

test("baby access requires an active FamilyMember and an active BabyMember", () => {
  const revokedFamily: UserPrincipal = {
    ...principal("test_user_revoked_family", familyA, "member", [member("test_user_revoked_family", babyA)]),
    familyMemberships: [{ familyId: familyA, role: "member", status: "revoked" }],
  };
  assert.deepEqual(authorizeBabyAccess(revokedFamily, context(babyA), "read"), {
    allowed: false,
    code: "FAMILY_ACCESS_DENIED",
  });

  const invitedBaby = principal("test_user_invited", familyA, "member", [member("test_user_invited", babyA, "member", "invited")]);
  assert.deepEqual(authorizeBabyAccess(invitedBaby, context(babyA), "read"), {
    allowed: false,
    code: "BABY_ACCESS_DENIED",
  });
});

test("viewer can read but cannot write or manage baby records", () => {
  const viewer = principal("test_user_viewer", familyA, "viewer", [member("test_user_viewer", babyA, "viewer")]);
  const scope = context(babyA);
  assert.equal(defaultSecurityPolicy.canReadRecord(viewer, scope), true);
  assert.deepEqual(authorizeBabyAccess(viewer, scope, "write"), {
    allowed: false,
    code: "BABY_WRITE_DENIED",
  });
  assert.deepEqual(authorizeBabyAccess(viewer, scope, "manage"), {
    allowed: false,
    code: "BABY_MANAGE_DENIED",
  });
});

test("family write/manage permission intersects with baby permission", () => {
  const familyViewerBabyAdmin = principal("test_user_viewer_admin", familyA, "viewer", [member("test_user_viewer_admin", babyA, "admin")]);
  const scope = context(babyA);
  assert.equal(defaultSecurityPolicy.canReadRecord(familyViewerBabyAdmin, scope), true);
  assert.deepEqual(authorizeBabyAccess(familyViewerBabyAdmin, scope, "write"), {
    allowed: false,
    code: "BABY_WRITE_DENIED",
  });
  assert.deepEqual(authorizeBabyAccess(familyViewerBabyAdmin, scope, "manage"), {
    allowed: false,
    code: "BABY_MANAGE_DENIED",
  });
});

test("unknown runtime family or baby roles fail closed", () => {
  const unknownFamily = {
    ...principal("test_user_unknown_family", familyA, "member", [member("test_user_unknown_family", babyA)]),
    familyMemberships: [{ familyId: familyA, role: "owner", status: "active" }],
  } as unknown as UserPrincipal;
  assert.deepEqual(authorizeBabyAccess(unknownFamily, context(babyA), "read"), {
    allowed: false,
    code: "FAMILY_ACCESS_DENIED",
  });

  const unknownBaby = principal("test_user_unknown_baby", familyA, "member", [
    { ...member("test_user_unknown_baby", babyA), role: "owner" },
  ] as unknown as ReadonlyArray<BabyMember>);
  assert.deepEqual(authorizeBabyAccess(unknownBaby, context(babyA), "read"), {
    allowed: false,
    code: "BABY_ACCESS_DENIED",
  });
});

test("record scope must agree with the Baby composite family identity", () => {
  const current = principal();
  assert.deepEqual(authorizeBabyAccess(current, context(babyA, familyB), "read"), {
    allowed: false,
    code: "BABY_SCOPE_MISMATCH",
  });
  assert.deepEqual(authorizeBabyAccess(current, {
    familyId: familyA,
    babyId: "test_baby_wrong",
    loadedBaby: babyA,
  }, "read"), {
    allowed: false,
    code: "BABY_SCOPE_MISMATCH",
  });
  assert.equal(defaultSecurityPolicy.canReadRecord(current, context(babyOtherFamily)), false);
});

test("family feed projection returns only babies with active baby access", () => {
  const current = principal("test_user_feed", familyA, "member", [member("test_user_feed", babyA)]);
  assert.deepEqual(defaultSecurityPolicy.visibleBabyIdsForFamily(current, familyA, [babyA, babyB, babyOtherFamily]), [babyA.id]);
  assert.deepEqual(defaultSecurityPolicy.visibleBabyIdsForFamily(current, familyB, [babyOtherFamily]), []);
});

test("the last active baby admin cannot be revoked, but another admin permits revocation", () => {
  const actor = principal("test_user_baby_admin", familyA, "member", [member("test_user_baby_admin", babyA, "admin")]);
  const target = member("test_user_target_admin", babyA, "admin");
  const targetFamilyMember = familyMember(target.userId);
  const scope = context(babyA);
  assert.equal(canRevokeBabyMember(actor, scope, target, [target], [targetFamilyMember]), false);
  const otherAdmin = member("test_user_other_admin", babyA, "admin");
  assert.equal(canRevokeBabyMember(actor, scope, target, [target, otherAdmin], [
    targetFamilyMember,
    familyMember(otherAdmin.userId),
  ]), true);
});

test("a viewer or revoked FamilyMember does not satisfy the last-admin safeguard", () => {
  const actor = principal("test_user_baby_admin_guard", familyA, "member", [member("test_user_baby_admin_guard", babyA, "admin")]);
  const target = member("test_user_target_admin_guard", babyA, "admin");
  const otherAdmin = member("test_user_other_admin_guard", babyA, "admin");
  const scope = context(babyA);
  assert.equal(canRevokeBabyMember(actor, scope, target, [target, otherAdmin], [
    familyMember(target.userId),
    familyMember(otherAdmin.userId, familyA, "viewer"),
  ]), false);
  assert.equal(canRevokeBabyMember(actor, scope, target, [target, otherAdmin], [
    familyMember(target.userId),
    familyMember(otherAdmin.userId, familyA, "member", "revoked"),
  ]), false);
});

test("baby membership consistency and composite uniqueness are explicit", () => {
  const first = member("test_user_a", babyA);
  const duplicate = member("test_user_a", babyA, "viewer");
  const second = member("test_user_a", babyB);
  assert.equal(babyMemberKey(first.userId, first.babyId), "test_user_a\u0000test_baby_a");
  assert.equal(hasUniqueBabyMembers([first, second]), true);
  assert.equal(hasUniqueBabyMembers([first, duplicate]), false);
  assert.equal(isBabyMemberConsistent(first, babyA), true);
  assert.equal(isBabyMemberConsistent({ ...first, familyId: familyB }, babyA), false);
});

test("legacy family-only record authorization no longer grants write access", () => {
  const legacyPrincipal = principal("test_user_legacy", familyA, "member", []);
  const familyOnly = familyA as unknown as BabyAccessContext;
  assert.equal(defaultSecurityPolicy.canWriteRecord(legacyPrincipal, familyOnly), false);
});
