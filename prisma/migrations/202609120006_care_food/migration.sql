-- CreateTable
CREATE TABLE "public"."food_records" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "record_date" VARCHAR(10) NOT NULL,
    "meal_type" VARCHAR(32) NOT NULL,
    "occurred_at" TIMESTAMPTZ(3),
    "food_item_ids" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
    "portion_description" VARCHAR(255),
    "reaction" VARCHAR(32),
    "notes" VARCHAR(1000),
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_food_records_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_food_records_family_id_baby_id_fkey" FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "food_records_meal_type_check" CHECK ("meal_type" IN ('breakfast', 'lunch', 'dinner', 'snack')),
    CONSTRAINT "food_records_reaction_check" CHECK ("reaction" IS NULL OR "reaction" IN ('like', 'normal', 'dislike')),
    CONSTRAINT "food_records_version_check" CHECK ("version" > 0)
);

CREATE INDEX "ix_food_records_baby_timeline" ON "public"."food_records"("baby_id", "deleted_at", "record_date" DESC, "id" DESC);
CREATE INDEX "ix_food_records_family_timeline" ON "public"."food_records"("family_id", "deleted_at", "record_date" DESC);

-- CreateTable
CREATE TABLE "public"."food_library_items" (
    "id" VARCHAR(64) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "allergen_risk" VARCHAR(16) NOT NULL,
    "recommended_age_months" INTEGER NOT NULL,
    "is_custom" BOOLEAN NOT NULL DEFAULT false,
    "family_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "food_library_items_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_food_library_items_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "food_library_items_allergen_risk_check" CHECK ("allergen_risk" IN ('low', 'medium', 'high')),
    CONSTRAINT "food_library_items_recommended_age_months_check" CHECK ("recommended_age_months" >= 0)
);

CREATE INDEX "ix_food_library_items_family_custom" ON "public"."food_library_items"("family_id", "is_custom");

-- CreateTable
CREATE TABLE "public"."family_food_statuses" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "food_item_id" VARCHAR(64) NOT NULL,
    "tried" BOOLEAN NOT NULL DEFAULT false,
    "reaction" VARCHAR(32),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_food_statuses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_family_food_statuses_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "uq_family_food_statuses" UNIQUE ("family_id", "food_item_id")
);

-- CreateTable
CREATE TABLE "public"."baby_food_plans" (
    "id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "plan_data" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "baby_food_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "uq_baby_food_plans_baby_id" UNIQUE ("baby_id"),
    CONSTRAINT "uq_baby_food_plans_family_baby" UNIQUE ("family_id", "baby_id"),
    CONSTRAINT "fk_baby_food_plans_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_baby_food_plans_family_id_baby_id_fkey" FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
