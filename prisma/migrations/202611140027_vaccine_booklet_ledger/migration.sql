-- Canonical vaccine ledger state. Legacy wire projection remains available in
-- the API while the stored dates distinguish actual administration from plans.

ALTER TABLE "public"."vaccine_records"
  ADD COLUMN "record_status" VARCHAR(20) NOT NULL DEFAULT 'needs_review',
  ADD COLUMN "manufacturer" VARCHAR(200),
  ADD COLUMN "trace_code" VARCHAR(200),
  ADD COLUMN "administration_route" VARCHAR(80),
  ADD COLUMN "injection_site" VARCHAR(120),
  ADD COLUMN "source_text" VARCHAR(4000);

-- Relax the historical required date before migrating appointment-only rows,
-- and align the free-text fields with the booklet entry UI.
ALTER TABLE "public"."vaccine_records"
  ALTER COLUMN "administered_date" DROP NOT NULL,
  ALTER COLUMN "vaccine_code" TYPE VARCHAR(200),
  ALTER COLUMN "notes" TYPE VARCHAR(4000);

-- Existing completed rows remain actual administrations. Incomplete rows with
-- a schedule date are appointments; incomplete rows without one remain
-- explicitly unverified rather than being reclassified as administered.
UPDATE "public"."vaccine_records"
SET "record_status" = CASE
      WHEN "is_completed" THEN 'completed'
      WHEN "scheduled_date" IS NOT NULL THEN 'planned'
      ELSE 'needs_review'
    END,
    "completed_date" = CASE
      WHEN "is_completed" THEN COALESCE("administered_date", "completed_date")
      ELSE NULL
    END,
    "administered_date" = CASE
      WHEN "is_completed" THEN COALESCE("administered_date", "completed_date")
      WHEN "scheduled_date" IS NOT NULL THEN NULL
      ELSE "administered_date"
    END;

-- A future date cannot be treated as an administration. Preserve its date as
-- unverified metadata and remove the old completion projection.
UPDATE "public"."vaccine_records"
SET "record_status" = 'needs_review',
    "is_completed" = FALSE,
    "completed_date" = NULL
WHERE "record_status" = 'completed'
  AND "administered_date" > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date;

UPDATE "public"."timeline_entries" t
SET "deleted_at" = COALESCE(t."deleted_at", CURRENT_TIMESTAMP),
    "updated_at" = CURRENT_TIMESTAMP,
    "version" = t."version" + 1
FROM "public"."vaccine_records" r
WHERE t."entity_type" = 'vaccine'
  AND t."entity_id" = r."id"
  AND t."family_id" = r."family_id"
  AND t."baby_id" = r."baby_id"
  AND r."record_status" = 'needs_review'
  AND r."is_completed" = FALSE
  AND r."administered_date" > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
  AND t."deleted_at" IS NULL;

ALTER TABLE "public"."vaccine_records"
  ADD CONSTRAINT "vaccine_records_status_check"
    CHECK ("record_status" IN ('completed', 'planned', 'needs_review')),
  ADD CONSTRAINT "vaccine_records_lifecycle_check"
    CHECK (
      ("record_status" = 'completed'
        AND "is_completed"
        AND "administered_date" IS NOT NULL
        AND "completed_date" = "administered_date")
      OR
      ("record_status" = 'planned'
        AND NOT "is_completed"
        AND "administered_date" IS NULL
        AND "completed_date" IS NULL
        AND "scheduled_date" IS NOT NULL)
      OR
      ("record_status" = 'needs_review'
        AND NOT "is_completed"
        AND "completed_date" IS NULL)
    );
