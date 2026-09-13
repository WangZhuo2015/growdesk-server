import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
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

test("SH-05: BFF Session Management suite", async (t) => {
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

  // Ensure all migrations up to 202609120009_bff_sessions are applied
  const migrations = [
    "prisma/migrations/202609120001_identity/migration.sql",
    "prisma/migrations/202609120002_foundation/migration.sql",
    "prisma/migrations/202609120003_care_feeding/migration.sql",
    "prisma/migrations/202609120004_care_diaper/migration.sql",
    "prisma/migrations/202609120005_care_sleep/migration.sql",
    "prisma/migrations/202609120006_care_food/migration.sql",
    "prisma/migrations/202609120007_care_supplement/migration.sql",
    "prisma/migrations/202609120008_care_growth/migration.sql",
    "prisma/migrations/202609120009_bff_sessions/migration.sql",
  ];

  for (const m of migrations) {
    const sql = fs.readFileSync(m, "utf8");
    try {
      await ctx.pool.query(sql);
    } catch {
      // Table may already exist in shared run, continue
    }
  }

  const username = `test_bff_user_${Date.now()}`;
  const password = "Password123!";
  const sessionSecret = crypto.randomBytes(32).toString("hex");
  const sessionSecretHash = crypto.createHash("sha256").update(sessionSecret).digest("hex");
  let userId = "";

  // Pre-register the user
  await t.test("Setup: Register test user", async () => {
    const regRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username,
        password,
        displayName: "BFF Test User",
      },
    });
    assert.strictEqual(regRes.statusCode, 201);
    userId = regRes.json<{ data: { user: { id: string } } }>().data.user.id;
    assert.ok(userId);
  });

  await t.test("BFF-01: Initial login & bind with username, password, and sessionSecretHash", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bff/session",
      payload: {
        sessionSecretHash,
        username,
        password,
        deviceLabel: "Chrome on macOS",
      },
    });
    assert.strictEqual(loginRes.statusCode, 200);
    const body = loginRes.json<{
      data: {
        accessToken: string;
        expiresIn: number;
        user: { id: string; username: string };
      };
    }>();

    assert.ok(body.data.accessToken);
    assert.strictEqual(body.data.user.id, userId);
    assert.strictEqual(body.data.user.username, username);

    // Verify row in bff_sessions table
    const dbRow = await ctx.prisma.bffSession.findUnique({
      where: { sessionSecretHash },
    });
    assert.ok(dbRow);
    assert.strictEqual(dbRow.userId, userId);
    assert.strictEqual(dbRow.revokedAt, null);
    assert.ok(dbRow.currentAccessToken);
  });

  await t.test("BFF-02: Exchange sessionSecretHash for active accessToken", async () => {
    const exchangeRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bff/session",
      payload: {
        sessionSecretHash,
        userId,
      },
    });
    assert.strictEqual(exchangeRes.statusCode, 200);
    const body = exchangeRes.json<{
      data: {
        accessToken: string;
        expiresIn: number;
        user: { id: string };
      };
    }>();

    assert.ok(body.data.accessToken);
    assert.strictEqual(body.data.user.id, userId);
  });

  await t.test("BFF-03: Concurrent exchange requests succeed without conflict", async () => {
    const requests = Array.from({ length: 5 }, () =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/bff/session",
        payload: {
          sessionSecretHash,
          userId,
        },
      }),
    );

    const responses = await Promise.all(requests);
    for (const res of responses) {
      assert.strictEqual(res.statusCode, 200);
      assert.ok(res.json<{ data: { accessToken: string } }>().data.accessToken);
    }
  });

  await t.test("BFF-04: Revoke session and verify subsequent exchange returns 401", async () => {
    const revokeRes = await app.inject({
      method: "DELETE",
      url: "/api/v1/auth/bff/session",
      payload: {
        sessionSecretHash,
      },
    });
    assert.strictEqual(revokeRes.statusCode, 200);

    const exchangeRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/bff/session",
      payload: {
        sessionSecretHash,
        userId,
      },
    });
    assert.strictEqual(exchangeRes.statusCode, 401);
  });
});
