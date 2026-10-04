-- Extend the existing native_go OAuth authority without mutating checksummed
-- migrations or creating a second public-schema credential store.
CREATE TABLE native_go.oauth_clients (
    client_id text PRIMARY KEY,
    client_name varchar(200) NOT NULL,
    redirect_uris text[] NOT NULL,
    scopes text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    CONSTRAINT oauth_clients_redirect_uris_count CHECK (cardinality(redirect_uris) BETWEEN 1 AND 10),
    CONSTRAINT oauth_clients_scopes CHECK (scopes <@ ARRAY['baby:read','baby:write']::text[])
);

-- NOT VALID keeps historical rows readable if an installation used the
-- original tables before client persistence existed; every new grant is still
-- checked against a registered client.
ALTER TABLE native_go.oauth_grants
    ADD COLUMN last_used_at timestamptz,
    ADD CONSTRAINT oauth_grants_client_fkey
        FOREIGN KEY (client_id) REFERENCES native_go.oauth_clients(client_id)
        ON DELETE RESTRICT NOT VALID;

CREATE INDEX oauth_grants_session ON native_go.oauth_grants(session_id, revoked_at);
CREATE INDEX oauth_grants_baby ON native_go.oauth_grants(family_id, baby_id, revoked_at);

CREATE TABLE native_go.oauth_access (
    token_hash char(64) PRIMARY KEY,
    grant_id text NOT NULL REFERENCES native_go.oauth_grants(id) ON DELETE CASCADE,
    scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 4),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_used_at timestamptz
);
CREATE INDEX oauth_access_grant ON native_go.oauth_access(grant_id, revoked_at);
CREATE INDEX oauth_access_expiry ON native_go.oauth_access(expires_at);

CREATE INDEX oauth_requests_expiry_id ON native_go.oauth_requests(expires_at, id);
ALTER TABLE native_go.oauth_requests ADD COLUMN consumed_at timestamptz;
