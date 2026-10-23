from pathlib import Path
import importlib.util
import hashlib
import json
import secrets
import sys
from migration_sql import migration_sql

source = Path('/private/tmp/growdesk-push-release-server-20261006')
helper = Path('/Users/wangzhuo/Documents/GitHub/growdesk-ios/scripts/test-cloud-parity.py')
spec = importlib.util.spec_from_file_location('owned_migration_probe', helper)
runtime = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = runtime
spec.loader.exec_module(runtime)
runtime.SERVER_ROOT = source
runtime.EVIDENCE_ROOT = source / 'evidence/tasks/WEB_PUSH_RELEASE_20261006/migration'
runner = runtime.OwnedRun(secrets.token_hex(6))
report = {'passed': False, 'productionConnections': 0, 'testRecordsCreated': 0}
try:
    runner.init_postgres()
    runner.psql('CREATE SCHEMA native_go; CREATE TABLE native_go.migrations(name text PRIMARY KEY,sha256 char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());')
    for p in sorted((source/'native/migrations').glob('*.sql'))[:3]:
        runner.psql(p.read_text()+f"\nINSERT INTO native_go.migrations(name,sha256) VALUES('{p.name}','{hashlib.sha256(p.read_bytes()).hexdigest()}');")
    runner.psql(f'GRANT SELECT,INSERT,UPDATE,DELETE ON public.notifications,public.task_outbox TO {runner.app_role}; ALTER TABLE public.notifications OWNER TO {runner.admin_role}; ALTER TABLE public.task_outbox OWNER TO {runner.admin_role};',admin=True)
    role = 'test_push_migrator_'+runner.run_id
    sql = migration_sql(source, role, runner.admin_role, runner.app_role)
    failure_sql = sql.replace('COMMIT;', "DO $rollback$ BEGIN RAISE EXCEPTION 'test_owned_forced_rollback'; END $rollback$; COMMIT;")
    failed = False
    try:
        runner.psql(failure_sql,admin=True)
    except Exception:
        failed = True
    assert failed, 'rollback fixture did not fail'
    rolled = runner.psql(f"SELECT (SELECT count(*) FROM native_go.migrations)=3 AND to_regclass('public.notification_preferences') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{role}') AND (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('notifications','task_outbox') AND tableowner='{runner.admin_role}')=2;",admin=True)
    assert rolled == 't', 'migration transaction did not fully rollback'
    runner.psql(sql,admin=True)
    state = json.loads(runner.psql(f"SELECT json_build_object('ledgerCount',(SELECT count(*) FROM native_go.migrations),'checksum',(SELECT sha256 FROM native_go.migrations WHERE name='0004_family_notifications.sql'),'temporaryRoleGone',NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='{role}'),'ownersRestored',(SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN('notifications','task_outbox','notification_preferences') AND tableowner='{runner.admin_role}')=3,'appStillNonSuper',NOT(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname='{runner.app_role}'),'appCrud',has_table_privilege('{runner.app_role}','public.notification_preferences','SELECT,INSERT,UPDATE,DELETE'),'validIndexes',(SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN('family_record_notification_recipient_event','family_record_outbox_task_phase') AND i.indisvalid)=2);",admin=True))
    assert state['ledgerCount']==4 and all(state[k] for k in ('temporaryRoleGone','ownersRestored','appStillNonSuper','appCrud','validIndexes'))
    assert state['checksum']==hashlib.sha256((source/'native/migrations/0004_family_notifications.sql').read_bytes()).hexdigest()
    assert runner.psql('SELECT count(*) FROM public.notification_preferences;') == '0'
    report.update({'passed':True,'controlledRoleExecution':True,'failureRolledBackAllDdlAndRoleChanges':True,'state':state})
finally:
    report['cleanup'] = runner.cleanup()
    target = source/'evidence/tasks/WEB_PUSH_RELEASE_20261006/migration-preflight.json'
    target.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report))
if not report['passed']:sys.exit(1)
