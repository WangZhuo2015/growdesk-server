-- CreateTable
CREATE TABLE "public"."growth_measurements" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "measurement_date" DATE NOT NULL,
    "weight_kg" DECIMAL(5,2),
    "height_cm" DECIMAL(5,1),
    "head_circumference_cm" DECIMAL(4,1),
    "attachment_id" VARCHAR(255),
    "notes" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "growth_measurements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_growth_measurements_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_growth_measurements_family_id_baby_id_fkey" FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "growth_measurements_version_check" CHECK ("version" > 0),
    CONSTRAINT "growth_measurements_has_values_check" CHECK ("weight_kg" IS NOT NULL OR "height_cm" IS NOT NULL OR "head_circumference_cm" IS NOT NULL),
    CONSTRAINT "growth_measurements_weight_positive_check" CHECK ("weight_kg" IS NULL OR "weight_kg" > 0),
    CONSTRAINT "growth_measurements_height_positive_check" CHECK ("height_cm" IS NULL OR "height_cm" > 0),
    CONSTRAINT "growth_measurements_head_positive_check" CHECK ("head_circumference_cm" IS NULL OR "head_circumference_cm" > 0)
);

CREATE INDEX "ix_growth_measurements_baby_timeline" ON "public"."growth_measurements"("baby_id", "deleted_at", "measurement_date" DESC, "id" DESC);
CREATE INDEX "ix_growth_measurements_family_timeline" ON "public"."growth_measurements"("family_id", "deleted_at", "measurement_date" DESC);
