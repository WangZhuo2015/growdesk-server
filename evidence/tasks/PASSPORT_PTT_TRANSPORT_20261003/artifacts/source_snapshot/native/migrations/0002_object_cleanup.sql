-- Native-only object cleanup journal. Public reference migrations stay frozen.
CREATE TABLE native_go.object_purges (
    id text PRIMARY KEY,
    family_id text NOT NULL,
    attachment_id text NOT NULL,
    object_key text NOT NULL UNIQUE,
    not_before timestamptz NOT NULL,
    lease_owner text,
    lease_until timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    completed_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX native_object_purges_due ON native_go.object_purges(not_before,id)
    WHERE completed_at IS NULL;
