#!/usr/bin/env python3
"""Real HTTP vaccine-record edit checks against an owned local PG/Redis/MinIO stack.

No externally supplied database URLs, account credentials, provider keys, or
service endpoints are accepted. Every account and tenant is created in this
run's disposable test_ database; the server is loopback-only and no worker is
started.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence/tasks/IOS_WEB_PARITY_20261002/vaccine-edit"
RESERVED_PORTS = {3088, 3089, 60756}


def clean_parent_env() -> dict[str, str]:
    """Keep only toolchain/runtime basics; drop inherited service/provider config."""
    keep = {
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", "GOPATH",
        "GOMODCACHE", "GOCACHE", "GOFLAGS", "CGO_ENABLED", "SDKROOT",
        "DEVELOPER_DIR", "SYSTEMROOT",
    }
    return {key: value for key, value in os.environ.items() if key in keep}


def free_loopback_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    if port in RESERVED_PORTS or port in {5432, 6379, 9000, 9001}:
        return free_loopback_port()
    return port


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hmac_sha256(key: bytes, value: str) -> bytes:
    return hmac.new(key, value.encode(), hashlib.sha256).digest()


def create_minio_bucket(endpoint: str, bucket: str, access: str, secret: str) -> None:
    """Create the owned bucket with one AWS SigV4 request; no credential CLI args."""
    now = datetime.now(timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    day = now.strftime("%Y%m%d")
    payload_hash = hashlib.sha256(b"").hexdigest()
    parsed = urllib.parse.urlsplit(endpoint)
    path = "/" + urllib.parse.quote(bucket, safe="-_.~")
    host = parsed.netloc
    canonical_headers = (
        f"host:{host}\n"
        f"x-amz-content-sha256:{payload_hash}\n"
        f"x-amz-date:{stamp}\n"
    )
    signed_headers = "host;x-amz-content-sha256;x-amz-date"
    canonical = f"PUT\n{path}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    scope = f"{day}/us-east-1/s3/aws4_request"
    string_to_sign = "AWS4-HMAC-SHA256\n" + stamp + "\n" + scope + "\n" + hashlib.sha256(canonical.encode()).hexdigest()
    key = hmac_sha256(("AWS4" + secret).encode(), day)
    key = hmac_sha256(key, "us-east-1")
    key = hmac_sha256(key, "s3")
    key = hmac_sha256(key, "aws4_request")
    signature = hmac_sha256(key, string_to_sign).hex()
    authorization = (
        f"AWS4-HMAC-SHA256 Credential={access}/{scope}, "
        f"SignedHeaders={signed_headers}, Signature={signature}"
    )
    request = urllib.request.Request(
        endpoint.rstrip("/") + path,
        data=b"",
        method="PUT",
        headers={
            "Authorization": authorization,
            "x-amz-content-sha256": payload_hash,
            "x-amz-date": stamp,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            if response.status not in (200, 204):
                raise RuntimeError("owned MinIO bucket creation returned unexpected status")
    except (urllib.error.HTTPError, urllib.error.URLError) as error:
        raise RuntimeError("owned MinIO bucket creation failed") from error


def redis_resp(port: int, password: str, *parts: str) -> str:
    with socket.create_connection(("127.0.0.1", port), timeout=1) as sock:
        sock.settimeout(1)
        messages = []
        if password:
            messages.append(("AUTH", "default", password))
        messages.append(parts)
        for message in messages:
            wire = f"*{len(message)}\r\n".encode()
            for value in message:
                raw = value.encode()
                wire += f"${len(raw)}\r\n".encode() + raw + b"\r\n"
            sock.sendall(wire)
            response = b""
            while not response.endswith(b"\r\n"):
                chunk = sock.recv(1)
                if not chunk:
                    raise RuntimeError("owned Redis closed readiness connection")
                response += chunk
            if response.startswith(b"-"):
                raise RuntimeError("owned Redis rejected readiness command")
        return response.decode(errors="replace").strip()


class OwnedStack:
    def __init__(self) -> None:
        self.owner = secrets.token_hex(7)
        self.admin_role = "test_admin_vaccine_" + self.owner
        self.app_role = "test_app_vaccine_" + self.owner
        self.database = "test_vaccine_edit_" + self.owner
        self.pg_password = secrets.token_hex(24)
        self.redis_password = secrets.token_hex(24)
        self.jwt = secrets.token_hex(32)
        self.s3_access = "test_s3_" + self.owner
        self.s3_secret = secrets.token_hex(24)
        self.temp = tempfile.TemporaryDirectory(prefix="growdesk-vaccine-edit-")
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.base_env = clean_parent_env()
        self.processes: list[subprocess.Popen[bytes]] = []
        self.pg_port = free_loopback_port()
        self.redis_port = free_loopback_port()
        self.s3_port = free_loopback_port()
        self.s3_console_port = free_loopback_port()
        self.api_port = free_loopback_port()
        self.pg_data = self.root / "postgres"
        self.pg_socket = self.root / "pgsocket"
        self.minio_data = self.root / "minio"
        self.pg_log = self.root / "postgres.log"
        self.redis_log = self.root / "redis.log"
        self.minio_log = self.root / "minio.log"
        self.api_log = self.root / "api.log"
        self.migrated: list[str] = []
        self.cleanup: dict[str, object] = {}
        self.api_env: dict[str, str] = {}
        self.base = ""

    def _tool(self, name: str) -> str:
        locations = {
            "initdb": "/opt/homebrew/bin/initdb",
            "pg_ctl": "/opt/homebrew/bin/pg_ctl",
            "psql": "/opt/homebrew/bin/psql",
            "postgres": "/opt/homebrew/bin/postgres",
            "redis-server": "/opt/homebrew/bin/redis-server",
            "minio": "/opt/homebrew/bin/minio",
            "go": "/opt/homebrew/bin/go",
        }
        candidate = Path(locations[name])
        resolved = candidate.resolve() if candidate.exists() else Path(shutil.which(name) or "")
        if not resolved.is_file() or not os.access(resolved, os.X_OK):
            raise RuntimeError(f"required local tool is unavailable: {name}")
        return str(resolved)

    def _run(self, argv: list[str], *, env: dict[str, str] | None = None, input_text: str | None = None,
             label: str) -> str:
        try:
            result = subprocess.run(
                argv, input=input_text, text=True, capture_output=True,
                env=env or self.base_env, check=False, cwd=ROOT,
            )
        except OSError as error:
            raise RuntimeError(f"{label}: local process could not start") from error
        if result.returncode != 0:
            raise RuntimeError(f"{label}: process exited {result.returncode}")
        return result.stdout.strip()

    def _write_private(self, path: Path, content: str) -> None:
        path.write_text(content)
        path.chmod(0o600)

    def _pg_env(self, user: str, database: str, password: str | None) -> dict[str, str]:
        env = dict(self.base_env)
        env.update({
            "PGHOST": "127.0.0.1", "PGPORT": str(self.pg_port),
            "PGUSER": user, "PGDATABASE": database,
            "PGSSLMODE": "disable", "PGCONNECT_TIMEOUT": "3",
        })
        if password is not None:
            env["PGPASSWORD"] = password
        return env

    def _psql(self, sql: str, *, user: str, database: str, password: str | None,
              label: str, socket: bool = False) -> str:
        env = self._pg_env(user, database, password)
        args = [self._tool("psql"), "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"]
        if socket:
            args += ["-h", str(self.pg_socket)]
        args += ["-f", "-"]
        return self._run(args, env=env, input_text=sql, label=label)

    def start(self) -> None:
        self.pg_data.mkdir(mode=0o700)
        self.pg_socket.mkdir(mode=0o700)
        self.minio_data.mkdir(mode=0o700)
        self._run([
            self._tool("initdb"), "-D", str(self.pg_data), "--username", self.admin_role,
            "--auth-local=trust", "--auth-host=scram-sha-256", "--no-instructions",
        ], label="initialize isolated PostgreSQL")
        options = (
            f"-h 127.0.0.1 -p {self.pg_port} -k {self.pg_socket} "
            "-c listen_addresses=127.0.0.1 -c log_statement=none -c log_connections=off "
            "-c log_error_verbosity=verbose"
        )
        self._run([
            self._tool("pg_ctl"), "-D", str(self.pg_data), "-l", str(self.pg_log),
            "-o", options, "-w", "start",
        ], label="start isolated PostgreSQL")
        self._psql(
            f"CREATE ROLE {self.app_role} LOGIN PASSWORD '{self.pg_password}' "
            "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;",
            user=self.admin_role, database="postgres", password=None,
            label="create isolated PostgreSQL role", socket=True,
        )
        self._psql(
            f"CREATE DATABASE {self.database} OWNER {self.app_role};",
            user=self.admin_role, database="postgres", password=None,
            label="create isolated PostgreSQL database", socket=True,
        )
        identity = self._psql(
            "SELECT current_database()||'|'||current_user||'|'||rolsuper::text "
            "FROM pg_roles WHERE rolname=current_user;",
            user=self.app_role, database=self.database, password=self.pg_password,
            label="verify isolated PostgreSQL identity",
        )
        if identity != f"{self.database}|{self.app_role}|false":
            raise RuntimeError("PostgreSQL host/database/role ownership guard failed")

        redis_conf = self.root / "redis.conf"
        self._write_private(redis_conf, "\n".join([
            "bind 127.0.0.1", f"port {self.redis_port}", "protected-mode yes",
            f'requirepass "{self.redis_password}"', "save \"\"", "appendonly no",
            f'dir "{self.root}"', "daemonize no", "loglevel warning", "",
        ]))
        self._spawn(
            [self._tool("redis-server"), str(redis_conf)], self.redis_log,
            env=dict(self.base_env), label="isolated Redis",
        )
        self._wait_until(lambda: redis_resp(self.redis_port, self.redis_password, "PING") == "+PONG",
                         "isolated Redis readiness")

        minio_env = dict(self.base_env)
        minio_env.update({
            "MINIO_ROOT_USER": self.s3_access,
            "MINIO_ROOT_PASSWORD": self.s3_secret,
            "MINIO_BROWSER": "off",
            "MINIO_UPDATE": "off",
        })
        self._spawn([
            self._tool("minio"), "server", str(self.minio_data),
            "--address", f"127.0.0.1:{self.s3_port}",
            "--console-address", f"127.0.0.1:{self.s3_console_port}",
        ], self.minio_log, env=minio_env, label="isolated MinIO")
        s3_endpoint = f"http://127.0.0.1:{self.s3_port}"
        self._wait_until(lambda: self._http_status(s3_endpoint + "/minio/health/ready") == 200,
                         "isolated MinIO readiness")
        self.s3_bucket = "test-vaccine-edit-" + self.owner
        create_minio_bucket(s3_endpoint, self.s3_bucket, self.s3_access, self.s3_secret)

        for migration in sorted((ROOT / "prisma/migrations").glob("*/migration.sql")):
            self._psql(
                migration.read_text(), user=self.app_role, database=self.database,
                password=self.pg_password, label=f"apply Prisma migration {migration.parent.name}",
            )
            self.migrated.append(migration.parent.name)

        s3_env = dict(self.base_env)
        s3_env.update({
            "DATABASE_URL": f"postgresql://{self.app_role}:{self.pg_password}@127.0.0.1:{self.pg_port}/{self.database}?sslmode=disable",
            "REDIS_URL": f"redis://default:{self.redis_password}@127.0.0.1:{self.redis_port}/0",
            "JWT_SECRET": self.jwt,
            "SESSION_ENCRYPTION_KEY": self.jwt,
            "GROWDESK_ENV": "test",
            "GROWDESK_GO_EXPERIMENTAL": "1",
            "DB_POOL_MAX": "12",
            "HOST": "127.0.0.1",
            "PORT": str(self.api_port),
            "PUBLIC_BASE_URL": f"http://127.0.0.1:{self.api_port}",
            "S3_BUCKET": self.s3_bucket,
            "S3_ENDPOINT": s3_endpoint,
            "S3_REGION": "us-east-1",
            "AWS_ACCESS_KEY_ID": self.s3_access,
            "AWS_SECRET_ACCESS_KEY": self.s3_secret,
            "AWS_EC2_METADATA_DISABLED": "true",
            "GROWDESK_AI_PROVIDER": "fixture",
            "GROWDESK_AI_FIXTURE_RESPONSE": json.dumps({
                "text": "test_only_isolated_ai_response", "actions": [],
            }, separators=(",", ":")),
        })
        self.api_env = s3_env
        self._run([
            self._tool("go"), "build", "-trimpath",
            f"-ldflags=-X=main.revision={self._head()}",
            "-o", str(self.root / "growdesk-api"), "./cmd/growdesk-api",
        ], env=self.base_env, label="build vaccine-edit API")
        self._run([
            self._tool("go"), "build", "-trimpath", "-o", str(self.root / "growdesk-migrate"),
            "./cmd/growdesk-migrate",
        ], env=self.base_env, label="build native migrator")
        self._run([str(self.root / "growdesk-migrate")], env=self.api_env,
                  label="apply isolated native migrations")
        self._spawn([str(self.root / "growdesk-api")], self.api_log,
                    env=self.api_env, label="isolated vaccine-edit API")
        self.base = f"http://127.0.0.1:{self.api_port}"
        self._wait_until(lambda: self._http_status(self.base + "/health/ready") == 200,
                         "isolated API readiness")
        self._verify_guards()

    def _head(self) -> str:
        return self._run(["git", "rev-parse", "HEAD"], label="read checkout revision")

    def _spawn(self, argv: list[str], log_path: Path, *, env: dict[str, str], label: str) -> None:
        log = log_path.open("wb")
        os.chmod(log_path, 0o600)
        try:
            process = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=log, stderr=log)
        except OSError as error:
            log.close()
            raise RuntimeError(f"{label}: local process could not start") from error
        # Retain the open descriptor until process exit to keep logs private and
        # avoid exposing environment or command-line credentials in diagnostics.
        setattr(process, "_evidence_log", log)
        self.processes.append(process)

    def _wait_until(self, probe, label: str) -> None:
        for _ in range(120):
            if any(process.poll() is not None for process in self.processes):
                raise RuntimeError(f"{label}: owned process exited early")
            try:
                if probe():
                    return
            except (OSError, TimeoutError, urllib.error.URLError):
                pass
            time.sleep(0.1)
        raise RuntimeError(f"{label}: readiness timed out")

    @staticmethod
    def _http_status(url: str) -> int | None:
        try:
            request = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(request, timeout=1) as response:
                return response.status
        except urllib.error.HTTPError as error:
            return error.code
        except urllib.error.URLError:
            return None

    def _verify_guards(self) -> None:
        parsed_db = urllib.parse.urlsplit(self.api_env["DATABASE_URL"])
        parsed_redis = urllib.parse.urlsplit(self.api_env["REDIS_URL"])
        parsed_s3 = urllib.parse.urlsplit(self.api_env["S3_ENDPOINT"])
        if parsed_db.hostname != "127.0.0.1" or parsed_db.path.lstrip("/") != self.database:
            raise RuntimeError("API PostgreSQL URL guard failed")
        if urllib.parse.unquote(parsed_db.username or "") != self.app_role:
            raise RuntimeError("API PostgreSQL role guard failed")
        if parsed_redis.hostname != "127.0.0.1" or int(parsed_redis.port or 0) != self.redis_port:
            raise RuntimeError("API Redis endpoint guard failed")
        if parsed_s3.hostname != "127.0.0.1" or int(parsed_s3.port or 0) != self.s3_port:
            raise RuntimeError("API object storage endpoint guard failed")
        if not all(value.startswith("test_") for value in (self.admin_role, self.app_role, self.database, self.s3_access)):
            raise RuntimeError("owned principal prefix guard failed")
        if self.api_port in RESERVED_PORTS:
            raise RuntimeError("API port guard failed")

    def sql(self, sql: str) -> str:
        return self._psql(sql, user=self.app_role, database=self.database,
                          password=self.pg_password, label="query owned test database")

    def close(self) -> None:
        for process in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            log = getattr(process, "_evidence_log", None)
            if log:
                log.close()
        pg_stopped = True
        if self.pg_data.exists():
            try:
                self._run([
                    self._tool("pg_ctl"), "-D", str(self.pg_data), "-m", "fast", "-w", "stop",
                ], label="stop owned PostgreSQL")
            except RuntimeError:
                pg_stopped = not (self.pg_data / "postmaster.pid").exists()
        children_stopped = all(process.poll() is not None for process in self.processes)
        self.database_diagnostics = self._safe_database_diagnostics()
        try:
            self.temp.cleanup()
        finally:
            self.cleanup = {
                "apiStopped": children_stopped,
                "redisAndMinioStopped": children_stopped,
                "postgresStopped": pg_stopped,
                "privateTempDirectoryRemoved": not self.root.exists(),
                "tenantDataRemovedWithOwnedDatabase": not self.root.exists(),
            }

    def _safe_database_diagnostics(self) -> list[dict[str, object]]:
        """Keep only SQLSTATE and a fixed allowlisted category, never SQL/messages."""
        if not self.pg_log.exists():
            return []
        categories = {
            "23502": "not-null-constraint", "23503": "foreign-key-constraint",
            "23505": "unique-constraint", "23514": "check-constraint",
            "22P02": "invalid-text-representation", "22007": "invalid-datetime-format",
            "22008": "datetime-field-overflow", "25P02": "transaction-aborted",
            "28P01": "password-authentication", "28000": "authorization-error",
            "42P01": "undefined-table", "42703": "undefined-column",
            "42883": "undefined-function-or-operator", "42P10": "invalid-conflict-target",
            "0A000": "unsupported-feature", "P0001": "application-raised-exception",
        }
        counts: dict[tuple[str, str], int] = {}
        error_lines = 0
        for line in self.pg_log.read_text(errors="replace").splitlines():
            if "ERROR:" in line or "FATAL:" in line:
                error_lines += 1
            match = re.search(r"\b(?:ERROR|FATAL):\s+([A-Z0-9]{5}):", line)
            state = match.group(1) if match else ""
            if state:
                pair = (state, categories.get(state, "database-error"))
                counts[pair] = counts.get(pair, 0) + 1
        result: list[dict[str, object]] = [
            {"sqlState": state, "category": category, "count": count}
            for (state, category), count in sorted(counts.items())
        ]
        if error_lines:
            result.append({"category": "postgres-error-lines", "count": error_lines})
        return result


def request(base: str, method: str, path: str, *, body=None, token=None, key=None):
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    if key:
        headers["Idempotency-Key"] = key
    encoded = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    req = urllib.request.Request(base + path, data=encoded, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            raw = response.read()
            return response.status, json.loads(raw), response.headers.get("X-Request-ID")
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read()), error.headers.get("X-Request-ID")


def expect(observations: list[dict[str, object]], base: str, method: str, path: str,
           status: int, *, body=None, token=None, key=None, name: str):
    actual, payload, request_id = request(base, method, path, body=body, token=token, key=key)
    if actual != status:
        code = payload.get("error", {}).get("code", "unexpected_success") if isinstance(payload, dict) else "invalid_response"
        raise AssertionError(f"{name}: expected HTTP {status}, got {actual} ({code}, requestId={request_id})")
    code = payload.get("error", {}).get("code") if status >= 400 and isinstance(payload, dict) else None
    # Signed sync cursors are request capabilities; retain only the route in evidence.
    observations.append({"case": name, "method": method, "path": path.split("?", 1)[0], "status": actual, "errorCode": code})
    return payload


def register(observations, base, username, password):
    return expect(observations, base, "POST", "/api/v1/auth/register", 201, name="register " + username,
                  body={"username": username, "password": password, "displayName": "Test Vaccine Edit", "deviceLabel": "test_vaccine_edit"})["data"]


def exercise(stack: OwnedStack) -> dict[str, object]:
    observations: list[dict[str, object]] = []
    suffix = stack.owner
    owner_name = "test_vaccine_edit_" + suffix + "_owner"
    outsider_name = "test_vaccine_edit_" + suffix + "_outsider"
    stranger_name = "test_vaccine_edit_" + suffix + "_stranger"
    owner_password = "test_pw_" + secrets.token_hex(16)
    outsider_password = "test_pw_" + secrets.token_hex(16)
    stranger_password = "test_pw_" + secrets.token_hex(16)
    owner = register(observations, stack.base, owner_name, owner_password)
    outsider = register(observations, stack.base, outsider_name, outsider_password)
    stranger = register(observations, stack.base, stranger_name, stranger_password)
    owner_token, outsider_token, stranger_token = owner["accessToken"], outsider["accessToken"], stranger["accessToken"]

    family = expect(observations, stack.base, "POST", "/api/v1/families", 201, token=owner_token,
                    body={"name": "test_family_vaccine_edit_" + suffix, "timeZone": "UTC"}, name="create test family")["data"]
    family_id = family["id"]
    baby = expect(observations, stack.base, "POST", f"/api/v1/families/{family_id}/babies", 201,
                  token=owner_token, body={"name": "test_baby_vaccine_edit_" + suffix,
                                          "birthDate": "2026-01-02", "gender": "girl"},
                  name="create test baby")["data"]
    baby_id = baby["id"]
    if not (owner_name.startswith("test_") and outsider_name.startswith("test_") and stranger_name.startswith("test_") and baby["name"].startswith("test_baby_")):
        raise AssertionError("tenant naming guard failed")

    stack.sql(f"""
      INSERT INTO family_members(id,family_id,user_id,role,status,updated_at)
      VALUES('test_family_member_{suffix}','{family_id}','{outsider['user']['id']}','member','active',NOW());
      INSERT INTO baby_members(id,family_id,baby_id,user_id,role,status,updated_at)
      VALUES('test_baby_member_{suffix}','{family_id}','{baby_id}','{outsider['user']['id']}','member','active',NOW());
    """)

    stack.sql("""
      INSERT INTO vaccines(id,vaccine_code,name,program_type,china_national,source_refs_json,legacy_metadata)
      VALUES('test_vaccine','TEST-EDIT','Test Vaccine Edit','national_immunization_program',true,'[\"test_source\"]','{}');
      INSERT INTO vaccine_doses(id,vaccine_id,dose_number,dose_label,dose_volume_ml)
      VALUES('test_vaccine_dose','test_vaccine',1,'Test Dose','0.50000');
    """)
    record_path = f"/api/v1/babies/{baby_id}/vaccines/records"
    created = expect(observations, stack.base, "POST", record_path, 201, token=owner_token,
                     key="test_vaccine_edit_create_" + suffix,
                     body={"vaccineCode": "TEST-EDIT", "vaccineId": "test_vaccine", "doseNumber": 1,
                           "administeredDate": "2026-06-01", "scheduledDate": "2026-06-10",
                           "completedDate": None, "isCompleted": False,
                           "clinic": "Test Clinic", "batchNumber": "test_batch_1", "notes": "test pending"},
                     name="create pending vaccine record")["data"]
    record_id = created["id"]
    if created["version"] != "1" or created["isCompleted"] is not False or created["completedDate"] is not None:
        raise AssertionError("pending vaccine record response was not canonical")

    family_feed_path = f"/api/v1/sync/families/{family_id}/changes"

    def family_feed(cursor: str | None, case: str):
        path = family_feed_path
        if cursor is not None:
            path += "?" + urllib.parse.urlencode({"cursor": cursor})
        return expect(observations, stack.base, "GET", path, 200, token=outsider_token, name=case)

    initial_feed = family_feed(None, "collaborator reads initial family feed")
    initial_cursor = initial_feed["nextCursor"]
    if not initial_cursor:
        raise AssertionError("initial collaborator feed did not return a continuation cursor")

    path = record_path + "/" + record_id
    complete = {
        "baseVersion": "1", "isCompleted": True,
        "administeredDate": "2026-06-04", "completedDate": "2026-06-04",
        "notes": "test completed edit", "clinic": "Test Clinic Updated",
        "batchNumber": "test_batch_2",
    }
    before = int(stack.sql(f"SELECT cursor FROM family_sync_states WHERE family_id='{family_id}';"))
    completed = expect(observations, stack.base, "PATCH", path, 200, token=owner_token,
                       key="test_vaccine_edit_complete_" + suffix, body=complete,
                       name="complete and edit vaccine record")
    after_complete = int(stack.sql(f"SELECT cursor FROM family_sync_states WHERE family_id='{family_id}';"))
    if completed["data"]["version"] != "2" or completed["data"]["completedDate"] != "2026-06-04" or completed["data"]["notes"] != "test completed edit":
        raise AssertionError("completion/date/notes update did not persist")
    if after_complete != before + 1:
        raise AssertionError("successful edit did not advance family sync cursor exactly once")
    timeline = json.loads(stack.sql(
        f"SELECT jsonb_build_array(to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD'),deleted_at IS NULL,version::text) "
        f"FROM timeline_entries WHERE family_id='{family_id}' AND baby_id='{baby_id}' "
        f"AND entity_type='vaccine' AND entity_id='{record_id}';"
    ))
    if timeline != ["2026-06-04", True, "1"]:
        raise AssertionError(f"completion timeline projection mismatch: {timeline!r}")
    selection = json.loads(stack.sql(
        f"SELECT jsonb_build_array(completed,version::text) FROM vaccine_selections "
        f"WHERE family_id='{family_id}' AND baby_id='{baby_id}' AND vaccine_id='test_vaccine' AND dose_number=1;"
    ))
    if selection != [True, "1"]:
        raise AssertionError("completion did not synchronize vaccine selection")

    completed_feed = family_feed(initial_cursor, "collaborator receives vaccine completion change")
    completed_changes = [change for change in completed_feed["changes"] if change["entityType"] == "vaccine" and change["entityId"] == record_id]
    if len(completed_changes) != 1:
        raise AssertionError(f"collaborator did not receive exactly one vaccine upsert: {completed_changes!r}")
    completed_change = completed_changes[0]
    if completed_change["operation"] != "upsert" or completed_change["version"] != "2" or completed_change["payload"].get("isCompleted") is not True or completed_change["payload"].get("completedDate") != "2026-06-04" or completed_change["payload"].get("babyId") != baby_id:
        raise AssertionError(f"collaborator received a noncanonical vaccine completion event: {completed_change!r}")
    completed_cursor = completed_feed["nextCursor"]

    replay = expect(observations, stack.base, "PATCH", path, 200, token=owner_token,
                    key="test_vaccine_edit_complete_" + suffix, body=complete,
                    name="replay identical vaccine edit")
    after_replay = int(stack.sql(f"SELECT cursor FROM family_sync_states WHERE family_id='{family_id}';"))
    if replay != completed or after_replay != after_complete:
        raise AssertionError("identical idempotency replay changed response or durable cursor")
    replay_feed = family_feed(completed_cursor, "identical replay creates no collaborator feed event")
    if replay_feed["changes"] or replay_feed["highWater"] != completed_feed["highWater"]:
        raise AssertionError("identical replay advanced the family feed or emitted a duplicate event")
    mismatch = {**complete, "notes": "test conflicting replay"}
    expect(observations, stack.base, "PATCH", path, 409, token=owner_token,
           key="test_vaccine_edit_complete_" + suffix, body=mismatch,
           name="reject changed-body idempotency replay")

    expect(observations, stack.base, "PATCH", path, 403, token=stranger_token,
           key="test_vaccine_edit_foreign_" + suffix,
           body={"baseVersion": "2", "notes": "test foreign edit"},
           name="deny foreign principal vaccine edit")
    expect(observations, stack.base, "PATCH", path, 409, token=owner_token,
           key="test_vaccine_edit_stale_" + suffix,
           body={"baseVersion": "1", "notes": "test stale edit"},
           name="reject stale baseVersion")
    expect(observations, stack.base, "PATCH", path, 400, token=owner_token,
           key="test_vaccine_edit_typo_" + suffix,
           body={"baseVersion": "2", "batchNumbr": "test typo"},
           name="reject unknown editable field")
    expect(observations, stack.base, "PATCH", path, 400, token=owner_token,
           key="test_vaccine_edit_invalid_date_" + suffix,
           body={"baseVersion": "2", "completedDate": "2026-02-30"},
           name="reject invalid calendar date")
    state_after_rejections = json.loads(stack.sql(
        f"SELECT jsonb_build_array(version::text,is_completed,completed_date::date::text,notes) "
        f"FROM vaccine_records WHERE id='{record_id}' AND family_id='{family_id}';"
    ))
    if state_after_rejections != ["2", True, "2026-06-04", "test completed edit"]:
        raise AssertionError("rejected edits mutated vaccine record")

    revoke = {
        "baseVersion": "2", "isCompleted": False, "completedDate": None,
        "scheduledDate": "2026-06-10", "notes": "test completion revoked",
    }
    revoked = expect(observations, stack.base, "PATCH", path, 200, token=owner_token,
                     key="test_vaccine_edit_revoke_" + suffix, body=revoke,
                     name="revoke vaccine completion")
    if revoked["data"]["version"] != "3" or revoked["data"]["isCompleted"] is not False or revoked["data"]["completedDate"] is not None or revoked["data"]["administeredDate"] != "2026-06-10":
        raise AssertionError("completion revoke did not retain pending schedule semantics")
    revoked_timeline = json.loads(stack.sql(
        f"SELECT jsonb_build_array(deleted_at IS NOT NULL,version::text) FROM timeline_entries "
        f"WHERE family_id='{family_id}' AND baby_id='{baby_id}' AND entity_type='vaccine' AND entity_id='{record_id}';"
    ))
    revoked_selection = json.loads(stack.sql(
        f"SELECT jsonb_build_array(completed,version::text) FROM vaccine_selections "
        f"WHERE family_id='{family_id}' AND baby_id='{baby_id}' AND vaccine_id='test_vaccine' AND dose_number=1;"
    ))
    if revoked_timeline != [True, "2"] or revoked_selection != [False, "2"]:
        raise AssertionError("revoke did not tombstone timeline and clear linked selection")
    revoked_feed = family_feed(completed_cursor, "collaborator receives vaccine completion revocation")
    revoked_changes = [change for change in revoked_feed["changes"] if change["entityType"] == "vaccine" and change["entityId"] == record_id]
    if len(revoked_changes) != 1 or revoked_changes[0]["operation"] != "upsert" or revoked_changes[0]["version"] != "3" or revoked_changes[0]["payload"].get("isCompleted") is not False or revoked_changes[0]["payload"].get("completedDate") is not None:
        raise AssertionError(f"collaborator did not receive the canonical completion revocation: {revoked_changes!r}")
    revoked_cursor = revoked_feed["nextCursor"]

    restore = {"baseVersion": "3", "isCompleted": True, "completedDate": "2026-06-12", "notes": "test re-completed"}
    restored = expect(observations, stack.base, "PATCH", path, 200, token=owner_token,
                      key="test_vaccine_edit_recomplete_" + suffix, body=restore,
                      name="re-complete and restore vaccine projection")
    if restored["data"]["version"] != "4" or restored["data"]["administeredDate"] != "2026-06-12":
        raise AssertionError("re-completion did not derive administered date")
    restored_timeline = json.loads(stack.sql(
        f"SELECT jsonb_build_array(to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD'),deleted_at IS NULL,version::text) "
        f"FROM timeline_entries WHERE family_id='{family_id}' AND baby_id='{baby_id}' "
        f"AND entity_type='vaccine' AND entity_id='{record_id}';"
    ))
    if restored_timeline != ["2026-06-12", True, "3"]:
        raise AssertionError("re-completion did not reactivate timeline projection")
    restored_feed = family_feed(revoked_cursor, "collaborator receives vaccine re-completion change")
    restored_changes = [change for change in restored_feed["changes"] if change["entityType"] == "vaccine" and change["entityId"] == record_id]
    if len(restored_changes) != 1 or restored_changes[0]["operation"] != "upsert" or restored_changes[0]["version"] != "4" or restored_changes[0]["payload"].get("isCompleted") is not True or restored_changes[0]["payload"].get("completedDate") != "2026-06-12":
        raise AssertionError(f"collaborator did not receive the canonical re-completion: {restored_changes!r}")
    restored_cursor = restored_feed["nextCursor"]

    late_replay = expect(observations, stack.base, "PATCH", path, 200, token=owner_token,
                         key="test_vaccine_edit_complete_" + suffix, body=complete,
                         name="replay earlier edit after later versions")
    if late_replay != completed:
        raise AssertionError("late idempotency replay did not return original response")
    late_replay_feed = family_feed(restored_cursor, "late replay creates no collaborator feed event")
    if late_replay_feed["changes"] or late_replay_feed["highWater"] != restored_feed["highWater"]:
        raise AssertionError("late idempotency replay advanced the family feed")
    receipt_count = stack.sql(
        f"SELECT count(*) FROM idempotency_receipts WHERE actor_id='{owner['user']['id']}' "
        f"AND scope_id='{family_id}' AND command_id LIKE 'vaccine-record-update:%';"
    )
    if receipt_count != "3":
        raise AssertionError("only successful edit commands should persist receipts")
    final_state = json.loads(stack.sql(
        f"SELECT jsonb_build_array(cursor::text,(SELECT count(*) FROM family_changes WHERE family_id='{family_id}' AND entity_type='vaccine' AND entity_id='{record_id}')," 
        f"(SELECT count(*) FROM vaccine_records WHERE id='{record_id}' AND deleted_at IS NOT NULL)," 
        f"(SELECT count(*) FROM timeline_entries WHERE id=(SELECT id FROM timeline_entries WHERE entity_id='{record_id}' AND entity_type='vaccine') AND deleted_at IS NULL)) "
        f"FROM family_sync_states WHERE family_id='{family_id}';"
    ))
    if final_state[2] != 0 or final_state[3] != 1:
        raise AssertionError("vaccine completion toggle left an invalid active-record/timeline tombstone state")

    ai_session = expect(observations, stack.base, "POST", "/api/v1/ai/sessions", 201, token=owner_token,
                        body={"babyId": baby_id, "title": "test AI replay"},
                        name="create isolated AI replay session")["data"]
    client_message_id = str(uuid.uuid4())
    ai_run_path = f"/api/v1/ai/sessions/{ai_session['id']}/runs"
    ai_body = {"clientMessageId": client_message_id, "message": "test-only queued replay"}
    first_run = expect(observations, stack.base, "POST", ai_run_path, 202, token=owner_token,
                       body=ai_body, name="create AI run with omitted empty attachments")["data"]
    run_id = first_run["id"]
    stored_input = json.loads(stack.sql(
        f"SELECT payload->'__native' FROM task_outbox WHERE aggregate_id='{run_id}' AND phase_key='native-initial';"
    ))
    if "attachmentIds" in stored_input:
        raise AssertionError("test setup did not reproduce the persisted omitted-empty attachment field")

    def ai_counts():
        return json.loads(stack.sql(
            f"SELECT jsonb_build_array((SELECT count(*) FROM ai_messages WHERE id='{client_message_id}'),"
            f"(SELECT count(*) FROM task_executions WHERE id='{run_id}'),"
            f"(SELECT count(*) FROM task_outbox WHERE aggregate_id='{run_id}' AND phase_key='native-initial'));"
        ))

    before_replay_counts = ai_counts()
    same_run = expect(observations, stack.base, "POST", ai_run_path, 202, token=owner_token,
                      body={**ai_body, "attachmentIds": []},
                      name="replay AI run with explicit empty attachments")["data"]
    if same_run["id"] != run_id or ai_counts() != before_replay_counts:
        raise AssertionError("same-message replay did not return the original run without duplicate writes")

    # A synthetic ready row in this disposable database reaches the real HTTP
    # handler's changed-nonempty-attachment conflict branch; no worker runs.
    attachment_id = str(uuid.uuid4())
    stack.sql(f"""
      INSERT INTO attachments(id,family_id,baby_id,uploader_id,purpose,mime_type,byte_size,sha256,object_key,status,expires_at,updated_at)
      VALUES('{attachment_id}','{family_id}','{baby_id}','{owner['user']['id']}','growth_photo','image/png',1,
        repeat('a',64),'test_object_{suffix}','ready',NOW()+INTERVAL '1 hour',NOW());
    """)
    expect(observations, stack.base, "POST", ai_run_path, 409, token=owner_token,
           body={**ai_body, "attachmentIds": [attachment_id]},
           name="reject replay with changed nonempty attachments")
    if ai_counts() != before_replay_counts:
        raise AssertionError("changed-attachment replay created an extra message, task, or outbox row")

    return {
        "status": "PASS",
        "tenant": {"usernamePrefix": "test_vaccine_edit_", "babyPrefix": "test_baby_vaccine_edit_", "freshDatabase": True},
        "api": {"scheme": "http", "host": "127.0.0.1", "port": stack.api_port},
        "checks": observations,
        "checkCount": len(observations),
        "persistentState": {
            "successfulUpdateReceipts": int(receipt_count),
            "recordTombstonedByEdit": final_state[2] > 0,
            "familyCursor": final_state[0],
            "vaccineFamilyChangeRows": final_state[1],
            "activeTimelineRows": final_state[3],
            "timelineReactivated": restored_timeline[1],
        },
        "migrations": {"prismaCount": len(stack.migrated), "nativeMigrationsApplied": True},
        "providerIsolation": {"ai": "fixture-only", "workerStarted": False, "pushCredentialsPresent": False},
    }


def main() -> int:
    if not __debug__:
        raise RuntimeError("Refusing optimized Python: regression assertions must remain enabled")
    evidence = {
        "scope": "Go vaccine-record PATCH and fixed OpenAPI contract",
        "status": "RUNNING",
        "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceFileHashes": {},
        "result": None,
        "cleanup": {},
    }
    source_files = [
        "packages/contracts/src/medical.ts", "packages/contracts/src/routes.ts", "contracts/openapi.json",
        "internal/backend/vaccine_records.go", "internal/backend/contract.go", "internal/backend/server.go",
        "internal/backend/clinical_transaction.go", "internal/backend/vaccine_records_test.go", "scripts/go-vaccine-edit-integration.py",
        "internal/backend/ai_run_commands.go", "internal/backend/ai_run_commands_test.go",
    ]
    evidence["sourceFileHashes"] = {
        name: sha256_file(ROOT / name) for name in source_files if (ROOT / name).is_file()
    }
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    result_path = EVIDENCE / "http-result.json"
    stack: OwnedStack | None = None
    return_code = 0
    try:
        stack = OwnedStack()
        stack.start()
        evidence["ownedEnvironment"] = {
            "database": "test_…", "role": "test_…", "postgresHost": "127.0.0.1",
            "redisHost": "127.0.0.1", "objectStorageHost": "127.0.0.1",
            "prismaMigrationCount": len(stack.migrated),
            "aiProvider": "fixture", "workerStarted": False,
            "pushCredentialsPresent": False,
        }
        evidence["result"] = exercise(stack)
        evidence["status"] = "PASS"
    except BaseException as error:
        evidence["status"] = "FAIL"
        evidence["failureType"] = type(error).__name__
        evidence["failure"] = str(error) if isinstance(error, (AssertionError, RuntimeError)) else type(error).__name__
        return_code = 130 if isinstance(error, KeyboardInterrupt) else 1
    finally:
        if stack is not None:
            stack.close()
            evidence["cleanup"] = stack.cleanup
            evidence["databaseDiagnostics"] = stack.database_diagnostics
            if not all(value is True for value in stack.cleanup.values()):
                evidence["status"] = "FAIL"
                return_code = 1
        result_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        result_path.chmod(0o600)
        if evidence["status"] == "PASS":
            print(f"PASS isolated vaccine-edit HTTP E2E ({evidence['result']['checkCount']} HTTP checks)")
            print(f"Evidence: {result_path}")
            print("PASS owned API, PostgreSQL, Redis, MinIO stopped; private tenant data removed")
        else:
            print(f"FAIL isolated vaccine-edit HTTP E2E ({evidence.get('failure', 'cleanup failure')})")
            print(f"Evidence: {result_path}")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
