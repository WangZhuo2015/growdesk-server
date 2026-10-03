ALTER TABLE "public"."task_executions"
    ADD COLUMN "result_expires_at" TIMESTAMPTZ(3);

-- Backfill already-completed native exports. Invalid or missing legacy expiry
-- metadata receives one hour from completion so old payloads are not retained
-- indefinitely when the new periodic cleaner begins running.
UPDATE "public"."task_executions"
SET "result_expires_at" = CASE
    WHEN ("result_ref"->>'expiresAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
        THEN ("result_ref"->>'expiresAt')::TIMESTAMPTZ(3)
    ELSE "updated_at" + INTERVAL '1 hour'
END
WHERE "kind" = 'user_data_export'
  AND "status" = 'succeeded'
  AND "result_ref" ? 'payload';

CREATE INDEX "ix_user_export_payload_expiry"
    ON "public"."task_executions"("result_expires_at", "id")
    WHERE "kind" = 'user_data_export'
      AND "status" = 'succeeded'
      AND "result_ref" ? 'payload';
