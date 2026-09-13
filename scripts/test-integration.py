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


def command(args, **kwargs):
    # Never echo commands: role setup includes an ephemeral credential.
    return subprocess.run(args, check=True, timeout=90, cwd=HERE, **kwargs)


def main():
    pgdir = '/opt/homebrew/opt/postgresql@18/bin'
    redisdir = '/opt/homebrew/opt/redis/bin'
    bins = {n: executable(n, 'PG_BIN', pgdir) for n in ['initdb', 'postgres', 'pg_isready', 'psql', 'createdb']}
    redis = executable('redis-server', 'REDIS_BIN', redisdir)
    if ' 18.' not in subprocess.check_output([bins['postgres'], '--version'], text=True):
        raise RuntimeError('Requires PostgreSQL 18')
    if 'v=8.' not in subprocess.check_output([redis, '--version'], text=True):
        raise RuntimeError('Requires Redis 8')
    # Scrub inherited database connection options from the managed subprocess environment.
    env = {k:v for k,v in os.environ.items() if not k.startswith('PG') and k not in
           ['DATABASE_URL', 'TEST_DATABASE_URL', 'BOOT02_RUN_FILE', 'REDIS_URL']}
    children = []
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
            command(['python3', 'scripts/legacy-import/test_import_integration.py'], env=env)
            command(['node', '--import', 'tsx', '--test', 'tests/integration/infrastructure.test.ts', 'tests/integration/foundation-migration.test.ts', 'tests/integration/unit-of-work.test.ts', 'tests/integration/auth.test.ts', 'tests/integration/auth-refresh.test.ts', 'tests/integration/family-baby.test.ts', 'tests/integration/auth-recovery.test.ts', 'tests/integration/feeding.test.ts', 'tests/integration/diaper.test.ts', 'tests/integration/sleep.test.ts', 'tests/integration/food.test.ts', 'tests/integration/supplement.test.ts', 'tests/integration/growth.test.ts', 'tests/integration/timeline.test.ts', 'tests/integration/bff-session.test.ts', 'tests/integration/attachments.test.ts', 'tests/integration/medical-vaccines.test.ts', 'tests/integration/tasks.test.ts', 'tests/integration/ai-runs.test.ts'], env=env)
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
    parser.parse_args()  # Reject unknown suites before creating any resources.
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, interrupted)
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        # Driver/subprocess exceptions may contain credentials; log only a class name.
        print(f'Isolated verification failed ({type(error).__name__}); owned resources cleaned.', flush=True)
        raise SystemExit(1)
