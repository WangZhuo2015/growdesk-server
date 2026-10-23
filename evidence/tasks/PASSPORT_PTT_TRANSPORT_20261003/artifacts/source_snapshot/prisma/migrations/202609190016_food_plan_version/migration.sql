-- Protect the shared BabyFoodPlan JSON from stale full-document writes.
ALTER TABLE "public"."baby_food_plans"
  ADD COLUMN "version" BIGINT NOT NULL DEFAULT 1;
