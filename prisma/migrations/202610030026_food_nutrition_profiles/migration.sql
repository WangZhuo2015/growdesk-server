-- Numeric nutrient profiles for family-created food library items.
ALTER TABLE "public"."food_library_items"
  ADD COLUMN "nutrients_json" JSONB,
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "public"."food_library_items"
  ADD CONSTRAINT "food_library_items_version_check" CHECK ("version" >= 1);
