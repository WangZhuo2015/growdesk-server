ALTER TABLE "public"."food_records"
  ADD COLUMN "food_amount_grams" NUMERIC(12,5);

ALTER TABLE "public"."food_records"
  ADD CONSTRAINT "food_records_food_amount_grams_check"
  CHECK ("food_amount_grams" IS NULL OR "food_amount_grams" > 0);
