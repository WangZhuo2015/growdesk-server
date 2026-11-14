-- Additive booklet metadata only. Never infer missing historical clinical data.
ALTER TABLE "public"."vaccine_records"
  ADD COLUMN "manufacturer" VARCHAR(200),
  ADD COLUMN "product_name" VARCHAR(200),
  ADD COLUMN "traceability_code" VARCHAR(200),
  ADD COLUMN "injection_site" VARCHAR(100);

