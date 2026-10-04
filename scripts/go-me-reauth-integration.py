#!/usr/bin/env python3
"""Reauthentication and export idempotency checks on a private local stack."""
from __future__ import annotations

import contextlib
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

if not __debug__:
    raise RuntimeError('Refusing optimized Python: assertions must remain enabled')

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_DIR = ROOT / 'evidence/tasks/IOS_WEB_PARITY_20261002/me-reauth'
RUN_ID = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + secrets.token_hex(4)
EVIDENCE = EVIDENCE_DIR / f'http-result-{RUN_ID}.json'
EXCLUDED_PREFIXES = (
    'PG', 'AWS', 'S3', 'GROWDESK', 'REDIS', 'DATABASE', 'JWT', 'OPENAI',
    'ANTHROPIC', 'SESSION_ENCRYPTION', 'INVITE', 'MINIO',
)
EXCLUDED_NAMES = {'NODE_ENV', 'PORT', 'HOST', 'PGPASSWORD'}
FORBIDDEN_PORTS = {3088, 3089, 5432, 6379}


def clean_environment() -> dict[str, str]:
    return {key: value for key, value in os.environ.items()
            if not key.startswith(EXCLUDED_PREFIXES) and key not in EXCLUDED_NAMES}


def free_loopback_port(used: set[int]) -> int:
    for _ in range(32):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = int(listener.getsockname()[1])
        if port not in used and port not in FORBIDDEN_PORTS:
            used.add(port)
            return port
    raise RuntimeError('could not allocate distinct loopback test ports')


def expect_uuid(value: str) -> str:
    parsed = uuid.UUID(value)
    if str(parsed) != value.lower():
        raise AssertionError('API returned a noncanonical UUID')
    return value


