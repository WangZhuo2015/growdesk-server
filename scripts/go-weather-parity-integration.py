#!/usr/bin/env python3
"""Real HTTP weather adapter tests with loopback-only virtual providers and owned PG/Redis."""
from __future__ import annotations
import argparse
import contextlib
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

if not __debug__:
    raise RuntimeError('Refusing optimized Python: regression assertions must remain enabled')

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('go_integration', ROOT / 'scripts/go-integration.py')
go_integration = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(go_integration)
OwnedEnvironment = go_integration.OwnedEnvironment
http = go_integration.http
expect = go_integration.expect


class LocalOwnedEnvironment:
    """Disposable local PG/Redis processes when no container runtime is installed."""
    def __init__(self):
        self.owner = secrets.token_hex(8)
        self.password = secrets.token_hex(24)
        self.admin_password = secrets.token_hex(24)
        self.jwt = secrets.token_hex(32)
        self.role = self.database = 'test_weather_' + self.owner
        self.env = {k: v for k, v in os.environ.items() if not (
            k.startswith(('PG', 'AWS', 'S3', 'GROWDESK', 'REDIS', 'DATABASE', 'JWT', 'OPENAI', 'ANTHROPIC',
                          'SESSION_ENCRYPTION', 'INVITE', 'WEATHER_', 'OPEN_METEO_'))
            or k in ('NODE_ENV', 'PORT', 'HOST'))}
        # initdb/postgres 18 rejects this host's inherited locale, so make the
        # isolated test server's locale deterministic instead of inheriting it.
        self.env['LC_ALL'] = 'C'
        self.env['LANG'] = 'C'
        self.containers = []
        self.processes = []
        self.files = []
        self.root = Path(tempfile.mkdtemp(prefix='growdesk-weather-owned-' + self.owner + '-', dir='/private/tmp'))
        self.marker = self.root / 'OWNER'
        self.marker.write_text('growdesk-weather-owned:' + self.owner + '\n')
        self.marker.chmod(0o600)
        self.pg_data = self.root / 'pgdata'
        self.pg_port = None
        self.redis_port = None
        self.pg_bin = None
        self.redis_process = None
        self.redis_log = None
        self.pg_log = None
        self.started_pg = False
        self.pg_postmaster_pid = None
        self.pg_startup_identity = None
        self.pg_cleanup_attempted = False
        self.pg_stop_verified = False
        self.pg_stop_command_exit_code = None
        self.pg_pid_termination_proven = False
        self.pg_cleanup_failure = None

    def run(self, args, data=None, extra_env=None):
        return subprocess.run(args, input=data, text=True, check=True, capture_output=True,
                              env={**self.env, **(extra_env or {})}).stdout.strip()

    @staticmethod
    def unused_port():
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        assert port not in (5432, 6379, 3088, 3089, 60756, 49762, 57006)
        return port

    def sql_admin(self, statement):
        return self.run([
            str(self.pg_bin / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-At',
            '-h', '127.0.0.1', '-p', str(self.pg_port), '-U', 'postgres', '-d', 'postgres',
        ], statement, {'PGPASSWORD': self.admin_password})

    def sql(self, statement):
        return self.run([
            str(self.pg_bin / 'psql'), '-X', '-v', 'ON_ERROR_STOP=1', '-At',
            '-h', '127.0.0.1', '-p', str(self.pg_port), '-U', self.role, '-d', self.database,
        ], statement, {'PGPASSWORD': self.password})

    @staticmethod
    def _process_start_identity(pid):
        result = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'lstart='],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, check=False,
        )
        identity = result.stdout.strip()
        return identity if result.returncode == 0 and identity else None

    def _read_postmaster_identity(self):
        pid_file = self.pg_data / 'postmaster.pid'
        lines = pid_file.read_text(encoding='utf-8').splitlines()
        if len(lines) < 3:
            raise RuntimeError('owned PostgreSQL postmaster.pid is incomplete')
        try:
            pid = int(lines[0])
        except ValueError as error:
            raise RuntimeError('owned PostgreSQL postmaster.pid has an invalid PID') from error
        if pid <= 0 or Path(lines[1]).resolve() != self.pg_data.resolve():
            raise RuntimeError('owned PostgreSQL postmaster.pid identity does not match its data directory')
        process_started_at = self._process_start_identity(pid)
        if process_started_at is None:
            raise RuntimeError('owned PostgreSQL postmaster PID is not running')
        return {
            'postmasterPID': pid,
            'dataDirectory': str(self.pg_data.resolve()),
            'postmasterStartTime': lines[2].strip(),
            'processStartedAt': process_started_at,
        }

    def _matches_postmaster_startup_identity(self):
        if not self.started_pg or not self.pg_startup_identity or not self.pg_postmaster_pid:
            return False
        try:
            current = self._read_postmaster_identity()
        except (OSError, RuntimeError) as error:
            self.pg_cleanup_failure = 'postmaster_identity_unavailable: ' + str(error)
            return False
        if current != self.pg_startup_identity or current['postmasterPID'] != self.pg_postmaster_pid:
            self.pg_cleanup_failure = 'postmaster_identity_mismatch_before_stop'
            return False
        return True

    def _prove_postmaster_terminated(self):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            current_identity = self._process_start_identity(self.pg_postmaster_pid)
            if current_identity is None:
                try:
                    os.kill(self.pg_postmaster_pid, 0)
                except ProcessLookupError:
                    return True
                except PermissionError:
                    self.pg_cleanup_failure = 'cannot_verify_postmaster_pid_termination'
                    return False
                self.pg_cleanup_failure = 'postmaster_pid_exists_but_identity_is_unreadable'
                return False
            if current_identity != self.pg_startup_identity['processStartedAt']:
                self.pg_cleanup_failure = 'postmaster_pid_identity_mismatch_after_stop'
                return False
            time.sleep(.1)
        self.pg_cleanup_failure = 'postmaster_pid_still_running_after_pg_ctl_stop'
        return False

    def _stop_owned_postgres(self):
        if self.pg_cleanup_attempted:
            return self.pg_stop_verified
        self.pg_cleanup_attempted = True
        if not self.started_pg:
            self.pg_stop_verified = True
            return True
        if not self._matches_postmaster_startup_identity():
            if self.pg_cleanup_failure is None:
                self.pg_cleanup_failure = 'postmaster_startup_identity_was_not_recorded'
            return False
        try:
            self.run([
                str(self.pg_bin / 'pg_ctl'), '-D', str(self.pg_data), '-m', 'fast', '-t', '10', '-w', 'stop',
            ])
            self.pg_stop_command_exit_code = 0
        except subprocess.CalledProcessError as error:
            self.pg_stop_command_exit_code = error.returncode
            self.pg_cleanup_failure = 'pg_ctl_stop_failed'
            return False
        except Exception as error:
            self.pg_cleanup_failure = 'pg_ctl_stop_failed: ' + type(error).__name__
            return False
        if not self._prove_postmaster_terminated():
            return False
        self.pg_pid_termination_proven = True
        self.pg_stop_verified = True
        return True

    def postgres_cleanup_evidence(self):
        return {
            'postmasterPID': self.pg_postmaster_pid,
            'startupIdentity': self.pg_startup_identity,
            'pgCtlStopExitCode': self.pg_stop_command_exit_code,
            'ownedPIDTerminationProven': self.pg_pid_termination_proven,
            'failure': self.pg_cleanup_failure,
        }

    def start(self):
        bindir = self.run(['pg_config', '--bindir'])
        self.pg_bin = Path(bindir)
        required = ('initdb', 'pg_ctl', 'psql')
        if any(not (self.pg_bin / name).is_file() for name in required) or shutil.which('redis-server', path=self.env.get('PATH')) is None:
            raise RuntimeError('local isolated PostgreSQL 18 and Redis 8 executables are required')
        self.pg_port = self.unused_port()
        self.redis_port = self.unused_port()
        if self.pg_port == self.redis_port:
            self.redis_port = self.unused_port()
        pwfile = self.root / 'pg-superuser-password'
        pwfile.write_text(self.admin_password + '\n')
        pwfile.chmod(0o600)
        self.run([
            str(self.pg_bin / 'initdb'), '-D', str(self.pg_data), '-U', 'postgres',
            '--auth-local=trust', '--auth-host=scram-sha-256', '--pwfile=' + str(pwfile), '--no-instructions',
        ])
        pwfile.unlink()
        self.pg_log = (self.root / 'postgres.log').open('w', encoding='utf-8')
        self.files.append(self.pg_log)
        socket_dir = self.root / 'socket'
        socket_dir.mkdir(mode=0o700)
        self.started_pg = True
        try:
            self.run([
                str(self.pg_bin / 'pg_ctl'), '-D', str(self.pg_data), '-l', str(self.root / 'postgres.log'),
                '-o', f'-h 127.0.0.1 -p {self.pg_port} -c listen_addresses=127.0.0.1 -c unix_socket_directories={socket_dir}',
                '-w', 'start',
            ])
        except subprocess.CalledProcessError as error:
            log_path = self.root / 'postgres.log'
            tail = log_path.read_text(errors='replace')[-1800:] if log_path.exists() else ''
            try:
                self.pg_startup_identity = self._read_postmaster_identity()
                self.pg_postmaster_pid = self.pg_startup_identity['postmasterPID']
            except (OSError, RuntimeError) as identity_error:
                self.pg_cleanup_failure = 'could_not_record_postmaster_startup_identity: ' + str(identity_error)
            raise RuntimeError('owned PostgreSQL startup failed: ' + tail) from error
        try:
            self.pg_startup_identity = self._read_postmaster_identity()
            self.pg_postmaster_pid = self.pg_startup_identity['postmasterPID']
        except (OSError, RuntimeError) as error:
            self.pg_cleanup_failure = 'could_not_record_postmaster_startup_identity: ' + str(error)
            raise RuntimeError(self.pg_cleanup_failure) from error
        create_sql = (
            f"CREATE ROLE {self.role} LOGIN PASSWORD '{self.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n"
            f"CREATE DATABASE {self.database} OWNER {self.role};\n"
        )
        self.sql_admin(create_sql)
        assert self.sql('SELECT current_database(),current_user,rolsuper FROM pg_roles WHERE rolname=current_user;') == self.database + '|' + self.role + '|f'
        for directory in sorted((ROOT / 'prisma/migrations').iterdir()):
            migration = directory / 'migration.sql'
            if migration.is_file():
                self.sql(migration.read_text())

        redis_conf = self.root / 'redis.conf'
        redis_conf.write_text('\n'.join([
            'bind 127.0.0.1', 'protected-mode yes', f'port {self.redis_port}',
            f'requirepass {self.password}', 'save ""', 'appendonly no', 'daemonize no',
            f'dir {self.root}', 'logfile ""',
        ]) + '\n')
        redis_conf.chmod(0o600)
        self.redis_log = (self.root / 'redis.log').open('w', encoding='utf-8')
        self.files.append(self.redis_log)
        self.redis_process = subprocess.Popen(['redis-server', str(redis_conf)], env=self.env,
                                              stdout=self.redis_log, stderr=self.redis_log)
        self.processes.append(self.redis_process)
        deadline = time.time() + 10
        while time.time() < deadline:
            if self.redis_process.poll() is not None:
                raise RuntimeError('owned Redis process exited during startup')
            try:
                with socket.create_connection(('127.0.0.1', self.redis_port), timeout=.2) as conn:
                    conn.sendall(f'*2\r\n$4\r\nAUTH\r\n${len(self.password)}\r\n{self.password}\r\n'.encode())
                    if b'+OK' not in conn.recv(128):
                        raise RuntimeError('owned Redis authentication probe failed')
                    conn.sendall(b'*1\r\n$4\r\nPING\r\n')
                    if b'+PONG' in conn.recv(128):
                        break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('owned Redis did not become ready')
        self.env.update(
            DATABASE_URL=f'postgresql://{self.role}:{self.password}@127.0.0.1:{self.pg_port}/{self.database}?sslmode=disable',
            REDIS_URL=f'redis://default:{self.password}@127.0.0.1:{self.redis_port}/0',
            JWT_SECRET=self.jwt,
            SESSION_ENCRYPTION_KEY=self.jwt,
            GROWDESK_ENV='test',
            GROWDESK_GO_EXPERIMENTAL='1',
            GROWDESK_AI_BUDGET_UNIT='ai_run_attempt',
            GROWDESK_AI_BUDGET_PERIOD='utc_day',
            GROWDESK_AI_BUDGET_USER_LIMIT='100',
            GROWDESK_AI_BUDGET_FAMILY_LIMIT='1000',
            GROWDESK_AI_BUDGET_GLOBAL_LIMIT='10000',
            DB_POOL_MAX='10',
            HOST='127.0.0.1',
        )
        return self

    def serve(self, binary):
        return OwnedEnvironment.serve(self, binary)

    def close(self):
        for proc in reversed(self.processes):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        self._stop_owned_postgres()
        # Reuse only the base helper's API-process/log cleanup; this instance owns no containers.
        OwnedEnvironment.close(self)
        safe_root = self.root.parent == Path('/private/tmp') and self.root.name.startswith('growdesk-weather-owned-' + self.owner + '-')
        redis_stopped = self.redis_process is None or self.redis_process.poll() is not None
        if (safe_root and self.pg_stop_verified and redis_stopped and self.marker.is_file()
                and self.marker.read_text() == 'growdesk-weather-owned:' + self.owner + '\n'):
            shutil.rmtree(self.root)

    def cleanup_status(self):
        redis_stopped = self.redis_process is None or self.redis_process.poll() is not None
        return {
            'postgresStopped': self.pg_stop_verified,
            'redisStopped': redis_stopped,
            'ownedTempDirectoryRemoved': not self.root.exists(),
            'containersRemoved': True,
        }

    def stop_redis_for_test(self):
        if self.redis_process is None or self.redis_process.poll() is not None:
            raise RuntimeError('owned Redis is not running')
        self.redis_process.terminate()
        self.redis_process.wait(timeout=5)

    def set_weather_cache_entry(self, latitude, longitude, fetched_at, data):
        material = f'coords:{latitude:.6f}:{longitude:.6f}'
        digest = hashlib.sha256(material.encode()).hexdigest()
        key = 'growdesk:weather:v1:' + digest
        value = json.dumps({'fetchedAt': fetched_at, 'data': data}, ensure_ascii=False, separators=(',', ':'))
        parts = ('SET', key, value, 'EX', '86400')
        command = ('*' + str(len(parts)) + '\r\n').encode()
        for part in parts:
            encoded = part.encode()
            command += ('$' + str(len(encoded)) + '\r\n').encode() + encoded + b'\r\n'
        with socket.create_connection(('127.0.0.1', self.redis_port), timeout=2) as connection:
            auth = ('AUTH', self.password)
            auth_command = ('*2\r\n$4\r\nAUTH\r\n$' + str(len(self.password)) + '\r\n' + self.password + '\r\n').encode()
            connection.sendall(auth_command)
            auth_result = connection.recv(128)
            if not auth_result.startswith(b'+OK'):
                raise RuntimeError('owned Redis authentication failed while setting weather test fixture')
            connection.sendall(command)
            if not connection.recv(128).startswith(b'+OK'):
                raise RuntimeError('owned Redis rejected the expired weather cache fixture')


