import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { buildApiApp } from "../../apps/api/src/app.js";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import { hashRefreshToken } from "../../apps/api/src/auth/tokens.js";

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

test("SH-03B: Refresh Token Rotation & Replay Reuse Detection suite", async (t) => {
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

  const jwtSecret = "integration-test-auth-refresh-secret-min-32-chars!";
  const ctx = createDatabaseContext({ url });
  const app = buildApiApp({
    databaseContext: ctx,
    jwtSecret,
  });

  t.after(async () => {
    await app.close();
    await ctx.close();
  });

  const username = `test_user_rot_${Date.now()}`;
  const password = "RotationPassword123!";

  // 1. Initial registration
  const regRes = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: {
      username,
      password,
      displayName: "Rotation Parent",
      deviceLabel: "iOS Test Device",
    },
  });
  assert.equal(regRes.statusCode, 201);
  const regData = regRes.json().data;
  let currentRefreshToken = regData.refreshToken;
  const currentSessionId = regData.sessionId;
  let priorToken = "";
  let rotationId1 = "";

  await t.test("R-01: Atomic refresh rotation issues successor and marks predecessor used", async () => {
    rotationId1 = crypto.randomUUID();
    const refreshRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        refreshToken: currentRefreshToken,
        rotationId: rotationId1,
      },
    });

    assert.equal(refreshRes.statusCode, 200);
    const body = refreshRes.json();
    assert.ok(body.data.accessToken);
    assert.ok(body.data.refreshToken);
    assert.notEqual(body.data.refreshToken, currentRefreshToken, "Successor token must be fresh");
    assert.equal(body.data.rotationId, rotationId1);

    const oldHash = hashRefreshToken(currentRefreshToken);
    const newHash = hashRefreshToken(body.data.refreshToken);

    // Verify in PG18 that old credential is used and links to new
    const oldCredRes = await ctx.pool.query("SELECT * FROM refresh_credentials WHERE token_hash = $1", [oldHash]);
    assert.equal(oldCredRes.rows.length, 1);
    assert.ok(oldCredRes.rows[0].used_at !== null);
    assert.equal(oldCredRes.rows[0].rotation_id, rotationId1);
    assert.equal(oldCredRes.rows[0].replaced_by_id, newHash);

    // Verify in PG18 that new credential is created and active
    const newCredRes = await ctx.pool.query("SELECT * FROM refresh_credentials WHERE token_hash = $1", [newHash]);
    assert.equal(newCredRes.rows.length, 1);
    assert.equal(newCredRes.rows[0].used_at, null);
    assert.equal(newCredRes.rows[0].parent_id, oldHash);
    assert.equal(newCredRes.rows[0].rotation_id, rotationId1);

    // Verify new access token works
    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${body.data.accessToken}` },
    });
    assert.equal(meRes.statusCode, 200);

    // Update pointers for subsequent tests
    priorToken = currentRefreshToken;
    currentRefreshToken = body.data.refreshToken;
  });

  await t.test("R-02: Same rotationId replay within 60s returns cached successor (lost response tolerance)", async () => {
    const replayRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        refreshToken: priorToken,
        rotationId: rotationId1, // Exactly the same rotationId
      },
    });

    assert.equal(replayRes.statusCode, 200);
    const replayBody = replayRes.json();
    assert.equal(replayBody.data.refreshToken, currentRefreshToken, "Must return identical successor");
    assert.equal(replayBody.data.rotationId, rotationId1);

    // Verify no extra credentials were created in PG18
    const countRes = await ctx.pool.query("SELECT count(*)::int AS count FROM refresh_credentials WHERE session_id = $1", [currentSessionId]);
    assert.equal(countRes.rows[0].count, 2, "Should strictly have original + successor only");
  });

  await t.test("R-03: Token reuse with different rotationId triggers 409 and revokes session family", async () => {
    const hostileRotationId = crypto.randomUUID();
    const reuseRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        refreshToken: priorToken, // Old, already-used token
        rotationId: hostileRotationId, // Different rotationId
      },
    });

    assert.equal(reuseRes.statusCode, 409);
    const reuseBody = reuseRes.json();
    assert.equal(reuseBody.error.code, "REFRESH_REUSE_DETECTED");

    // Verify in PG18 that device session is completely revoked
    const sessionRow = await ctx.pool.query("SELECT revoked_at FROM device_sessions WHERE id = $1", [currentSessionId]);
    assert.ok(sessionRow.rows[0].revoked_at !== null, "Session must be revoked");

    // Verify all refresh credentials for that session are revoked
    const credRows = await ctx.pool.query("SELECT revoked_at FROM refresh_credentials WHERE session_id = $1", [currentSessionId]);
    for (const row of credRows.rows) {
      assert.ok(row.revoked_at !== null, "All session credentials must be revoked");
    }

    // Subsequent refresh with successor token is now rejected with 401
    const successorRefreshRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        refreshToken: currentRefreshToken,
        rotationId: crypto.randomUUID(),
      },
    });
    assert.equal(successorRefreshRes.statusCode, 401);
    assert.equal(successorRefreshRes.json().error.code, "REFRESH_TOKEN_REVOKED");
  });

  await t.test("R-04: Non-existent refresh token fails closed with 401 INVALID_REFRESH_TOKEN", async () => {
    const bogusRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: {
        refreshToken: crypto.randomBytes(32).toString("hex"),
        rotationId: crypto.randomUUID(),
      },
    });

    assert.equal(bogusRes.statusCode, 401);
    assert.equal(bogusRes.json().error.code, "INVALID_REFRESH_TOKEN");
  });
});
