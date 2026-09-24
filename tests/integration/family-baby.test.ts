import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";

interface OwnedRun {
  directory: string;
  token: string;
  database: string;
  user: string;
  password: string;
  pgPort: number;
  redisPort: number;
}

function readRun(): OwnedRun {
  const file = process.env.BOOT02_RUN_FILE;
  if (!file) throw new Error("Integration tests require the managed test runner");
  const real = fs.realpathSync(file);
  const parent = path.dirname(real);
  if (path.dirname(parent) !== fs.realpathSync(os.tmpdir()) || !path.basename(parent).startsWith("growdesk-integration-")) {
    throw new Error("Integration manifest is outside its private run");
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) throw new Error("Unsafe manifest permissions");
  return JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
}

test("SH-03C: Family and Baby Authorization & Management suite", async (t) => {
  const run = readRun();
  const identity = {
    host: "127.0.0.1" as const,
    port: run.pgPort,
    database: run.database,
    role: run.user,
    password: run.password,
  };
  const url = requireTestDatabaseUrl(
    `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
    identity,
  );

  const jwtSecret = "integration-test-family-baby-secret-32-chars!!";
  const ctx = createDatabaseContext({ url });
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret,
  });

  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  // Helper to register a test user and obtain access token & user info
  async function registerUser(prefix: string) {
    const username = `test_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const password = "ValidPassword123!";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username,
        password,
        displayName: `DisplayName ${prefix}`,
        deviceLabel: "Test Device",
      },
    });
    assert.equal(res.statusCode, 201, `Failed to register ${username}`);
    const body = res.json();
    return {
      userId: body.data.user.id,
      username,
      displayName: body.data.user.displayName,
      token: body.data.accessToken,
    };
  }

  // Setup 3 users
  // User A: Primary user, admin in Family 1
  // User B: Joins Family 1, becomes caregiver for Baby 1
  // User C: Isolated user in Family 2
  const userA = await registerUser("user_a");
  const userB = await registerUser("user_b");
  const userC = await registerUser("user_c");

  let family1Id = "";
  let family2Id = "";
  let baby1Id = "";
  let inviteCode = "";

  await t.test("FB-01: User A creates a new family -> User A is admin, permissionVersion is 1", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        name: "test_family_alpha",
        timeZone: "Asia/Shanghai",
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.data.id);
    assert.equal(body.data.name, "test_family_alpha");
    assert.equal(body.data.timeZone, "Asia/Shanghai");
    family1Id = body.data.id;

    // Check DB sync state
    const syncState = await ctx.prisma.familySyncState.findUnique({
      where: { familyId: family1Id },
    });
    assert.ok(syncState);
    assert.equal(syncState.permissionVersion, 1);
  });

  await t.test("FB-02: User C creates Family 2; User A and C listFamilies return strictly isolated data", async () => {
    const resC = await app.inject({
      method: "POST",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${userC.token}` },
      payload: {
        name: "test_family_beta",
        timeZone: "America/New_York",
      },
    });
    assert.equal(resC.statusCode, 201);
    family2Id = resC.json().data.id;

    // User A lists families -> sees their default family and Family 1, but NOT Family 2
    const listResA = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(listResA.statusCode, 200);
    const familiesA = listResA.json().data;
    assert.ok(familiesA.some((f: { id: string }) => f.id === family1Id));
    assert.ok(!familiesA.some((f: { id: string }) => f.id === family2Id));

    // User C cannot get Family 1 details (returns 404 fail closed)
    const getResC = await app.inject({
      method: "GET",
      url: `/api/v1/families/${family1Id}`,
      headers: { authorization: `Bearer ${userC.token}` },
    });
    assert.equal(getResC.statusCode, 404);
  });

  await t.test("FB-03: Create family invite -> preview without auth works", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/families/${family1Id}/invites`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        expiresInDays: 7,
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.data.inviteCode);
    assert.ok(body.data.expiresAt);
    inviteCode = body.data.inviteCode;

    // Public preview without token
    const previewRes = await app.inject({
      method: "GET",
      url: `/api/v1/families/invites/preview?code=${inviteCode}`,
    });
    assert.equal(previewRes.statusCode, 200);
    const previewBody = previewRes.json();
    assert.equal(previewBody.data.familyName, "test_family_alpha");
    assert.equal(previewBody.data.inviterName, userA.displayName);
  });

  await t.test("FB-04: User B joins Family 1 via inviteCode -> becomes member, but has NO baby access", async () => {
    const joinRes = await app.inject({
      method: "POST",
      url: "/api/v1/families/join",
      headers: { authorization: `Bearer ${userB.token}` },
      payload: {
        inviteCode,
      },
    });

    assert.equal(joinRes.statusCode, 200);
    const joinBody = joinRes.json();
    assert.equal(joinBody.data.family.id, family1Id);
    assert.equal(joinBody.data.role, "member");

    // Joining with the same code again (usage limit reached) fails
    const reJoinRes = await app.inject({
      method: "POST",
      url: "/api/v1/families/join",
      headers: { authorization: `Bearer ${userC.token}` },
      payload: {
        inviteCode,
      },
    });
    assert.equal(reJoinRes.statusCode, 404);
  });

  await t.test("FB-04A: family projection preserves real member identity, relation, and role", async () => {
    const listRes = await app.inject({
      method: "GET",
      url: `/api/v1/families/${family1Id}/members`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(listRes.statusCode, 200, listRes.payload);
    const members = listRes.json().data as Array<Record<string, unknown>>;
    assert.equal(members.length, 2);
    const memberA = members.find(member => member.userId === userA.userId);
    const memberB = members.find(member => member.userId === userB.userId);
    assert.ok(memberA);
    assert.equal(memberA.id, (await ctx.prisma.familyMember.findUniqueOrThrow({ where: { uq_family_members_family_user: { familyId: family1Id, userId: userA.userId } } })).id);
    assert.equal(memberA.familyId, family1Id);
    assert.equal(memberA.username, userA.username);
    assert.equal(memberA.relation, "parent");
    assert.equal(memberA.role, "admin");
    assert.ok(memberB);
    assert.equal(memberB.id, (await ctx.prisma.familyMember.findUniqueOrThrow({ where: { uq_family_members_family_user: { familyId: family1Id, userId: userB.userId } } } )).id);
    assert.equal(memberB.username, userB.username);
    assert.equal(memberB.relation, "parent");
    assert.equal(memberB.role, "member");

    // A viewer row is a valid family permission. The projection must preserve
    // it rather than silently changing it to member.
    await ctx.prisma.familyMember.update({
      where: { uq_family_members_family_user: { familyId: family1Id, userId: userB.userId } },
      data: { role: "viewer" },
    });
    const viewerRes = await app.inject({
      method: "GET",
      url: `/api/v1/families/${family1Id}/members`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(viewerRes.statusCode, 200, viewerRes.payload);
    assert.equal((viewerRes.json().data as Array<Record<string, unknown>>).find(member => member.userId === userB.userId)?.role, "viewer");
    await ctx.prisma.familyMember.update({
      where: { uq_family_members_family_user: { familyId: family1Id, userId: userB.userId } },
      data: { role: "member" },
    });

    const crossFamily = await app.inject({
      method: "GET",
      url: `/api/v1/families/${family1Id}/members`,
      headers: { authorization: `Bearer ${userC.token}` },
    });
    assert.equal(crossFamily.statusCode, 403, crossFamily.payload);
  });

  await t.test("FB-05: User A creates Baby 1; User B cannot see Baby 1 in list or get", async () => {
    const createBabyRes = await app.inject({
      method: "POST",
      url: `/api/v1/families/${family1Id}/babies`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        name: "test_baby_one",
        birthDate: "2026-01-15",
        gender: "girl",
        gestationalWeeks: 39,
        gestationalDays: 2,
      },
    });

    assert.equal(createBabyRes.statusCode, 201, `Create baby failed: ${createBabyRes.payload}`);
    const babyBody = createBabyRes.json();
    baby1Id = babyBody.data.id;
    assert.equal(babyBody.data.name, "test_baby_one");
    assert.equal(babyBody.data.birthDate, "2026-01-15");
    assert.equal(babyBody.data.gender, "girl");
    assert.equal(babyBody.data.gestationalWeeks, 39);
    assert.equal(babyBody.data.gestationalDays, 2);

    // User A lists babies -> sees Baby 1
    const listA = await app.inject({
      method: "GET",
      url: `/api/v1/families/${family1Id}/babies`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(listA.statusCode, 200);
    assert.equal(listA.json().data.length, 1);
    assert.equal(listA.json().data[0].id, baby1Id);

    // CRITICAL SECURITY RULE: User B (in same family) has NO active BabyMember row yet -> gets empty list!
    const listB = await app.inject({
      method: "GET",
      url: `/api/v1/families/${family1Id}/babies`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(listB.statusCode, 200);
    assert.equal(listB.json().data.length, 0);

    // User B trying to get Baby 1 directly gets 404 (fail closed)
    const getB = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${baby1Id}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(getB.statusCode, 404);
  });

  await t.test("FB-06: User A adds User B as caregiver to Baby 1 -> User B now sees and gets Baby 1", async () => {
    const addMemberRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${baby1Id}/members`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        userId: userB.userId,
        role: "member",
      },
    });

    assert.equal(addMemberRes.statusCode, 201);
    assert.equal(addMemberRes.json().data.success, true);

    // Now User B lists babies -> sees Baby 1
    const listB = await app.inject({
      method: "GET",
      url: `/api/v1/families/${family1Id}/babies`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(listB.statusCode, 200);
    assert.equal(listB.json().data.length, 1);
    assert.equal(listB.json().data[0].id, baby1Id);

    // User B can get Baby 1 details
    const getB = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${baby1Id}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(getB.statusCode, 200);
    assert.equal(getB.json().data.name, "test_baby_one");

    // List baby caregivers -> sees User A (admin) and User B (member)
    const listCaregivers = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${baby1Id}/members`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(listCaregivers.statusCode, 200);
    const caregivers = listCaregivers.json().data;
    assert.equal(caregivers.length, 2);
    assert.ok(caregivers.some((c: { userId: string; role: string }) => c.userId === userA.userId && c.role === "admin"));
    assert.ok(caregivers.some((c: { userId: string; role: string }) => c.userId === userB.userId && c.role === "member"));
  });

  await t.test("FB-07: Cross-tenant isolation: Cannot add User C (from Family 2) to Baby 1 (Family 1)", async () => {
    const addRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${baby1Id}/members`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        userId: userC.userId,
        role: "member",
      },
    });

    assert.equal(addRes.statusCode, 400);
    assert.equal(addRes.json().error.code, "TARGET_NOT_IN_FAMILY");
  });

  await t.test("FB-08: Last family admin protection: User A cannot demote self while only admin", async () => {
    const demoteRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/families/${family1Id}/members/${userA.userId}`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        role: "member",
      },
    });

    assert.equal(demoteRes.statusCode, 409);
    assert.equal(demoteRes.json().error.code, "LAST_FAMILY_ADMIN_PROTECTION");
  });

  await t.test("FB-09: Last baby admin protection: User A cannot be revoked from Baby 1 while only baby admin", async () => {
    // 1. Direct revocation via baby member endpoint
    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${baby1Id}/members/${userA.userId}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(revokeRes.statusCode, 409);
    assert.equal(revokeRes.json().error.code, "LAST_BABY_ADMIN_PROTECTION");

    // 2. Family removal protection: cannot remove User A from family because they are the last baby admin
    // Even if User B is promoted to family admin first:
    await app.inject({
      method: "PATCH",
      url: `/api/v1/families/${family1Id}/members/${userB.userId}`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: { role: "admin" },
    });

    // User B (now family admin) tries to remove User A from family:
    const removeFamilyRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/families/${family1Id}/members/${userA.userId}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(removeFamilyRes.statusCode, 409);
    assert.equal(removeFamilyRes.json().error.code, "LAST_BABY_ADMIN_PROTECTION");
  });

  await t.test("FB-10: Promote User B to baby admin -> now User A can be revoked from Baby 1", async () => {
    // Promote User B to baby admin
    const promoteRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${baby1Id}/members`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        userId: userB.userId,
        role: "admin",
      },
    });
    assert.equal(promoteRes.statusCode, 201);

    // Now revoke User A from Baby 1
    const revokeRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/babies/${baby1Id}/members/${userA.userId}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(revokeRes.statusCode, 200);
    assert.equal(revokeRes.json().data.removed, true);

    // User A can no longer get Baby 1
    const getA = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${baby1Id}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(getA.statusCode, 404);

    // User B still has full access
    const getB = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${baby1Id}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(getB.statusCode, 200);
  });

  await t.test("FB-11: Viewer permissions: demoting family member or baby role to viewer denies write/create", async () => {
    // Demote User A in Baby 1 by re-adding as viewer
    const addViewerRes = await app.inject({
      method: "POST",
      url: `/api/v1/babies/${baby1Id}/members`,
      headers: { authorization: `Bearer ${userB.token}` },
      payload: {
        userId: userA.userId,
        role: "viewer",
      },
    });
    assert.equal(addViewerRes.statusCode, 201);

    // User A can now read Baby 1
    const getA = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${baby1Id}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(getA.statusCode, 200);

    // But User A CANNOT update Baby 1 (viewer role forbidden)
    const updateRes = await app.inject({
      method: "PATCH",
      url: `/api/v1/babies/${baby1Id}`,
      headers: { authorization: `Bearer ${userA.token}` },
      payload: {
        name: "malicious_rename",
      },
    });
    assert.equal(updateRes.statusCode, 403);
  });

  await t.test("FB-12: Removing User A from Family 1 cascades revocation of baby membership", async () => {
    // User B (admin) removes User A from family
    const removeRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/families/${family1Id}/members/${userA.userId}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(removeRes.statusCode, 200);
    assert.equal(removeRes.json().data.removed, true);

    // User A can no longer read Baby 1 even though they had a viewer row previously
    const getA = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${baby1Id}`,
      headers: { authorization: `Bearer ${userA.token}` },
    });
    assert.equal(getA.statusCode, 404);

    // Baby 1 still exists for User B
    const getB = await app.inject({
      method: "GET",
      url: `/api/v1/babies/${baby1Id}`,
      headers: { authorization: `Bearer ${userB.token}` },
    });
    assert.equal(getB.statusCode, 200);
  });
});
