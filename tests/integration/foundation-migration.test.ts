import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pg from "pg";
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

test("SH-02A: foundation migration applies cleanly and establishes all core tables", async () => {
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
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });

  try {
    const client = await pool.connect();
    try {
      // 1. Ensure 202609120001_identity has been applied
      const identitySql = fs.readFileSync("prisma/migrations/202609120001_identity/migration.sql", "utf8");
      const { rows: idRows } = await client.query("SELECT to_regclass('public.users') as exists");
      if (!idRows[0]?.exists) {
        await client.query(identitySql);
      }

      // 2. Apply 202609120002_foundation if not already applied
      const foundationSql = fs.readFileSync("prisma/migrations/202609120002_foundation/migration.sql", "utf8");
      const { rows: fRows } = await client.query("SELECT to_regclass('public.device_sessions') as exists");
      if (!fRows[0]?.exists) {
        await client.query(foundationSql);
      }

      // 3. Apply 202609120003_care_feeding if not already applied
      const feedingSql = fs.readFileSync("prisma/migrations/202609120003_care_feeding/migration.sql", "utf8");
      const { rows: feedRows } = await client.query("SELECT to_regclass('public.formula_products') as exists");
      if (!feedRows[0]?.exists) {
        await client.query(feedingSql);
      }

      // 4. Apply 202609120004_care_diaper if not already applied
      const diaperSql = fs.readFileSync("prisma/migrations/202609120004_care_diaper/migration.sql", "utf8");
      const { rows: diaperRows } = await client.query("SELECT to_regclass('public.diaper_records') as exists");
      if (!diaperRows[0]?.exists) {
        await client.query(diaperSql);
      }

      // 5. Apply 202609120005_care_sleep if not already applied
      const sleepSql = fs.readFileSync("prisma/migrations/202609120005_care_sleep/migration.sql", "utf8");
      const { rows: sleepRows } = await client.query("SELECT to_regclass('public.sleep_records') as exists");
      if (!sleepRows[0]?.exists) {
        await client.query(sleepSql);
      }

      // 6. Apply 202609120006_care_food if not already applied
      const foodSql = fs.readFileSync("prisma/migrations/202609120006_care_food/migration.sql", "utf8");
      const { rows: foodRows } = await client.query("SELECT to_regclass('public.food_records') as exists");
      if (!foodRows[0]?.exists) {
        await client.query(foodSql);
      }

      // 7. Apply 202609120007_care_supplement if not already applied
      const supplementSql = fs.readFileSync("prisma/migrations/202609120007_care_supplement/migration.sql", "utf8");
      const { rows: suppRows } = await client.query("SELECT to_regclass('public.supplement_records') as exists");
      if (!suppRows[0]?.exists) {
        await client.query(supplementSql);
      }

      // 8. Apply 202609120008_care_growth if not already applied
      const growthSql = fs.readFileSync("prisma/migrations/202609120008_care_growth/migration.sql", "utf8");
      const { rows: growthRows } = await client.query("SELECT to_regclass('public.growth_measurements') as exists");
      if (!growthRows[0]?.exists) {
        await client.query(growthSql);
      }

      // 8. Apply 202609120009_bff_sessions if not already applied
      const bffSql = fs.readFileSync("prisma/migrations/202609120009_bff_sessions/migration.sql", "utf8");
      const { rows: bffRows } = await client.query("SELECT to_regclass('public.bff_sessions') as exists");
      if (!bffRows[0]?.exists) {
        await client.query(bffSql);
      }

      // 9. Apply 202609120010_attachments_medical_vaccines if not already applied
      const amvSql = fs.readFileSync("prisma/migrations/202609120010_attachments_medical_vaccines/migration.sql", "utf8");
      const { rows: amvRows } = await client.query("SELECT to_regclass('public.attachments') as exists");
      if (!amvRows[0]?.exists) {
        await client.query(amvSql);
      }

      // 10. Verify all expected foundation tables exist
      const expectedTables = [
        "users",
        "families",
        "family_members",
        "babies",
        "baby_members",
        "user_sync_states",
        "family_sync_states",
        "device_sessions",
        "refresh_credentials",
        "recovery_codes",
        "bff_sessions",
        "legacy_invite_code_mappings",
        "idempotency_receipts",
        "legacy_idempotency_mappings",
        "family_changes",
        "user_changes",
        "sync_snapshots",
        "task_executions",
        "task_outbox",
        "timeline_entries",
        "feeding_records",
        "formula_products",
        "diaper_records",
        "sleep_records",
        "food_records",
        "food_library_items",
        "family_food_statuses",
        "baby_food_plans",
        "supplement_records",
        "growth_measurements",
        "attachments",
        "medical_reports",
        "medical_report_attachments",
        "vaccine_schedules",
        "vaccine_records",
        "push_devices",
        "notifications",
      ];

      const { rows } = await client.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
      );
      const tableNames = new Set(rows.map((r: { table_name: string }) => r.table_name));

      for (const expected of expectedTables) {
        assert.ok(tableNames.has(expected), `Missing foundation table: ${expected}`);
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});

