-- GrowDesk's HTTP contract accepts decimal strings without a fixed scale.
-- PostgreSQL typmods rounded those inputs before the API could read them back.
-- Unconstrained numeric retains the exact accepted fractional digits.
ALTER TABLE "public"."formula_products"
  ALTER COLUMN "reconstitution_ratio" TYPE NUMERIC
  USING "reconstitution_ratio"::NUMERIC;

ALTER TABLE "public"."growth_measurements"
  ALTER COLUMN "weight_kg" TYPE NUMERIC
  USING "weight_kg"::NUMERIC,
  ALTER COLUMN "height_cm" TYPE NUMERIC
  USING "height_cm"::NUMERIC,
  ALTER COLUMN "head_circumference_cm" TYPE NUMERIC
  USING "head_circumference_cm"::NUMERIC;
