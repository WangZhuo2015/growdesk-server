-- Durable, privacy-bounded accounting for native AI provider attempts and
-- authenticated Go MCP calls. No request content, credentials, or client IPs
-- are retained in these ledgers.
CREATE TABLE native_go.ai_provider_attempts (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    run_id text NOT NULL REFERENCES public.task_executions(id) ON DELETE CASCADE,
    family_id text REFERENCES public.families(id) ON DELETE CASCADE,
    baby_id text REFERENCES public.babies(id) ON DELETE SET NULL,
    attempt integer NOT NULL CHECK (attempt > 0),
    phase text NOT NULL CHECK (phase IN ('model','asr')),
    provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 80),
    model text CHECK (model IS NULL OR length(model) <= 160),
    status text NOT NULL CHECK (status IN ('dispatched','reported','unknown','failed')),
    usage_state text NOT NULL CHECK (usage_state IN ('unknown','partial','reported')),
    input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
    total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
    cost_micros bigint CHECK (cost_micros IS NULL OR cost_micros >= 0),
    cost_state text NOT NULL CHECK (cost_state IN ('unpriced','unknown','reported')),
    error_code text CHECK (error_code IS NULL OR length(error_code) <= 80),
    dispatched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz,
    UNIQUE (run_id,attempt,phase)
);
CREATE INDEX ai_provider_attempts_owner_time ON native_go.ai_provider_attempts(user_id,dispatched_at DESC);
CREATE INDEX ai_provider_attempts_baby_time ON native_go.ai_provider_attempts(user_id,baby_id,dispatched_at DESC);

-- Budget limits are operator-configured execution-attempt counts, never USD or
-- token units. A reservation is one native AI run attempt in a UTC day window.
CREATE TABLE native_go.ai_budget_windows (
    scope_type text NOT NULL CHECK (scope_type IN ('user','family','global')),
    scope_id text NOT NULL,
    period_start date NOT NULL,
    unit text NOT NULL CHECK (unit = 'ai_run_attempt'),
    limit_value bigint NOT NULL CHECK (limit_value > 0),
    reserved_units bigint NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
    settled_units bigint NOT NULL DEFAULT 0 CHECK (settled_units >= 0),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (scope_type,scope_id,period_start,unit)
);
CREATE TABLE native_go.ai_budget_reservations (
    id text PRIMARY KEY,
    run_id text NOT NULL REFERENCES public.task_executions(id) ON DELETE CASCADE,
    user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    family_id text REFERENCES public.families(id) ON DELETE CASCADE,
    attempt integer NOT NULL CHECK (attempt > 0),
    period_start date NOT NULL,
    unit text NOT NULL CHECK (unit = 'ai_run_attempt'),
    status text NOT NULL CHECK (status IN ('reserved','settled','released')),
    reserved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    settled_at timestamptz,
    UNIQUE (run_id,attempt)
);
CREATE INDEX ai_budget_reservations_owner ON native_go.ai_budget_reservations(user_id,period_start,status);

CREATE TABLE native_go.mcp_usage_calls (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    grant_id text NOT NULL REFERENCES native_go.oauth_grants(id) ON DELETE CASCADE,
    family_id text REFERENCES public.families(id) ON DELETE CASCADE,
    baby_id text REFERENCES public.babies(id) ON DELETE SET NULL,
    method text NOT NULL CHECK (length(method) <= 120),
    tool_name text CHECK (tool_name IS NULL OR length(tool_name) <= 160),
    category text NOT NULL CHECK (category IN ('read','write','manage')),
    outcome text NOT NULL CHECK (outcome IN ('pending','success','denied','failed')),
    error_code text CHECK (error_code IS NULL OR length(error_code) <= 80),
    records_created integer CHECK (records_created IS NULL OR records_created >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    duration_ms bigint CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
CREATE INDEX mcp_usage_calls_owner_time ON native_go.mcp_usage_calls(user_id,created_at DESC);
CREATE INDEX mcp_usage_calls_baby_time ON native_go.mcp_usage_calls(user_id,baby_id,created_at DESC);
