#!/usr/bin/env python3
"""Disposable loopback-only PostgreSQL acceptance; never reads service secrets."""
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
pg_bin = Path('/opt/homebrew/opt/postgresql@18/bin')
for name in ('initdb', 'pg_ctl', 'psql'):
    assert (pg_bin / name).is_file(), f'Missing {name}'
task_env = {k: v for k, v in os.environ.items() if not re.match(
    r'^(?:PG|DATABASE|TEST_|GROWDESK_|AI_|ASR_|TTS_|OPENAI_|OPENROUTER_|PASSPORT_)', k)}
task_env['GOFLAGS'] = '-mod=readonly'
os.umask(0o077)
task_dir = Path(tempfile.mkdtemp(prefix='test_passport_voice_pg_'))
cluster = task_dir / 'data'
socket_dir = task_dir / 'sockets'
socket_dir.mkdir(mode=0o700)
seed = secrets.token_hex(6)
admin = 'test_voice_admin_' + seed
role = database = 'test_voice_' + seed
assert re.fullmatch(r'test_[a-z0-9_]+', role)
password = secrets.token_urlsafe(24)
with socket.socket() as probe:
    probe.bind(('127.0.0.1', 0))
    port = probe.getsockname()[1]
assert port != 5432
started = False
proof = {'loopback_only': True, 'nondefault_port': port,
         'database': database, 'role': role, 'guard_passed': False,
         'tests_exit_code': None, 'fixture_counts_after': None}

def run(argv, log_name, env=None):
    with (evidence / log_name).open('a') as log:
        subprocess.run(argv, cwd=root, env=env or task_env, stdout=log,
                       stderr=subprocess.STDOUT, check=True)

def sql(query, user=role, db=database):
    env = dict(task_env)
    env['PGPASSWORD'] = password
    result = subprocess.run([str(pg_bin/'psql'), '-X', '-v', 'ON_ERROR_STOP=1',
         '-h', '127.0.0.1', '-p', str(port), '-U', user, '-d', db, '-At', '-c', query],
         cwd=root, env=env, capture_output=True, text=True, check=True)
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
    print('PASS owned loopback test_ DB/role guard', flush=True)
    task_db_env = dict(task_env, PGPASSWORD=password)
    migrations = sorted((root/'prisma/migrations').glob('*/migration.sql')) + sorted((root/'native/migrations').glob('*.sql'))
    tracked = set(subprocess.check_output(['git', 'ls-files'], cwd=root, text=True).splitlines())
    assert migrations and all(str(p.relative_to(root)) in tracked for p in migrations)
    for migration in migrations:
        run([str(pg_bin/'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', str(port),
             '-U', role, '-d', database, '-f', str(migration)], 'pg-migrations.log', task_db_env)
    task_test_env = dict(task_env)
    task_test_env.update({'PASSPORT_REQUIRE_INTEGRATION': '1',
       'TEST_PASSPORT_DATABASE_URL': f'postgresql://{role}:{password}@127.0.0.1:{port}/{database}?sslmode=disable'})
    run(['go', 'test', '-race', '-count=1', '-v', './internal/backend',
         '-run', '^TestPassport(ConfirmationRevocationIntegration|ConfirmedRecordsIntegration|FoodCatalogContextIntegration)$'],
         'pg-acceptance.log', task_test_env)
    proof['tests_exit_code'] = 0
    counts = sql("SELECT (SELECT count(*) FROM users)||'|'||(SELECT count(*) FROM families)||'|'||"
                 "(SELECT count(*) FROM babies)||'|'||(SELECT count(*) FROM passport_devices)")
    proof['fixture_counts_after'] = counts
    assert counts == '0|0|0|0', 'Test tenant cleanup did not finish'
    print('PASS isolated Passport records and revocation acceptance; fixtures=0|0|0|0', flush=True)
finally:
    cleanup_ok = True
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
    print(json.dumps({'temporary_cluster_removed': proof['temporary_cluster_removed']}), flush=True)
    if not cleanup_ok:
        raise RuntimeError('Could not stop the owned temporary cluster; retained data directory for recovery')
