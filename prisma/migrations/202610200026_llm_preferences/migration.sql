CREATE TABLE "llm_preferences" (
    "user_id" TEXT NOT NULL,
    "feature" VARCHAR(32) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "profile_id" VARCHAR(100) NOT NULL,
    "model_id" VARCHAR(200) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_preferences_pkey" PRIMARY KEY ("user_id", "feature"),
    CONSTRAINT "llm_preferences_user_id_fkey" FOREIGN KEY ("user_id")
        REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "llm_preferences_feature_check" CHECK ("feature" IN (
        'chat', 'daily_summary', 'tips', 'record_parse', 'nutrition_parse',
        'search', 'growth_ocr', 'medical_ocr', 'voice'
    )),
    CONSTRAINT "llm_preferences_source_check" CHECK ("source" IN ('api', 'chatgpt'))
);
