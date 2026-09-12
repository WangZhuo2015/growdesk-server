-- CreateTable: sleep_records
CREATE TABLE "sleep_records" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "sleep_type" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "ended_at" TIMESTAMPTZ(3),
    "night_waking_count" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "source_agent" TEXT,
    "recorded_by_user_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sleep_records_pkey" PRIMARY KEY ("id")
);

-- Foreign Keys
ALTER TABLE "sleep_records"
    ADD CONSTRAINT "sleep_records_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sleep_records"
    ADD CONSTRAINT "sleep_records_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constraints
ALTER TABLE "sleep_records"
    ADD CONSTRAINT "sleep_records_sleep_type_check"
    CHECK ("sleep_type" IN ('nap', 'night'));

ALTER TABLE "sleep_records"
    ADD CONSTRAINT "sleep_records_version_check"
    CHECK ("version" > 0);

ALTER TABLE "sleep_records"
    ADD CONSTRAINT "sleep_records_night_waking_count_check"
    CHECK ("night_waking_count" >= 0);

ALTER TABLE "sleep_records"
    ADD CONSTRAINT "sleep_records_time_order_check"
    CHECK ("ended_at" IS NULL OR "ended_at" >= "started_at");

-- Active sleep unique partial index: at most one active (ongoing, ended_at IS NULL) sleep record per baby
CREATE UNIQUE INDEX "uq_sleep_records_active_baby"
    ON "sleep_records"("baby_id")
    WHERE ("ended_at" IS NULL AND "deleted_at" IS NULL);

-- Indexes
CREATE INDEX "ix_sleep_records_baby_timeline" ON "sleep_records"("baby_id", "deleted_at", "started_at" DESC, "id" DESC);
CREATE INDEX "ix_sleep_records_family_timeline" ON "sleep_records"("family_id", "deleted_at", "started_at" DESC);
