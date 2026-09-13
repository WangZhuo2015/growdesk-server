-- CreateTable
CREATE TABLE "public"."bff_sessions" (
    "id" TEXT NOT NULL,
    "session_secret_hash" VARCHAR(64) NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "encrypted_refresh_token" TEXT NOT NULL,
    "rotation_id" TEXT NOT NULL,
    "current_access_token" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "idle_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "absolute_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bff_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_bff_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_bff_sessions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."device_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "bff_sessions_session_secret_hash_key" ON "public"."bff_sessions"("session_secret_hash");
CREATE INDEX "ix_bff_sessions_valid" ON "public"."bff_sessions"("session_secret_hash", "revoked_at", "absolute_expires_at");
CREATE INDEX "ix_bff_sessions_user" ON "public"."bff_sessions"("user_id");