class VirtualWeatherProvider:
    def __init__(self):
        self.lock = threading.Lock()
        self.counts = {'/v1/search': 0, '/v1/forecast': 0, '/v1/air-quality': 0}
        self.requests = []
        self.delay_seconds = 0.0
        self.forecast_status = 200
        self.air_status = 200
        self.missing_metrics = False
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def _json(self, status, payload):
                encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode()
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_GET(self):
                split = urlsplit(self.path)
                query = parse_qs(split.query)
                if split.path.startswith('/__control/'):
                    self._json(404, {'error': 'not found'})
                    return
                with owner.lock:
                    owner.counts[split.path] = owner.counts.get(split.path, 0) + 1
                    owner.requests.append((split.path, query))
                    delay = owner.delay_seconds if split.path == '/v1/forecast' else 0.0
                    status = owner.forecast_status if split.path == '/v1/forecast' else 200
                    air_status = owner.air_status
                    missing = owner.missing_metrics
                if delay:
                    time.sleep(delay)
                if split.path == '/v1/search':
                    city = query.get('name', [''])[0]
                    if city == 'NoSuchCity':
                        self._json(200, {'results': []})
                    else:
                        self._json(200, {'results': [{
                            'id': 999001,
                            'name': city,
                            'latitude': 35.68,
                            'longitude': 139.69,
                            'country': 'Japan',
                            'admin1': 'Tokyo',
                            'timezone': 'Asia/Tokyo',
                        }]})
                    return
                if split.path == '/v1/forecast':
                    if status != 200:
                        self._json(status, {'error': 'fixture outage'})
                        return
                    lon = float(query.get('longitude', ['120.62'])[0])
                    timezone = 'America/Los_Angeles' if lon < -100 else ('Asia/Tokyo' if lon > 130 else 'Asia/Shanghai')
                    if missing:
                        current = {'time': '2026-10-03T22:00'}
                        daily = {'time': ['2026-10-03']}
                        hourly = {'time': ['2026-10-03T23:00', '2026-10-04T00:00']}
                    else:
                        forecast_times = [f'2026-10-{day:02d}T{hour:02d}:00' for day in (3, 4) for hour in range(24)]
                        current = {
                            'time': '2026-10-03T22:00',
                            'temperature_2m': 19.5,
                            'relative_humidity_2m': 71,
                            'precipitation': 0,
                            'weather_code': 2,
                            'wind_speed_10m': 6,
                        }
                        daily = {
                            'time': ['2026-10-03'],
                            'uv_index_max': [3.5],
                            'precipitation_probability_max': [40],
                        }
                        hourly = {
                            'time': forecast_times,
                            'temperature_2m': [18 - (index % 5) for index in range(len(forecast_times))],
                            'precipitation_probability': [20 + (index % 10) for index in range(len(forecast_times))],
                            'weather_code': [2 if index % 2 == 0 else 3 for index in range(len(forecast_times))],
                            'uv_index': [2 for _ in forecast_times],
                        }
                    self._json(200, {
                        'latitude': float(query.get('latitude', ['31.3'])[0]),
                        'longitude': lon,
                        'timezone': timezone,
                        'current': current,
                        'daily': daily,
                        'hourly': hourly,
                    })
                    return
                if split.path == '/v1/air-quality':
                    if air_status != 200:
                        self._json(air_status, {'error': 'fixture outage'})
                        return
                    if missing:
                        self._json(200, {
                            'timezone': 'Asia/Shanghai',
                            'current': {'time': '2026-10-03T22:00'},
                            'hourly': {'time': ['2026-10-03T23:00']},
                        })
                    else:
                        air_times = [f'2026-10-{day:02d}T{hour:02d}:00' for day, hour in ((3, 22), (3, 23), (4, 0), (4, 1), (4, 2), (4, 3), (4, 4), (4, 5))]
                        self._json(200, {
                            'timezone': 'Asia/Shanghai',
                            'current': {'time': '2026-10-03T22:00', 'european_aqi': 31, 'uv_index': 5.5},
                            'hourly': {'time': air_times, 'european_aqi': [31, 30, 25, 24, 23, 22, 21, 20], 'uv_index': [5.5, 4, 3, 2, 1, 0, 0, 0]},
                        })
                    return
                self._json(404, {'error': 'not found'})

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        assert host == '127.0.0.1' and port not in (3088, 3089, 60756, 49762, 57006)
        self.origin = f'http://{host}:{port}'

    def control(self, **updates):
        with self.lock:
            for key, value in updates.items():
                setattr(self, key, value)

    def counts_snapshot(self):
        with self.lock:
            return dict(self.counts)

    def requests_snapshot(self):
        with self.lock:
            return [(path, {key: list(value) for key, value in query.items()}) for path, query in self.requests]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise RuntimeError('virtual provider thread did not stop')


