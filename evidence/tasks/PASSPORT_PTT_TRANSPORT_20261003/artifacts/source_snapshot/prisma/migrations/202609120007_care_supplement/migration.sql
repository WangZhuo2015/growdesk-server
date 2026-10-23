-- CreateTable
CREATE TABLE "public"."supplement_records" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "supplement_name" VARCHAR(100) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "amount" VARCHAR(100),
    "notes" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplement_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_supplement_records_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_supplement_records_family_id_baby_id_fkey" FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "supplement_records_version_check" CHECK ("version" > 0)
);

CREATE INDEX "ix_supplement_records_baby_timeline" ON "public"."supplement_records"("baby_id", "deleted_at", "occurred_at" DESC, "id" DESC);
CREATE INDEX "ix_supplement_records_family_timeline" ON "public"."supplement_records"("family_id", "deleted_at", "occurred_at" DESC);
