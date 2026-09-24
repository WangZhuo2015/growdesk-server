-- Durable, tenant-scoped undo snapshots. A snapshot is written in the same
-- transaction as the soft delete it protects; restore only clears the target
-- row's tombstone after rechecking the current scope and conflict state.
CREATE TABLE "public"."record_snapshots" (
  "id" TEXT NOT NULL,
  "family_id" TEXT NOT NULL,
  "baby_id" TEXT NOT NULL,
  "user_id" TEXT,
  "source" VARCHAR(32) NOT NULL DEFAULT 'mcp',
  "source_agent" VARCHAR(200),
  "action" VARCHAR(32) NOT NULL,
  "entity_type" VARCHAR(50) NOT NULL,
  "entity_id" TEXT NOT NULL,
  "payload_json" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "source_system" VARCHAR(100),
  "source_batch_id" CHAR(64),
  "source_table" VARCHAR(100),
  "source_id" TEXT,
  "source_hash" CHAR(64),
  "mapping_version" VARCHAR(100),
  "restored" BOOLEAN NOT NULL DEFAULT FALSE,
  "restored_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "record_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "record_snapshots_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "record_snapshots_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "record_snapshots_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "record_snapshots_action_check"
    CHECK ("action" IN ('delete', 'update', 'batch_overwrite')),
  CONSTRAINT "record_snapshots_entity_type_check"
    CHECK ("entity_type" IN ('feeding', 'sleep', 'diaper', 'food', 'growth', 'medical_report', 'vaccine', 'food_plan', 'supplement')),
  CONSTRAINT "record_snapshots_payload_hash_check" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "record_snapshots_source_hash_check" CHECK ("source_hash" IS NULL OR "source_hash" ~ '^[0-9a-f]{64}$')
 );

CREATE INDEX "ix_record_snapshots_baby_created"
  ON "public"."record_snapshots"("family_id", "baby_id", "created_at" DESC, "id" DESC);
CREATE INDEX "ix_record_snapshots_restore_lookup"
  ON "public"."record_snapshots"("family_id", "baby_id", "entity_type", "restored", "created_at" DESC);
CREATE INDEX "ix_record_snapshots_source"
  ON "public"."record_snapshots"("source_batch_id", "source_table", "source_id");
