CREATE TABLE "personal_access_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "token_hint" VARCHAR(64) NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY['voice:submit']::TEXT[],
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "personal_access_tokens_scope_voice_submit_only" CHECK ("scopes" = ARRAY['voice:submit']::TEXT[]),
    CONSTRAINT "personal_access_tokens_user_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "personal_access_tokens_token_hash_key" ON "personal_access_tokens"("token_hash");
CREATE INDEX "ix_personal_access_tokens_user_active" ON "personal_access_tokens"("user_id", "revoked_at", "created_at" DESC);
