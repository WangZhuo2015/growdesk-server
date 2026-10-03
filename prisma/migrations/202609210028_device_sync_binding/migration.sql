CREATE TABLE "device_sync_bindings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "installation_id" VARCHAR(128) NOT NULL,
    "local_vault_id" VARCHAR(128) NOT NULL,
    "family_id" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "generation" BIGINT NOT NULL DEFAULT 1,
    "consent_version" VARCHAR(64) NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_sync_bindings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_sync_bindings_status_check" CHECK ("status" IN ('pending', 'active', 'paused', 'revoked')),
    CONSTRAINT "device_sync_bindings_generation_check" CHECK ("generation" > 0),
    CONSTRAINT "device_sync_bindings_consent_version_check" CHECK (length("consent_version") BETWEEN 1 AND 64),
    CONSTRAINT "device_sync_bindings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_sync_bindings_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_device_sync_bindings_principal_vault_family"
    ON "device_sync_bindings"("user_id", "installation_id", "local_vault_id", "family_id");
CREATE INDEX "ix_device_sync_bindings_user_updated"
    ON "device_sync_bindings"("user_id", "updated_at", "id");

CREATE TABLE "device_sync_import_plans" (
    "id" TEXT NOT NULL,
    "binding_id" TEXT NOT NULL,
    "generation" BIGINT NOT NULL,
    "consent_version" VARCHAR(64) NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "expected_chunk_count" INTEGER NOT NULL,
    "expected_record_count" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "activated_generation" BIGINT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activated_at" TIMESTAMPTZ(3),

    CONSTRAINT "device_sync_import_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "device_sync_import_plans_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "device_sync_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_sync_import_plans_status_check" CHECK ("status" IN ('pending', 'activated')),
    CONSTRAINT "device_sync_import_plans_count_check" CHECK ("expected_chunk_count" BETWEEN 0 AND 10000 AND "expected_record_count" BETWEEN 0 AND 500000),
    CONSTRAINT "device_sync_import_plans_activation_check" CHECK (("status" = 'pending' AND "activated_at" IS NULL AND "activated_generation" IS NULL) OR ("status" = 'activated' AND "activated_at" IS NOT NULL AND "activated_generation" IS NOT NULL))
);

CREATE UNIQUE INDEX "uq_device_sync_import_plans_binding_generation"
    ON "device_sync_import_plans"("binding_id", "generation");
CREATE INDEX "ix_device_sync_import_plans_binding_status"
    ON "device_sync_import_plans"("binding_id", "status", "created_at");

CREATE TABLE "device_sync_import_chunks" (
    "import_id" TEXT NOT NULL,
    "chunk_id" TEXT NOT NULL,
    "chunk_index" INTEGER NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "item_count" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'pending',
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "applied_at" TIMESTAMPTZ(3),

    CONSTRAINT "device_sync_import_chunks_pkey" PRIMARY KEY ("import_id", "chunk_id"),
    CONSTRAINT "device_sync_import_chunks_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "device_sync_import_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_sync_import_chunks_index_key" UNIQUE ("import_id", "chunk_index"),
    CONSTRAINT "device_sync_import_chunks_index_check" CHECK ("chunk_index" BETWEEN 0 AND 9999),
    CONSTRAINT "device_sync_import_chunks_count_check" CHECK ("item_count" BETWEEN 1 AND 50),
    CONSTRAINT "device_sync_import_chunks_status_check" CHECK (("status" = 'pending' AND "response_body" IS NULL AND "applied_at" IS NULL) OR ("status" = 'applied' AND "response_body" IS NOT NULL AND "applied_at" IS NOT NULL))
);

CREATE TABLE "device_sync_binding_action_receipts" (
    "user_id" TEXT NOT NULL,
    "binding_id" TEXT NOT NULL,
    "idempotency_key" VARCHAR(128) NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_sync_binding_action_receipts_pkey" PRIMARY KEY ("user_id", "binding_id", "idempotency_key"),
    CONSTRAINT "device_sync_binding_action_receipts_binding_id_fkey" FOREIGN KEY ("binding_id") REFERENCES "device_sync_bindings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "device_sync_binding_action_receipts_key_check" CHECK (length("idempotency_key") BETWEEN 1 AND 128)
);
