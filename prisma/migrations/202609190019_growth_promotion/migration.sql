-- Additive audit fields for the image-free legacy GrowthMeasurement promotion.
-- The attachment lane remains separate: rows with a legacy image URL are
-- rejected until an Attachment/object-storage mapping exists.

ALTER TABLE "growth_measurements"
  ADD COLUMN "legacy_client_id" TEXT,
  ADD COLUMN "legacy_metadata" JSONB;

CREATE UNIQUE INDEX "uq_growth_measurements_baby_legacy_client"
  ON "growth_measurements"("baby_id", "legacy_client_id")
  WHERE "legacy_client_id" IS NOT NULL;
