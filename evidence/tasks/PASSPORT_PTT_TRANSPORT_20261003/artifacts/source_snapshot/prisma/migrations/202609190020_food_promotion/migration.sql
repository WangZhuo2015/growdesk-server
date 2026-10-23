-- Additive audit/provenance fields for the bounded legacy food promotion.
-- FoodLogRecord carried source, actor, client id, and observations that were
-- not present in the initial canonical FoodRecord model. FoodItem and
-- FamilyFoodStatus likewise keep the complete source row in JSON metadata so
-- the historical projection can be reconciled without re-reading SQLite.

ALTER TABLE "food_records"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "source_agent" TEXT,
  ADD COLUMN "recorded_by_user_id" TEXT,
  ADD COLUMN "legacy_client_id" TEXT,
  ADD COLUMN "legacy_metadata" JSONB;

ALTER TABLE "food_library_items"
  ADD COLUMN "legacy_metadata" JSONB;

ALTER TABLE "family_food_statuses"
  ADD COLUMN "legacy_status" VARCHAR(16),
  ADD COLUMN "legacy_acceptance" INTEGER,
  ADD COLUMN "legacy_first_added_date" VARCHAR(10),
  ADD COLUMN "legacy_metadata" JSONB;

CREATE UNIQUE INDEX "uq_food_records_baby_legacy_client"
  ON "food_records"("baby_id", "legacy_client_id")
  WHERE "legacy_client_id" IS NOT NULL;

ALTER TABLE "family_food_statuses"
  ADD CONSTRAINT "family_food_statuses_legacy_acceptance_check"
  CHECK ("legacy_acceptance" IS NULL OR "legacy_acceptance" BETWEEN 0 AND 5);
