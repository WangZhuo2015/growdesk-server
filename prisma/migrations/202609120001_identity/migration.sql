-- PostgreSQL identity/family/baby migration foundation.
--
-- This is the first target migration and has no relationship to the old
-- SQLite migration history. It creates empty tables only. The importer must
-- read a verified, read-only source snapshot and write one immutable
-- legacy_import.import_batches row followed by idempotent raw rows.
--
-- Mapping/backfill contract:
--   1. Preserve source User/Family/FamilyMember/Baby IDs as text.
--   2. Interpret legacy date-only and wall-clock values using the explicit
--      source assumption Family.timezone = Asia/Shanghai.
--   3. Expand each valid FamilyMember x Baby-in-family pair into BabyMember.
--      A missing/ambiguous source relation is quarantined in import_rows;
--      family membership is never an authorization bypass.
--   4. User deletion cascades only membership edges and sync state. Shared
--      Baby rows remain because they have no User foreign key.
--   5. import_rows.user_id/family_id/baby_id are nullable source lineage
--      columns only. They are not foreign keys and never authorize a request.
--
-- The migration is intended to run under the separately controlled postgres
-- migration owner. The API role receives no grants in this bootstrap; in
-- particular, legacy_import is never exposed to the API. Future principal-
-- scoped grants must be reviewed and added separately.

CREATE SCHEMA IF NOT EXISTS "legacy_import";

CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_hash_algorithm" TEXT NOT NULL DEFAULT 'bcrypt',
    "password_hash_version" INTEGER NOT NULL DEFAULT 1,
    "password_hash_needs_rehash" BOOLEAN NOT NULL DEFAULT false,
    "display_name" TEXT NOT NULL,
    "timezone" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "families" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Shanghai',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "family_members" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "relation" TEXT NOT NULL DEFAULT 'parent',
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "family_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "babies" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "birth_date" DATE NOT NULL,
    "gender" TEXT NOT NULL DEFAULT 'unknown',
    "gestational_age" INTEGER,
    "avatar_url" TEXT,
    "avatar_metadata" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "babies_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "baby_members" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "baby_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_sync_states" (
    "user_id" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "cursor" BIGINT NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_sync_states_pkey" PRIMARY KEY ("user_id")
);

CREATE TABLE "family_sync_states" (
    "family_id" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "cursor" BIGINT NOT NULL DEFAULT 0,
    "permission_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "family_sync_states_pkey" PRIMARY KEY ("family_id")
);

-- The archive is a separate PostgreSQL schema. Its JSON payload intentionally
-- preserves all non-token source fields, including the opaque legacy
-- User.passwordHash value, so the controlled verifier can support a bounded
-- hash migration. Plaintext passwords and live access/refresh secrets are not
-- copied into the archive.
CREATE TABLE "legacy_import"."import_batches" (
    "batch_id" VARCHAR(128) NOT NULL,
    "source_system" TEXT NOT NULL,
    "source_snapshot" TEXT,
    "checksum" CHAR(64) NOT NULL,
    "source_schema_hash" CHAR(64),
    "mapping_version" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL DEFAULT 0,
    "table_counts" JSONB NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("batch_id")
);

CREATE TABLE "legacy_import"."import_rows" (
    "batch_id" VARCHAR(128) NOT NULL,
    "source_table" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "user_id" TEXT,
    "family_id" TEXT,
    "baby_id" TEXT,
    "payload" JSONB NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("batch_id", "source_table", "source_id")
);

