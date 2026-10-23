from pathlib import Path
import hashlib
import re


def migration_sql(source: Path, migration_role: str, owner: str, app_role: str) -> str:
    for role in (migration_role, owner, app_role):
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", role):
            raise ValueError("invalid role identifier")
    files = sorted((source / "native/migrations").glob("*.sql"))
    assert [p.name for p in files] == ["0001_oauth.sql", "0002_object_cleanup.sql", "0003_passport.sql", "0004_family_notifications.sql"]
    checks = " AND ".join(
        f"EXISTS(SELECT 1 FROM native_go.migrations WHERE name='{p.name}' AND sha256='{hashlib.sha256(p.read_bytes()).hexdigest()}')"
        for p in files[:3]
    )
    new = files[3]
    digest = hashlib.sha256(new.read_bytes()).hexdigest()
    return f"""BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='45s';
SELECT pg_advisory_xact_lock(9836172001);
DO $preflight$ BEGIN
 IF NOT ({checks}) OR (SELECT count(*) FROM native_go.migrations) <> 3 THEN
  RAISE EXCEPTION 'Unexpected native migration ledger';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{migration_role}') THEN
  RAISE EXCEPTION 'Migration role already exists';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN ('notifications','task_outbox') AND tableowner <> '{owner}') THEN
  RAISE EXCEPTION 'Unexpected existing table owner';
 END IF;
 IF EXISTS(SELECT 1 FROM public.notifications WHERE event_key LIKE 'family_record:%' GROUP BY user_id,event_key HAVING count(*)>1)
 OR EXISTS(SELECT 1 FROM public.task_outbox WHERE type='family_record_notification' OR(type='push_delivery' AND payload->'__native' ?'familyRecord') GROUP BY aggregate_id,phase_key HAVING count(*)>1) THEN
  RAISE EXCEPTION 'Family notification identity collision';
 END IF;
END $preflight$;
CREATE ROLE {migration_role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
GRANT USAGE,CREATE ON SCHEMA public TO {migration_role};
GRANT USAGE ON SCHEMA native_go TO {migration_role};
GRANT SELECT,INSERT ON TABLE native_go.migrations TO {migration_role};
GRANT REFERENCES ON TABLE public.users,public.babies TO {migration_role};
ALTER TABLE public.notifications OWNER TO {migration_role};
ALTER TABLE public.task_outbox OWNER TO {migration_role};
SET LOCAL ROLE {migration_role};
DO $identity$ BEGIN
 IF current_user <> '{migration_role}' OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolcanlogin OR rolcreatedb OR rolcreaterole OR rolbypassrls)) THEN
  RAISE EXCEPTION 'Migration principal is not restricted';
 END IF;
END $identity$;
{new.read_text()}
INSERT INTO native_go.migrations(name,sha256) VALUES('{new.name}','{digest}');
RESET ROLE;
ALTER TABLE public.notifications OWNER TO {owner};
ALTER TABLE public.task_outbox OWNER TO {owner};
ALTER TABLE public.notification_preferences OWNER TO {owner};
GRANT SELECT,INSERT,UPDATE,DELETE ON public.notification_preferences TO {app_role};
REVOKE USAGE,CREATE ON SCHEMA public FROM {migration_role};
REVOKE USAGE ON SCHEMA native_go FROM {migration_role};
REVOKE SELECT,INSERT ON TABLE native_go.migrations FROM {migration_role};
REVOKE REFERENCES ON TABLE public.users,public.babies FROM {migration_role};
DROP ROLE {migration_role};
COMMIT;
"""


if __name__ == "__main__":
    root = Path('/private/tmp/growdesk-push-release-server-20261006')
    Path(__file__).with_name('production-migration.sql').write_text(migration_sql(root, 'growdesk_push_migrator_20261006', 'postgres', 'growdesk'))
