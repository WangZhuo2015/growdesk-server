-- Canonical durable voice result history for the Web/iOS voice UI.
-- The composite baby foreign key keeps the family boundary database-enforced.

CREATE TABLE "public"."agent_voice_logs" (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "family_id" TEXT NOT NULL,
  "baby_id" TEXT NOT NULL,
  "prompt" TEXT NOT NULL,
  "reply" TEXT NOT NULL,
  "is_async" BOOLEAN NOT NULL DEFAULT FALSE,
  "is_fast_path" BOOLEAN NOT NULL DEFAULT FALSE,
  "acknowledged" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_voice_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_voice_logs_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_voice_logs_family_id_fkey"
    FOREIGN KEY ("family_id") REFERENCES "public"."families"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "agent_voice_logs_family_id_baby_id_fkey"
    FOREIGN KEY ("family_id", "baby_id") REFERENCES "public"."babies"("family_id", "id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ix_agent_voice_logs_user_ack_created"
  ON "public"."agent_voice_logs"("user_id", "acknowledged", "created_at" DESC, "id" DESC);
CREATE INDEX "ix_agent_voice_logs_baby_created"
  ON "public"."agent_voice_logs"("baby_id", "created_at" DESC, "id" DESC);