CREATE UNIQUE INDEX "users_username_key" ON "users"("username");
CREATE INDEX "ix_users_deleted_id" ON "users"("deleted_at", "id");
CREATE INDEX "ix_families_deleted_id" ON "families"("deleted_at", "id");
CREATE INDEX "ix_family_members_user_status" ON "family_members"("user_id", "status");
CREATE INDEX "ix_family_members_family_status" ON "family_members"("family_id", "status");
CREATE UNIQUE INDEX "family_members_family_id_user_id_key" ON "family_members"("family_id", "user_id");
CREATE INDEX "ix_babies_family_timeline" ON "babies"("family_id", "deleted_at", "created_at", "id");
CREATE UNIQUE INDEX "babies_family_id_id_key" ON "babies"("family_id", "id");
CREATE INDEX "ix_baby_members_family_baby_status" ON "baby_members"("family_id", "baby_id", "status");
CREATE INDEX "ix_baby_members_user_family_status_baby" ON "baby_members"("user_id", "family_id", "status", "baby_id");
CREATE UNIQUE INDEX "baby_members_user_id_baby_id_key" ON "baby_members"("user_id", "baby_id");
CREATE INDEX "ix_legacy_import_rows_batch_table" ON "legacy_import"."import_rows"("batch_id", "source_table");
CREATE INDEX "ix_legacy_import_rows_user_id" ON "legacy_import"."import_rows"("user_id");
CREATE INDEX "ix_legacy_import_rows_family_id" ON "legacy_import"."import_rows"("family_id");
CREATE INDEX "ix_legacy_import_rows_baby_id" ON "legacy_import"."import_rows"("baby_id");

ALTER TABLE "family_members"
    ADD CONSTRAINT "family_members_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "family_members"
    ADD CONSTRAINT "family_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "babies"
    ADD CONSTRAINT "babies_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "baby_members"
    ADD CONSTRAINT "baby_members_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "baby_members"
    ADD CONSTRAINT "baby_members_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "baby_members"
    ADD CONSTRAINT "baby_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_sync_states"
    ADD CONSTRAINT "user_sync_states_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "family_sync_states"
    ADD CONSTRAINT "family_sync_states_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "legacy_import"."import_rows"
    ADD CONSTRAINT "import_rows_batch_id_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "legacy_import"."import_batches"("batch_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Explicit text constraints keep the role/status contract stable while
-- allowing future enum migration only after an audited decision.
ALTER TABLE "family_members"
    ADD CONSTRAINT "family_members_role_check" CHECK ("role" IN ('admin', 'member', 'viewer'));
ALTER TABLE "family_members"
    ADD CONSTRAINT "family_members_status_check" CHECK ("status" IN ('invited', 'active', 'revoked'));
ALTER TABLE "family_members"
    ADD CONSTRAINT "family_members_relation_check" CHECK ("relation" IN ('mother', 'father', 'grandfather', 'grandmother', 'maternal_grandfather', 'maternal_grandmother', 'caregiver', 'other', 'parent', 'grandparent'));
ALTER TABLE "baby_members"
    ADD CONSTRAINT "baby_members_role_check" CHECK ("role" IN ('admin', 'member', 'viewer'));
ALTER TABLE "baby_members"
    ADD CONSTRAINT "baby_members_status_check" CHECK ("status" IN ('invited', 'active', 'revoked'));
ALTER TABLE "babies"
    ADD CONSTRAINT "babies_gender_check" CHECK ("gender" IN ('female', 'male', 'unknown', 'unspecified'));
ALTER TABLE "users"
    ADD CONSTRAINT "users_version_check" CHECK ("version" > 0);
ALTER TABLE "families"
    ADD CONSTRAINT "families_version_check" CHECK ("version" > 0);
ALTER TABLE "family_members"
    ADD CONSTRAINT "family_members_version_check" CHECK ("version" > 0);
ALTER TABLE "babies"
    ADD CONSTRAINT "babies_version_check" CHECK ("version" > 0);
ALTER TABLE "baby_members"
    ADD CONSTRAINT "baby_members_version_check" CHECK ("version" > 0);
ALTER TABLE "user_sync_states"
    ADD CONSTRAINT "user_sync_states_cursor_check" CHECK ("cursor" >= 0);
ALTER TABLE "family_sync_states"
    ADD CONSTRAINT "family_sync_states_cursor_check" CHECK ("cursor" >= 0);

-- Do not allow the PostgreSQL PUBLIC pseudo-role to read either schema/table.
-- No GRANT is made to the current growdesk API role in this foundation.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA "legacy_import" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA "legacy_import" FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
