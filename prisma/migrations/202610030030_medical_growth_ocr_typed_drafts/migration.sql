ALTER TABLE "public"."medical_reports"
  ADD COLUMN "category" VARCHAR(32);

ALTER TABLE "public"."medical_reports"
  ADD CONSTRAINT "medical_reports_category_check"
  CHECK ("category" IS NULL OR "category" IN ('blood', 'growth', 'trace_element', 'allergy', 'general'));

ALTER TABLE "public"."ai_runs"
  ADD COLUMN "ocr_draft" JSONB;

ALTER TABLE "public"."ai_runs"
  ADD CONSTRAINT "ai_runs_ocr_draft_object_check"
  CHECK ("ocr_draft" IS NULL OR jsonb_typeof("ocr_draft") = 'object');
