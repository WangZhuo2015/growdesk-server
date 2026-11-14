#!/usr/bin/env python3
"""Run the real vaccine HTTP regression using disposable local PostgreSQL/Redis.

For environments without Docker only. This runner accepts executable paths, never
a database URL, existing data directory or account. It creates and guards a fresh
test_ database/role, binds both services to random loopback ports and removes only
its own temporary directory after terminating its own child processes.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import time
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('vaccine_scenario', ROOT / 'scripts/go-vaccines-integration.py')
assert SPEC and SPEC.loader
VACCINES = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VACCINES)
TOOLS, DOMAIN = VACCINES.TOOLS, VACCINES.DOMAIN

PG_QUERY = r"""
import pg from 'pg';
// Match psql's calendar-date output, without a host-timezone conversion.
pg.types.setTypeParser(1082, value => value);
let sql = '';
for await (const chunk of process.stdin) sql += chunk;
const client = new pg.Client({connectionString: process.env.GROWDESK_LOCAL_TEST_DATABASE_URL});
try {
  await client.connect();
  const result = await client.query(sql);
  const results = Array.isArray(result) ? result : [result];
  const lines = [];
  for (const item of results) {
    for (const row of item.rows) {
      lines.push(item.fields.map(field => {
        const value = row[field.name];
        if (value === null) return '';
        if (typeof value === 'boolean') return value ? 't' : 'f';
        if (value instanceof Date) return field.dataTypeID === 1082 ? value.toISOString().slice(0, 10) : value.toISOString();
        if (typeof value === 'object') return JSON.stringify(value);
        return String(value);
      }).join('|'));
    }
  }
  process.stdout.write(lines.join('\n'));
} finally { await client.end(); }
"""


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    if port in (5432, 6379, 3080, 3081, 3088, 3089):
        raise RuntimeError('Refusing a reserved port')
    return port


class LocalOwnedEnvironment(TOOLS.OwnedEnvironment):
    def __init__(self, postgres_bin, redis_binary):
        super().__init__()
        self.postgres_bin, self.redis_binary = postgres_bin, redis_binary
        self.directory = tempfile.TemporaryDirectory(prefix='test_growdesk_vaccine_')
        self.path = Path(self.directory.name)
        self.database_url = ''
        self.versions = {}

    def query(self, url, statement):
        result = subprocess.run(['node', '--input-type=module', '-e', PG_QUERY], cwd=ROOT,
            env={**self.env, 'GROWDESK_LOCAL_TEST_DATABASE_URL': url}, input=statement,
            text=True, capture_output=True)
        if result.returncode:
            message = result.stderr[-2500:]
            for secret in (self.password, self.admin_password, self.jwt):
                message = message.replace(secret, '<redacted>')
            raise RuntimeError('Owned PostgreSQL query failed: ' + message)
        return result.stdout.strip()

    def sql(self, statement):
        parsed = urlsplit(self.database_url)
        if (parsed.hostname != '127.0.0.1' or parsed.port in (5432, None)
                or parsed.path != '/' + self.database or parsed.username != self.role
                or not self.role.startswith('test_go_')):
            raise RuntimeError('Owned PostgreSQL identity guard failed')
        return self.query(self.database_url, statement)

    def child(self, args):
        log = tempfile.TemporaryFile(mode='w+t')
        self.files.append(log)
        process = subprocess.Popen([str(arg) for arg in args], cwd=self.path,
            env=self.env, stdout=log, stderr=log)
        self.processes.append(process)
        return process, log

    def start(self):
        pg_version = self.run([str(self.postgres_bin / 'postgres'), '--version'])
        redis_version = self.run([str(self.redis_binary), '--version'])
        if not pg_version.startswith('postgres (PostgreSQL) 18.'):
            raise RuntimeError('This regression requires real PostgreSQL 18')
        if not redis_version.startswith('Redis server v='):
            raise RuntimeError('Redis executable did not identify itself')
        self.versions = {'postgres': pg_version, 'redis': redis_version}
        bootstrap_role = 'test_bootstrap_' + self.owner
        password_file = self.path / 'bootstrap_password'
        password_file.write_text(self.admin_password + '\n')
        password_file.chmod(0o600)
        data = self.path / 'postgres'
        self.run([str(self.postgres_bin / 'initdb'), '-D', str(data), '-U', bootstrap_role,
            '--auth-host=scram-sha-256', '--auth-local=trust', '--locale=C', '--encoding=UTF8',
            '--pwfile=' + str(password_file)])
        password_file.unlink()
        pg_port, redis_port = free_port(), free_port()
        process, log = self.child([self.postgres_bin / 'postgres', '-D', data, '-h', '127.0.0.1',
            '-p', pg_port, '-c', 'unix_socket_directories='])
        bootstrap_url = f'postgresql://{bootstrap_role}:{self.admin_password}@127.0.0.1:{pg_port}/postgres?sslmode=disable'
        for _ in range(100):
            if process.poll() is not None:
                log.seek(0)
                raise RuntimeError('Owned PostgreSQL exited: ' + log.read()[-2500:])
            try:
                if self.query(bootstrap_url, 'SELECT 1;') == '1':
                    break
            except RuntimeError:
                time.sleep(.1)
        else:
            raise RuntimeError('Owned PostgreSQL startup timed out')
        self.query(bootstrap_url, f"CREATE ROLE {self.role} LOGIN PASSWORD '{self.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;")
        self.query(bootstrap_url, f'CREATE DATABASE {self.database} OWNER {self.role};')
        self.database_url = f'postgresql://{self.role}:{self.password}@127.0.0.1:{pg_port}/{self.database}?sslmode=disable'
        identity = self.sql('SELECT current_database(),current_user,rolsuper FROM pg_roles WHERE rolname=current_user;')
        if identity != self.database + '|' + self.role + '|f':
            raise RuntimeError('Owned PostgreSQL live role guard failed')
        for directory in sorted((ROOT / 'prisma/migrations').iterdir()):
            migration = directory / 'migration.sql'
            if migration.is_file():
                self.sql(migration.read_text())
        redis, redis_log = self.child([self.redis_binary, '--bind', '127.0.0.1', '--port', redis_port,
            '--requirepass', self.password, '--save', '', '--appendonly', 'no', '--dir', self.path])
        self.env.update(DATABASE_URL=self.database_url,
            REDIS_URL=f'redis://default:{self.password}@127.0.0.1:{redis_port}/0',
            JWT_SECRET=self.jwt, SESSION_ENCRYPTION_KEY=self.jwt, GROWDESK_ENV='test',
            GROWDESK_GO_EXPERIMENTAL='1', DB_POOL_MAX='10', HOST='127.0.0.1')
        if redis.poll() is not None:
            redis_log.seek(0)
            raise RuntimeError('Owned Redis exited: ' + redis_log.read()[-2000:])
        print('PASS owned local PostgreSQL identity, non-superuser and complete migrations', flush=True)
        return self

    def close(self):
        super().close()
        self.directory.cleanup()


def main():
    if not __debug__:
        raise RuntimeError('Assertions are required; do not run with python -O')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--postgres-bin', type=Path, required=True)
    parser.add_argument('--redis-binary', type=Path, required=True)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--reference', action='store_true')
    parser.add_argument('--report', type=Path)
    args = parser.parse_args()
    args.postgres_bin, args.redis_binary, args.binary = (path.resolve() for path in (args.postgres_bin, args.redis_binary, args.binary))
    for binary in (args.postgres_bin / 'postgres', args.postgres_bin / 'initdb', args.redis_binary, args.binary):
        if not binary.is_file() or not os.access(binary, os.X_OK):
            raise RuntimeError('Missing executable: ' + str(binary))
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    diff = subprocess.check_output(['git', 'diff', '--binary', 'HEAD'], cwd=ROOT)
    identity = json.loads(subprocess.check_output([str(args.binary), '--version'], cwd=ROOT, text=True))
    if identity.get('revision') != commit:
        raise RuntimeError('Binary revision does not match the checkout baseline')
    report = {'scope': 'vaccine booklet owned local-process HTTP regression', 'status': 'RUNNING',
        'evidenceStatus': 'IMPLEMENTED_NOT_REVIEWED', 'baselineCommit': commit,
        'trackedDiffSha256': hashlib.sha256(diff).hexdigest(), 'binary': identity,
        'binarySha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(), 'runtimes': {}}

    def save():
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f'signal {signum}')

    signal.signal(signal.SIGTERM, interrupted)
    save()
    try:
        for runtime in (('go', 'typescript') if args.reference else ('go',)):
            owned = LocalOwnedEnvironment(args.postgres_bin, args.redis_binary)
            try:
                owned.start()
                report['serviceVersions'] = owned.versions
                native = owned.serve(args.binary)
                base = native if runtime == 'go' else DOMAIN.serve_reference(owned)
                process = owned.processes[-1]

                def restart():
                    nonlocal process
                    process.terminate()
                    process.wait(timeout=10)
                    endpoint = owned.serve(args.binary) if runtime == 'go' else DOMAIN.serve_reference(owned)
                    process = owned.processes[-1]
                    return endpoint

                report['runtimes'][runtime] = VACCINES.VaccineScenario(owned, base).run(
                    restart, runtime, native if runtime == 'typescript' else None)
            finally:
                owned.close()
        if args.reference:
            left, right = (report['runtimes'][name]['observations'] for name in ('go', 'typescript'))
            if left != right:
                differences = [{'go': a, 'typescript': b} for a, b in zip(left, right) if a != b]
                if len(left) != len(right):
                    differences.append({'lengths': [len(left), len(right)]})
                raise AssertionError('HTTP/state parity differs: ' + json.dumps(differences, ensure_ascii=False))
            report['differentialObservations'] = len(left)
        report['status'] = 'PASS'
        print('PASS vaccine booklet Go/TypeScript HTTP regression', flush=True)
    except BaseException as error:
        report['status'] = 'FAIL'
        report['failureType'] = type(error).__name__
        raise
    finally:
        save()


if __name__ == '__main__':
    main()
