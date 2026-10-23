-- Canonical private, append-only legacy AI archive metadata.
-- Raw legacy rows remain in legacy_import.import_rows. This table stores the
-- immutable hashes/content plus an explicit authorization scope. Rows whose
-- owner or private attachment cannot be proven are retained as quarantine and
-- must never be projected through a user-facing route.

CREATE TABLE "public"."ai_archive_entries" (
  "id" TEXT NOT NULL,
  "source_batch_id" CHAR(64) NOT NULL,
  "source_system" VARCHAR(100) NOT NULL,
  "source_table" VARCHAR(100) NOT NULL DEFAULT 'AiArchive',
  "source_id" TEXT NOT NULL,
  "source_hash" CHAR(64) NOT NULL,
  "kind" VARCHAR(32) NOT NULL,
  "file_path" TEXT,
  "content" TEXT,
  "content_hash" CHAR(64) NOT NULL,
  "byte_size" INTEGER,
  "user_id" TEXT,
  "family_id" TEXT,
  "baby_id" TEXT,
  "attachment_id" TEXT,
  "status" VARCHAR(20) NOT NULL DEFAULT 'quarantined',
  "quarantine_code" VARCHAR(100),
  "metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ai_archive_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_archive_entries_source_unique" UNIQUE ("source_batch_id", "source_table", "source_id"),
  CONSTRAINT "ai_archive_entries_source_batch_check" CHECK ("source_batch_id" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_archive_entries_source_hash_check" CHECK ("source_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_archive_entries_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "ai_archive_entries_size_check" CHECK ("byte_size" IS NULL OR "byte_size" >= 0),
  CONSTRAINT "ai_archive_entries_status_check" CHECK ("status" IN ('mapped', 'quarantined')),
  CONSTRAINT "ai_archive_entries_scope_check" CHECK (
    "status" = 'quarantined'
    OR ("user_id" IS NOT NULL AND "family_id" IS NOT NULL)
  ),
  CONSTRAINT "ai_archive_entries_binary_attachment_check" CHECK (
    "status" = 'quarantined'
    OR "file_path" IS NULL
    OR "attachment_id" IS NOT NULL
  ),
  CONSTRAINT "ai_archive_entries_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_archive_entries_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_archive_entries_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_archive_entries_attachment_id_fkey"
    FOREIGN KEY ("attachment_id") REFERENCES "public"."attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ix_ai_archive_entries_scope_created"
  ON "public"."ai_archive_entries"("family_id", "baby_id", "created_at" DESC, "id" DESC);
CREATE INDEX "ix_ai_archive_entries_kind_created"
  ON "public"."ai_archive_entries"("kind", "created_at" DESC, "id" DESC);
CREATE INDEX "ix_ai_archive_entries_attachment"
  ON "public"."ai_archive_entries"("attachment_id");
CREATE INDEX "ix_ai_archive_entries_status_created"
  ON "public"."ai_archive_entries"("status", "created_at" DESC);
