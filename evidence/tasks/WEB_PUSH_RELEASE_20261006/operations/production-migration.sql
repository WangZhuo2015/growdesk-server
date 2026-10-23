BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='45s';
SELECT pg_advisory_xact_lock(9836172001);
DO $preflight$ BEGIN
 IF NOT (EXISTS(SELECT 1 FROM native_go.migrations WHERE name='0001_oauth.sql' AND sha256='bde35d470380232f00de11ec794c01d586a17c1782b24176c154dcc824986481') AND EXISTS(SELECT 1 FROM native_go.migrations WHERE name='0002_object_cleanup.sql' AND sha256='ab219547e33f576baecb31652e89f02006efdc977f7d423447817a1ae51aa19a') AND EXISTS(SELECT 1 FROM native_go.migrations WHERE name='0003_passport.sql' AND sha256='6f4b5d04a9c9b4cfcb2cb3a28ec2c3b9bb3648f8acd1785c895443f532c3a8ab')) OR (SELECT count(*) FROM native_go.migrations) <> 3 THEN
  RAISE EXCEPTION 'Unexpected native migration ledger';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='growdesk_push_migrator_20261006') THEN
  RAISE EXCEPTION 'Migration role already exists';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN ('notifications','task_outbox') AND tableowner <> 'postgres') THEN
  RAISE EXCEPTION 'Unexpected existing table owner';
 END IF;
 IF EXISTS(SELECT 1 FROM public.notifications WHERE event_key LIKE 'family_record:%' GROUP BY user_id,event_key HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM public.task_outbox WHERE type='family_record_notification' OR(type='push_delivery' AND payload->'__native' ?'familyRecord') GROUP BY aggregate_id,phase_key HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Family notification identity collision';
 END IF;
END $preflight$;
CREATE ROLE growdesk_push_migrator_20261006 NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT USAGE,CREATE ON SCHEMA public TO growdesk_push_migrator_20261006;
GRANT USAGE ON SCHEMA native_go TO growdesk_push_migrator_20261006;
GRANT SELECT,INSERT ON TABLE native_go.migrations TO growdesk_push_migrator_20261006;
GRANT REFERENCES ON TABLE public.users,public.babies TO growdesk_push_migrator_20261006;
ALTER TABLE public.notifications OWNER TO growdesk_push_migrator_20261006;
ALTER TABLE public.task_outbox OWNER TO growdesk_push_migrator_20261006;
SET LOCAL ROLE growdesk_push_migrator_20261006;
DO $identity$ BEGIN
 IF current_user <> 'growdesk_push_migrator_20261006' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Migration principal is not restricted';
 END IF;
END $identity$;
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

INSERT INTO native_go.migrations(name,sha256) VALUES('0004_family_notifications.sql','1dcb0e81c4f4b0a44595b30129990325e69a82c79efc215f6ab4a19f742c4a88');
RESET ROLE;
ALTER TABLE public.notifications OWNER TO postgres;
ALTER TABLE public.task_outbox OWNER TO postgres;
ALTER TABLE public.notification_preferences OWNER TO postgres;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.notification_preferences TO growdesk;
REVOKE USAGE,CREATE ON SCHEMA public FROM growdesk_push_migrator_20261006;
REVOKE USAGE ON SCHEMA native_go FROM growdesk_push_migrator_20261006;
REVOKE SELECT,INSERT ON TABLE native_go.migrations FROM growdesk_push_migrator_20261006;
REVOKE REFERENCES ON TABLE public.users,public.babies FROM growdesk_push_migrator_20261006;
DROP ROLE growdesk_push_migrator_20261006;
COMMIT;
