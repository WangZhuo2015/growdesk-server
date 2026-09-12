import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import bcrypt from "bcryptjs";
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

test("SH-03A: Authentication, DeviceSession, and Principal resolution suite", async (t) => {
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

  const testUsername = `test_user_auth_${Date.now()}`;
  const testPassword = "SuperStrongP@ssw0rd123!";
  let primaryAccessToken = "";
  let primarySessionId = "";

  await t.test("A-01: User registration creates user, default family, and initial session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: testUsername,
        password: testPassword,
        displayName: "Test Parent Alpha",
        deviceLabel: "iPhone 16 Pro iOS",
      },
    });

    assert.equal(res.statusCode, 201);
    const body = res.json();
    assert.ok(body.data.accessToken, "Should return accessToken");
    assert.ok(body.data.refreshToken, "Should return refreshToken");
    assert.equal(body.data.expiresIn, 600);
    assert.ok(body.data.sessionId, "Should return sessionId");
    assert.equal(body.data.user.username, testUsername);
    assert.equal(body.data.user.displayName, "Test Parent Alpha");

    primaryAccessToken = body.data.accessToken;
    primarySessionId = body.data.sessionId;

    // Verify in PG18 that user, default family, admin membership and sync states exist
    const userRow = await ctx.pool.query("SELECT * FROM users WHERE id = $1", [body.data.user.id]);
    assert.equal(userRow.rows.length, 1);

    const userSync = await ctx.pool.query("SELECT * FROM user_sync_states WHERE user_id = $1", [body.data.user.id]);
    assert.equal(userSync.rows.length, 1);
    assert.equal(BigInt(userSync.rows[0].cursor), 0n);

    const fmRow = await ctx.pool.query("SELECT * FROM family_members WHERE user_id = $1", [body.data.user.id]);
    assert.equal(fmRow.rows.length, 1);
    assert.equal(fmRow.rows[0].role, "admin");
    assert.equal(fmRow.rows[0].status, "active");

    const sessionRow = await ctx.pool.query("SELECT * FROM device_sessions WHERE id = $1", [primarySessionId]);
    assert.equal(sessionRow.rows.length, 1);
    assert.equal(sessionRow.rows[0].platform, "ios");
    assert.equal(sessionRow.rows[0].revoked_at, null);

    const credRow = await ctx.pool.query("SELECT * FROM refresh_credentials WHERE session_id = $1", [primarySessionId]);
    assert.equal(credRow.rows.length, 1);
  });

  await t.test("A-02: Username duplicate registration rejected with 409 USERNAME_EXISTS", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: testUsername,
        password: "AnotherPassword123!",
        displayName: "Duplicate Attempt",
      },
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.error.code, "USERNAME_EXISTS");
  });

  await t.test("A-03: User login with valid credentials creates new session", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: testUsername,
        password: testPassword,
        deviceLabel: "Chrome macOS Web",
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.data.accessToken);
    assert.ok(body.data.sessionId);
    assert.notEqual(body.data.sessionId, primarySessionId, "New login issues independent session");
    assert.equal(body.data.user.username, testUsername);
  });

  await t.test("A-04: User login with invalid password rejected with 401 INVALID_CREDENTIALS", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: testUsername,
        password: "WrongPassword!",
      },
    });

    assert.equal(res.statusCode, 401);
    const body = res.json();
    assert.equal(body.error.code, "INVALID_CREDENTIALS");
  });

  await t.test("A-05: Legacy bcrypt hash transparently upgraded on successful login", async () => {
    const legacyUsername = `test_legacy_${Date.now()}`;
    const legacyPassword = "OldLegacyPassword123!";
    // Cost 8 bcrypt hash
    const legacyHash = await bcrypt.hash(legacyPassword, 8);
    const legacyUserId = `test_user_legacy_${Date.now()}`;

    await ctx.pool.query(
      `INSERT INTO users (id, username, password_hash, password_hash_version, display_name, updated_at)
       VALUES ($1, $2, $3, 1, 'Legacy User', NOW())`,
      [legacyUserId, legacyUsername, legacyHash],
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: legacyUsername,
        password: legacyPassword,
      },
    });

    assert.equal(res.statusCode, 200);

    // Verify hash upgraded in database
    const updatedUser = await ctx.pool.query("SELECT password_hash, password_hash_version FROM users WHERE id = $1", [legacyUserId]);
    assert.equal(updatedUser.rows[0].password_hash_version, 2);
    assert.ok(updatedUser.rows[0].password_hash.startsWith("$2b$12$"), "Should be upgraded to bcrypt 12");
  });

  await t.test("A-06: Authenticated request resolves UserPrincipal and accesses /me", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        authorization: `Bearer ${primaryAccessToken}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.data.username, testUsername);
    assert.equal(body.data.displayName, "Test Parent Alpha");
  });

  await t.test("A-07: List active sessions returns all active DeviceSessions", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/auth/sessions",
      headers: {
        authorization: `Bearer ${primaryAccessToken}`,
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.length >= 2, "Should have registered session and login session");
    const foundPrimary = body.data.find((s: { id: string }) => s.id === primarySessionId);
    assert.ok(foundPrimary, "Should contain primarySessionId");
  });

  await t.test("A-08: Logout revokes session and subsequent requests fail with 401", async () => {
    const logoutRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        authorization: `Bearer ${primaryAccessToken}`,
      },
    });

    assert.equal(logoutRes.statusCode, 200);
    assert.deepEqual(logoutRes.json(), { data: { success: true } });

    // Verify session revoked in DB
    const sessionRes = await ctx.pool.query("SELECT revoked_at FROM device_sessions WHERE id = $1", [primarySessionId]);
    assert.ok(sessionRes.rows[0].revoked_at !== null);

    // Verify subsequent request with that token is rejected
    const retryRes = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        authorization: `Bearer ${primaryAccessToken}`,
      },
    });

    assert.equal(retryRes.statusCode, 401);
    const retryBody = retryRes.json();
    assert.equal(retryBody.error.code, "SESSION_REVOKED");
  });

  await t.test("A-09: Explicit session revocation by ID terminates that session only", async () => {
    // Re-login to get active session 1
    const loginRes1 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: testUsername,
        password: testPassword,
        deviceLabel: "Device Session 1",
      },
    });
    assert.equal(loginRes1.statusCode, 200);
    const token1 = loginRes1.json().data.accessToken;

    // Login to get active session 2
    const loginRes2 = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: testUsername,
        password: testPassword,
        deviceLabel: "Device Session 2",
      },
    });
    assert.equal(loginRes2.statusCode, 200);
    const session2Id = loginRes2.json().data.sessionId;
    const token2 = loginRes2.json().data.accessToken;

    // Device 1 revokes session 2
    const deleteRes = await app.inject({
      method: "DELETE",
      url: `/api/v1/auth/sessions/${session2Id}`,
      headers: {
        authorization: `Bearer ${token1}`,
      },
    });
    assert.equal(deleteRes.statusCode, 200);
    assert.deepEqual(deleteRes.json(), { data: { revoked: true } });

    // Request from device 2 is now rejected
    const checkRes2 = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        authorization: `Bearer ${token2}`,
      },
    });
    assert.equal(checkRes2.statusCode, 401);
    assert.equal(checkRes2.json().error.code, "SESSION_REVOKED");

    // Request from device 1 remains valid
    const checkRes1 = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: {
        authorization: `Bearer ${token1}`,
      },
    });
    assert.equal(checkRes1.statusCode, 200);
  });
});
