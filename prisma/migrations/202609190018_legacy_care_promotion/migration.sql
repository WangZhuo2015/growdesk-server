-- Additive legacy care promotion audit fields.
-- The source archive remains the authoritative raw payload. These fields make
-- the promotion of the first three record families queryable without making
-- legacy_import an online read source.

ALTER TABLE "legacy_idempotency_mappings"
  ADD COLUMN "source_system" TEXT,
  ADD COLUMN "source_batch_id" CHAR(64),
  ADD COLUMN "source_table" TEXT,
  ADD COLUMN "source_id" TEXT,
  ADD COLUMN "source_hash" CHAR(64),
  ADD COLUMN "mapping_version" TEXT,
  ADD COLUMN "metadata" JSONB;

ALTER TABLE "feeding_records"
  ADD COLUMN "legacy_client_id" TEXT,
  ADD COLUMN "legacy_metadata" JSONB;

ALTER TABLE "diaper_records"
  ADD COLUMN "legacy_client_id" TEXT,
  ADD COLUMN "legacy_metadata" JSONB;

ALTER TABLE "sleep_records"
  ADD COLUMN "legacy_client_id" TEXT,
  ADD COLUMN "legacy_metadata" JSONB;

CREATE INDEX "ix_legacy_idempotency_source_batch"
  ON "legacy_idempotency_mappings"("source_batch_id", "source_table", "source_id");

CREATE UNIQUE INDEX "uq_feeding_records_baby_legacy_client"
  ON "feeding_records"("baby_id", "legacy_client_id")
  WHERE "legacy_client_id" IS NOT NULL;

CREATE UNIQUE INDEX "uq_diaper_records_baby_legacy_client"
  ON "diaper_records"("baby_id", "legacy_client_id")
  WHERE "legacy_client_id" IS NOT NULL;

CREATE UNIQUE INDEX "uq_sleep_records_baby_legacy_client"
  ON "sleep_records"("baby_id", "legacy_client_id")
  WHERE "legacy_client_id" IS NOT NULL;
