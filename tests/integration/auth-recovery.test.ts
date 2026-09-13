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

test("SH-03D: Password Change & Recovery Codes suite", async (t) => {
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

  const jwtSecret = "integration-test-auth-secret-min-32-chars-long!";
  const ctx = createDatabaseContext({ url });
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret,
  });

  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  const username = `test_rec_${Date.now()}`;
  let currentPassword = "InitialPassword123!";
  let session1Token = "";
  let session1Id = "";
  let session2Token = "";
  let batch1Codes: string[] = [];
  let batch1Id = "";
  let batch2Codes: string[] = [];
  let batch2Id = "";

  // 1. Setup: Register user
  await t.test("Setup: Register user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username,
        password: currentPassword,
        displayName: "Recovery Test User",
        deviceLabel: "Web Primary",
      },
    });
    assert.equal(res.statusCode, 201);
    const body = res.json<{ data: { accessToken: string; sessionId: string } }>();
    session1Token = body.data.accessToken;
    session1Id = body.data.sessionId;
    assert.ok(session1Token);
    assert.ok(session1Id);
  });

  // 2. Setup: Login to create session 2
  await t.test("Setup: Second login creates session 2", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username,
        password: currentPassword,
        deviceLabel: "iOS Secondary",
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ data: { accessToken: string } }>();
    session2Token = body.data.accessToken;
    assert.ok(session2Token);
  });

  // 3. RC-01: Change password with wrong old password fails with 401
  await t.test("RC-01: Change password with wrong current password fails with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/change",
      headers: { authorization: `Bearer ${session1Token}` },
      payload: {
        oldPassword: "WrongPassword999!",
        newPassword: "NewSuperPassword123!",
      },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "INVALID_CREDENTIALS");
  });

  // 4. RC-02: Change password with valid old password succeeds; revokes other session
  await t.test("RC-02: Change password with valid credentials revokes session 2 while keeping session 1", async () => {
    const nextPassword = "UpdatedPassword456!";
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/change",
      headers: { authorization: `Bearer ${session1Token}` },
      payload: {
        oldPassword: currentPassword,
        newPassword: nextPassword,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ data: { success: boolean } }>();
    assert.equal(body.data.success, true);
    currentPassword = nextPassword;

    // Session 1 remains active
    const meRes1 = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${session1Token}` },
    });
    assert.equal(meRes1.statusCode, 200);

    // Session 2 was revoked by password change
    const meRes2 = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${session2Token}` },
    });
    assert.equal(meRes2.statusCode, 401);
  });

  // 5. RC-03: Login with old password fails, new password succeeds
  await t.test("RC-03: Login verifies new password and rejects old password", async () => {
    const failRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username,
        password: "InitialPassword123!",
      },
    });
    assert.equal(failRes.statusCode, 401);

    const successRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username,
        password: currentPassword,
      },
    });
    assert.equal(successRes.statusCode, 200);
  });

  // 6. RC-04: Regenerate recovery codes requires valid password
  await t.test("RC-04: Regenerate recovery codes with wrong password fails with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recovery-codes/regenerate",
      headers: { authorization: `Bearer ${session1Token}` },
      payload: {
        password: "WrongPassword999!",
      },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "INVALID_CREDENTIALS");
  });

  // 7. RC-05: Regenerate recovery codes returns 10 single-use codes
  await t.test("RC-05: Regenerate recovery codes returns 10 codes and batchId", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recovery-codes/regenerate",
      headers: { authorization: `Bearer ${session1Token}` },
      payload: {
        password: currentPassword,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ data: { codes: string[]; batchId: string } }>();
    assert.equal(body.data.codes.length, 10);
    assert.ok(body.data.batchId);
    batch1Codes = body.data.codes;
    batch1Id = body.data.batchId;

    // Check database has 10 active codes
    const dbCodes = await ctx.prisma.recoveryCode.findMany({
      where: { batchId: batch1Id, revokedAt: null, usedAt: null },
    });
    assert.equal(dbCodes.length, 10);
  });

  // 8. RC-06: Regenerating new recovery code batch revokes previous batch
  await t.test("RC-06: Regenerating second batch revokes first batch in DB", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/recovery-codes/regenerate",
      headers: { authorization: `Bearer ${session1Token}` },
      payload: {
        password: currentPassword,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ data: { codes: string[]; batchId: string } }>();
    assert.equal(body.data.codes.length, 10);
    batch2Codes = body.data.codes;
    batch2Id = body.data.batchId;
    assert.notEqual(batch1Id, batch2Id);

    // Old batch is now revoked
    const revokedCount = await ctx.prisma.recoveryCode.count({
      where: { batchId: batch1Id, revokedAt: { not: null } },
    });
    assert.equal(revokedCount, 10);

    // New batch is active
    const activeCount = await ctx.prisma.recoveryCode.count({
      where: { batchId: batch2Id, revokedAt: null, usedAt: null },
    });
    assert.equal(activeCount, 10);
  });

  // 9. RC-07: Attempting to recover password with revoked batch 1 code fails
  await t.test("RC-07: Recovery with revoked code from batch 1 fails with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/recover",
      payload: {
        username,
        recoveryCode: batch1Codes[0],
        newPassword: "BrandNewPassword789!",
      },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "INVALID_RECOVERY_CODE");
  });

  // 10. RC-08: Recovery with non-existent username or bogus code fails with 401
  await t.test("RC-08: Recovery with wrong username or bogus code fails closed with 401", async () => {
    const res1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/recover",
      payload: {
        username: "test_non_existent_user_999",
        recoveryCode: batch2Codes[0],
        newPassword: "BrandNewPassword789!",
      },
    });
    assert.equal(res1.statusCode, 401);

    const res2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/recover",
      payload: {
        username,
        recoveryCode: "invalid-code-format",
        newPassword: "BrandNewPassword789!",
      },
    });
    assert.equal(res2.statusCode, 401);
  });

  // 11. RC-09: Recover password with valid code from batch 2 succeeds
  await t.test("RC-09: Valid recovery code resets password, marks code used, revokes batch and all sessions", async () => {
    const codeToUse = batch2Codes[0];
    const recoveredPassword = "RecoveredSuperSecurePassword999!";

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/recover",
      payload: {
        username,
        recoveryCode: codeToUse,
        newPassword: recoveredPassword,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ data: { success: boolean } }>();
    assert.equal(body.data.success, true);
    currentPassword = recoveredPassword;

    // The code used is marked usedAt
    const usedCount = await ctx.prisma.recoveryCode.count({
      where: { batchId: batch2Id, usedAt: { not: null } },
    });
    assert.equal(usedCount, 1);

    // Remaining 9 codes in the batch are revoked
    const revokedRemaining = await ctx.prisma.recoveryCode.count({
      where: { batchId: batch2Id, revokedAt: { not: null }, usedAt: null },
    });
    assert.equal(revokedRemaining, 9);

    // Existing session 1 is now revoked
    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${session1Token}` },
    });
    assert.equal(meRes.statusCode, 401);
  });

  // 12. RC-10: Used recovery code cannot be reused
  await t.test("RC-10: Re-using the consumed recovery code fails with 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/password/recover",
      payload: {
        username,
        recoveryCode: batch2Codes[0],
        newPassword: "AnotherNewPassword111!",
      },
    });
    assert.equal(res.statusCode, 401);
    const body = res.json<{ error: { code: string } }>();
    assert.equal(body.error.code, "INVALID_RECOVERY_CODE");
  });

  // 13. RC-11: Login with recovered password succeeds
  await t.test("RC-11: User can login with new recovered password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username,
        password: currentPassword,
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json<{ data: { accessToken: string } }>();
    assert.ok(body.data.accessToken);

    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${body.data.accessToken}` },
    });
    assert.equal(meRes.statusCode, 200);
    const meBody = meRes.json<{ data: { username: string } }>();
    assert.equal(meBody.data.username, username);
  });
});
