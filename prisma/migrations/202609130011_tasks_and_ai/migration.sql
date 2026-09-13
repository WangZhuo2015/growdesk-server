-- Migration: 202609130011_tasks_and_ai
-- Implements AI sessions, messages, runs (1:1 with task_executions), run events, and daily summaries.

CREATE TABLE "ai_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "baby_id" TEXT,
    "title" TEXT NOT NULL DEFAULT '新对话',
    "context_type" TEXT NOT NULL DEFAULT 'general',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_sessions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_ai_sessions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_ai_sessions_baby" FOREIGN KEY ("baby_id") REFERENCES "babies"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ix_ai_sessions_user_updated" ON "ai_sessions" ("user_id", "updated_at" DESC);
CREATE INDEX "ix_ai_sessions_baby_updated" ON "ai_sessions" ("baby_id", "updated_at" DESC);

CREATE TABLE "ai_messages" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "image" TEXT,
    "tools_json" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_ai_messages_session" FOREIGN KEY ("session_id") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ix_ai_messages_session_created" ON "ai_messages" ("session_id", "created_at" ASC);

CREATE TABLE "ai_runs" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "baby_id" TEXT,
    "last_event_seq" BIGINT NOT NULL DEFAULT 0,
    "result_summary" TEXT,
    "proposed_plan" JSONB,
    "error_code" TEXT,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_ai_runs_task_execution" FOREIGN KEY ("id") REFERENCES "task_executions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_ai_runs_session" FOREIGN KEY ("session_id") REFERENCES "ai_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_ai_runs_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_ai_runs_baby" FOREIGN KEY ("baby_id") REFERENCES "babies"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ix_ai_runs_session" ON "ai_runs" ("session_id", "created_at" DESC);
CREATE INDEX "ix_ai_runs_user" ON "ai_runs" ("user_id", "created_at" DESC);

CREATE TABLE "ai_run_events" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_run_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_ai_run_events_run" FOREIGN KEY ("run_id") REFERENCES "ai_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_ai_run_events_seq" ON "ai_run_events" ("run_id", "sequence");
CREATE INDEX "ix_ai_run_events_run" ON "ai_run_events" ("run_id", "sequence" ASC);

CREATE TABLE "daily_summaries" (
    "id" TEXT NOT NULL,
    "baby_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "target_date" DATE NOT NULL,
    "content" TEXT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_summaries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fk_daily_summaries_baby" FOREIGN KEY ("baby_id") REFERENCES "babies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "fk_daily_summaries_family" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_daily_summaries_baby_date" ON "daily_summaries" ("baby_id", "target_date");
CREATE INDEX "ix_daily_summaries_family_date" ON "daily_summaries" ("family_id", "target_date" DESC);

-- Update task_outbox constraint to include 'dispatching'
ALTER TABLE "task_outbox" DROP CONSTRAINT IF EXISTS "task_outbox_dispatch_state_check";
ALTER TABLE "task_outbox" ADD CONSTRAINT "task_outbox_dispatch_state_check" CHECK ("dispatch_state" IN ('active', 'dispatching', 'parked', 'closed'));