def query(city=None, lat=None, lon=None):
    if city is not None:
        from urllib.parse import quote
        return '?city=' + quote(city, safe='')
    return f'?lat={lat}&lon={lon}'


def run_tests(owned, base, provider):
    username = 'test_weather_' + owned.owner
    password = 'test_password_' + secrets.token_hex(12)
    registered = expect(base, 'POST', '/api/v1/auth/register', 201, {
        'username': username, 'password': password, 'displayName': 'test weather user', 'deviceLabel': 'test_weather_http',
    })['data']
    token = registered['accessToken']
    assert username.startswith('test_')
    checks = []

    before = provider.counts_snapshot()
    expect(base, 'GET', '/api/v1/weather?city=Tokyo', 401)
    assert provider.counts_snapshot() == before, 'unauthenticated request reached weather provider'
    checks.append('unauthenticated request rejected before provider access')

    first = expect(base, 'GET', '/api/v1/weather', 200, token=token)['data']
    assert first['city'] == '苏州' and first['sources']['location'] == 'legacy_default_suzhou'
    assert first['cacheState'] == 'miss' and first['isStale'] is False
    assert first['temperature'] == 19.5 and first['humidity'] == 71
    assert first['uv'] == 3.5 and first['rainProbability'] == 40
    assert first['timezone'] == 'Asia/Shanghai' and first['units']['temperature'] == '°C'
    assert first['units']['airQuality'] == 'European AQI points'
    assert first['sources']['weather'] == 'open_meteo_forecast' and first['sources']['outdoorAdvice'] == 'growdesk_weather_rules_v1'
    assert first['fetchedAt'].endswith('Z')
    first_requests = provider.requests_snapshot()
    assert not any(path == '/v1/search' for path, _query in first_requests), 'default city unexpectedly geocoded'
    default_forecast = [params for path, params in first_requests if path == '/v1/forecast'][-1]
    assert default_forecast['latitude'] == ['31.300000'] and default_forecast['longitude'] == ['120.620000']
    assert default_forecast['forecast_days'] == ['2']
    first_counts = provider.counts_snapshot()
    hit = expect(base, 'GET', '/api/v1/weather', 200, token=token)['data']
    assert hit['cacheState'] == 'hit' and provider.counts_snapshot() == first_counts
    checks.append('default Suzhou strategy and Redis fresh-cache hit')

    city = expect(base, 'GET', '/api/v1/weather' + query(city='Tokyo'), 200, token=token)['data']
    assert city['city'] == 'Tokyo, Japan' and city['timezone'] == 'Asia/Tokyo', f"unexpected geocoded city/timezone: {city['city']!r} / {city['timezone']!r}"
    assert city['sources']['location'] == 'open_meteo_geocoding'
    assert city['airQualityScale'] == 'european_aqi' and city['airQualityCategory'] == 'fair'
    assert '欧洲AQI' in city['airQuality'] and 'open_meteo_air_quality_cams_european_aqi' == city['sources']['airQuality']
    geocoding_query = [params for path, params in provider.requests_snapshot() if path == '/v1/search'][-1]
    assert geocoding_query['name'] == ['Tokyo'] and 'latitude' not in geocoding_query and 'longitude' not in geocoding_query
    checks.append('city geocoding and explicitly European AQI scale/category/source')

    before = provider.counts_snapshot()
    coords = expect(base, 'GET', '/api/v1/weather' + query(lat='37.77', lon='-122.42'), 200, token=token)['data']
    after = provider.counts_snapshot()
    assert coords['city'] == '当前位置' and coords['timezone'] == 'America/Los_Angeles'
    assert coords['sources']['location'] == 'coordinates' and after['/v1/search'] == before['/v1/search']
    hours = coords['hourlyForecast']
    assert [row['time'] for row in hours] == ['22:00', '23:00', '00:00', '01:00', '02:00', '03:00', '04:00', '05:00']
    assert hours[2]['dateTime'].startswith('2026-10-04T00:00:00-07:00')
    assert hours[0]['uv'] == 5.5 and hours[1]['uv'] == 4
    assert coords['currentPrecipitationProbability'] == 22
    checks.append('coordinate lookup skips geocoding and hourly local dates cross midnight')

    before = provider.counts_snapshot()
    for invalid_query in (
        '?lat=31.3',
        '?lon=120.62',
        '?city=Tokyo&lat=31&lon=120',
        '?lat=90.1&lon=120',
        '?lat=1&lat=2&lon=3',
        '?lat=&lon=',
        '?city=',
        '?city=' + ('x' * 101),
        '?unit=fahrenheit',
        '?city=NoSuchCity',
    ):
        expected = 404 if invalid_query == '?city=NoSuchCity' else 400
        result = expect(base, 'GET', '/api/v1/weather' + invalid_query, expected, token=token)
        assert result.get('error', {}).get('code') in ('WEATHER_CITY_NOT_FOUND', 'BAD_REQUEST', 'FST_ERR_VALIDATION')
    after = provider.counts_snapshot()
    assert after['/v1/search'] == before['/v1/search'] + 1
    assert after['/v1/forecast'] == before['/v1/forecast']
    checks.append('paired coordinates, exclusivity, bounds, duplicates, and unmatched city validation')

    provider.control(missing_metrics=True)
    missing = expect(base, 'GET', '/api/v1/weather?lat=5.5&lon=6.5', 200, token=token)['data']
    assert missing['uv'] is None and missing['uvCurrent'] is None and missing['airQualityIndex'] is None
    assert missing['airQuality'] is None and missing['airQualityCategory'] is None
    assert missing['temperature'] is None and missing['humidity'] is None
    assert missing['sources']['airQuality'] == 'unavailable'
    provider.control(missing_metrics=False)
    checks.append('missing weather, UV and AQI data remain null, never zero/good')

    provider.control(air_status=503)
    partial_air = expect(base, 'GET', '/api/v1/weather?lat=5.6&lon=6.6', 200, token=token)['data']
    assert partial_air['temperature'] == 19.5 and partial_air['airQualityIndex'] is None
    assert partial_air['airQuality'] is None and partial_air['airQualityCategory'] is None
    assert partial_air['sources']['airQuality'] == 'unavailable'
    provider.control(air_status=200)
    checks.append('air-quality provider failure preserves weather while marking AQI unavailable')

    provider.control(forecast_status=503)
    unavailable = expect(base, 'GET', '/api/v1/weather?lat=4.5&lon=6.5', 502, token=token)
    assert unavailable['error']['code'] == 'WEATHER_PROVIDER_UNAVAILABLE'
    provider.control(forecast_status=200)
    checks.append('provider failure returns a bounded error without fabricated values')

    provider.control(delay_seconds=4.2)
    timeout_started = time.monotonic()
    timeout = expect(base, 'GET', '/api/v1/weather?lat=3.4&lon=6.5', 502, token=token)
    timeout_elapsed = time.monotonic() - timeout_started
    assert timeout['error']['code'] == 'WEATHER_PROVIDER_UNAVAILABLE' and timeout_elapsed <= 4.0
    provider.control(delay_seconds=0)
    checks.append('provider timeout returns bounded 502')

    stale_query = '/api/v1/weather?lat=2.3&lon=6.5'
    expect(base, 'GET', stale_query, 200, token=token)
    time.sleep(1.2)
    provider.control(forecast_status=503)
    stale = expect(base, 'GET', stale_query, 200, token=token)['data']
    assert stale['cacheState'] == 'stale' and stale['isStale'] is True and stale['staleAgeSeconds'] >= 1
    provider.control(forecast_status=200)
    checks.append('expired Redis cache is served only after provider failure and visibly marked stale')

    if isinstance(owned, LocalOwnedEnvironment):
        expired_path = '/api/v1/weather?lat=2.4&lon=6.6'
        expired_data = expect(base, 'GET', expired_path, 200, token=token)['data']
        too_old = (datetime.now(timezone.utc) - timedelta(hours=25)).isoformat(timespec='seconds').replace('+00:00', 'Z')
        expired_data['fetchedAt'] = too_old
        owned.set_weather_cache_entry(2.4, 6.6, too_old, expired_data)
        provider.control(forecast_status=503)
        expired = expect(base, 'GET', expired_path, 502, token=token)
        assert expired['error']['code'] == 'WEATHER_PROVIDER_UNAVAILABLE'
        provider.control(forecast_status=200)
        checks.append('cache older than 24 hours is rejected after provider failure')

    invalid_number = expect(base, 'GET', '/api/v1/weather?lat=NaN&lon=1', 400, token=token)
    assert invalid_number['error']['code'] == 'FST_ERR_VALIDATION'
    checks.append('non-finite numeric query rejected')
    if isinstance(owned, LocalOwnedEnvironment):
        owned.stop_redis_for_test()
        cache_down = expect(base, 'GET', '/api/v1/weather?lat=1.3&lon=2.5', 200, token=token)['data']
        assert cache_down['cacheState'] == 'unavailable' and cache_down['isStale'] is False
        checks.append('provider data remains available and cache state is exposed when owned Redis is down')
    return {'checks': checks, 'checkCount': len(checks), 'usernamePrefix': 'test_weather_', 'userID': registered['user']['id']}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--evidence-dir', type=Path, required=True)
    args = parser.parse_args()
    if shutil.which('docker'):
        owned = OwnedEnvironment()
        stack_kind = 'owned_postgres18_redis8_containers'
    else:
        owned = LocalOwnedEnvironment()
        stack_kind = 'owned_local_postgres18_redis8_processes'
    owned.env = {k: v for k, v in owned.env.items() if not k.startswith(('WEATHER_', 'OPEN_METEO_'))}
    fixture = VirtualWeatherProvider()
    status = 'failed'
    result = None
    error_message = None
    failure_location = None
    cleanup = {'apiStopped': False, 'fixtureStopped': False, 'containersRemoved': False}

    def interrupted(signum, frame):
        raise KeyboardInterrupt(f'signal {signum}')

    signal.signal(signal.SIGTERM, interrupted)
    try:
        owned.start()
        owned.env.update(WEATHER_TEST_PROVIDER_ORIGIN=fixture.origin, WEATHER_CACHE_FRESH_SECONDS='1')
        base = owned.serve(args.binary)
        result = run_tests(owned, base, fixture)
        status = 'passed'
    except Exception as error:
        error_message = type(error).__name__ + ': ' + str(error)
        frames = traceback.extract_tb(error.__traceback__)
        if frames:
            frame = frames[-1]
            failure_location = f'{Path(frame.filename).name}:{frame.lineno} in {frame.name}'
        for secret in (getattr(owned, 'password', ''), getattr(owned, 'admin_password', ''), getattr(owned, 'jwt', '')):
            if secret:
                error_message = error_message.replace(secret, '[redacted]')
    finally:
        container_ids = list(owned.containers)
        process_refs = list(owned.processes)
        with contextlib.suppress(Exception):
            fixture.close()
            cleanup['fixtureStopped'] = True
        owned.close()
        cleanup['apiStopped'] = all(p.poll() is not None for p in process_refs)
        checks = []
        for cid in container_ids:
            checked = subprocess.run(['docker', 'inspect', cid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     check=False, env=owned.env)
            checks.append(checked.returncode != 0)
        cleanup['containersRemoved'] = all(checks) if checks else True
        if isinstance(owned, LocalOwnedEnvironment):
            cleanup.update(owned.cleanup_status())
        if not all(cleanup.values()):
            status = 'cleanup_failed'
        args.evidence_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            'status': status,
            'runID': owned.owner,
            'testPrincipal': (result or {}).get('usernamePrefix', 'test_weather_') + owned.owner,
            'userID': (result or {}).get('userID'),
            'checks': (result or {}).get('checks', []),
            'checkCount': (result or {}).get('checkCount', 0),
            'error': error_message,
            'failureLocation': failure_location,
            'provider': 'loopback_virtual_open_meteo_protocol_fixture_only',
            'stackKind': stack_kind,
            'apiOrigin': 'loopback_owned_api_only',
            'cleanup': cleanup,
            'postgresCleanupEvidence': owned.postgres_cleanup_evidence() if isinstance(owned, LocalOwnedEnvironment) else None,
            'noProductionOrExternalProvider': True,
            'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        }
        result_path = args.evidence_dir / f'http-{owned.owner}.json'
        result_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n')
        print(json.dumps({'status': status, 'evidence': str(result_path), 'checks': payload['checkCount'], 'cleanup': cleanup}, ensure_ascii=False), flush=True)
    if status != 'passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