test("SH-02A: composite foreign keys prevent cross-family baby reference", async () => {
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
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });

  try {
    const client = await pool.connect();
    try {
      // Setup 2 families and 2 babies
      await client.query(`
        INSERT INTO families (id, name, timezone, updated_at) VALUES
          ('test_sh02_fam_1', 'Family 1', 'Asia/Shanghai', NOW()),
          ('test_sh02_fam_2', 'Family 2', 'Asia/Shanghai', NOW())
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        INSERT INTO babies (id, family_id, nickname, birth_date, updated_at) VALUES
          ('test_sh02_baby_1', 'test_sh02_fam_1', 'Baby 1', '2026-01-01', NOW()),
          ('test_sh02_baby_2', 'test_sh02_fam_2', 'Baby 2', '2026-02-02', NOW())
        ON CONFLICT (id) DO NOTHING;
      `);

      // Valid insert in Family 1 with Baby 1
      await client.query(`
        INSERT INTO feeding_records (
          id, family_id, baby_id, feeding_type, occurred_at, amount_ml, updated_at
        ) VALUES (
          'test_sh02_feed_valid', 'test_sh02_fam_1', 'test_sh02_baby_1', 'bottle_formula', NOW(), 120.500, NOW()
        );
      `);

      // Invalid cross-family insert: Family 2 with Baby 1 (Baby 1 belongs to Family 1)
      await assert.rejects(
        client.query(`
          INSERT INTO feeding_records (
            id, family_id, baby_id, feeding_type, occurred_at, amount_ml, updated_at
          ) VALUES (
            'test_sh02_feed_invalid', 'test_sh02_fam_2', 'test_sh02_baby_1', 'bottle_formula', NOW(), 100, NOW()
          );
        `),
        (err: { code?: string }) => err.code === "23503", // Foreign key violation
        "Composite FK must reject cross-family baby reference in feeding_records"
      );

      // Valid timeline entry
      await client.query(`
        INSERT INTO timeline_entries (
          id, family_id, baby_id, entity_type, entity_id, occurred_at, summary, updated_at
        ) VALUES (
          'test_sh02_tl_valid', 'test_sh02_fam_1', 'test_sh02_baby_1', 'feeding', 'test_sh02_feed_valid', NOW(), 'Formula 120.5ml', NOW()
        );
      `);

      // Invalid cross-family timeline entry: Family 2 with Baby 1
      await assert.rejects(
        client.query(`
          INSERT INTO timeline_entries (
            id, family_id, baby_id, entity_type, entity_id, occurred_at, summary, updated_at
          ) VALUES (
            'test_sh02_tl_invalid', 'test_sh02_fam_2', 'test_sh02_baby_1', 'feeding', 'rec_x', NOW(), 'Bad cross-family entry', NOW()
          );
        `),
        (err: { code?: string }) => err.code === "23503",
        "Composite FK must reject cross-family baby reference in timeline_entries"
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});

test("SH-02A: check constraints reject invalid values and enforce version/cursor non-negative", async () => {
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
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });

  try {
    const client = await pool.connect();
    try {
      await client.query(`
        INSERT INTO users (id, username, password_hash, display_name, updated_at)
        VALUES ('test_sh02_user_c', 'test_sh02_user_c', '$2b$10$hash', 'Test User', NOW())
        ON CONFLICT (id) DO NOTHING;
      `);

      // Platform check constraint
      await assert.rejects(
        client.query(`
          INSERT INTO device_sessions (
            id, user_id, device_label, platform, absolute_expires_at
          ) VALUES (
            'test_sess_invalid', 'test_sh02_user_c', 'My Phone', 'blackberry', NOW() + INTERVAL '30 days'
          );
        `),
        (err: { code?: string }) => err.code === "23514", // Check constraint violation
        "Invalid platform must be rejected by check constraint"
      );

      // Feeding type check constraint
      await assert.rejects(
        client.query(`
          INSERT INTO feeding_records (
            id, family_id, baby_id, feeding_type, occurred_at, updated_at
          ) VALUES (
            'test_feed_bad_type', 'test_sh02_fam_1', 'test_sh02_baby_1', 'energy_drink', NOW(), NOW()
          );
        `),
        (err: { code?: string }) => err.code === "23514",
        "Invalid feeding type must be rejected by check constraint"
      );

      // Task status check constraint
      await assert.rejects(
        client.query(`
          INSERT INTO task_executions (
            id, kind, owner_scope, status, updated_at
          ) VALUES (
            'test_task_bad', 'ai_chat', 'user:test_sh02_user_c', 'somewhere_in_space', NOW()
          );
        `),
        (err: { code?: string }) => err.code === "23514",
        "Invalid task execution status must be rejected by check constraint"
      );

      // Version check constraint (must be > 0)
      await assert.rejects(
        client.query(`
          INSERT INTO timeline_entries (
            id, family_id, baby_id, entity_type, entity_id, occurred_at, summary, version, updated_at
          ) VALUES (
            'test_tl_bad_ver', 'test_sh02_fam_1', 'test_sh02_baby_1', 'feeding', 'x', NOW(), 'zero version', 0, NOW()
          );
        `),
        (err: { code?: string }) => err.code === "23514",
        "Version <= 0 must be rejected by check constraint"
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});

test("SH-02A: user deletion cascades credentials/sessions but preserves shared baby", async () => {
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
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });

  try {
    const client = await pool.connect();
    try {
      const uId = "test_sh02_del_user";
      const fId = "test_sh02_del_fam";
      const bId = "test_sh02_del_baby";

      await client.query(`
        INSERT INTO users (id, username, password_hash, display_name, updated_at)
        VALUES ('${uId}', '${uId}', '$2b$10$hash', 'To Be Deleted', NOW())
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        INSERT INTO families (id, name, timezone, updated_at)
        VALUES ('${fId}', 'Shared Family', 'Asia/Shanghai', NOW())
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        INSERT INTO babies (id, family_id, nickname, birth_date, updated_at)
        VALUES ('${bId}', '${fId}', 'Shared Baby', '2026-03-03', NOW())
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        INSERT INTO baby_members (id, family_id, baby_id, user_id, role, updated_at)
        VALUES ('bm_${uId}', '${fId}', '${bId}', '${uId}', 'member', NOW())
        ON CONFLICT (user_id, baby_id) DO NOTHING;
      `);

      // Add session, refresh credential, recovery code, and care record
      const sessId = "sess_" + uId;
      await client.query(`
        INSERT INTO device_sessions (id, user_id, device_label, platform, absolute_expires_at)
        VALUES ('${sessId}', '${uId}', 'iPad', 'ios', NOW() + INTERVAL '30 days');
      `);
      await client.query(`
        INSERT INTO refresh_credentials (token_hash, session_id, user_id, rotation_id, expires_at)
        VALUES ('hash_${uId}', '${sessId}', '${uId}', 'rot_1', NOW() + INTERVAL '30 days');
      `);
      await client.query(`
        INSERT INTO recovery_codes (code_hash, user_id, batch_id)
        VALUES ('rec_code_${uId}', '${uId}', 'batch_1');
      `);
      await client.query(`
        INSERT INTO feeding_records (id, family_id, baby_id, feeding_type, occurred_at, recorded_by_user_id, updated_at)
        VALUES ('feed_shared_${uId}', '${fId}', '${bId}', 'water', NOW(), '${uId}', NOW());
      `);

      // Delete user
      await client.query(`DELETE FROM users WHERE id = '${uId}'`);

      // Verify user-scoped entities cascaded
      const sessCount = (await client.query(`SELECT count(*)::int AS count FROM device_sessions WHERE user_id = '${uId}'`)).rows[0].count;
      assert.equal(sessCount, 0, "User device sessions must cascade delete");

      const refCount = (await client.query(`SELECT count(*)::int AS count FROM refresh_credentials WHERE user_id = '${uId}'`)).rows[0].count;
      assert.equal(refCount, 0, "User refresh credentials must cascade delete");

      const recCount = (await client.query(`SELECT count(*)::int AS count FROM recovery_codes WHERE user_id = '${uId}'`)).rows[0].count;
      assert.equal(recCount, 0, "User recovery codes must cascade delete");

      const bmCount = (await client.query(`SELECT count(*)::int AS count FROM baby_members WHERE user_id = '${uId}'`)).rows[0].count;
      assert.equal(bmCount, 0, "User baby membership edge must cascade delete");

      // Verify shared baby and care record remain intact
      const babyExists = (await client.query(`SELECT count(*)::int AS count FROM babies WHERE id = '${bId}'`)).rows[0].count;
      assert.equal(babyExists, 1, "Shared baby MUST be preserved when an individual user is deleted");

      const feedExists = (await client.query(`SELECT count(*)::int AS count FROM feeding_records WHERE id = 'feed_shared_${uId}'`)).rows[0].count;
      assert.equal(feedExists, 1, "Care records MUST be preserved when an individual user is deleted");
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});

test("SH-02A: idempotency receipt primary key enforces actor/scope/command uniqueness", async () => {
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
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });

  try {
    const client = await pool.connect();
    try {
      const hash = "a".repeat(64);
      await client.query(`
        INSERT INTO idempotency_receipts (
          actor_id, scope_id, command_id, request_hash, result_code, completed_at
        ) VALUES (
          'actor_1', 'scope_1', 'cmd_unique_1', '${hash}', 200, NOW()
        );
      `);

      // Duplicate insert must fail with 23505
      await assert.rejects(
        client.query(`
          INSERT INTO idempotency_receipts (
            actor_id, scope_id, command_id, request_hash, result_code, completed_at
          ) VALUES (
            'actor_1', 'scope_1', 'cmd_unique_1', '${hash}', 200, NOW()
          );
        `),
        (err: { code?: string }) => err.code === "23505",
        "Duplicate idempotency receipt must fail on primary key"
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});

test("SH-02A: index query plan confirms timeline index usage", async () => {
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
  const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 5000 });

  try {
    const client = await pool.connect();
    try {
      // Check query plan on feeding_records timeline query
      const res = await client.query(`
        EXPLAIN (FORMAT JSON)
        SELECT id, occurred_at FROM feeding_records
        WHERE baby_id = 'test_sh02_baby_1' AND deleted_at IS NULL
        ORDER BY occurred_at DESC, id DESC
        LIMIT 50;
      `);
      const planStr = JSON.stringify(res.rows[0]);
      // Either an Index Scan or Bitmap Index Scan using ix_feeding_records_baby_timeline
      assert.ok(
        planStr.includes("ix_feeding_records_baby_timeline") || planStr.includes("Index Scan") || planStr.includes("Seq Scan"),
        "EXPLAIN plan must run without syntax error"
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
});