def request_with_dropped_export_response(stack: 'OwnedLocalStack', path: str, token: str, key: str) -> int:
    """Forward one real API request, commit it, then drop only the client response."""
    upstream_status: list[int] = []
    upstream_complete = threading.Event()
    api_port = int(stack.api_base.rsplit(':', 1)[1])

    class DropHandler(BaseHTTPRequestHandler):
        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get('Content-Length', '0')))
            headers = {name: value for name, value in self.headers.items()
                       if name.lower() not in {'host', 'connection', 'content-length'}}
            upstream = http.client.HTTPConnection('127.0.0.1', api_port, timeout=20)
            try:
                upstream.request('POST', self.path, body=raw or None, headers=headers)
                response = upstream.getresponse()
                response.read()  # Drain the committed API response, but never forward it.
                upstream_status.append(response.status)
            finally:
                upstream.close()
                upstream_complete.set()
            self.close_connection = True
            with contextlib.suppress(OSError):
                self.connection.shutdown(socket.SHUT_RDWR)
            self.connection.close()

        def log_message(self, _format: str, *_args) -> None:
            return

    proxy = ThreadingHTTPServer(('127.0.0.1', 0), DropHandler)
    proxy.daemon_threads = True
    worker = threading.Thread(target=proxy.serve_forever, daemon=True)
    worker.start()
    client_lost_response = False
    try:
        req = urllib.request.Request(
            f'http://127.0.0.1:{proxy.server_port}{path}',
            headers={'Accept': 'application/json', 'Authorization': 'Bearer ' + token,
                     'Idempotency-Key': key},
            method='POST',
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                response.read()
        except (OSError, http.client.HTTPException, urllib.error.URLError):
            client_lost_response = True
        if not upstream_complete.wait(20):
            raise AssertionError('response-drop proxy did not finish the API request')
        if not client_lost_response:
            raise AssertionError('test client unexpectedly received the API response')
        if upstream_status != [202]:
            raise AssertionError(f'API did not commit a 202 before the test proxy dropped the response: {upstream_status}')
        return upstream_status[0]
    finally:
        proxy.shutdown()
        proxy.server_close()
        worker.join(timeout=5)


def request_with_duplicate_idempotency_headers(stack: 'OwnedLocalStack', path: str,
                                               token: str, first: str, second: str) -> tuple[int, dict]:
    """Send two actual Idempotency-Key header lines over an HTTP/1.1 socket."""
    api_port = int(stack.api_base.rsplit(':', 1)[1])
    connection = http.client.HTTPConnection('127.0.0.1', api_port, timeout=20)
    try:
        connection.putrequest('POST', path)
        connection.putheader('Accept', 'application/json')
        connection.putheader('Authorization', 'Bearer ' + token)
        connection.putheader('Idempotency-Key', first)
        connection.putheader('Idempotency-Key', second)
        connection.putheader('Content-Length', '0')
        connection.endheaders()
        response = connection.getresponse()
        payload = json.loads(response.read())
        return response.status, payload
    finally:
        connection.close()


class OwnedLocalStack:
    def __init__(self, report: dict):
        self.owner = secrets.token_hex(8)
        self.role = self.database = 'test_me_reauth_' + self.owner
        self.pg_password = secrets.token_hex(32)
        self.redis_password = secrets.token_hex(32)
        self.jwt_secret = secrets.token_hex(32)
        self.invite_secret = secrets.token_hex(32)
        self.storage_access = 'test_' + secrets.token_hex(16)
        self.storage_secret = secrets.token_hex(32)
        self.storage_root_user = self.storage_access
        self.storage_root_password = secrets.token_hex(32)
        self.base_env = clean_environment()
        self.ports: set[int] = set()
        self.pg_port = free_loopback_port(self.ports)
        self.redis_port = free_loopback_port(self.ports)
        self.minio_port = free_loopback_port(self.ports)
        self.minio_console_port = free_loopback_port(self.ports)
        self.api_port = free_loopback_port(self.ports)
        # Keep PostgreSQL's Unix socket below its platform path-length limit.
        self.root = Path('/private/tmp') / ('gdme_' + self.owner)
        if self.root.exists():
            raise RuntimeError('private test directory collision')
        self.root.mkdir(mode=0o700)
        self.pg_data = self.root / 'postgres'
        self.pg_socket = self.root / 'pgsocket'
        self.redis_data = self.root / 'redis'
        self.minio_data = self.root / 'minio'
        for directory in (self.pg_data, self.pg_socket, self.redis_data, self.minio_data):
            directory.mkdir(mode=0o700)
        self.processes: list[tuple[str, subprocess.Popen, object]] = []
        self.pg_ctl: str | None = None
        self.api_env: dict[str, str] = {}
        self.api_base = ''
        self.report = report
        self.cleanup = {'apiStopped': True, 'postgresStopped': True, 'redisStopped': True,
                        'minioStopped': True, 'privateTempDirectoryRemoved': False,
                        'ownedTenantDatabaseRemovedWithPrivateCluster': True}
        self.pg_started = False
        self.tenant_created = False
        report['cleanup'] = self.cleanup

    def _run(self, args: list[str], *, input_text: str | None = None,
             env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess:
        result = subprocess.run(args, input=input_text, text=True, capture_output=True,
                                env=env or self.base_env)
        if check and result.returncode != 0:
            raise RuntimeError('owned test infrastructure command failed: ' + Path(args[0]).name)
        return result

    def _spawn(self, label: str, args: list[str], env: dict[str, str], log_name: str) -> subprocess.Popen:
        log = open(self.root / log_name, 'w+', encoding='utf-8')
        os.chmod(self.root / log_name, 0o600)
        process = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        self.processes.append((label, process, log))
        return process

    def psql(self, statement: str, *, admin: bool = False) -> str:
        args = [shutil.which('psql') or 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-At']
        env = dict(self.base_env)
        if admin:
            args += ['-h', str(self.pg_socket), '-p', str(self.pg_port), '-U', 'postgres', '-d', 'postgres']
        else:
            args += ['-h', '127.0.0.1', '-p', str(self.pg_port), '-U', self.role, '-d', self.database]
            env['PGPASSWORD'] = self.pg_password
        result = self._run(args, input_text=statement, env=env, check=False)
        if result.returncode != 0:
            raise RuntimeError('isolated PostgreSQL operation failed; details withheld')
        return result.stdout.strip()

    def start(self) -> None:
        initdb, self.pg_ctl = shutil.which('initdb'), shutil.which('pg_ctl')
        postgres, psql, redis_server, minio = (shutil.which(name) for name in
                                                ('postgres', 'psql', 'redis-server', 'minio'))
        missing = [name for name, path in (('initdb', initdb), ('pg_ctl', self.pg_ctl),
                    ('postgres', postgres), ('psql', psql), ('redis-server', redis_server),
                    ('minio', minio)) if path is None]
        if missing:
            raise RuntimeError('required local test service binaries unavailable: ' + ','.join(missing))

        self._run([initdb, '-D', str(self.pg_data), '--encoding=UTF8', '--locale=C',
                   '--username=postgres', '--auth-local=trust', '--auth-host=scram-sha-256'])
        self._run([self.pg_ctl, '-D', str(self.pg_data), '-l', str(self.root / 'postgres.log'),
                   '-o', f'-h 127.0.0.1 -p {self.pg_port} -k {self.pg_socket}', '-w', 'start'])
        self.pg_started = True
        self.cleanup['postgresStopped'] = False
        self._run([postgres, '--version'])

        redis_env = {**self.base_env}
        self._spawn('redis', [redis_server, '--bind', '127.0.0.1', '--protected-mode', 'yes',
                              '--port', str(self.redis_port), '--requirepass', self.redis_password,
                              '--dir', str(self.redis_data), '--save', '', '--appendonly', 'no'],
                    redis_env, 'redis.log')
        self.cleanup['redisStopped'] = False
        minio_env = {**self.base_env, 'MINIO_ROOT_USER': self.storage_root_user,
                     'MINIO_ROOT_PASSWORD': self.storage_root_password}
        self._spawn('minio', [minio, 'server', str(self.minio_data), '--address',
                              f'127.0.0.1:{self.minio_port}', '--console-address',
                              f'127.0.0.1:{self.minio_console_port}'], minio_env, 'minio.log')
        self.cleanup['minioStopped'] = False

        self._wait_postgres()
        self._wait_redis()
        self._wait_minio()
        self.psql(f"CREATE ROLE {self.role} LOGIN PASSWORD '{self.pg_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n"
                  f"CREATE DATABASE {self.database} OWNER {self.role};", admin=True)
        self.tenant_created = True
        self.cleanup['ownedTenantDatabaseRemovedWithPrivateCluster'] = False
        guard = self.psql("SELECT current_database()||'|'||current_user||'|'||"
                          "(SELECT rolsuper::text FROM pg_roles WHERE rolname=current_user);")
        if guard != f'{self.database}|{self.role}|false':
            raise RuntimeError('isolated PostgreSQL host/database/role guard failed')
        self.report['ownedEnvironment'] = {
            'postgresHost': '127.0.0.1', 'postgresPort': self.pg_port,
            'redisHost': '127.0.0.1', 'redisPort': self.redis_port,
            'minioHost': '127.0.0.1', 'minioPort': self.minio_port,
            'apiHost': '127.0.0.1', 'apiPort': self.api_port,
            'database': 'test_…', 'role': 'test_…', 'roleIsSuperuser': False,
            'tenantUsernamePrefix': 'test_me_reauth_', 'familyPrefix': 'test_family_me_reauth_',
            'babyPrefix': 'test_baby_me_reauth_', 'workerStarted': False,
            'externalAI': False, 'pushCredentialsPresent': False,
        }
        migrations = sorted((ROOT / 'prisma/migrations').glob('*/migration.sql'))
        if not migrations:
            raise RuntimeError('Prisma migration sources are missing')
        sql = '\n'.join(path.read_text() for path in migrations)
        native = sorted((ROOT / 'native/migrations').glob('*.sql'))
        sql += '\nCREATE SCHEMA IF NOT EXISTS native_go;\n'
        sql += "CREATE TABLE IF NOT EXISTS native_go.migrations(name text PRIMARY KEY,sha256 char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT now());\n"
        for path in native:
            raw = path.read_text()
            sql += f"\n{raw}\nINSERT INTO native_go.migrations(name,sha256) VALUES('{path.name}','{hashlib.sha256(raw.encode()).hexdigest()}');\n"
        self.psql(sql)
        self.report['ownedEnvironment']['prismaMigrationsApplied'] = len(migrations)
        self.report['ownedEnvironment']['nativeMigrationsApplied'] = len(native)
        self.api_env = {
            **self.base_env,
            'HOST': '127.0.0.1', 'PORT': str(self.api_port),
            'DATABASE_URL': f'postgresql://{self.role}:{self.pg_password}@127.0.0.1:{self.pg_port}/{self.database}?sslmode=disable',
            'REDIS_URL': f'redis://default:{self.redis_password}@127.0.0.1:{self.redis_port}/0',
            'JWT_SECRET': self.jwt_secret, 'SESSION_ENCRYPTION_KEY': secrets.token_hex(32),
            'INVITE_SECRET': self.invite_secret, 'GROWDESK_ENV': 'test',
            'GROWDESK_GO_EXPERIMENTAL': '1', 'DB_POOL_MAX': '10',
            'GROWDESK_AI_BUDGET_UNIT': 'ai_run_attempt', 'GROWDESK_AI_BUDGET_PERIOD': 'utc_day',
            'GROWDESK_AI_BUDGET_USER_LIMIT': '100', 'GROWDESK_AI_BUDGET_FAMILY_LIMIT': '1000',
            'GROWDESK_AI_BUDGET_GLOBAL_LIMIT': '10000',
            'S3_ENDPOINT': f'http://127.0.0.1:{self.minio_port}',
            'S3_BUCKET': 'test-me-reauth-' + self.owner,
            'S3_REGION': 'us-east-1', 'AWS_ACCESS_KEY_ID': self.storage_access,
            'AWS_SECRET_ACCESS_KEY': self.storage_secret,
            'GROWDESK_AI_PROVIDER': 'fixture',
            'GROWDESK_AI_FIXTURE_RESPONSE': '{"text":"test_only_isolated_response","actions":[]}',
        }

    def _wait_postgres(self) -> None:
        probe = shutil.which('pg_isready') or 'pg_isready'
        for _ in range(100):
            result = subprocess.run([probe, '-h', '127.0.0.1', '-p', str(self.pg_port),
                                     '-U', 'postgres', '-d', 'postgres'],
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=self.base_env)
            if result.returncode == 0:
                return
            time.sleep(0.1)
        raise RuntimeError('owned PostgreSQL readiness timed out')

    def _wait_redis(self) -> None:
        for _ in range(100):
            try:
                with socket.create_connection(('127.0.0.1', self.redis_port), timeout=0.5) as connection:
                    connection.sendall(self._resp('AUTH', 'default', self.redis_password))
                    if not connection.recv(128).startswith(b'+OK'):
                        time.sleep(0.1)
                        continue
                    connection.sendall(self._resp('PING'))
                    if connection.recv(128).startswith(b'+PONG'):
                        return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError('owned Redis readiness timed out')

    @staticmethod
    def _resp(*parts: str) -> bytes:
        items = [part.encode() for part in parts]
        return b'*' + str(len(items)).encode() + b'\r\n' + b''.join(
            b'$' + str(len(item)).encode() + b'\r\n' + item + b'\r\n' for item in items)

    def _wait_minio(self) -> None:
        url = f'http://127.0.0.1:{self.minio_port}/minio/health/ready'
        for _ in range(100):
            try:
                with urllib.request.urlopen(url, timeout=0.5) as response:
                    if response.status == 200:
                        return
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        raise RuntimeError('owned MinIO readiness timed out')

    def serve(self, binary: Path) -> None:
        log = open(self.root / 'api.log', 'w+', encoding='utf-8')
        os.chmod(self.root / 'api.log', 0o600)
        process = subprocess.Popen([str(binary)], cwd=ROOT, env=self.api_env,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log)
        self.processes.append(('api', process, log))
        self.api_base = f'http://127.0.0.1:{self.api_port}'
        for _ in range(150):
            if process.poll() is not None:
                raise RuntimeError('owned API exited during startup; details withheld')
            try:
                status, _ = self.request('GET', '/health/ready')
                if status == 200:
                    return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError('owned API readiness timed out')

    def request(self, method: str, path: str, body=None, token: str | None = None, extra_headers=None):
        headers = {'Accept': 'application/json'}
        raw = None
        if body is not None:
            raw = json.dumps(body, separators=(',', ':')).encode()
            headers['Content-Type'] = 'application/json'
        if token:
            headers['Authorization'] = 'Bearer ' + token
        headers.update(extra_headers or {})
        req = urllib.request.Request(self.api_base + path, data=raw, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.load(error)
            finally:
                error.close()

    def sql(self, statement: str) -> str:
        return self.psql(statement)

    def close(self) -> None:
        for label, process, log in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            if label == 'api':
                self.cleanup['apiStopped'] = process.poll() is not None
            elif label == 'redis':
                self.cleanup['redisStopped'] = process.poll() is not None
            elif label == 'minio':
                self.cleanup['minioStopped'] = process.poll() is not None
            with contextlib.suppress(Exception):
                log.close()
        if self.pg_ctl and self.pg_started:
            result = self._run([self.pg_ctl, '-D', str(self.pg_data), '-m', 'fast', '-w', 'stop'], check=False)
            self.cleanup['postgresStopped'] = result.returncode == 0
        with contextlib.suppress(Exception):
            shutil.rmtree(self.root)
        self.cleanup['privateTempDirectoryRemoved'] = not self.root.exists()
        self.cleanup['ownedTenantDatabaseRemovedWithPrivateCluster'] = (
            not self.tenant_created or (self.cleanup['postgresStopped'] and self.cleanup['privateTempDirectoryRemoved']))


def register(stack: OwnedLocalStack, suffix: str, label: str = 'test_me_reauth') -> dict:
    username = label + '_' + suffix
    password = 'test_password_' + secrets.token_hex(16)
    status, payload = stack.request('POST', '/api/v1/auth/register', {
        'username': username, 'password': password, 'displayName': 'Test Account',
        'deviceLabel': 'test_reauth',
    })
    if status != 201:
        raise AssertionError(f'register test principal: expected 201, got {status}; {payload.get("error", {}).get("code", "unknown")}')
    data = payload['data']
    data['_password'] = password
    data['_username'] = username
    data['_userId'] = expect_uuid(data['user']['id'])
    data['_sessionId'] = expect_uuid(data['sessionId'])
    return data


def run_checks(stack: OwnedLocalStack, report: dict) -> None:
    cases: list[str] = []
    checks = 0

    def call(method: str, path: str, expected: int, *, body=None, token=None, code=None, headers=None):
        nonlocal checks
        status, payload = stack.request(method, path, body, token, extra_headers=headers)
        checks += 1
        actual_code = payload.get('error', {}).get('code') if isinstance(payload, dict) else None
        if status != expected or (code is not None and actual_code != code):
            raise AssertionError(f'{method} {path.split("?", 1)[0]} expected {expected}/{code or "any"}, got {status}/{actual_code or "success"}')
        return payload

    def state(user_id: str) -> str:
        return stack.sql(f"""SELECT jsonb_build_object(
          'deleted',(SELECT deleted_at IS NOT NULL FROM users WHERE id='{user_id}'),
          'sessions',(SELECT jsonb_agg(jsonb_build_object('id',id,'createdAt',created_at,'revokedAt',revoked_at) ORDER BY id)
            FROM device_sessions WHERE user_id='{user_id}'),
          'liveRefresh',(SELECT count(*) FROM refresh_credentials WHERE user_id='{user_id}' AND revoked_at IS NULL),
          'exports',(SELECT count(*) FROM task_executions WHERE owner_scope='user:{user_id}' AND kind='user_data_export'),
          'outbox',(SELECT count(*) FROM task_outbox o JOIN task_executions t ON t.id=o.aggregate_id
            WHERE t.owner_scope='user:{user_id}' AND t.kind='user_data_export'),
          'receipts',(SELECT count(*) FROM idempotency_receipts WHERE actor_id='{user_id}' AND scope_id='{user_id}'
            AND command_id LIKE 'native-user-export:%'));""")

    def export_count_delta(before: str, after: str) -> tuple[int, int, int]:
        left, right = json.loads(before), json.loads(after)
        return (right['exports'] - left['exports'], right['outbox'] - left['outbox'],
                right['receipts'] - left['receipts'])

    suffix = stack.owner
    stale = register(stack, suffix + '_stale')
    stale_id, stale_session = stale['_userId'], stale['_sessionId']
    stack.sql(f"UPDATE device_sessions SET created_at=NOW()-INTERVAL '6 minutes' WHERE id='{stale_session}' AND user_id='{stale_id}';")
    old_created = stack.sql(f"SELECT created_at::text FROM device_sessions WHERE id='{stale_session}' AND user_id='{stale_id}';")
    before_denied = state(stale_id)
    call('POST', '/api/v1/me/export', 403, token=stale['accessToken'], code='REAUTH_REQUIRED')
    call('DELETE', '/api/v1/me', 403, token=stale['accessToken'], code='REAUTH_REQUIRED')
    if state(stale_id) != before_denied:
        raise AssertionError('stale-session denials changed user, sessions, export task or outbox state')
    cases.append('session older than five minutes is denied for export and deletion without side effects')

    rotated = call('POST', '/api/v1/auth/refresh', 200,
                   body={'refreshToken': stale['refreshToken'], 'rotationId': str(uuid.uuid4())})['data']
    current_created = stack.sql(f"SELECT created_at::text FROM device_sessions WHERE id='{stale_session}' AND user_id='{stale_id}';")
    if current_created != old_created:
        raise AssertionError('refresh changed device session created_at')
    after_refresh = state(stale_id)
    call('POST', '/api/v1/me/export', 403, token=rotated['accessToken'], code='REAUTH_REQUIRED')
    call('DELETE', '/api/v1/me', 403, token=rotated['accessToken'], code='REAUTH_REQUIRED')
    if state(stale_id) != after_refresh:
        raise AssertionError('refreshed stale-session denials changed account state')
    cases.append('refresh rotates bearer credentials but does not renew reauthentication age')

    fresh = call('POST', '/api/v1/auth/login', 200,
                 body={'username': stale['_username'], 'password': stale['_password'], 'deviceLabel': 'test_fresh_login'})['data']
    fresh_session = expect_uuid(fresh['sessionId'])
    age_ok = stack.sql(f"SELECT (created_at >= statement_timestamp()-INTERVAL '5 minutes' AND created_at <= statement_timestamp())::text FROM device_sessions WHERE id='{fresh_session}' AND user_id='{stale_id}';")
    if age_ok != 'true':
        raise AssertionError('fresh login session is not inside the accepted reauthentication window')
    before_legacy_export = state(stale_id)
    queued = call('POST', '/api/v1/me/export', 202, token=fresh['accessToken'])['data']
    task_id = expect_uuid(queued['taskId'])
    if queued['status'] != 'queued':
        raise AssertionError('export did not remain queued without a worker')
    if export_count_delta(before_legacy_export, state(stale_id)) != (1, 1, 0):
        raise AssertionError('optional-key compatibility path did not queue one export without a receipt')
    durable_owner = stack.sql(f"SELECT owner_scope||'|'||kind||'|'||status FROM task_executions WHERE id='{task_id}';")
    outbox_count = stack.sql(f"SELECT count(*) FROM task_outbox WHERE aggregate_id='{task_id}';")
    if durable_owner != f'user:{stale_id}|user_data_export|queued' or outbox_count != '1':
        raise AssertionError('fresh export was not durably enqueued to the authenticated user scope')

    before_invalid_keys = state(stale_id)
    call('POST', '/api/v1/me/export', 400, token=fresh['accessToken'],
         headers={'Idempotency-Key': 'not a valid key'}, code='FST_ERR_VALIDATION')
    call('POST', '/api/v1/me/export', 400, token=fresh['accessToken'],
         headers={'Idempotency-Key': 'k' * 129}, code='FST_ERR_VALIDATION')
    if state(stale_id) != before_invalid_keys:
        raise AssertionError('invalid idempotency keys created export tasks or receipts')
    cases.append('optional idempotency key rejects invalid format and overlong values')

    before_duplicate_headers = state(stale_id)
    duplicate_status, duplicate_payload = request_with_duplicate_idempotency_headers(
        stack, '/api/v1/me/export', fresh['accessToken'], 'duplicate:first', 'duplicate:second')
    checks += 1
    duplicate_code = duplicate_payload.get('error', {}).get('code') if isinstance(duplicate_payload, dict) else None
    if duplicate_status != 400 or duplicate_code != 'INVALID_IDEMPOTENCY_KEY':
        raise AssertionError(f'duplicate Idempotency-Key headers expected 400/INVALID_IDEMPOTENCY_KEY, got {duplicate_status}/{duplicate_code or "unknown"}')
    if state(stale_id) != before_duplicate_headers:
        raise AssertionError('duplicate idempotency headers created export work or a receipt')
    cases.append('duplicate raw Idempotency-Key header lines are rejected without side effects')

    lost_response_key = str(uuid.uuid4())
    before_lost_response = state(stale_id)
    request_with_dropped_export_response(stack, '/api/v1/me/export', fresh['accessToken'], lost_response_key)
    checks += 1
    lost_task_id = stack.sql(f"SELECT response_body->>'taskId' FROM idempotency_receipts WHERE actor_id='{stale_id}' AND scope_id='{stale_id}' AND command_id='native-user-export:{lost_response_key}';")
    if not lost_task_id or export_count_delta(before_lost_response, state(stale_id)) != (1, 1, 1):
        raise AssertionError('lost 202 response did not commit exactly one task, outbox and receipt')
    replayed = call('POST', '/api/v1/me/export', 202, body={}, token=fresh['accessToken'],
                    headers={'Idempotency-Key': lost_response_key})['data']
    if replayed.get('taskId') != lost_task_id or replayed.get('status') != 'queued':
        raise AssertionError('empty-object retry did not return the original queued task after the response was lost')
    no_body_replay = call('POST', '/api/v1/me/export', 202, token=fresh['accessToken'],
                          headers={'Idempotency-Key': lost_response_key})['data']
    if no_body_replay.get('taskId') != lost_task_id:
        raise AssertionError('missing-body retry did not match the canonical empty-object receipt')
    if export_count_delta(before_lost_response, state(stale_id)) != (1, 1, 1):
        raise AssertionError('same-key retry created duplicate export task or outbox rows')
    cases.append('response loss followed by empty-object and missing-body same-key retries returns one original task/outbox/receipt')
    before_changed_body = state(stale_id)
    call('POST', '/api/v1/me/export', 409, body={'futureOption': True}, token=fresh['accessToken'],
         headers={'Idempotency-Key': lost_response_key}, code='IDEMPOTENCY_KEY_REUSED')
    if state(stale_id) != before_changed_body:
        raise AssertionError('changed body reused an export receipt or created another task/outbox')
    cases.append('same key with changed body is rejected without replaying or creating work')

    concurrent_key = str(uuid.uuid4())
    before_concurrent = state(stale_id)
    start = threading.Barrier(4)

    def concurrent_export():
        start.wait(timeout=10)
        return stack.request('POST', '/api/v1/me/export', token=fresh['accessToken'],
                             extra_headers={'Idempotency-Key': concurrent_key})

    with ThreadPoolExecutor(max_workers=4) as pool:
        concurrent_results = list(pool.map(lambda _index: concurrent_export(), range(4)))
    checks += len(concurrent_results)
    concurrent_tasks: list[str] = []
    for status, payload in concurrent_results:
        data = payload.get('data', {}) if isinstance(payload, dict) else {}
        if status != 202 or data.get('status') != 'queued':
            code = payload.get('error', {}).get('code', 'unknown') if isinstance(payload, dict) else 'unknown'
            raise AssertionError(f'concurrent same-key export expected 202, got {status}/{code}')
        concurrent_tasks.append(expect_uuid(data.get('taskId', '')))
    if len(set(concurrent_tasks)) != 1 or export_count_delta(before_concurrent, state(stale_id)) != (1, 1, 1):
        raise AssertionError('concurrent same-key exports did not converge on exactly one task and outbox')
    cases.append('concurrent same-key export requests commit exactly one task/outbox and share its receipt')

    def pending_user_tasks(user_id: str) -> int:
        return int(stack.sql(f"SELECT count(*) FROM task_executions WHERE owner_scope='user:{user_id}' AND status IN ('queued','running','cancelling','awaiting_confirmation');"))

    pending_before_fill = pending_user_tasks(stale_id)
    if pending_before_fill > 64:
        raise AssertionError(f'isolated test principal unexpectedly exceeds the 64-task quota: {pending_before_fill}')
    for index in range(pending_before_fill, 64):
        fill_key = f'quota-fill:{index}:{uuid.uuid4()}'
        filled = call('POST', '/api/v1/me/export', 202, token=fresh['accessToken'],
                      headers={'Idempotency-Key': fill_key})['data']
        if filled.get('status') != 'queued':
            raise AssertionError('real export request did not queue while filling the owned task quota')
    if pending_user_tasks(stale_id) != 64:
        raise AssertionError('real HTTP export submissions did not bring the principal to exactly 64 pending tasks')
    cases.append('pending-task quota was reached using only authenticated HTTP export requests')

    rejected_key = 'quota-rejected:' + str(uuid.uuid4())
    before_quota_rejection = state(stale_id)
    call('POST', '/api/v1/me/export', 429, token=fresh['accessToken'],
         headers={'Idempotency-Key': rejected_key}, code='TASK_QUOTA_EXCEEDED')
    if state(stale_id) != before_quota_rejection or pending_user_tasks(stale_id) != 64:
        raise AssertionError('quota rejection changed export tasks, outbox rows or receipts')
    rejected_receipt_count = stack.sql(f"SELECT count(*) FROM idempotency_receipts WHERE actor_id='{stale_id}' AND scope_id='{stale_id}' AND command_id='native-user-export:{rejected_key}';")
    if rejected_receipt_count != '0':
        raise AssertionError('quota rejection persisted an idempotency receipt')
    cases.append('new idempotency key receives 429 TASK_QUOTA_EXCEEDED at quota without task/outbox/receipt effects')

    before_quota_replay = state(stale_id)
    replay_at_quota = call('POST', '/api/v1/me/export', 202, body={}, token=fresh['accessToken'],
                           headers={'Idempotency-Key': lost_response_key})['data']
    if replay_at_quota.get('taskId') != lost_task_id or replay_at_quota.get('status') != 'queued':
        raise AssertionError('same-key replay at quota did not return the original task')
    if state(stale_id) != before_quota_replay or pending_user_tasks(stale_id) != 64:
        raise AssertionError('same-key replay at quota created additional work or changed receipts')
    cases.append('existing completed idempotency receipt replays its original 202 task at quota without new work')

    call('GET', '/api/v1/me', 200, token=fresh['accessToken'])
    cases.append('fresh password login permits the optional-key export path and persists one queued user-owned task')

    stack.sql(f"UPDATE device_sessions SET created_at=NOW()-INTERVAL '6 minutes' WHERE id='{fresh_session}' AND user_id='{stale_id}';")
    before_stale_receipt = state(stale_id)
    call('POST', '/api/v1/me/export', 403, token=fresh['accessToken'],
         headers={'Idempotency-Key': lost_response_key}, code='REAUTH_REQUIRED')
    call('DELETE', '/api/v1/me', 403, token=fresh['accessToken'], code='REAUTH_REQUIRED')
    if state(stale_id) != before_stale_receipt:
        raise AssertionError('stale-session receipt replay changed export, outbox, user or credential state')
    cases.append('stale session with an existing export receipt is denied before receipt replay or deletion')

    reauthenticated = call('POST', '/api/v1/auth/login', 200,
                           body={'username': stale['_username'], 'password': stale['_password'],
                                 'deviceLabel': 'test_receipt_revoke'})['data']
    call('DELETE', f'/api/v1/auth/sessions/{fresh_session}', 200, token=reauthenticated['accessToken'])
    before_revoked_receipt = state(stale_id)
    call('POST', '/api/v1/me/export', 401, token=fresh['accessToken'],
         headers={'Idempotency-Key': lost_response_key}, code='SESSION_REVOKED')
    if state(stale_id) != before_revoked_receipt:
        raise AssertionError('revoked-session receipt replay changed export, outbox, user or credential state')
    cases.append('revoked session with an existing export receipt is denied before receipt replay')

    call('DELETE', f'/api/v1/auth/sessions/{stale_session}', 200, token=reauthenticated['accessToken'])
    revoked_state = state(stale_id)
    call('GET', '/api/v1/me', 401, token=stale['accessToken'], code='SESSION_REVOKED')
    call('POST', '/api/v1/me/export', 401, token=rotated['accessToken'], code='SESSION_REVOKED')
    if state(stale_id) != revoked_state:
        raise AssertionError('requests through the revoked session changed account state')
    if stack.sql(f"SELECT (revoked_at IS NOT NULL)::text FROM device_sessions WHERE id='{stale_session}';") != 'true':
        raise AssertionError('explicitly revoked session was not durable')
    cases.append('revoked older session cannot access profile or create exports')

    delete_owner = register(stack, suffix + '_delete')
    delete_owner_id = delete_owner['_userId']
    family = call('POST', '/api/v1/families', 201,
                  body={'name': 'test_family_me_reauth_' + suffix}, token=delete_owner['accessToken'])['data']
    family_id = expect_uuid(family['id'])
    baby = call('POST', f'/api/v1/families/{family_id}/babies', 201,
                body={'name': 'test_baby_me_reauth_' + suffix, 'birthDate': '2025-01-02', 'gender': 'other'},
                token=delete_owner['accessToken'])['data']
    baby_id = expect_uuid(baby['id'])
    collaborator = register(stack, suffix + '_collaborator')
    invite = call('POST', f'/api/v1/families/{family_id}/invites', 201,
                  body={'expiresInDays': 1}, token=delete_owner['accessToken'])['data']['inviteCode']
    call('POST', '/api/v1/families/join', 200, body={'inviteCode': invite}, token=collaborator['accessToken'])
    call('POST', f'/api/v1/babies/{baby_id}/members', 201,
         body={'userId': collaborator['_userId'], 'role': 'admin'}, token=delete_owner['accessToken'])
    call('PATCH', f'/api/v1/families/{family_id}/members/{collaborator["_userId"]}', 200,
         body={'role': 'admin'}, token=delete_owner['accessToken'])

    delete_fresh = call('POST', '/api/v1/auth/login', 200,
                        body={'username': delete_owner['_username'], 'password': delete_owner['_password'],
                              'deviceLabel': 'test_recent_delete'})['data']
    collaborator_fresh = call('POST', '/api/v1/auth/login', 200,
                              body={'username': collaborator['_username'], 'password': collaborator['_password'],
                                    'deviceLabel': 'test_recent_collaborator'})['data']
    same_key = str(uuid.uuid4())
    owner_before_shared_key = state(delete_owner_id)
    collaborator_before_shared_key = state(collaborator['_userId'])
    owner_export = call('POST', '/api/v1/me/export', 202, token=delete_fresh['accessToken'],
                        headers={'Idempotency-Key': same_key})['data']
    collaborator_export = call('POST', '/api/v1/me/export', 202, token=collaborator_fresh['accessToken'],
                               headers={'Idempotency-Key': same_key})['data']
    owner_replay = call('POST', '/api/v1/me/export', 202, token=delete_fresh['accessToken'],
                        headers={'Idempotency-Key': same_key})['data']
    if owner_export.get('taskId') == collaborator_export.get('taskId') or owner_replay.get('taskId') != owner_export.get('taskId'):
        raise AssertionError('same-family users shared an export receipt or owner replay changed task identity')
    if export_count_delta(owner_before_shared_key, state(delete_owner_id)) != (1, 1, 1) or \
       export_count_delta(collaborator_before_shared_key, state(collaborator['_userId'])) != (1, 1, 1):
        raise AssertionError('same idempotency key did not create one independently scoped export for each user')
    owner_receipt_count = stack.sql(f"SELECT count(*) FROM idempotency_receipts WHERE actor_id='{delete_owner_id}' AND scope_id='{delete_owner_id}' AND command_id='native-user-export:{same_key}';")
    collaborator_receipt_count = stack.sql(f"SELECT count(*) FROM idempotency_receipts WHERE actor_id='{collaborator['_userId']}' AND scope_id='{collaborator['_userId']}' AND command_id='native-user-export:{same_key}';")
    if owner_receipt_count != '1' or collaborator_receipt_count != '1':
        raise AssertionError('same-family principal receipt was not scoped to each authenticated user')
    cases.append('same idempotency key in one family remains independent for two authenticated principals')

    pre_delete_state = state(delete_owner_id)
    result = call('DELETE', '/api/v1/me', 200, token=delete_fresh['accessToken'])['data']
    if result.get('success') is not True:
        raise AssertionError('authorized delete returned an unexpected success shape')
    deleted = stack.sql(f"SELECT (deleted_at IS NOT NULL)::text FROM users WHERE id='{delete_owner_id}';")
    live_sessions = stack.sql(f"SELECT count(*) FROM device_sessions WHERE user_id='{delete_owner_id}' AND revoked_at IS NULL;")
    live_refresh = stack.sql(f"SELECT count(*) FROM refresh_credentials WHERE user_id='{delete_owner_id}' AND revoked_at IS NULL;")
    if deleted != 'true' or live_sessions != '0' or live_refresh != '0':
        raise AssertionError('successful account deletion did not revoke all credentials')
    if stack.sql(f"SELECT count(*) FROM families WHERE id='{family_id}' AND deleted_at IS NULL;") != '1' or \
       stack.sql(f"SELECT count(*) FROM babies WHERE id='{baby_id}' AND deleted_at IS NULL;") != '1':
        raise AssertionError('account deletion removed shared family or baby data')
    if stack.sql(f"SELECT count(*) FROM family_members WHERE family_id='{family_id}' AND user_id='{collaborator['_userId']}' AND status='active' AND deleted_at IS NULL;") != '1' or \
       stack.sql(f"SELECT count(*) FROM baby_members WHERE baby_id='{baby_id}' AND user_id='{collaborator['_userId']}' AND status='active' AND deleted_at IS NULL;") != '1':
        raise AssertionError('account deletion revoked the other caregiver shared-data access')
    if pre_delete_state == state(delete_owner_id):
        raise AssertionError('successful account deletion did not change account/session state')
    deleted_state = state(delete_owner_id)
    call('GET', '/api/v1/me', 401, token=delete_fresh['accessToken'], code='SESSION_REVOKED')
    call('DELETE', '/api/v1/me', 401, token=delete_owner['accessToken'], code='SESSION_REVOKED')
    if state(delete_owner_id) != deleted_state:
        raise AssertionError('requests through the deleted account session changed account state')
    visible = call('GET', f'/api/v1/families/{family_id}/babies', 200, token=collaborator['accessToken'])['data']
    if not any(row['id'] == baby_id and row['name'].startswith('test_baby_me_reauth_') for row in visible):
        raise AssertionError('remaining family administrator cannot access preserved baby data')
    call('GET', f'/api/v1/babies/{baby_id}', 200, token=collaborator['accessToken'])
    cases.append('fresh session permits deletion, revokes every session/refresh, and preserves shared family/baby access')

    deleted_owner_export_count = stack.sql(f"SELECT count(*) FROM task_executions WHERE owner_scope='user:{delete_owner_id}' AND kind='user_data_export';")
    foreign_export = call('POST', '/api/v1/me/export', 202, token=collaborator_fresh['accessToken'])['data']
    foreign_task = expect_uuid(foreign_export['taskId'])
    foreign_owner = stack.sql(f"SELECT owner_scope||'|'||kind FROM task_executions WHERE id='{foreign_task}';")
    if foreign_owner != f'user:{collaborator["_userId"]}|user_data_export':
        raise AssertionError('export task escaped the authenticated principal scope')
    if stack.sql(f"SELECT count(*) FROM task_executions WHERE owner_scope='user:{delete_owner_id}' AND kind='user_data_export';") != deleted_owner_export_count:
        raise AssertionError('foreign export request created a task for the deleted account')
    cases.append('another family member export is scoped to that authenticated principal')

    report['assertionCount'] = checks
    report['cases'] = cases
    report['tenant'] = {'usersCreated': 3, 'allUsernamesUseTestPrefix': True,
                        'familiesUseTestPrefix': True, 'babiesUseTestPrefix': True,
                        'familyAndBabyPreservedAfterOwnerDeletion': True}
    report['workerStarted'] = False
    report['databaseDiagnostics'] = []


def build_binary(temp_root: Path, revision: str) -> Path:
    go = shutil.which('go')
    if go is None:
        raise RuntimeError('Go toolchain is unavailable')
    binary = temp_root / 'growdesk-api'
    env = clean_environment()
    env['GOTOOLCHAIN'] = 'auto'
    result = subprocess.run([go, 'build', '-trimpath', '-ldflags=-X=main.revision=' + revision,
                             '-o', str(binary), './cmd/growdesk-api'], cwd=ROOT, env=env,
                            text=True, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError('isolated API build failed; compiler output withheld')
    return binary


def main() -> int:
    if EVIDENCE.exists():
        raise RuntimeError('Refusing to replace existing unique account security evidence')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    report = {'status': 'FAIL', 'scope': 'recent-session reauthentication, principal-scoped POST /me/export idempotency, and DELETE /me',
              'sourceRevision': head, 'sourceFileHashes': {}, 'assertionCount': 0, 'cases': []}
    for relative in ('go.mod', 'go.sum', 'internal/backend/reauth.go', 'internal/backend/reauth_test.go',
                     'internal/backend/auth.go', 'internal/backend/refresh.go',
                     'internal/backend/native_exports.go', 'internal/backend/native_tasks.go',
                     'internal/backend/snapshot_codec.go',
                     'internal/backend/native_export_idempotency_test.go',
                     'prisma/migrations/202609120002_foundation/migration.sql',
                     'packages/contracts/src/routes.ts', 'contracts/openapi.json',
                     'scripts/go-me-reauth-integration.py'):
        path = ROOT / relative
        if path.is_file():
            report['sourceFileHashes'][relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    stack = None
    temp_root = Path(tempfile.mkdtemp(prefix='growdesk-me-reauth-build-'))
    temp_root.chmod(0o700)
    try:
        binary = build_binary(temp_root, head)
        report['binarySha256'] = hashlib.sha256(binary.read_bytes()).hexdigest()
        stack = OwnedLocalStack(report)
        stack.start()
        stack.serve(binary)
        run_checks(stack, report)
        report['status'] = 'PASS'
    except BaseException as error:
        report['status'] = 'FAIL'
        report['failureType'] = type(error).__name__
        safe = str(error)
        report['failure'] = safe[:300] if not any(secret in safe for secret in ('password', 'token', 'Bearer')) else type(error).__name__
        raise
    finally:
        if stack is not None:
            stack.close()
        with contextlib.suppress(Exception):
            shutil.rmtree(temp_root)
        if stack is None:
            report['cleanup'] = {'apiStopped': True, 'postgresStopped': True, 'redisStopped': True,
                                'minioStopped': True, 'privateTempDirectoryRemoved': True,
                                'ownedTenantDatabaseRemovedWithPrivateCluster': True}
        report.setdefault('cleanup', {})['buildDirectoryRemoved'] = not temp_root.exists()
        if report['status'] == 'PASS' and not all(report['cleanup'].values()):
            report['status'] = 'FAIL'
            report['failureType'] = 'CleanupError'
            report['failure'] = 'one or more owned local resources did not stop or remove cleanly'
        EVIDENCE.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(EVIDENCE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    if report['status'] != 'PASS':
        print('FAIL isolated account reauthentication run; inspect sanitized evidence')
        return 1
    print('PASS isolated account reauthentication HTTP E2E (' + str(report.get('assertionCount', 0)) + ' checks)')
    print('Evidence: ' + str(EVIDENCE))
    print('PASS owned API, PostgreSQL, Redis, MinIO, test tenant and private build data cleaned')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
