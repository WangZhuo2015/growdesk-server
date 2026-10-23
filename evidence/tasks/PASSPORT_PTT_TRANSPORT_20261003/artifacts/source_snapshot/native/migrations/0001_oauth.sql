-- Native-only authorization state. The frozen Prisma schema and SQL migration
-- history remain immutable; apply this migration explicitly before enabling
-- native OAuth. API/worker startup never creates or alters tables.
CREATE SCHEMA IF NOT EXISTS native_go;
CREATE TABLE native_go.oauth_grants (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    session_id text NOT NULL REFERENCES public.device_sessions(id) ON DELETE CASCADE,
    client_id text NOT NULL,
    family_id text NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    baby_id text NOT NULL REFERENCES public.babies(id) ON DELETE CASCADE,
    audience text NOT NULL,
    scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE INDEX oauth_grants_user ON native_go.oauth_grants(user_id,revoked_at);
CREATE TABLE native_go.oauth_codes (
    code_hash char(64) PRIMARY KEY,
    grant_id text NOT NULL REFERENCES native_go.oauth_grants(id) ON DELETE CASCADE,
    client_id text NOT NULL,
    redirect_uri text NOT NULL,
    challenge text NOT NULL CHECK (length(challenge)=43),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz
);
CREATE INDEX oauth_codes_expiry ON native_go.oauth_codes(expires_at);
CREATE TABLE native_go.oauth_refresh (
    token_hash char(64) PRIMARY KEY,
    grant_id text NOT NULL REFERENCES native_go.oauth_grants(id) ON DELETE CASCADE,
    scopes text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at timestamptz,
    revoked_at timestamptz,
    replacement_hash char(64)
);
CREATE INDEX oauth_refresh_grant ON native_go.oauth_refresh(grant_id,revoked_at);
CREATE INDEX oauth_refresh_expiry ON native_go.oauth_refresh(expires_at);
CREATE TABLE native_go.oauth_requests (
    id text PRIMARY KEY,
    browser_secret_hash char(64) NOT NULL,
    request_json jsonb NOT NULL,
    user_id text REFERENCES public.users(id) ON DELETE CASCADE,
    password_fingerprint char(64),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX oauth_requests_expiry ON native_go.oauth_requests(expires_at);
