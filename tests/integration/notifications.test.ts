/** Run only through scripts/test-integration.py against its owned PostgreSQL instance. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

function readOwnedRun(): OwnedRun {
  const manifest = process.env.BOOT02_RUN_FILE;
  if (!manifest) throw new Error("Integration tests require the managed test runner");
  const real = fs.realpathSync(manifest);
  const parent = path.dirname(real);
  const stat = fs.statSync(real);
  if (
    path.dirname(parent) !== fs.realpathSync(os.tmpdir())
    || !path.basename(parent).startsWith("growdesk-integration-")
    || stat.uid !== process.getuid?.()
    || (stat.mode & 0o077)
  ) {
    throw new Error("Unsafe integration manifest");
  }
  const run = JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
  if (
    run.directory !== parent
    || run.database !== "test_growdesk_integration"
    || run.user !== "test_runner"
    || !Number.isInteger(run.pgPort)
    || run.pgPort < 1025
    || run.pgPort > 65535
  ) {
    throw new Error("Not an owned test database");
  }
  return run;
}

test("SH-06 notifications use an owned keyset and enforce user isolation", async t => {
  const run = readOwnedRun();
  const database = createDatabaseContext({
    url: requireTestDatabaseUrl(
      `postgresql://${run.user}:${run.password}@127.0.0.1:${run.pgPort}/${run.database}?sslmode=disable`,
      {
        host: "127.0.0.1",
        port: run.pgPort,
        database: run.database,
        role: run.user,
        password: run.password,
      },
    ),
  });
  const app = buildApiApp({
    databaseContext: database,
    jwtSecret: "test_notifications_secret_at_least_32_characters",
  });
  const familyIds: string[] = [];
  const userIds: string[] = [];

  t.after(async () => {
    try {
      if (familyIds.length) {
        await database.prisma.family.deleteMany({ where: { id: { in: familyIds } } });
      }
      if (userIds.length) {
        await database.prisma.user.deleteMany({
          where: { id: { in: userIds }, username: { startsWith: "test_notifications_" } },
        });
      }
    } finally {
      await app.close();
      await database.close();
    }
  });

  async function register(label: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: {
        username: `test_notifications_${label}_${randomUUID().slice(0, 8)}`,
        password: "TestPassword123!",
        displayName: `test_notifications_${label}`,
      },
    });
    assert.equal(response.statusCode, 201, response.payload);
    const auth = response.json<{ data: { accessToken: string; user: { id: string } } }>().data;
    userIds.push(auth.user.id);
    const families = await app.inject({
      method: "GET",
      url: "/api/v1/families",
      headers: { authorization: `Bearer ${auth.accessToken}` },
    });
    assert.equal(families.statusCode, 200, families.payload);
    const familyId = families.json<{ data: Array<{ id: string }> }>().data[0]?.id;
    assert.ok(familyId);
    familyIds.push(familyId);
    return {
      token: auth.accessToken,
      headers: { authorization: `Bearer ${auth.accessToken}` },
      userId: auth.user.id,
    };
  }

  const owner = await register("owner");
  const other = await register("other");

  const notificationIds = Array.from({ length: 205 }, () => randomUUID());
  const baseMs = Date.parse("2026-09-19T00:00:00.000Z");
  await database.prisma.notification.createMany({
    data: notificationIds.map((id, index) => ({
      id,
      userId: owner.userId,
      eventKey: `test.notifications.${index}`,
      title: `test notification ${index}`,
      body: `test body ${index}`,
      data: { index },
      // Repeated timestamps exercise the id tie-breaker as well as the time key.
      createdAt: new Date(baseMs + Math.floor(index / 3) * 1000),
    })),
  });

  await t.test("205 owned rows are returned once across keyset pages", async () => {
    const received: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/notifications?${query}`,
        headers: owner.headers,
      });
      assert.equal(response.statusCode, 200, response.payload);
      const body = response.json<{ data: Array<{ id: string; userId: string; createdAt: string }>; page: { nextCursor: string | null } }>();
      assert.ok(body.data.length <= 100);
      assert.ok(body.data.every(item => item.userId === owner.userId));
      received.push(...body.data.map(item => item.id));
      cursor = body.page.nextCursor;
      pages += 1;
      assert.ok(pages <= 3, "cursor should advance through exactly three pages");
    } while (cursor);

    assert.equal(pages, 3);
    assert.equal(received.length, 205);
    assert.equal(new Set(received).size, 205);
    assert.deepEqual(new Set(received), new Set(notificationIds));
  });

  await t.test("another principal cannot list or mark the owner's notification", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?limit=100",
      headers: other.headers,
    });
    assert.equal(list.statusCode, 200, list.payload);
    const listed = list.json<{ data: Array<{ id: string; userId: string }> }>().data;
    assert.equal(listed.length, 0);
    assert.ok(listed.every(item => item.userId !== owner.userId));

    const foreignRead = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${notificationIds[0]}/read`,
      headers: other.headers,
    });
    assert.equal(foreignRead.statusCode, 404, foreignRead.payload);
    const rowAfterForeignRead = await database.prisma.notification.findUniqueOrThrow({
      where: { id: notificationIds[0] },
      select: { readAt: true },
    });
    assert.equal(rowAfterForeignRead.readAt, null);

    const ownRead = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${notificationIds[0]}/read`,
      headers: owner.headers,
    });
    assert.equal(ownRead.statusCode, 200, ownRead.payload);
    const rowAfterOwnRead = await database.prisma.notification.findUniqueOrThrow({
      where: { id: notificationIds[0] },
      select: { readAt: true },
    });
    assert.ok(rowAfterOwnRead.readAt);
  });

  await t.test("malformed cursors fail instead of silently restarting from page one", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/notifications?cursor=not-a-valid-cursor",
      headers: owner.headers,
    });
    assert.equal(response.statusCode, 400, response.payload);
    assert.equal(response.json<{ error: { code: string } }>().error.code, "INVALID_NOTIFICATION_CURSOR");
  });
});
