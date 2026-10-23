#!/usr/bin/env python3
"""Run the Passport record-query diagnostic on a disposable owned PG cluster."""
from pathlib import Path
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import tempfile

root = Path(__file__).resolve().parents[3]
evidence = Path(__file__).resolve().parent
test_source = evidence / "query_test.go.txt"
assert test_source.is_file(), "missing query_test.go.txt"
integration_source = root / "internal/backend/passport_voice_query_integration_test.go"
assert integration_source.is_file(), "missing persistent Passport voice query integration test"
pg_bin = Path('/opt/homebrew/opt/postgresql@18/bin')
for name in ('initdb', 'pg_ctl', 'psql'):
    assert (pg_bin / name).is_file(), f'Missing {name}'

# Never inherit application, database, cloud, or provider credentials into the
# test/migration process. The fake ASR/chat/TTS endpoints run on loopback only.
task_env = {k: v for k, v in os.environ.items() if not re.match(
    r'^(?:PG|DATABASE|TEST_|GROWDESK_|AI_|ASR_|TTS_|OPENAI_|OPENROUTER_|PASSPORT_)', k)}
task_env['GOFLAGS'] = '-mod=readonly'
os.umask(0o077)
task_dir = Path(tempfile.mkdtemp(prefix='test_passport_query_pg_'))
cluster = task_dir / 'data'
socket_dir = task_dir / 'sockets'
socket_dir.mkdir(mode=0o700)
seed = secrets.token_hex(6)
admin = 'test_query_admin_' + seed
role = database = 'test_passport_query_' + seed
assert re.fullmatch(r'test_[a-z0-9_]+', role)
password = secrets.token_urlsafe(24)
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
assert port != 5432

started = False
test_exit = None
cleanup_ok = True
proof = {
    'loopback_only': True,
    'nondefault_port': port,
    'database': database,
    'role': role,
    'guard_passed': False,
    'test_exit_code': None,
    'test_suite': 'persistent Passport voice-record PostgreSQL integration suite',
    'test_exit_expected': 0,
    'tenant_counts_after_test': None,
    'temporary_cluster_removed': False,
}

for log_name in ('pg-setup.log', 'pg-migrations.log', 'pg-acceptance.log'):
    (evidence / log_name).write_text('')

def run(argv, log_name, env=None, check=True):
    with (evidence / log_name).open('a') as log:
        result = subprocess.run(argv, cwd=root, env=env or task_env,
                                stdout=log, stderr=subprocess.STDOUT)
    if check and result.returncode != 0:
        raise subprocess.CalledProcessError(result.returncode, argv)
    return result

def sql(query, user=role, db=database):
    env = dict(task_env)
    env['PGPASSWORD'] = password
    result = subprocess.run([
        str(pg_bin/'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1',
        '-p', str(port), '-U', user, '-d', db, '-At', '-c', query,
    ], cwd=root, env=env, capture_output=True, text=True, check=True)
    return result.stdout.strip()

try:
    run([str(pg_bin/'initdb'), '-D', str(cluster), '-U', admin, '-A', 'trust', '--no-locale'], 'pg-setup.log')
    run([str(pg_bin/'pg_ctl'), '-D', str(cluster), '-l', str(task_dir/'postgres.log'),
         '-o', f'-h 127.0.0.1 -p {port} -k {socket_dir} -c max_connections=25 -c shared_buffers=32MB',
         '-w', '-t', '20', 'start'], 'pg-setup.log')
    started = True
    sql(f"CREATE ROLE {role} LOGIN NOSUPERUSER PASSWORD '{password}'", admin, 'postgres')
    sql(f'CREATE DATABASE {database} OWNER {role}', admin, 'postgres')
    observed = sql("SELECT current_database()||'|'||current_user||'|'||rolsuper::text||'|'||pg_get_userbyid(datdba) "
                   "FROM pg_database JOIN pg_roles ON rolname=current_user WHERE datname=current_database()")
    assert observed == f'{database}|{role}|false|{role}', 'Refusing unowned/superuser database'
    proof['guard_passed'] = True

    task_db_env = dict(task_env, PGPASSWORD=password)
    migrations = sorted((root/'prisma/migrations').glob('*/migration.sql')) + sorted((root/'native/migrations').glob('*.sql'))
    tracked = set(subprocess.check_output(['git', 'ls-files'], cwd=root, text=True).splitlines())
    assert migrations and all(str(p.relative_to(root)) in tracked for p in migrations), 'Refusing untracked migration input'
    for migration in migrations:
        run([str(pg_bin/'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', str(port),
             '-U', role, '-d', database, '-f', str(migration)], 'pg-migrations.log', task_db_env)

    test_env = dict(task_env)
    test_env.update({
        'PASSPORT_REQUIRE_INTEGRATION': '1',
        'TEST_PASSPORT_DATABASE_URL': f'postgresql://{role}:{password}@127.0.0.1:{port}/{database}?sslmode=disable',
    })
    result = run([
        'go', 'test', '-race', '-count=1', '-v',
        './internal/backend', '-run', '^(TestPassportVoiceRecordQueryContextDiagnostic|TestPassportVoiceRecordContextAllKindsIntegration|TestPassportVoiceRecordContextLocalWindowAndTruncationIntegration|TestPassportVoiceQueryRejectsProviderWriteActionIntegration|TestPassportVoiceNonDataOperationOmitsRecordContextIntegration|TestPassportVoiceWriteTurnUsesFamilyTimeZoneWithoutRecordContextIntegration)$',
    ], 'pg-acceptance.log', test_env, check=False)
    test_exit = result.returncode
    proof['test_exit_code'] = test_exit

    counts = sql("SELECT (SELECT count(*) FROM users)||'|'||(SELECT count(*) FROM families)||'|'||"
                 "(SELECT count(*) FROM babies)||'|'||(SELECT count(*) FROM passport_devices)")
    proof['tenant_counts_after_test'] = counts
    assert counts == '0|0|0|0', 'The isolated test tenant was not fully removed'
finally:
    if started or (cluster/'postmaster.pid').exists():
        try:
            run([str(pg_bin/'pg_ctl'), '-D', str(cluster), '-m', 'immediate', '-w', 'stop'], 'pg-setup.log')
        except subprocess.CalledProcessError:
            cleanup_ok = False
    if cleanup_ok:
        shutil.rmtree(task_dir)
    proof['temporary_cluster_removed'] = not task_dir.exists()
    if not cleanup_ok:
        proof['retained_temporary_directory'] = str(task_dir)
    (evidence/'pg-acceptance.json').write_text(json.dumps(proof, indent=2)+'\n')
    print((evidence/'pg-acceptance.log').read_text() if (evidence/'pg-acceptance.log').exists() else '')
    print(json.dumps({'temporary_cluster_removed': proof['temporary_cluster_removed'],
                      'guard_passed': proof['guard_passed'],
                      'test_exit_code': proof['test_exit_code'],
                      'tenant_counts_after_test': proof['tenant_counts_after_test']}))
    if not cleanup_ok:
        raise RuntimeError('Could not stop the disposable test PostgreSQL cluster; recovery data was retained')

if test_exit is None:
    raise RuntimeError('The isolated Passport query test did not run')
raise SystemExit(test_exit)
