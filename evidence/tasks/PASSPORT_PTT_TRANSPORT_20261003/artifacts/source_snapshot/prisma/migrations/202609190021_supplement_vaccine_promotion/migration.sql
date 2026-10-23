-- Additive canonical storage for the legacy nutrition and vaccine reference
-- graph.  The old archive remains immutable; the promotion script writes
-- source hashes and target snapshots to legacy_idempotency_mappings.

ALTER TABLE "public"."supplement_records"
  ADD COLUMN "product_id" TEXT,
  ADD COLUMN "dose" DECIMAL(12,5),
  ADD COLUMN "unit_name" VARCHAR(50),
  -- Existing canonical rows have no source column. Keep their provenance
  -- neutral, matching the other care-record migrations; legacy promotion
  -- writes the source carried by each archive row explicitly.
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "source_agent" TEXT,
  ADD COLUMN "legacy_client_id" TEXT,
  ADD COLUMN "legacy_metadata" JSONB;

CREATE INDEX "ix_supplement_records_product" ON "public"."supplement_records"("product_id");
CREATE UNIQUE INDEX "uq_supplement_records_baby_legacy_client"
  ON "public"."supplement_records"("baby_id", "legacy_client_id")
  WHERE "legacy_client_id" IS NOT NULL;

CREATE TABLE "public"."supplement_products" (
  "id" TEXT NOT NULL,
  "family_id" TEXT NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "brand" VARCHAR(100),
  "dosage_form" VARCHAR(50),
  "unit_name" VARCHAR(50) NOT NULL,
  "default_dose" DECIMAL(12,5) NOT NULL DEFAULT 1,
  "nutrients_json" JSONB,
  "notes" TEXT,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "is_archived" BOOLEAN NOT NULL DEFAULT FALSE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "legacy_metadata" JSONB,
  CONSTRAINT "supplement_products_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplement_products_default_dose_check" CHECK ("default_dose" > 0),
  CONSTRAINT "supplement_products_version_check" CHECK ("version" > 0),
  CONSTRAINT "fk_supplement_products_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ix_supplement_products_family" ON "public"."supplement_products"("family_id", "is_archived", "deleted_at");

CREATE TABLE "public"."supplement_schedules" (
  "id" TEXT NOT NULL,
  "family_id" TEXT NOT NULL,
  "baby_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "frequency" VARCHAR(32) NOT NULL DEFAULT 'daily',
  "custom_days_json" JSONB,
  "target_dose" DECIMAL(12,5) NOT NULL DEFAULT 1,
  "reminder_time" VARCHAR(5),
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "start_date" DATE,
  "notes" TEXT,
  "version" INTEGER NOT NULL DEFAULT 1,
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "legacy_metadata" JSONB,
  CONSTRAINT "supplement_schedules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "supplement_schedules_target_dose_check" CHECK ("target_dose" > 0),
  CONSTRAINT "supplement_schedules_version_check" CHECK ("version" > 0),
  CONSTRAINT "fk_supplement_schedules_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_supplement_schedules_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "fk_supplement_schedules_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "public"."supplement_products"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ix_supplement_schedules_baby" ON "public"."supplement_schedules"("baby_id", "is_active", "deleted_at");
CREATE INDEX "ix_supplement_schedules_family" ON "public"."supplement_schedules"("family_id", "deleted_at");

ALTER TABLE "public"."supplement_records"
  ADD CONSTRAINT "fk_supplement_records_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "public"."supplement_products"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "fk_supplement_records_recorded_by_user_id_fkey"
    FOREIGN KEY ("recorded_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."vaccine_records"
  ADD COLUMN "vaccine_id" TEXT,
  ADD COLUMN "dose_number" INTEGER,
  ADD COLUMN "legacy_name" VARCHAR(200),
  ADD COLUMN "legacy_dose" VARCHAR(100),
  ADD COLUMN "scheduled_date" DATE,
  ADD COLUMN "completed_date" DATE,
  ADD COLUMN "is_completed" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "legacy_metadata" JSONB;

CREATE TABLE "public"."vaccines" (
  "id" TEXT NOT NULL,
  "vaccine_code" VARCHAR(100) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "short_name" VARCHAR(200),
  "english_name" VARCHAR(200),
  "program_type" VARCHAR(80) NOT NULL,
  "legacy_label" VARCHAR(100),
  "sex_restriction" VARCHAR(20) NOT NULL DEFAULT 'all',
  "china_national" BOOLEAN NOT NULL DEFAULT FALSE,
  "diseases" JSONB,
  "target_population" TEXT,
  "policy_effective_date" VARCHAR(10),
  "policy_version" VARCHAR(100),
  "routine_healthy_child_option" BOOLEAN NOT NULL DEFAULT TRUE,
  "manual_review_required" BOOLEAN NOT NULL DEFAULT FALSE,
  "market_status" VARCHAR(50),
  "product_brand_name" VARCHAR(200),
  "product_manufacturer" VARCHAR(200),
  "product_approval_number" VARCHAR(100),
  "jiangsu_notes" TEXT,
  "suzhou_notes" TEXT,
  "catch_up_supported" BOOLEAN NOT NULL DEFAULT FALSE,
  "catch_up_rules" JSONB,
  "simultaneous_vaccination" TEXT,
  "substitution_rules" JSONB,
  "contraindications" JSONB,
  "precautions" JSONB,
  "special_populations" JSONB,
  "regional_overrides" JSONB,
  "regimen_options" JSONB,
  "source_refs_json" JSONB,
  "legacy_metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vaccines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vaccines_vaccine_code_key" UNIQUE ("vaccine_code")
);

CREATE TABLE "public"."vaccine_doses" (
  "id" TEXT NOT NULL,
  "vaccine_id" TEXT NOT NULL,
  "dose_number" INTEGER NOT NULL,
  "dose_label" VARCHAR(100) NOT NULL,
  "recommended_age_months" INTEGER,
  "minimum_age_days" INTEGER,
  "maximum_age_days" INTEGER,
  "recommended_age_max_months" INTEGER,
  "minimum_interval_days_from_previous" INTEGER,
  "maximum_interval_days_from_previous" INTEGER,
  "route" VARCHAR(50),
  "site" VARCHAR(100),
  "dose_volume_ml" DECIMAL(12,5),
  "notes" TEXT,
  "source_refs_json" JSONB,
  "legacy_metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vaccine_doses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vaccine_doses_dose_number_check" CHECK ("dose_number" > 0),
  CONSTRAINT "vaccine_doses_vaccine_id_fkey"
    FOREIGN KEY ("vaccine_id") REFERENCES "public"."vaccines"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "uq_vaccine_doses_vaccine_dose" UNIQUE ("vaccine_id", "dose_number")
);

CREATE TABLE "public"."vaccine_schedule_entries" (
  "id" TEXT NOT NULL,
  "vaccine_id" TEXT NOT NULL,
  "age_months" INTEGER,
  "age_days" INTEGER,
  "age_label" VARCHAR(100),
  "dose_number" INTEGER NOT NULL,
  "priority" VARCHAR(30) NOT NULL,
  "is_optional" BOOLEAN NOT NULL DEFAULT FALSE,
  "action" TEXT,
  "selection_group" VARCHAR(100),
  "notes" TEXT,
  "source_refs_json" JSONB,
  "legacy_metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vaccine_schedule_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vaccine_schedule_entries_dose_number_check" CHECK ("dose_number" > 0),
  CONSTRAINT "vaccine_schedule_entries_vaccine_id_fkey"
    FOREIGN KEY ("vaccine_id") REFERENCES "public"."vaccines"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "ix_vaccine_schedule_entries_age" ON "public"."vaccine_schedule_entries"("vaccine_id", "age_months", "dose_number");

CREATE TABLE "public"."vaccine_strategy_groups" (
  "id" TEXT NOT NULL,
  "strategy_id" VARCHAR(100) NOT NULL,
  "vaccine_id" TEXT,
  "name" VARCHAR(200) NOT NULL,
  "scope" VARCHAR(100),
  "base_program" VARCHAR(100),
  "options_json" JSONB,
  "source_refs_json" JSONB,
  "legacy_metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vaccine_strategy_groups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vaccine_strategy_groups_strategy_id_key" UNIQUE ("strategy_id"),
  CONSTRAINT "vaccine_strategy_groups_vaccine_id_fkey"
    FOREIGN KEY ("vaccine_id") REFERENCES "public"."vaccines"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "public"."vaccine_selections" (
  "id" TEXT NOT NULL,
  "family_id" TEXT NOT NULL,
  "baby_id" TEXT NOT NULL,
  "vaccine_id" TEXT NOT NULL,
  "dose_number" INTEGER NOT NULL DEFAULT 1,
  "selected" BOOLEAN NOT NULL DEFAULT TRUE,
  "completed" BOOLEAN NOT NULL DEFAULT FALSE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "legacy_metadata" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "vaccine_selections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vaccine_selections_dose_number_check" CHECK ("dose_number" > 0),
  CONSTRAINT "vaccine_selections_version_check" CHECK ("version" > 0),
  CONSTRAINT "vaccine_selections_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vaccine_selections_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "vaccine_selections_vaccine_id_fkey"
    FOREIGN KEY ("vaccine_id") REFERENCES "public"."vaccines"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "uq_vaccine_selections_baby_vaccine_dose" UNIQUE ("baby_id", "vaccine_id", "dose_number")
);
CREATE INDEX "ix_vaccine_selections_scope" ON "public"."vaccine_selections"("family_id", "baby_id");

ALTER TABLE "public"."vaccine_records"
  ADD CONSTRAINT "vaccine_records_vaccine_id_fkey"
    FOREIGN KEY ("vaccine_id") REFERENCES "public"."vaccines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."vaccine_records"
  ADD CONSTRAINT "vaccine_records_completion_check"
    CHECK (NOT "is_completed" OR "completed_date" IS NOT NULL);
