-- CreateTable: diaper_records
CREATE TABLE "diaper_records" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "diaper_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "poop_color" TEXT,
    "poop_consistency" TEXT,
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "source_agent" TEXT,
    "recorded_by_user_id" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "diaper_records_pkey" PRIMARY KEY ("id")
);

-- Foreign Keys
ALTER TABLE "diaper_records"
    ADD CONSTRAINT "diaper_records_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "diaper_records"
    ADD CONSTRAINT "diaper_records_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Constraints
ALTER TABLE "diaper_records"
    ADD CONSTRAINT "diaper_records_diaper_type_check"
    CHECK ("diaper_type" IN ('pee', 'poop', 'both', 'wet', 'dirty', 'dry'));

ALTER TABLE "diaper_records"
    ADD CONSTRAINT "diaper_records_version_check"
    CHECK ("version" > 0);

-- Indexes
CREATE INDEX "ix_diaper_records_baby_timeline" ON "diaper_records"("baby_id", "deleted_at", "occurred_at" DESC, "id" DESC);
CREATE INDEX "ix_diaper_records_family_timeline" ON "diaper_records"("family_id", "deleted_at", "occurred_at" DESC);
