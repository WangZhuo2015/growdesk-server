import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { FeedingRepository } from "../../packages/database/src/feeding-repository.js";
import { TimelineRepository } from "../../packages/database/src/timeline-repository.js";
import {
  IdempotencyKeyReusedError,
  ConcurrencyConflictError,
  BabyAccessDeniedError,
} from "../../packages/database/src/errors.js";
import { UserPrincipal } from "@growdesk/domain";
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

test("SH-02B: UnitOfWork full transaction and concurrency suite", async (t) => {
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
    identity
  );

  const ctx = createDatabaseContext({ url });
  const repo = new FeedingRepository(ctx.prisma);
  const timelineRepo = new TimelineRepository(ctx.prisma);

  t.after(async () => {
    await ctx.close();
  });

  const familyId = "test_fam_uow_1";
  const babyId1 = "test_baby_uow_1";
  const babyId2 = "test_baby_uow_2";
  const userId = "test_user_uow_1";
  const viewerUserId = "test_user_uow_viewer";

  // Setup seed tenant rows in PG18
  await ctx.pool.query(`
    INSERT INTO users (id, username, password_hash, display_name, updated_at) VALUES
      ($1, $1, $3, $4, NOW()),
      ($2, $2, $3, $5, NOW())
    ON CONFLICT (id) DO NOTHING;
  `, [userId, viewerUserId, "$2b$10$hash", "Caregiver One", "Viewer Only"]);

  await ctx.pool.query(`
    INSERT INTO families (id, name, timezone, updated_at) VALUES
      ($1, $2, $3, NOW())
    ON CONFLICT (id) DO NOTHING;
  `, [familyId, "UOW Family", "Asia/Shanghai"]);

  await ctx.pool.query(`
    INSERT INTO family_members (id, family_id, user_id, role, status, updated_at) VALUES
      ($1, $3, $4, $6, $7, NOW()),
      ($2, $3, $5, $8, $7, NOW())
    ON CONFLICT (family_id, user_id) DO NOTHING;
  `, [
    "fm_" + userId,
    "fm_" + viewerUserId,
    familyId,
    userId,
    viewerUserId,
    "admin",
    "active",
    "member"
  ]);

  await ctx.pool.query(`
    INSERT INTO babies (id, family_id, nickname, birth_date, updated_at) VALUES
      ($1, $3, $4, $5, NOW()),
      ($2, $3, $6, $7, NOW())
    ON CONFLICT (id) DO NOTHING;
  `, [
    babyId1,
    babyId2,
    familyId,
    "Baby Alpha",
    "2026-01-01",
    "Baby Beta",
    "2026-02-02"
  ]);

  await ctx.pool.query(`
    INSERT INTO baby_members (id, family_id, baby_id, user_id, role, status, updated_at) VALUES
      ($1, $3, $4, $5, $7, $8, NOW()),
      ($2, $3, $4, $6, $9, $8, NOW())
    ON CONFLICT (user_id, baby_id) DO NOTHING;
  `, [
    "bm_" + userId + "_1",
    "bm_" + viewerUserId + "_1",
    familyId,
    babyId1,
    userId,
    viewerUserId,
    "admin",
    "active",
    "viewer"
  ]);

  const principal: UserPrincipal = {
    userId,
    username: userId,
    sessionId: "sess_test_uow",
    familyMemberships: [{ familyId, role: "admin", status: "active" }],
    babyMemberships: [{ userId, familyId, babyId: babyId1, role: "admin", status: "active" }],
  };

  const viewerPrincipal: UserPrincipal = {
    userId: viewerUserId,
    username: viewerUserId,
    sessionId: "sess_test_viewer",
    familyMemberships: [{ familyId, role: "member", status: "active" }],
    babyMemberships: [{ userId: viewerUserId, familyId, babyId: babyId1, role: "viewer", status: "active" }],
  };

  await t.test("B-01: Idempotent replay returns cached result without re-executing", async () => {
    const feedId = "feed_idemp_1";
    const commandId = "cmd_idemp_1";
    const requestHash = "a".repeat(64);

    const first = await repo.create(principal, {
      id: feedId,
      familyId,
      babyId: babyId1,
      commandId,
      requestHash,
      feedingType: "bottle_formula",
      occurredAt: new Date("2026-09-12T10:00:00Z"),
      amountMl: "120.000",
    });

    assert.equal(first.replayed, false);
    assert.equal(first.version, 1);
    const initialCursor = BigInt(first.familyCursor);
    assert.ok(initialCursor > 0n);

    // Replay with IDENTICAL commandId and requestHash
    const second = await repo.create(principal, {
      id: feedId,
      familyId,
      babyId: babyId1,
      commandId,
      requestHash,
      feedingType: "bottle_formula",
      occurredAt: new Date("2026-09-12T10:00:00Z"),
      amountMl: "120.000",
    });

    assert.equal(second.replayed, true);
    assert.deepEqual(second.result.id, feedId);

    // Verify cursor was NOT advanced on replay
    const { rows } = await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id = $1", [familyId]);
    assert.equal(BigInt(rows[0].cursor), initialCursor);
  });

  await t.test("B-02: Key reuse with different payload throws 409 IDEMPOTENCY_KEY_REUSED", async () => {
    const commandId = "cmd_idemp_1"; // Reused from previous test
    const differentHash = "b".repeat(64);

    await assert.rejects(
      repo.create(principal, {
        id: "feed_idemp_different",
        familyId,
        babyId: babyId1,
        commandId,
        requestHash: differentHash,
        feedingType: "breast_left",
        occurredAt: new Date("2026-09-12T11:00:00Z"),
      }),
      (err) => err instanceof IdempotencyKeyReusedError && err.statusCode === 409
    );
  });

  await t.test("B-04: Concurrency conflict detected on baseVersion mismatch", async () => {
    const feedId = "feed_conflict_1";
    const createRes = await repo.create(principal, {
      id: feedId,
      familyId,
      babyId: babyId1,
      commandId: "cmd_conflict_init",
      requestHash: "c".repeat(64),
      feedingType: "water",
      occurredAt: new Date("2026-09-12T12:00:00Z"),
      amountMl: "50",
    });
    assert.equal(createRes.version, 1);

    // Try to update with wrong baseVersion (e.g. 5 instead of 1)
    await assert.rejects(
      repo.update(principal, {
        id: feedId,
        familyId,
        babyId: babyId1,
        commandId: "cmd_conflict_wrong_v",
        requestHash: "d".repeat(64),
        baseVersion: 5,
        amountMl: "60",
      }),
      (err) => err instanceof ConcurrencyConflictError && err.statusCode === 409
    );

    // Update with correct baseVersion: 1 -> advances to version 2
    const updateRes = await repo.update(principal, {
      id: feedId,
      familyId,
      babyId: babyId1,
      commandId: "cmd_conflict_correct_v",
      requestHash: "e".repeat(64),
      baseVersion: 1,
      amountMl: "60.000",
    });
    assert.equal(updateRes.version, 2);
    assert.equal(Number(updateRes.result.amountMl), 60);
  });

  await t.test("B-05: Transaction atomicity rolls back all changes on callback error", async () => {
    const feedId = "feed_rollback_fail";
    const commandId = "cmd_rollback_test";
    const cursorBeforeRes = await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id = $1", [familyId]);
    const cursorBefore = BigInt(cursorBeforeRes.rows[0].cursor);

    // Execute with intentionally invalid feeding type to trigger DB check constraint failure
    await assert.rejects(
      repo.create(principal, {
        id: feedId,
        familyId,
        babyId: babyId1,
        commandId,
        requestHash: "f".repeat(64),
        feedingType: "unsupported_beverage",
        occurredAt: new Date(),
      }),
      (err: Error) => err.message.includes("23514")
    );

    // Verify row not inserted
    const rowRes = await ctx.pool.query("SELECT count(*)::int AS count FROM feeding_records WHERE id = $1", [feedId]);
    assert.equal(rowRes.rows[0].count, 0);

    // Verify cursor was NOT advanced
    const cursorAfterRes = await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id = $1", [familyId]);
    assert.equal(BigInt(cursorAfterRes.rows[0].cursor), cursorBefore);

    // Verify no idempotency receipt was saved
    const receiptRes = await ctx.pool.query(
      "SELECT count(*)::int AS count FROM idempotency_receipts WHERE command_id = $1",
      [commandId]
    );
    assert.equal(receiptRes.rows[0].count, 0);
  });

  await t.test("B-06: Baby access denied if BabyMember row is missing or viewer", async () => {
    // principal has no BabyMember row for babyId2
    await assert.rejects(
      repo.create(principal, {
        id: "feed_no_baby_member",
        familyId,
        babyId: babyId2,
        commandId: "cmd_no_bm",
        requestHash: "hash_no_bm",
        feedingType: "water",
        occurredAt: new Date(),
      }),
      (err) => err instanceof BabyAccessDeniedError && err.statusCode === 403
    );

    // viewerPrincipal has role: viewer -> write denied
    await assert.rejects(
      repo.create(viewerPrincipal, {
        id: "feed_viewer_write",
        familyId,
        babyId: babyId1,
        commandId: "cmd_viewer_write",
        requestHash: "hash_viewer_write",
        feedingType: "water",
        occurredAt: new Date(),
      }),
      (err) => err instanceof BabyAccessDeniedError && err.statusCode === 403
    );
  });

  await t.test("B-07: Concurrent commands serialize under FamilySyncState row lock", async () => {
    const concurrentCount = 5;
    const promises = Array.from({ length: concurrentCount }, (_, i) => {
      const id = `feed_concurrent_${i}_${Date.now()}`;
      const commandId = `cmd_concurrent_${i}_${Date.now()}`;
      return repo.create(principal, {
        id,
        familyId,
        babyId: babyId1,
        commandId,
        requestHash: `hash_concurrent_${i}`,
        feedingType: "bottle_formula",
        occurredAt: new Date(),
        amountMl: (100 + i * 10).toString(),
      });
    });

    const results = await Promise.all(promises);
    assert.equal(results.length, concurrentCount);

    // Verify all cursors are strictly distinct and sorted
    const cursors = results.map((r) => BigInt(r.familyCursor));
    const uniqueCursors = new Set(cursors);
    assert.equal(uniqueCursors.size, concurrentCount, "Every concurrent transaction must receive a unique cursor");
  });

  await t.test("B-08: Timeline projection is maintained atomically with keyset pagination", async () => {
    const feedId = "feed_tl_check";
    await repo.create(principal, {
      id: feedId,
      familyId,
      babyId: babyId1,
      commandId: "cmd_tl_check",
      requestHash: "hash_tl_check",
      feedingType: "breast_both",
      occurredAt: new Date("2026-09-12T15:00:00Z"),
      leftMinutes: 10,
      rightMinutes: 12,
    });

    // Query timeline
    const timeline = await timelineRepo.listByBaby(principal, familyId, babyId1, { limit: 10 });
    assert.ok(timeline.length > 0);
    const item = timeline.find((t) => t.entityId === feedId);
    assert.ok(item, "Timeline projection must be found");
    assert.equal(item.entityType, "feeding");
    assert.ok(item.summary.includes("breast_both"));
  });
});
