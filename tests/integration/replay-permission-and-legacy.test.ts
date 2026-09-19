import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDatabaseContext } from "../../packages/database/src/client.js";
import { FeedingRepository } from "../../packages/database/src/feeding-repository.js";
import { DiaperRepository } from "../../packages/database/src/diaper-repository.js";
import { SleepRepository } from "../../packages/database/src/sleep-repository.js";
import {
  BabyAccessDeniedError,
  FamilyAccessDeniedError,
  IdempotencyKeyReusedError,
} from "../../packages/database/src/errors.js";
import { LegacyIdempotencyGoneError } from "../../packages/database/src/unit-of-work.js";
import { requireTestDatabaseUrl } from "../../packages/testkit/src/environment.js";
import type { UserPrincipal } from "@growdesk/domain";

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
  if (
    path.dirname(parent) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(parent).startsWith("growdesk-integration-")
  ) {
    throw new Error("Integration manifest is outside its private run");
  }
  const stat = fs.statSync(real);
  if (stat.uid !== process.getuid?.() || stat.mode & 0o077) {
    throw new Error("Unsafe manifest permissions");
  }
  return JSON.parse(fs.readFileSync(real, "utf8")) as OwnedRun;
}

function unique(prefix: string): string {
  return `test_${prefix}_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

interface Tenant {
  familyId: string;
  babyId: string;
  otherBabyId: string;
  userId: string;
  principal: UserPrincipal;
}

async function cleanupTenant(
  pool: ReturnType<typeof createDatabaseContext>["pool"],
  tenant: Tenant
): Promise<void> {
  await pool.query("DELETE FROM families WHERE id=$1", [tenant.familyId]);
  await pool.query("DELETE FROM users WHERE id=$1", [tenant.userId]);
}

async function seedTenant(
  pool: ReturnType<typeof createDatabaseContext>["pool"],
  prefix: string
): Promise<Tenant> {
  const label = prefix.startsWith("test_") ? prefix : `test_${prefix}`;
  const familyId = unique(`${prefix}_family`);
  const babyId = unique(`${prefix}_baby`);
  const otherBabyId = unique(`${prefix}_other_baby`);
  const userId = unique(`${prefix}_user`);
  await pool.query(
    `INSERT INTO users (id, username, password_hash, display_name, updated_at)
     VALUES ($1, $1, $2, $3, NOW())`,
    [userId, "$2b$10$test_hash", `${label} user`]
  );
  await pool.query(
    `INSERT INTO families (id, name, timezone, updated_at)
     VALUES ($1, $2, 'UTC', NOW())`,
    [familyId, `${label} family`]
  );
  await pool.query(
    `INSERT INTO family_members
       (id, family_id, user_id, role, status, updated_at)
     VALUES ($1, $2, $3, 'admin', 'active', NOW())`,
    [unique(`${prefix}_family_member`), familyId, userId]
  );
  await pool.query(
    `INSERT INTO babies
       (id, family_id, nickname, birth_date, updated_at)
     VALUES ($1, $3, $4, DATE '2026-01-01', NOW()),
            ($2, $3, $5, DATE '2026-02-01', NOW())`,
    [babyId, otherBabyId, familyId, `${label} baby`, `${label} other baby`]
  );
  await pool.query(
    `INSERT INTO baby_members
       (id, family_id, baby_id, user_id, role, status, updated_at)
     VALUES ($1, $4, $5, $6, 'admin', 'active', NOW()),
            ($2, $4, $3, $6, 'admin', 'active', NOW())`,
    [
      unique(`${prefix}_baby_member`),
      unique(`${prefix}_other_baby_member`),
      babyId,
      familyId,
      otherBabyId,
      userId,
    ]
  );
  return {
    familyId,
    babyId,
    otherBabyId,
    userId,
    principal: {
      userId,
      username: userId,
      sessionId: unique(`${prefix}_session`),
      familyMemberships: [{ familyId, role: "admin", status: "active" }],
      babyMemberships: [
        { userId, familyId, babyId, role: "admin", status: "active" },
        { userId, familyId, babyId: otherBabyId, role: "admin", status: "active" },
      ],
    },
  };
}

function sameFieldsForFeeding() {
  return {
    feedingType: "formula",
    occurredAt: new Date("2026-01-03T08:00:00.000Z"),
    amountMl: "120.500",
    leftMinutes: 4,
    rightMinutes: 5,
    durationMinutes: 9,
    spitUp: "false",
    formulaProductId: null,
    notes: "legacy feeding",
  } as const;
}

function sameFieldsForDiaper() {
  return {
    diaperType: "pee",
    occurredAt: new Date("2026-01-03T09:00:00.000Z"),
    poopColor: null,
    poopConsistency: null,
    notes: "legacy diaper",
  } as const;
}

function sameFieldsForSleep() {
  return {
    sleepType: "nap",
    startedAt: new Date("2026-01-03T10:00:00.000Z"),
    endedAt: new Date("2026-01-03T11:00:00.000Z"),
    nightWakingCount: 0,
    notes: "legacy sleep",
  } as const;
}

test("replay authorization and legacy care keys are serialized in owned PostgreSQL", async (t) => {
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
  const ctx = createDatabaseContext({ url, maxConnections: 24 });
  t.after(async () => ctx.close());

  await t.test("SQL-imported instants round-trip without host timezone shifts", async (st) => {
    const tenant = await seedTenant(ctx.pool, "import-timezone");
    st.after(() => cleanupTenant(ctx.pool, tenant));
    const timezone = await ctx.pool.query("SHOW TimeZone");
    assert.equal(timezone.rows[0]?.TimeZone, "UTC");
    const id = unique("timezone-record");
    const instant = "2026-01-03T08:00:00.123Z";
    await ctx.pool.query(
      `INSERT INTO diaper_records
       (id, family_id, baby_id, diaper_type, occurred_at, version, updated_at)
       VALUES ($1, $2, $3, 'pee', $4::timestamptz, 1, NOW())`,
      [id, tenant.familyId, tenant.babyId, instant]
    );
    const row = await ctx.prisma.diaperRecord.findUniqueOrThrow({ where: { id } });
    assert.equal(row.occurredAt.toISOString(), instant);
  });

  await t.test("missing family is rejected before sync lock or side effects", async (st) => {
    const tenant = await seedTenant(ctx.pool, "missing-family");
    st.after(() => cleanupTenant(ctx.pool, tenant));
    const repo = new FeedingRepository(ctx.prisma);
    const missingFamilyId = unique("missing_family");
    const missingBabyId = unique("missing_baby");
    const commandId = unique("missing_family_command");

    await assert.rejects(
      repo.create(tenant.principal, {
        id: unique("missing_family_record"),
        familyId: missingFamilyId,
        babyId: missingBabyId,
        commandId,
        requestHash: "missing-family-hash",
        feedingType: "formula",
        occurredAt: new Date("2026-01-01T08:00:00Z"),
        amountMl: "30",
      }),
      (error) => error instanceof FamilyAccessDeniedError && error.statusCode === 403
    );

    const sideEffects = await ctx.pool.query(
      `SELECT
         (SELECT count(*)::int FROM family_sync_states WHERE family_id=$1) AS sync_states,
         (SELECT count(*)::int FROM feeding_records WHERE family_id=$1) AS feeding_records,
         (SELECT count(*)::int FROM family_changes WHERE family_id=$1) AS family_changes,
         (SELECT count(*)::int FROM idempotency_receipts WHERE scope_id=$1 AND command_id=$2) AS receipts`,
      [missingFamilyId, commandId]
    );
    assert.deepEqual(sideEffects.rows[0], {
      sync_states: 0,
      feeding_records: 0,
      family_changes: 0,
      receipts: 0,
    });
  });

  await t.test("current database family and baby revocations reject cached replay", async (st) => {
    const tenant = await seedTenant(ctx.pool, "permission");
    st.after(() => cleanupTenant(ctx.pool, tenant));
    const repo = new FeedingRepository(ctx.prisma);
    const input = {
      familyId: tenant.familyId,
      babyId: tenant.babyId,
      feedingType: "formula",
      occurredAt: new Date("2026-02-01T08:00:00Z"),
      amountMl: "100",
    } as const;
    const familyKey = unique("permission-family-key");
    await repo.create(tenant.principal, {
      ...input,
      id: unique("permission_record"),
      commandId: familyKey,
      requestHash: "permission-family-hash",
    });

    await ctx.pool.query(
      "UPDATE family_members SET status='revoked' WHERE family_id=$1 AND user_id=$2",
      [tenant.familyId, tenant.userId]
    );
    await assert.rejects(
      repo.create(tenant.principal, {
        ...input,
        id: unique("permission_family_replay"),
        commandId: familyKey,
        requestHash: "permission-family-hash",
      }),
      (error) => error instanceof FamilyAccessDeniedError && error.statusCode === 403
    );

    await ctx.pool.query(
      "UPDATE family_members SET status='active' WHERE family_id=$1 AND user_id=$2",
      [tenant.familyId, tenant.userId]
    );
    await ctx.pool.query(
      "UPDATE families SET deleted_at=NOW() WHERE id=$1",
      [tenant.familyId]
    );
    await assert.rejects(
      repo.create(tenant.principal, {
        ...input,
        id: unique("permission_deleted_family_replay"),
        commandId: familyKey,
        requestHash: "permission-family-hash",
      }),
      (error) => error instanceof FamilyAccessDeniedError && error.statusCode === 403
    );
    await ctx.pool.query("UPDATE families SET deleted_at=NULL WHERE id=$1", [tenant.familyId]);

    const babyKey = unique("permission-baby-key");
    await repo.create(tenant.principal, {
      ...input,
      id: unique("permission_baby_record"),
      commandId: babyKey,
      requestHash: "permission-baby-hash",
    });
    await ctx.pool.query(
      "UPDATE baby_members SET status='revoked' WHERE family_id=$1 AND baby_id=$2 AND user_id=$3",
      [tenant.familyId, tenant.babyId, tenant.userId]
    );
    await assert.rejects(
      repo.create(tenant.principal, {
        ...input,
        id: unique("permission_baby_replay"),
        commandId: babyKey,
        requestHash: "permission-baby-hash",
      }),
      (error) => error instanceof BabyAccessDeniedError && error.statusCode === 403
    );

    await ctx.pool.query(
      "UPDATE baby_members SET status='active' WHERE family_id=$1 AND baby_id=$2 AND user_id=$3",
      [tenant.familyId, tenant.babyId, tenant.userId]
    );
    await ctx.pool.query(
      "UPDATE babies SET deleted_at=NOW() WHERE id=$1 AND family_id=$2",
      [tenant.babyId, tenant.familyId]
    );
    await assert.rejects(
      repo.create(tenant.principal, {
        ...input,
        id: unique("permission_deleted_baby_replay"),
        commandId: babyKey,
        requestHash: "permission-baby-hash",
      }),
      (error) => error instanceof BabyAccessDeniedError && error.statusCode === 403
    );
  });

  await t.test("sixteen same-key creates produce one row, one change, and one receipt", async (st) => {
    const tenant = await seedTenant(ctx.pool, "concurrent");
    st.after(() => cleanupTenant(ctx.pool, tenant));
    const repo = new FeedingRepository(ctx.prisma);
    const commandId = unique("same-key");
    const requestHash = "same-key-hash";
    const ids = Array.from({ length: 16 }, () => unique("same-key-record"));
    const before = await ctx.pool.query(
      "SELECT cursor FROM family_sync_states WHERE family_id=$1",
      [tenant.familyId]
    );
    const beforeCursor = BigInt(before.rows[0]?.cursor ?? 0);
    const results = await Promise.all(
      ids.map((id) =>
        repo.create(tenant.principal, {
          id,
          familyId: tenant.familyId,
          babyId: tenant.babyId,
          commandId,
          requestHash,
          feedingType: "formula",
          occurredAt: new Date("2026-03-01T08:00:00Z"),
          amountMl: "90",
        })
      )
    );
    assert.equal(results.filter((result) => !result.replayed).length, 1);
    assert.equal(results.filter((result) => result.replayed).length, 15);
    assert.equal(new Set(results.map((result) => result.result.id)).size, 1);

    const rowCount = await ctx.pool.query(
      "SELECT count(*)::int AS count FROM feeding_records WHERE family_id=$1 AND baby_id=$2 AND id=ANY($3::text[])",
      [tenant.familyId, tenant.babyId, ids]
    );
    assert.equal(rowCount.rows[0]?.count, 1);
    const receiptCount = await ctx.pool.query(
      "SELECT count(*)::int AS count FROM idempotency_receipts WHERE actor_id=$1 AND scope_id=$2 AND command_id=$3",
      [tenant.userId, tenant.familyId, commandId]
    );
    assert.equal(receiptCount.rows[0]?.count, 1);
    const changeCount = await ctx.pool.query(
      "SELECT count(*)::int AS count FROM family_changes WHERE family_id=$1 AND entity_id=ANY($2::text[])",
      [tenant.familyId, ids]
    );
    assert.equal(changeCount.rows[0]?.count, 1);
    const after = await ctx.pool.query(
      "SELECT cursor FROM family_sync_states WHERE family_id=$1",
      [tenant.familyId]
    );
    assert.equal(BigInt(after.rows[0]?.cursor ?? 0), beforeCursor + 1n);

    await assert.rejects(
      repo.create(tenant.principal, {
        id: unique("same-key-different-body"),
        familyId: tenant.familyId,
        babyId: tenant.babyId,
        commandId,
        requestHash: "different-body-hash",
        feedingType: "formula",
        occurredAt: new Date("2026-03-01T08:00:00Z"),
        amountMl: "91",
      }),
      (error) => error instanceof IdempotencyKeyReusedError && error.statusCode === 409
    );
  });

  await t.test("feeding imported client id replays and enforces mismatch, baby scope, and tombstone", async (st) => {
    const tenant = await seedTenant(ctx.pool, "legacy-feeding");
    st.after(() => cleanupTenant(ctx.pool, tenant));
    const repo = new FeedingRepository(ctx.prisma);
    const fields = sameFieldsForFeeding();
    const clientId = unique("legacy-feeding-client");
    const firstId = unique("legacy-feeding-row");
    const otherId = unique("legacy-feeding-other-row");
    const beforeState = await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id=$1", [tenant.familyId]);
    const beforeCursor = BigInt(beforeState.rows[0]?.cursor ?? 0);
    await ctx.pool.query(
      `INSERT INTO feeding_records
       (id,family_id,baby_id,feeding_type,occurred_at,amount_ml,left_minutes,right_minutes,
        duration_minutes,spit_up,formula_product_id,notes,source,source_agent,recorded_by_user_id,
        legacy_client_id,version,deleted_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'legacy_import',NULL,$13,$14,1,NULL,NOW(),NOW()),
              ($15,$2,$16,$4,$5,$6,$7,$8,$9,$10,$11,$12,'legacy_import',NULL,$13,$14,1,NULL,NOW(),NOW())`,
      [
        firstId, tenant.familyId, tenant.babyId, fields.feedingType, fields.occurredAt, fields.amountMl,
        fields.leftMinutes, fields.rightMinutes, fields.durationMinutes, fields.spitUp, fields.formulaProductId,
        fields.notes, tenant.userId, clientId, otherId, tenant.otherBabyId,
      ]
    );
    const before = await ctx.pool.query("SELECT count(*)::int AS count FROM family_changes WHERE family_id=$1", [tenant.familyId]);
    const replay = await repo.create(tenant.principal, { ...fields, id: unique("legacy-feeding-new"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-feeding" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.id, firstId);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM idempotency_receipts WHERE scope_id=$1 AND command_id=$2", [tenant.familyId, clientId])).rows[0]?.count, 0);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM family_changes WHERE family_id=$1", [tenant.familyId])).rows[0]?.count, before.rows[0]?.count);
    await assert.rejects(repo.create(tenant.principal, { ...fields, amountMl: "121", id: unique("legacy-feeding-mismatch"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-feeding-mismatch" }), (error) => error instanceof IdempotencyKeyReusedError && error.statusCode === 409);
    const otherReplay = await repo.create(tenant.principal, { ...fields, id: unique("legacy-feeding-other-new"), familyId: tenant.familyId, babyId: tenant.otherBabyId, commandId: clientId, requestHash: "legacy-feeding-other" });
    assert.equal(otherReplay.replayed, true);
    assert.equal(otherReplay.result.id, otherId);
    await ctx.pool.query(
      "UPDATE baby_members SET status='revoked' WHERE family_id=$1 AND baby_id=$2 AND user_id=$3",
      [tenant.familyId, tenant.otherBabyId, tenant.userId]
    );
    await assert.rejects(
      repo.create(tenant.principal, { ...fields, id: unique("legacy-feeding-cross-baby-denied"), familyId: tenant.familyId, babyId: tenant.otherBabyId, commandId: clientId, requestHash: "legacy-feeding-cross-baby-denied" }),
      (error) => error instanceof BabyAccessDeniedError && error.statusCode === 403
    );
    await ctx.pool.query("UPDATE feeding_records SET deleted_at=NOW() WHERE id=$1", [firstId]);
    await assert.rejects(repo.create(tenant.principal, { ...fields, id: unique("legacy-feeding-deleted"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-feeding-deleted" }), (error) => error instanceof LegacyIdempotencyGoneError && error.statusCode === 409 && error.code === "LEGACY_IDEMPOTENCY_GONE");
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM feeding_records WHERE family_id=$1 AND baby_id=$2 AND legacy_client_id=$3", [tenant.familyId, tenant.babyId, clientId])).rows[0]?.count, 1);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM idempotency_receipts WHERE scope_id=$1 AND command_id=$2", [tenant.familyId, clientId])).rows[0]?.count, 0);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM family_changes WHERE family_id=$1", [tenant.familyId])).rows[0]?.count, 0);
    assert.equal(BigInt((await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id=$1", [tenant.familyId])).rows[0]?.cursor ?? 0), beforeCursor);
  });

  await t.test("diaper imported client id replays and enforces mismatch, baby scope, and tombstone", async (st) => {
    const tenant = await seedTenant(ctx.pool, "legacy-diaper");
    st.after(() => cleanupTenant(ctx.pool, tenant));
    const repo = new DiaperRepository(ctx.prisma);
    const fields = sameFieldsForDiaper();
    const clientId = unique("legacy-diaper-client");
    const firstId = unique("legacy-diaper-row");
    const otherId = unique("legacy-diaper-other-row");
    const beforeState = await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id=$1", [tenant.familyId]);
    const beforeCursor = BigInt(beforeState.rows[0]?.cursor ?? 0);
    await ctx.pool.query(
      `INSERT INTO diaper_records
       (id,family_id,baby_id,diaper_type,occurred_at,poop_color,poop_consistency,notes,source,source_agent,recorded_by_user_id,legacy_client_id,version,deleted_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'legacy_import',NULL,$9,$10,1,NULL,NOW(),NOW()),
              ($11,$2,$12,$4,$5,$6,$7,$8,'legacy_import',NULL,$9,$10,1,NULL,NOW(),NOW())`,
      [firstId, tenant.familyId, tenant.babyId, fields.diaperType, fields.occurredAt, fields.poopColor, fields.poopConsistency, fields.notes, tenant.userId, clientId, otherId, tenant.otherBabyId]
    );
    const replay = await repo.create(tenant.principal, { ...fields, id: unique("legacy-diaper-new"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-diaper" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.id, firstId);
    await assert.rejects(repo.create(tenant.principal, { ...fields, notes: "changed", id: unique("legacy-diaper-mismatch"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-diaper-mismatch" }), (error) => error instanceof IdempotencyKeyReusedError && error.statusCode === 409);
    const otherReplay = await repo.create(tenant.principal, { ...fields, id: unique("legacy-diaper-other-new"), familyId: tenant.familyId, babyId: tenant.otherBabyId, commandId: clientId, requestHash: "legacy-diaper-other" });
    assert.equal(otherReplay.replayed, true);
    assert.equal(otherReplay.result.id, otherId);
    await ctx.pool.query(
      "UPDATE baby_members SET status='revoked' WHERE family_id=$1 AND baby_id=$2 AND user_id=$3",
      [tenant.familyId, tenant.otherBabyId, tenant.userId]
    );
    await assert.rejects(
      repo.create(tenant.principal, { ...fields, id: unique("legacy-diaper-cross-baby-denied"), familyId: tenant.familyId, babyId: tenant.otherBabyId, commandId: clientId, requestHash: "legacy-diaper-cross-baby-denied" }),
      (error) => error instanceof BabyAccessDeniedError && error.statusCode === 403
    );
    await ctx.pool.query("UPDATE diaper_records SET deleted_at=NOW() WHERE id=$1", [firstId]);
    await assert.rejects(repo.create(tenant.principal, { ...fields, id: unique("legacy-diaper-deleted"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-diaper-deleted" }), (error) => error instanceof LegacyIdempotencyGoneError && error.statusCode === 409 && error.code === "LEGACY_IDEMPOTENCY_GONE");
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM diaper_records WHERE family_id=$1 AND baby_id=$2 AND legacy_client_id=$3", [tenant.familyId, tenant.babyId, clientId])).rows[0]?.count, 1);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM idempotency_receipts WHERE scope_id=$1 AND command_id=$2", [tenant.familyId, clientId])).rows[0]?.count, 0);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM family_changes WHERE family_id=$1", [tenant.familyId])).rows[0]?.count, 0);
    assert.equal(BigInt((await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id=$1", [tenant.familyId])).rows[0]?.cursor ?? 0), beforeCursor);
  });

  await t.test("sleep imported client id replays and enforces mismatch, baby scope, and tombstone", async (st) => {
    const tenant = await seedTenant(ctx.pool, "legacy-sleep");
    st.after(() => cleanupTenant(ctx.pool, tenant));
    const repo = new SleepRepository(ctx.prisma);
    const fields = sameFieldsForSleep();
    const clientId = unique("legacy-sleep-client");
    const firstId = unique("legacy-sleep-row");
    const otherId = unique("legacy-sleep-other-row");
    const beforeState = await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id=$1", [tenant.familyId]);
    const beforeCursor = BigInt(beforeState.rows[0]?.cursor ?? 0);
    await ctx.pool.query(
      `INSERT INTO sleep_records
       (id,family_id,baby_id,sleep_type,started_at,ended_at,night_waking_count,notes,source,source_agent,recorded_by_user_id,legacy_client_id,version,deleted_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'legacy_import',NULL,$9,$10,1,NULL,NOW(),NOW()),
              ($11,$2,$12,$4,$5,$6,$7,$8,'legacy_import',NULL,$9,$10,1,NULL,NOW(),NOW())`,
      [firstId, tenant.familyId, tenant.babyId, fields.sleepType, fields.startedAt, fields.endedAt, fields.nightWakingCount, fields.notes, tenant.userId, clientId, otherId, tenant.otherBabyId]
    );
    const replay = await repo.create(tenant.principal, { ...fields, id: unique("legacy-sleep-new"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-sleep" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.result.id, firstId);
    await assert.rejects(repo.create(tenant.principal, { ...fields, nightWakingCount: 1, id: unique("legacy-sleep-mismatch"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-sleep-mismatch" }), (error) => error instanceof IdempotencyKeyReusedError && error.statusCode === 409);
    const otherReplay = await repo.create(tenant.principal, { ...fields, id: unique("legacy-sleep-other-new"), familyId: tenant.familyId, babyId: tenant.otherBabyId, commandId: clientId, requestHash: "legacy-sleep-other" });
    assert.equal(otherReplay.replayed, true);
    assert.equal(otherReplay.result.id, otherId);
    await ctx.pool.query(
      "UPDATE baby_members SET status='revoked' WHERE family_id=$1 AND baby_id=$2 AND user_id=$3",
      [tenant.familyId, tenant.otherBabyId, tenant.userId]
    );
    await assert.rejects(
      repo.create(tenant.principal, { ...fields, id: unique("legacy-sleep-cross-baby-denied"), familyId: tenant.familyId, babyId: tenant.otherBabyId, commandId: clientId, requestHash: "legacy-sleep-cross-baby-denied" }),
      (error) => error instanceof BabyAccessDeniedError && error.statusCode === 403
    );
    await ctx.pool.query("UPDATE sleep_records SET deleted_at=NOW() WHERE id=$1", [firstId]);
    await assert.rejects(repo.create(tenant.principal, { ...fields, id: unique("legacy-sleep-deleted"), familyId: tenant.familyId, babyId: tenant.babyId, commandId: clientId, requestHash: "legacy-sleep-deleted" }), (error) => error instanceof LegacyIdempotencyGoneError && error.statusCode === 409 && error.code === "LEGACY_IDEMPOTENCY_GONE");
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM sleep_records WHERE family_id=$1 AND baby_id=$2 AND legacy_client_id=$3", [tenant.familyId, tenant.babyId, clientId])).rows[0]?.count, 1);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM idempotency_receipts WHERE scope_id=$1 AND command_id=$2", [tenant.familyId, clientId])).rows[0]?.count, 0);
    assert.equal((await ctx.pool.query("SELECT count(*)::int AS count FROM family_changes WHERE family_id=$1", [tenant.familyId])).rows[0]?.count, 0);
    assert.equal(BigInt((await ctx.pool.query("SELECT cursor FROM family_sync_states WHERE family_id=$1", [tenant.familyId])).rows[0]?.cursor ?? 0), beforeCursor);
  });
});
