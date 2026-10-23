-- Family record events use their own identity namespace. Existing AI event keys
-- are categories rather than unique events and must not be constrained here.
CREATE UNIQUE INDEX family_record_notification_recipient_event
    ON public.notifications(user_id, event_key)
    WHERE event_key LIKE 'family_record:%';

CREATE UNIQUE INDEX family_record_outbox_task_phase
    ON public.task_outbox(aggregate_id, phase_key)
    WHERE type = 'family_record_notification'
       OR (type = 'push_delivery' AND payload->'__native' ? 'familyRecord');

CREATE TABLE public.notification_preferences (
    id text PRIMARY KEY,
    user_id text NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    baby_id text REFERENCES public.babies(id) ON DELETE CASCADE,
    scope_key text NOT NULL DEFAULT '',
    timezone varchar(100) NOT NULL,
    family_record_enabled boolean NOT NULL DEFAULT true,
    quiet_start smallint,
    quiet_end smallint,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, scope_key),
    CHECK (scope_key = COALESCE(baby_id, '')),
    CHECK ((quiet_start IS NULL AND quiet_end IS NULL)
        OR (quiet_start IS NOT NULL AND quiet_end IS NOT NULL
            AND quiet_start BETWEEN 0 AND 1439 AND quiet_end BETWEEN 0 AND 1439
            AND quiet_start <> quiet_end))
);
