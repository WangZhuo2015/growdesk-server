-- Migration: 202609120002_foundation
-- Adds DeviceSession, RefreshCredential, RecoveryCode, LegacyInviteCodeMapping,
-- IdempotencyReceipt, LegacyIdempotencyMapping, FamilyChange, UserChange,
-- SyncSnapshot, TaskExecution, TaskOutbox, TimelineEntry, and FeedingRecord.

CREATE TABLE "device_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "device_label" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'unknown',
    "client_version" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(3),
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "device_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "refresh_credentials" (
    "token_hash" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "rotation_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "replaced_by_id" TEXT,

    CONSTRAINT "refresh_credentials_pkey" PRIMARY KEY ("token_hash")
);

CREATE TABLE "recovery_codes" (
    "code_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "recovery_codes_pkey" PRIMARY KEY ("code_hash")
);

CREATE TABLE "legacy_invite_code_mappings" (
    "code_hmac" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "key_id" TEXT NOT NULL,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "max_uses" INTEGER NOT NULL DEFAULT 1,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_invite_code_mappings_pkey" PRIMARY KEY ("code_hmac")
);

CREATE TABLE "idempotency_receipts" (
    "actor_id" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "command_id" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "result_code" INTEGER NOT NULL DEFAULT 200,
    "result_summary" JSONB,
    "response_body" JSONB,
    "completed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_idempotency_receipts" PRIMARY KEY ("actor_id", "scope_id", "command_id")
);

CREATE TABLE "legacy_idempotency_mappings" (
    "id" TEXT NOT NULL,
    "target_entity_type" TEXT NOT NULL,
    "target_entity_id" TEXT NOT NULL,
    "source_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'mapped',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legacy_idempotency_mappings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "family_changes" (
    "family_id" TEXT NOT NULL,
    "cursor" BIGINT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_family_changes" PRIMARY KEY ("family_id", "cursor")
);

CREATE TABLE "user_changes" (
    "user_id" TEXT NOT NULL,
    "cursor" BIGINT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "op" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pk_user_changes" PRIMARY KEY ("user_id", "cursor")
);

CREATE TABLE "sync_snapshots" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scope_id" TEXT NOT NULL,
    "epoch" TEXT NOT NULL,
    "high_water" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "page_count" INTEGER NOT NULL DEFAULT 0,
    "manifest" JSONB,
    "hash" CHAR(64),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_executions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "owner_scope" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 3,
    "fence_token" BIGINT NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "last_heartbeat_at" TIMESTAMPTZ(3),
    "cancel_requested_at" TIMESTAMPTZ(3),
    "progress" JSONB,
    "result_ref" JSONB,
    "error_details" JSONB,
    "next_event_seq" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "task_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "task_outbox" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "phase_key" TEXT NOT NULL DEFAULT 'initial',
    "dispatch_state" TEXT NOT NULL DEFAULT 'active',
    "next_dispatch_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_dispatched_at" TIMESTAMPTZ(3),
    "terminal_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_outbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "timeline_entries" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "details" JSONB,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "timeline_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "feeding_records" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "feeding_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "amount_ml" DECIMAL(10, 3),
    "left_minutes" INTEGER,
    "right_minutes" INTEGER,
    "duration_minutes" INTEGER,
    "spit_up" TEXT,
    "formula_product_id" TEXT,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "source_agent" TEXT,
    "recorded_by_user_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "feeding_records_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE INDEX "ix_device_sessions_user_valid" ON "device_sessions"("user_id", "revoked_at", "absolute_expires_at");
