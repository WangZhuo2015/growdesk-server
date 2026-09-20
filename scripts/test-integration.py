"""Run workspace integration tests against exclusively owned PostgreSQL and Redis children."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

HERE = Path(__file__).resolve().parent.parent


def executable(name, variable, fallback):
    folder = os.environ.get(variable)
    value = str(Path(folder) / name) if folder else shutil.which(name) or str(Path(fallback) / name)
    if not Path(value).is_file():
        raise RuntimeError(f'Missing binary: {name}; run backend:doctor')
    return value


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def command(args, timeout=90, **kwargs):
    # Never echo commands: role setup includes an ephemeral credential.
    return subprocess.run(args, check=True, timeout=timeout, cwd=HERE, **kwargs)


def validate_web_root(value):
    root = Path(value).expanduser()
    if not root.is_absolute():
        raise RuntimeError('--web-root must be an absolute path')
    root = root.resolve()
    if not root.is_dir():
        raise RuntimeError('--web-root must point to an existing Web repository')
    if not (root / '.next' / 'standalone' / 'server.js').is_file():
        raise RuntimeError('--web-root is missing .next/standalone/server.js; build the Web first')
    return root


def main(web_root=None, web_ui=False, legacy_web_root=None, legacy_care=False, s3=False):
    if (web_ui or legacy_web_root is not None) and web_root is None:
        raise RuntimeError('--web-ui/--legacy-web-root require --web-root')
    pgdir = '/opt/homebrew/opt/postgresql@18/bin'
    redisdir = '/opt/homebrew/opt/redis/bin'
    bins = {n: executable(n, 'PG_BIN', pgdir) for n in ['initdb', 'postgres', 'pg_isready', 'psql', 'createdb']}
    redis = executable('redis-server', 'REDIS_BIN', redisdir)
    minio = executable('minio', 'MINIO_BIN', '/opt/homebrew/bin') if s3 else None
    if ' 18.' not in subprocess.check_output([bins['postgres'], '--version'], text=True):
        raise RuntimeError('Requires PostgreSQL 18')
    if 'v=8.' not in subprocess.check_output([redis, '--version'], text=True):
        raise RuntimeError('Requires Redis 8')
    # Scrub inherited database connection options from the managed subprocess environment.
    env = {k:v for k,v in os.environ.items() if not k.startswith(('PG', 'S3_', 'AWS_', 'MINIO_')) and k not in
           ['DATABASE_URL', 'TEST_DATABASE_URL', 'BOOT02_RUN_FILE', 'REDIS_URL']}
    children = []
    # The API imports workspace packages through their package.json `main`
    # fields. Build those packages from source before starting any isolated
    # database resources so an integration run cannot silently exercise stale
    # ignored dist/ artifacts (for example an old response schema).
    command(['npm', 'run', 'backend:build'], env=env, timeout=360)
    with tempfile.TemporaryDirectory(prefix='growdesk-integration-') as temp:
        root = Path(temp).resolve()
        pgport, redisport = free_port(), free_port()
        while pgport == redisport:
            redisport = free_port()
        identity = dict(directory=str(root), pgPort=pgport, redisPort=redisport,
                        token=secrets.token_hex(16), database='test_growdesk_integration',
                        user='test_runner', password=secrets.token_hex(24))
        manifest = root / 'environment.json'
        manifest.write_text(json.dumps(identity)); manifest.chmod(0o600)
        env['BOOT02_RUN_FILE'] = str(manifest)
        logs = []
        try:
            command([bins['initdb'], '-D', str(root/'pg'), '-E', 'UTF-8', '--locale=C', '-A', 'trust'], env=env,
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Tests authenticate as a dedicated non-superuser; bootstrap uses private Unix socket.
            (root/'pg/pg_hba.conf').write_text('local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\n')
            pglog = open(root/'pg.log', 'w'); logs.append(pglog)
            postgres = subprocess.Popen([bins['postgres'], '-D', str(root/'pg'), '-p', str(pgport),
                '-h', '127.0.0.1', '-k', str(root), '-c', 'cluster_name='+identity['token']], env=env,
                stdout=pglog, stderr=subprocess.STDOUT)
            children.append(postgres)
            for _ in range(100):
                if postgres.poll() is not None:
                    raise RuntimeError('Owned PostgreSQL failed to start; no existing instance will be adopted')
                ready = subprocess.run([bins['pg_isready'], '-h', str(root), '-p', str(pgport)], env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if ready.returncode == 0: break
                time.sleep(.1)
            else: raise RuntimeError('PostgreSQL readiness timed out')
            command([bins['psql'], '-h', str(root), '-p', str(pgport), '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
                input=f"CREATE ROLE test_runner LOGIN NOSUPERUSER PASSWORD '{identity['password']}';",
                text=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            command([bins['createdb'], '-h', str(root), '-p', str(pgport), '-O', identity['user'], identity['database']], env=env)
            redislog = open(root/'redis.log', 'w'); logs.append(redislog)
            redisproc = subprocess.Popen([redis, '--bind', '127.0.0.1', '--port', str(redisport), '--dir', str(root),
                '--save', '', '--appendonly', 'no', '--requirepass', identity['password']], env=env,
                stdout=redislog, stderr=subprocess.STDOUT)
            children.append(redisproc)
            for _ in range(100):
                if redisproc.poll() is not None: raise RuntimeError('Owned Redis failed to start')
                try:
                    with socket.create_connection(('127.0.0.1', redisport), timeout=.1): break
                except OSError: time.sleep(.1)
            else: raise RuntimeError('Redis readiness timed out')
            if minio:
                s3port = free_port()
                while s3port in (pgport, redisport):
                    s3port = free_port()
                consoleport = free_port()
                while consoleport in (pgport, redisport, s3port):
                    consoleport = free_port()
                s3identity = dict(endpoint=f'http://127.0.0.1:{s3port}',
                                  bucket='test-s3-'+identity['token'], region='us-east-1',
                                  accessKeyId='test_'+secrets.token_hex(12),
                                  secretAccessKey=secrets.token_hex(24))
                s3env = dict(env, MINIO_ROOT_USER=s3identity['accessKeyId'],
                             MINIO_ROOT_PASSWORD=s3identity['secretAccessKey'],
                             MINIO_BROWSER='off', MINIO_UPDATE='off')
                s3log = open(root/'minio.log', 'w'); logs.append(s3log)
                minioproc = subprocess.Popen([minio, 'server', str(root/'objects'),
                    '--address', f'127.0.0.1:{s3port}',
                    '--console-address', f'127.0.0.1:{consoleport}'],
                    env=s3env, stdout=s3log, stderr=subprocess.STDOUT)
                children.append(minioproc)
                s3identity['pid'] = minioproc.pid
                identity['s3'] = s3identity
                manifest.write_text(json.dumps(identity))
                for _ in range(100):
                    if minioproc.poll() is not None:
                        raise RuntimeError('Owned MinIO failed; no existing object store will be adopted')
                    try:
                        # Ignore inherited proxy settings even for loopback health checks.
                        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                        with opener.open(s3identity['endpoint']+'/minio/health/ready', timeout=.2) as response:
                            if response.status == 200: break
                    except (OSError, urllib.error.URLError):
                        pass
                    time.sleep(.1)
                else: raise RuntimeError('Owned MinIO readiness timed out')
            # Prove instance ownership before any migration or concurrent business suite.
            command(['node', '--import', 'tsx', '--test', 'tests/integration/infrastructure.test.ts'], env=env)
            # Apply the complete production migration sequence to this freshly
            # owned database before business suites run. Fail on the first SQL
            # error; per-suite legacy CREATE TABLE probes are not migration proof.
            migration_env = dict(env, PGPASSWORD=identity['password'])
            for migration in sorted(Path('prisma/migrations').glob('*/migration.sql')):
                command([bins['psql'], '-X', '-h', '127.0.0.1', '-p', str(pgport),
                         '-U', identity['user'], '-d', identity['database'],
                         '-v', 'ON_ERROR_STOP=1', '-f', str(migration)],
                        env=migration_env, stdout=subprocess.DEVNULL)
            command(['python3', 'scripts/legacy-import/test_import_integration.py'], env=env)
            if legacy_care:
                # Opt-in only: this suite uses the same owned manifest and
                # creates/cleans a unique test_ tenant inside the running DB.
                command(['python3', 'scripts/legacy-import/test_care_materializer_integration.py'], env=env)
                command(['python3', 'scripts/legacy-import/test_food_materializer_integration.py'], env=env)
                command(['python3', 'scripts/legacy-import/test_medical_materializer_integration.py'], env=env)
                command(['node', '--import', 'tsx', '--test',
                         'tests/integration/legacy-attachment-reference-backfill.test.ts'], env=env)
            command(['node', '--import', 'tsx', '--test', 'tests/integration/foundation-migration.test.ts', 'tests/integration/unit-of-work.test.ts', 'tests/integration/auth.test.ts', 'tests/integration/auth-refresh.test.ts', 'tests/integration/family-baby.test.ts', 'tests/integration/auth-recovery.test.ts', 'tests/integration/feeding.test.ts', 'tests/integration/diaper.test.ts', 'tests/integration/sleep.test.ts', 'tests/integration/food.test.ts', 'tests/integration/supplement.test.ts', 'tests/integration/growth.test.ts', 'tests/integration/timeline.test.ts', 'tests/integration/bff-session.test.ts', 'tests/integration/attachments.test.ts', 'tests/integration/growth-attachments.test.ts', 'tests/integration/replay-permission-and-legacy.test.ts', 'tests/integration/medical-vaccines.test.ts', 'tests/integration/tasks.test.ts', 'tests/integration/ai-runs.test.ts', 'tests/integration/sync.test.ts', 'tests/integration/notifications.test.ts'], env=env)
            command(['node', '--import', 'tsx', '--test', 'tests/integration/web-feeding-regression.test.ts', 'tests/integration/care-isolation-regression.test.ts'], env=env)
            # Run the durable Web conversation regression after schema setup,
            # in the same exclusively owned database. Failures remain fatal.
            command(['node', '--import', 'tsx', '--test', 'tests/integration/web-ai-session-regression.test.ts'], env=env)
            if s3:
                command(['node', '--import', 'tsx', '--test', 'tests/integration/owned-object-storage.test.ts',
                         'tests/integration/legacy-attachment-promotion.test.ts'], env=env)
            if web_root is not None:
                # This suite starts both listeners itself. Keep the existing
                # process-injection suites as the default and give the real
                # Next standalone process a longer startup/request budget.
                env['GROWDESK_WEB_ROOT'] = str(web_root)
                if web_ui:
                    env['GROWDESK_WEB_UI'] = '1'
                if legacy_web_root is not None:
                    env['GROWDESK_LEGACY_WEB_ROOT'] = str(legacy_web_root)
                command(['node', '--import', 'tsx', '--test', 'tests/integration/web-http-parity.test.ts'],
                        env=env, timeout=360)
            print('Owned PostgreSQL/Redis integration checks passed; test process exited successfully.', flush=True)
        finally:
            # Popen handles identify only children started here, never PID files from other runs.
            for child in reversed(children):
                if child.poll() is None:
                    child.terminate()
                    try: child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill(); child.wait(timeout=5)
            for log in logs: log.close()
    print('Owned test processes stopped and private data directory removed.', flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--suite', choices=['infrastructure'], default='infrastructure')
    parser.add_argument('--web-root', type=Path,
                        help='absolute old Web repository containing .next/standalone/server.js')
    parser.add_argument('--web-ui', action='store_true',
                        help='run the fixed old Web scripts/review/ui-parity-acceptance.mjs hook while the stack is alive')
    parser.add_argument('--legacy-web-root', type=Path,
                        help='absolute built legacy Web root for the optional same-seed golden fixture')
    parser.add_argument('--legacy-care', action='store_true',
                        help='run the opt-in legacy identity-v1 care materializer checks in the owned PG')
    parser.add_argument('--s3', action='store_true',
                        help='start an owned loopback MinIO child and run real object-storage HTTP checks; MINIO_BIN selects its binary directory')
    args = parser.parse_args()  # Reject unknown suites before creating any resources.
    web_root = validate_web_root(args.web_root) if args.web_root is not None else None
    legacy_web_root = validate_web_root(args.legacy_web_root) if args.legacy_web_root is not None else None
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main(web_root, args.web_ui, legacy_web_root, args.legacy_care, args.s3)
    except (Exception, KeyboardInterrupt) as error:
        # Driver/subprocess exceptions may contain credentials; log only a class name.
        print(f'Isolated verification failed ({type(error).__name__}); owned resources cleaned.', flush=True)
        raise SystemExit(1)
