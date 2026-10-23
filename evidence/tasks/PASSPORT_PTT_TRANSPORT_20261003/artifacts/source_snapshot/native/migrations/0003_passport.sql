-- Native migration: Passport Devices and Pairings
-- Supports FoloToy AI Passport cloud companion integration.

CREATE TABLE IF NOT EXISTS public.passport_devices (
    id text PRIMARY KEY,
    owner_user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    family_id text NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
    baby_id text NOT NULL REFERENCES public.babies(id) ON DELETE CASCADE,
    device_label text NOT NULL,
    credential_hash text NOT NULL,
    firmware_version text,
    hardware_version text,
    capabilities jsonb,
    last_seen_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS passport_devices_owner ON public.passport_devices(owner_user_id, revoked_at);
CREATE INDEX IF NOT EXISTS passport_devices_baby ON public.passport_devices(baby_id, revoked_at);
CREATE INDEX IF NOT EXISTS passport_devices_cred ON public.passport_devices(credential_hash);

CREATE TABLE IF NOT EXISTS public.passport_pairings (
    id text PRIMARY KEY,
    pair_code_hash text NOT NULL UNIQUE,
    poll_token_hash text NOT NULL UNIQUE,
    device_info jsonb NOT NULL,
    device_label text,
    owner_user_id text REFERENCES public.users(id) ON DELETE CASCADE,
    family_id text REFERENCES public.families(id) ON DELETE CASCADE,
    baby_id text REFERENCES public.babies(id) ON DELETE CASCADE,
    credential_hash text,
    expires_at timestamptz NOT NULL,
    claimed_at timestamptz,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS passport_pairings_expiry ON public.passport_pairings(expires_at);
CREATE INDEX IF NOT EXISTS passport_pairings_code ON public.passport_pairings(pair_code_hash);
CREATE INDEX IF NOT EXISTS passport_pairings_poll ON public.passport_pairings(poll_token_hash);