CREATE INDEX "ix_refresh_credentials_session_valid" ON "refresh_credentials"("session_id", "revoked_at", "expires_at");
CREATE INDEX "ix_refresh_credentials_user" ON "refresh_credentials"("user_id");
CREATE INDEX "ix_refresh_credentials_rotation" ON "refresh_credentials"("rotation_id");
CREATE INDEX "ix_recovery_codes_user_batch" ON "recovery_codes"("user_id", "batch_id", "used_at", "revoked_at");
CREATE INDEX "ix_legacy_invite_family_expires" ON "legacy_invite_code_mappings"("family_id", "expires_at");
CREATE INDEX "ix_idempotency_receipts_scope_completed" ON "idempotency_receipts"("scope_id", "completed_at");
CREATE UNIQUE INDEX "uq_legacy_idempotency_type_source" ON "legacy_idempotency_mappings"("target_entity_type", "source_key");
CREATE INDEX "ix_legacy_idempotency_target_id" ON "legacy_idempotency_mappings"("target_entity_id");
CREATE INDEX "ix_family_changes_family_entity" ON "family_changes"("family_id", "entity_type", "entity_id");
CREATE INDEX "ix_family_changes_family_created" ON "family_changes"("family_id", "created_at");
CREATE INDEX "ix_user_changes_user_entity" ON "user_changes"("user_id", "entity_type", "entity_id");
CREATE INDEX "ix_sync_snapshots_scope" ON "sync_snapshots"("scope", "scope_id", "status");
CREATE INDEX "ix_sync_snapshots_expires" ON "sync_snapshots"("expires_at");
CREATE INDEX "ix_task_executions_status_lease" ON "task_executions"("status", "lease_expires_at");
CREATE INDEX "ix_task_executions_scope_kind" ON "task_executions"("owner_scope", "kind", "status");
CREATE INDEX "ix_task_outbox_dispatch" ON "task_outbox"("dispatch_state", "next_dispatch_at");
CREATE INDEX "ix_task_outbox_aggregate" ON "task_outbox"("aggregate_id");
CREATE UNIQUE INDEX "uq_timeline_entries_entity" ON "timeline_entries"("family_id", "baby_id", "entity_type", "entity_id");
CREATE INDEX "ix_timeline_entries_baby_timeline" ON "timeline_entries"("baby_id", "deleted_at", "occurred_at" DESC, "id" DESC);
CREATE INDEX "ix_timeline_entries_family_timeline" ON "timeline_entries"("family_id", "deleted_at", "occurred_at" DESC);
CREATE INDEX "ix_feeding_records_baby_timeline" ON "feeding_records"("baby_id", "deleted_at", "occurred_at" DESC, "id" DESC);
CREATE INDEX "ix_feeding_records_family_timeline" ON "feeding_records"("family_id", "deleted_at", "occurred_at" DESC);

-- Foreign Keys
ALTER TABLE "device_sessions"
    ADD CONSTRAINT "device_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_credentials"
    ADD CONSTRAINT "refresh_credentials_session_id_fkey"
    FOREIGN KEY ("session_id") REFERENCES "device_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "refresh_credentials"
    ADD CONSTRAINT "refresh_credentials_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "recovery_codes"
    ADD CONSTRAINT "recovery_codes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "legacy_invite_code_mappings"
    ADD CONSTRAINT "legacy_invite_code_mappings_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "family_changes"
    ADD CONSTRAINT "family_changes_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_changes"
    ADD CONSTRAINT "user_changes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "timeline_entries"
    ADD CONSTRAINT "timeline_entries_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "timeline_entries"
    ADD CONSTRAINT "timeline_entries_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "feeding_records"
    ADD CONSTRAINT "feeding_records_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feeding_records"
    ADD CONSTRAINT "feeding_records_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constraints
ALTER TABLE "device_sessions"
    ADD CONSTRAINT "device_sessions_platform_check" CHECK ("platform" IN ('ios', 'web', 'macos', 'android', 'unknown'));
ALTER TABLE "family_changes"
    ADD CONSTRAINT "family_changes_op_check" CHECK ("op" IN ('upsert', 'delete'));
ALTER TABLE "family_changes"
    ADD CONSTRAINT "family_changes_cursor_check" CHECK ("cursor" >= 0);
ALTER TABLE "family_changes"
    ADD CONSTRAINT "family_changes_version_check" CHECK ("version" > 0);
ALTER TABLE "user_changes"
    ADD CONSTRAINT "user_changes_op_check" CHECK ("op" IN ('upsert', 'delete'));
ALTER TABLE "user_changes"
    ADD CONSTRAINT "user_changes_cursor_check" CHECK ("cursor" >= 0);
ALTER TABLE "user_changes"
    ADD CONSTRAINT "user_changes_version_check" CHECK ("version" > 0);
ALTER TABLE "task_executions"
    ADD CONSTRAINT "task_executions_status_check" CHECK ("status" IN ('queued', 'running', 'awaiting_confirmation', 'succeeded', 'failed', 'cancelling', 'cancelled'));
ALTER TABLE "task_executions"
    ADD CONSTRAINT "task_executions_attempt_check" CHECK ("attempt" >= 0);
ALTER TABLE "task_executions"
    ADD CONSTRAINT "task_executions_fence_token_check" CHECK ("fence_token" >= 0);
ALTER TABLE "task_outbox"
    ADD CONSTRAINT "task_outbox_dispatch_state_check" CHECK ("dispatch_state" IN ('active', 'parked', 'closed'));
ALTER TABLE "timeline_entries"
    ADD CONSTRAINT "timeline_entries_version_check" CHECK ("version" > 0);
ALTER TABLE "feeding_records"
    ADD CONSTRAINT "feeding_records_feeding_type_check" CHECK ("feeding_type" IN ('breast_left', 'breast_right', 'breast_both', 'bottle_breast_milk', 'bottle_formula', 'formula', 'water'));
ALTER TABLE "feeding_records"
    ADD CONSTRAINT "feeding_records_version_check" CHECK ("version" > 0);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
