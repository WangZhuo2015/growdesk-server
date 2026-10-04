#!/usr/bin/env python3
"""Owned loopback PostgreSQL/Redis/MinIO run for typed medical and growth OCR.

This proves the task/worker/wire/authorization/transaction contract with an
explicit virtual OCR fixture. It does not measure OCR recognition quality or
contact an external AI, push, billing, production, or legacy Web service.
"""
from __future__ import annotations

import hashlib
import http.server
import json
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_PORTS = {3081, 3088, 3089, 49762, 57006, 60756, 5432, 6379}
HTTP_EXPECT_COUNT = 0
PNG = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDAT"
    b"\x08\xd7c\xfc\xff\x1f\x00\x03\x03\x02\x00\xef\xbf\xac\xb8\x00\x00\x00\x00IEND\xaeB`\x82"
)
PDF = b"%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n"
HEIC = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1"


class HeldOCRProvider:
    """A loopback OpenAI-compatible fixture that releases a valid OCR result on demand."""

    def __init__(self, assistant_result: dict):
        self.request_received = threading.Event()
        self.release_response = threading.Event()
        self.response_finished = threading.Event()
        content = json.dumps(assistant_result, ensure_ascii=False, separators=(",", ":"))
        self.response_body = json.dumps({
            "choices": [{"message": {"content": content}}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1},
        }, separators=(",", ":")).encode()
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer test_virtual_provider_key":
                    self.send_error(404)
                    return
                length = int(self.headers.get("Content-Length", "0"))
                if length < 1 or length > 16 * 1024 * 1024:
                    self.send_error(413)
                    return
                self.rfile.read(length)
                fixture.request_received.set()
                if not fixture.release_response.wait(60):
                    self.send_error(504)
                    return
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(fixture.response_body)))
                    self.end_headers()
                    self.wfile.write(fixture.response_body)
                    self.wfile.flush()
                except OSError:
                    # The worker may close its request after the HTTP cancel.
                    pass
                finally:
                    fixture.response_finished.set()

            def log_message(self, _format, *_args):
                return

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base_url = f"http://127.0.0.1:{self.server.server_port}/v1"
        self.thread = threading.Thread(target=self.server.serve_forever, name="test-held-ocr-provider", daemon=True)
        self.thread.start()

    def wait_for_request(self, timeout: float = 30) -> bool:
        return self.request_received.wait(timeout)

    def close(self) -> None:
        self.release_response.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def clean_env() -> dict[str, str]:
    return {key: os.environ[key] for key in ("PATH", "HOME", "LANG", "LC_ALL") if key in os.environ}


def random_port() -> int:
    for _ in range(32):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = int(listener.getsockname()[1])
        if port not in FORBIDDEN_PORTS:
            return port
    raise RuntimeError("loopback_port_allocation_failed")


def checked(args: list[str], *, env: dict[str, str], cwd: Path, timeout: int = 180,
            input_text: str | None = None) -> str:
    result = subprocess.run(args, cwd=cwd, env=env, input=input_text, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if result.returncode:
        # Commands run with private fixture configuration. Keep diagnostics
        # bounded and avoid echoing environment, URLs, SQL passwords or tokens.
        raise RuntimeError(f"owned_command_failed:{Path(args[0]).name}:{result.returncode}")
    return result.stdout.strip()


class OwnedStack:
    def __init__(self, suffix: str):
        self.suffix = suffix
        self.root = Path(tempfile.mkdtemp(prefix="growdesk-mgocr-", dir="/private/tmp"))
        os.chmod(self.root, 0o700)
        self.env = clean_env()
        self.processes: list[tuple[str, subprocess.Popen, object]] = []
        self.pg_started = False
        self.cleanup_ok = False
        self.db_name = "test_gmocr_" + suffix
        self.db_role = "test_app_" + suffix
        self.db_password = uuid.uuid4().hex + uuid.uuid4().hex
        self.admin_password = uuid.uuid4().hex + uuid.uuid4().hex
        self.jwt = uuid.uuid4().hex + uuid.uuid4().hex
        self.redis_password = uuid.uuid4().hex + uuid.uuid4().hex
        self.minio_root = "test_mgocr_" + suffix
        self.minio_password = uuid.uuid4().hex + uuid.uuid4().hex
        self.bucket = "test-ocr-" + suffix
        self.pg_port, self.redis_port = random_port(), random_port()
        self.minio_port, self.minio_console_port, self.api_port = random_port(), random_port(), random_port()
        self.pg_dir = self.root / "pgdata"
        self.pg_socket = self.root / "pgsocket"
        self.redis_dir = self.root / "redis"
        self.minio_dir = self.root / "minio"
        self.api_binary = self.root / "growdesk-api"
        self.worker_binary = self.root / "growdesk-worker"
        self.migrate_binary = self.root / "growdesk-migrate"
        self.app_env: dict[str, str] = {}

    def _spawn(self, label: str, args: list[str], env: dict[str, str]) -> subprocess.Popen:
        log = open(self.root / f"{label}.log", "ab", buffering=0)
        os.chmod(log.name, 0o600)
        process = subprocess.Popen(args, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        self.processes.append((label, process, log))
        return process

    def _start_postgres(self) -> None:
        self.pg_dir.mkdir(mode=0o700)
        self.pg_socket.mkdir(mode=0o700)
        checked(["/opt/homebrew/bin/initdb", "-D", str(self.pg_dir), "--username=postgres",
                 "--auth-local=trust", "--auth-host=scram-sha-256", "--no-locale", "--encoding=UTF8"],
                env=self.env, cwd=ROOT)
        checked(["/opt/homebrew/bin/pg_ctl", "-D", str(self.pg_dir), "-o",
                 f"-h 127.0.0.1 -p {self.pg_port} -k {self.pg_socket}", "-l", str(self.root / "postgres.log"),
                 "-w", "start"], env=self.env, cwd=ROOT)
        os.chmod(self.root / "postgres.log", 0o600)
        self.pg_started = True
        admin_env = {**self.env, "PGCONNECT_TIMEOUT": "5"}
        sql = f"CREATE ROLE {self.db_role} LOGIN PASSWORD '{self.db_password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\nCREATE DATABASE {self.db_name} OWNER {self.db_role};\n"
        checked(["/opt/homebrew/bin/psql", "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-h",
                 str(self.pg_socket), "-p", str(self.pg_port), "-U", "postgres", "-d", "postgres"],
                env=admin_env, cwd=ROOT, input_text=sql)
        app_db_env = {**self.env, "PGPASSWORD": self.db_password, "PGCONNECT_TIMEOUT": "5"}
        identity = checked(["/opt/homebrew/bin/psql", "-X", "-A", "-t", "-h", "127.0.0.1",
                            "-p", str(self.pg_port), "-U", self.db_role, "-d", self.db_name,
                            "-c", "SELECT current_database()||'|'||current_user||'|'||"
                                  "(SELECT rolsuper::text FROM pg_roles WHERE rolname=current_user)||'|'||host(inet_server_addr())"],
                           env=app_db_env, cwd=ROOT)
        if identity != f"{self.db_name}|{self.db_role}|false|127.0.0.1":
            raise RuntimeError("postgres_identity_guard_failed")
        migrations = sorted((ROOT / "prisma/migrations").glob("*/migration.sql"))
        for migration in migrations:
            checked(["/opt/homebrew/bin/psql", "-X", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1",
                     "-p", str(self.pg_port), "-U", self.db_role, "-d", self.db_name, "-f", str(migration)],
                    env=app_db_env, cwd=ROOT)
        self.env.update(app_db_env)

    def _start_redis(self) -> None:
        self.redis_dir.mkdir(mode=0o700)
        redis_env = {**self.env}
        self._spawn("redis", ["/opt/homebrew/bin/redis-server", "--bind", "127.0.0.1", "--port",
                               str(self.redis_port), "--requirepass", self.redis_password, "--save", "",
                               "--appendonly", "no", "--dir", str(self.redis_dir)], redis_env)
        for _ in range(100):
            try:
                with socket.create_connection(("127.0.0.1", self.redis_port), timeout=0.2) as sock:
                    sock.sendall(f"*2\r\n$4\r\nAUTH\r\n${len(self.redis_password)}\r\n{self.redis_password}\r\n".encode())
                    if b"+OK" not in sock.recv(128):
                        raise RuntimeError("redis_auth_guard_failed")
                    sock.sendall(b"*1\r\n$4\r\nPING\r\n")
                    if b"+PONG" not in sock.recv(128):
                        raise RuntimeError("redis_readiness_failed")
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("redis_readiness_timeout")

    def _start_minio(self) -> None:
        self.minio_dir.mkdir(mode=0o700)
        minio_env = {**self.env, "MINIO_ROOT_USER": self.minio_root, "MINIO_ROOT_PASSWORD": self.minio_password,
                     "MINIO_UPDATE": "off", "MINIO_BROWSER": "off"}
        self._spawn("minio", ["/opt/homebrew/bin/minio", "server", str(self.minio_dir), "--address",
                               f"127.0.0.1:{self.minio_port}", "--console-address",
                               f"127.0.0.1:{self.minio_console_port}"], minio_env)
        for _ in range(150):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.minio_port}/minio/health/ready", timeout=1) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.2)
        else:
            raise RuntimeError("minio_readiness_timeout")
        helper = self.root / "create_bucket.go"
        helper.write_text('''package main
import ("context"; "log"; "os"; "github.com/aws/aws-sdk-go-v2/aws"; "github.com/aws/aws-sdk-go-v2/service/s3")
func main(){ctx:=context.Background(); c:=s3.New(s3.Options{Region:"us-east-1",Credentials:aws.CredentialsProviderFunc(func(context.Context)(aws.Credentials,error){return aws.Credentials{AccessKeyID:os.Getenv("AWS_ACCESS_KEY_ID"),SecretAccessKey:os.Getenv("AWS_SECRET_ACCESS_KEY"),Source:"isolated-test"},nil}),BaseEndpoint:aws.String(os.Getenv("S3_ENDPOINT")),UsePathStyle:true}); if _,err:=c.CreateBucket(ctx,&s3.CreateBucketInput{Bucket:aws.String(os.Getenv("S3_BUCKET"))});err!=nil{log.Fatal("bucket")}}
''', encoding="utf-8")
        os.chmod(helper, 0o600)
        bucket_env = {**self.env, "AWS_ACCESS_KEY_ID": self.minio_root, "AWS_SECRET_ACCESS_KEY": self.minio_password,
                      "S3_ENDPOINT": f"http://127.0.0.1:{self.minio_port}", "S3_BUCKET": self.bucket}
        checked(["go", "run", str(helper)], env=bucket_env, cwd=ROOT, timeout=120)
        self.env.update(bucket_env)

    def _build_binaries(self) -> None:
        checked(["go", "build", "-trimpath", "-o", str(self.api_binary), "./cmd/growdesk-api"],
                env=self.env, cwd=ROOT, timeout=300)
        checked(["go", "build", "-trimpath", "-o", str(self.worker_binary), "./cmd/growdesk-worker"],
                env=self.env, cwd=ROOT, timeout=300)
        checked(["go", "build", "-trimpath", "-o", str(self.migrate_binary), "./cmd/growdesk-migrate"],
                env=self.env, cwd=ROOT, timeout=300)
        for binary in (self.api_binary, self.worker_binary, self.migrate_binary):
            os.chmod(binary, 0o700)

    def _start_api(self) -> str:
        self.app_env = {
            **self.env,
            "DATABASE_URL": f"postgresql://{self.db_role}:{self.db_password}@127.0.0.1:{self.pg_port}/{self.db_name}?sslmode=disable",
            "REDIS_URL": f"redis://default:{self.redis_password}@127.0.0.1:{self.redis_port}/0",
            "JWT_SECRET": self.jwt,
            "SESSION_ENCRYPTION_KEY": self.jwt,
            "INVITE_SECRET": uuid.uuid4().hex + uuid.uuid4().hex,
            "GROWDESK_ENV": "test",
            "GROWDESK_GO_EXPERIMENTAL": "1",
            "GROWDESK_AI_PROVIDER": "fixture",
            "GROWDESK_AI_MODEL": "virtual_ocr_fixture",
            "GROWDESK_AI_FIXTURE_RESPONSE": json.dumps({"text": "isolated virtual provider", "actions": []}),
            "S3_ENDPOINT": f"http://127.0.0.1:{self.minio_port}",
            "S3_BUCKET": self.bucket,
            "S3_REGION": "us-east-1",
            "AWS_ACCESS_KEY_ID": self.minio_root,
            "AWS_SECRET_ACCESS_KEY": self.minio_password,
            "HOST": "127.0.0.1",
            "PORT": str(self.api_port),
            "PUBLIC_BASE_URL": f"http://127.0.0.1:{self.api_port}",
        }
        checked([str(self.migrate_binary)], env=self.app_env, cwd=ROOT, timeout=90)
        self._spawn("api", [str(self.api_binary)], self.app_env)
        base = f"http://127.0.0.1:{self.api_port}"
        for _ in range(120):
            try:
                status, _ = request(base, "GET", "/health/ready")
                if status == 200:
                    return base
            except OSError:
                pass
            time.sleep(0.2)
        raise RuntimeError("api_readiness_timeout")

    def start(self) -> tuple[str, int]:
        # Build first so no service starts until the source is fixed and both
        # binaries identify the same current detached worktree.
        self._build_binaries()
        self._start_postgres()
        self._start_redis()
        self._start_minio()
        return self._start_api(), self.minio_port

    def run_worker(self, fixture: dict) -> None:
        env = {**self.app_env, "GROWDESK_AI_FIXTURE_RESPONSE": json.dumps(fixture, ensure_ascii=False)}
        log_path = self.root / f"worker-{len(self.processes)}.log"
        with open(log_path, "wb") as log:
            os.chmod(log_path, 0o600)
            process = subprocess.run([str(self.worker_binary), "--once"], cwd=ROOT, env=env,
                                     stdout=log, stderr=subprocess.STDOUT, timeout=240)
        if process.returncode != 0:
            raise RuntimeError(f"fixture_worker_failed:{process.returncode}")

    def start_worker(self, label: str, overrides: dict[str, str]) -> subprocess.Popen:
        env = {**self.app_env, **overrides}
        log = open(self.root / f"{label}.log", "ab", buffering=0)
        os.chmod(log.name, 0o600)
        process = subprocess.Popen([str(self.worker_binary), "--once"], cwd=ROOT, env=env,
                                   stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        self.processes.append((label, process, log))
        return process

    @staticmethod
    def wait_worker(process: subprocess.Popen, timeout: float = 30) -> None:
        try:
            result = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            raise RuntimeError("held_provider_worker_timeout") from None
        if result != 0:
            raise RuntimeError(f"held_provider_worker_failed:{result}")

    def sql(self, query: str) -> str:
        env = {**self.env, "PGPASSWORD": self.db_password, "PGCONNECT_TIMEOUT": "5"}
        return checked(["/opt/homebrew/bin/psql", "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-h",
                        "127.0.0.1", "-p", str(self.pg_port), "-U", self.db_role, "-d", self.db_name,
                        "-c", query], env=env, cwd=ROOT)

    def close(self) -> bool:
        ok = True
        for _label, process, log in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
            ok = ok and process.poll() is not None
            try:
                log.close()
            except Exception:
                pass
        if self.pg_started:
            pid_file = self.pg_dir / "postmaster.pid"
            try:
                lines = pid_file.read_text(encoding="utf-8").splitlines()
                if len(lines) < 2 or Path(lines[1]) != self.pg_dir:
                    raise RuntimeError("postgres_owned_directory_guard_failed")
                stopped = subprocess.run(["/opt/homebrew/bin/pg_ctl", "-D", str(self.pg_dir), "-m", "fast",
                                          "-w", "stop"], cwd=ROOT, env=self.env,
                                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                ok = ok and stopped.returncode == 0
            except FileNotFoundError:
                pass
            except Exception:
                ok = False
        shutil.rmtree(self.root, ignore_errors=False)
        self.cleanup_ok = ok and not self.root.exists()
        return self.cleanup_ok


def request(base: str, method: str, path: str, body=None, token=None, key=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if key:
        headers["Idempotency-Key"] = key
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read()
        return error.code, json.loads(raw) if raw else {}


def expect(base: str, method: str, path: str, status: int, body=None, token=None, key=None):
    global HTTP_EXPECT_COUNT
    HTTP_EXPECT_COUNT += 1
    actual, result = request(base, method, path, body, token, key)
    if actual != status:
        code = result.get("error", {}).get("code", "unknown") if isinstance(result, dict) else "unknown"
        raise AssertionError(f"{method}:{path}:expected={status}:actual={actual}:code={code}")
    return result


def family_feed(base: str, family: str, token: str, cursor: str | None = None) -> dict:
    query = {"limit": "200"}
    if cursor is not None:
        query["cursor"] = cursor
    path = f"/api/v1/sync/families/{family}/changes?{urllib.parse.urlencode(query)}"
    return expect(base, "GET", path, 200, token=token)


def register(base: str, label: str, suffix: str) -> dict:
    username = f"test_mgocr_{label}_{suffix}"
    result = expect(base, "POST", "/api/v1/auth/register", 201, {
        "username": username, "displayName": username,
        "password": "test_password_mgocr_8675309", "deviceLabel": "test_medical_growth_ocr",
    })["data"]
    return result


def create_scope(base: str, token: str, label: str, suffix: str) -> tuple[dict, dict]:
    family = expect(base, "POST", "/api/v1/families", 201,
                     {"name": f"test_family_mgocr_{label}_{suffix}", "timeZone": "UTC"}, token)["data"]
    baby = expect(base, "POST", f"/api/v1/families/{family['id']}/babies", 201,
                  {"name": f"test_baby_mgocr_{label}_{suffix}", "birthDate": "2025-01-02", "gender": "girl"}, token)["data"]
    return family, baby


def ready_attachment(base: str, token: str, family: str, baby: str, purpose: str,
                     minio_port: int, data: bytes, mime: str) -> str:
    digest = hashlib.sha256(data).hexdigest()
    response = expect(base, "POST", "/api/v1/attachments", 201, {
        "purpose": purpose, "mimeType": mime, "byteSize": len(data), "sha256": digest,
        "ownerScope": {"familyId": family, "babyId": baby},
    }, token)["data"]
    upload = urllib.parse.urlsplit(response["uploadUrl"])
    if (upload.scheme != "http" or upload.hostname != "127.0.0.1" or upload.port != minio_port or
            upload.username or upload.password or upload.fragment):
        raise RuntimeError("presigned_upload_loopback_guard_failed")
    request = urllib.request.Request(response["uploadUrl"], data=data, method="PUT",
                                    headers={"Content-Type": mime})
    try:
        with urllib.request.urlopen(request, timeout=20) as result:
            if result.status not in (200, 204):
                raise AssertionError("minio_upload_unexpected_status")
    except (OSError, urllib.error.URLError, urllib.error.HTTPError):
        raise RuntimeError("owned_object_upload_failed") from None
    expect(base, "POST", f"/api/v1/attachments/{response['id']}/complete", 200,
           {"sha256": digest, "byteSize": len(data)}, token)
    return response["id"]


def state(stack: OwnedStack, user: str, family: str, baby: str) -> dict:
    if not all(len(value) == 36 and value[8] == "-" for value in (user, family, baby)):
        raise RuntimeError("state_query_scope_guard_failed")
    raw = stack.sql(f"""SELECT json_build_object(
      'tasks',(SELECT COUNT(*) FROM task_executions WHERE owner_scope='user:{user}'),
      'outbox',(SELECT COUNT(*) FROM task_outbox o JOIN task_executions t ON t.id=o.aggregate_id WHERE t.owner_scope='user:{user}'),
      'sessions',(SELECT COUNT(*) FROM ai_sessions WHERE user_id='{user}'),
      'messages',(SELECT COUNT(*) FROM ai_messages m JOIN ai_sessions s ON s.id=m.session_id WHERE s.user_id='{user}'),
      'runs',(SELECT COUNT(*) FROM ai_runs WHERE user_id='{user}'),
      'events',(SELECT COUNT(*) FROM ai_run_events e JOIN ai_runs r ON r.id=e.run_id WHERE r.user_id='{user}'),
      'receipts',(SELECT COUNT(*) FROM idempotency_receipts WHERE actor_id='{user}'),
      'taskResultRefs',(SELECT COUNT(*) FROM task_executions WHERE owner_scope='user:{user}' AND result_ref IS NOT NULL),
      'runSummaries',(SELECT COUNT(*) FROM ai_runs WHERE user_id='{user}' AND result_summary IS NOT NULL),
      'ocrDrafts',(SELECT COUNT(*) FROM ai_runs WHERE user_id='{user}' AND ocr_draft IS NOT NULL),
      'medicalReports',(SELECT COUNT(*) FROM medical_reports WHERE family_id='{family}' AND baby_id='{baby}' AND deleted_at IS NULL),
      'growthMeasurements',(SELECT COUNT(*) FROM growth_measurements WHERE family_id='{family}' AND baby_id='{baby}' AND deleted_at IS NULL),
      'timeline',(SELECT COUNT(*) FROM timeline_entries WHERE family_id='{family}' AND baby_id='{baby}' AND deleted_at IS NULL),
      'changes',(SELECT COUNT(*) FROM family_changes WHERE family_id='{family}'),
      'familyCursor',COALESCE((SELECT cursor FROM family_sync_states WHERE family_id='{family}'),0))::text""")
    return json.loads(raw)


def text_field(value):
    return {"value": value, "confidence": 0.96 if value is not None else None,
            "uncertainty": "" if value is not None else "not visible in isolated fixture"}


def medical_fixture() -> dict:
    dec = lambda value, unit: {"value": value, "sourceValue": value, "sourceUnit": unit,
                               "confidence": 0.94, "uncertainty": ""}
    return {"text": "Test CBC source text: Hemoglobin 120 g/L", "actions": [], "ocrDraft": {
        "title": text_field("Blood test"), "category": {"value": "blood", "confidence": 0.96, "uncertainty": ""},
        "reportDate": {"value": "2026-09-15", "confidence": 0.93, "uncertainty": ""},
        "hospital": text_field("Test Hospital"), "department": text_field("Pediatrics"),
        "doctorNotes": text_field("Source note"), "items": [{
            "name": text_field("Hemoglobin"), "value": {"value": "120", "confidence": 0.94, "uncertainty": ""},
            "unit": text_field("g/L"), "referenceRange": text_field("110-150"),
            "status": {"value": "normal", "confidence": 0.92, "uncertainty": ""},
            "interpretation": text_field("Within printed range"),
        }], "growthData": {"weightKg": dec("8.25", "kg"), "heightCm": dec("70.5", "cm"),
                            "headCircumferenceCm": dec("44.1", "cm")},
    }}


def growth_fixture() -> dict:
    dec = lambda value, unit: {"value": value, "sourceValue": value, "sourceUnit": unit,
                               "confidence": 0.95, "uncertainty": ""}
    return {"text": "Test growth source text: 8.3 kg, 71 cm", "actions": [], "ocrDraft": {
        "measurementDate": {"value": "2026-09-16", "confidence": 0.92, "uncertainty": ""},
        "weightKg": dec("8.30", "kg"), "heightCm": dec("71", "cm"),
        "headCircumferenceCm": {"value": None, "sourceValue": None, "sourceUnit": None,
                                "confidence": None, "uncertainty": "not visible in isolated fixture"},
    }}


def run_scenarios(stack: OwnedStack, base: str, minio_port: int) -> dict:
    suffix = stack.suffix
    owner = register(base, "owner", suffix)
    member = register(base, "member", suffix)
    outsider = register(base, "other", suffix)
    owner_token, member_token, outsider_token = owner["accessToken"], member["accessToken"], outsider["accessToken"]
    owner_id, member_id, outsider_id = owner["user"]["id"], member["user"]["id"], outsider["user"]["id"]
    family, baby = create_scope(base, owner_token, "owner", suffix)
    second_baby = expect(base, "POST", f"/api/v1/families/{family['id']}/babies", 201,
                         {"name": f"test_baby_mgocr_second_{suffix}", "birthDate": "2025-02-02", "gender": "girl"},
                         owner_token)["data"]
    invite = expect(base, "POST", f"/api/v1/families/{family['id']}/invites", 201,
                    {"expiresInDays": 1}, owner_token)["data"]["inviteCode"]
    expect(base, "POST", "/api/v1/families/join", 200, {"inviteCode": invite}, member_token)
    expect(base, "POST", f"/api/v1/babies/{baby['id']}/members", 201,
           {"userId": member_id, "role": "member"}, owner_token)
    other_family, other_baby = create_scope(base, outsider_token, "other", suffix)
    family_id, baby_id = family["id"], baby["id"]
    med_pdf = ready_attachment(base, owner_token, family_id, baby_id, "medical_report", minio_port,
                               PDF, "application/pdf")
    med_png = ready_attachment(base, owner_token, family_id, baby_id, "medical_report", minio_port,
                               PNG, "image/png")
    growth_png = ready_attachment(base, owner_token, family_id, baby_id, "growth_photo", minio_port,
                                  PNG, "image/png")
    growth_heic = ready_attachment(base, owner_token, family_id, baby_id, "growth_photo", minio_port,
                                   HEIC, "image/heic")
    foreign_attachment = ready_attachment(base, outsider_token, other_family["id"], other_baby["id"],
                                          "medical_report", minio_port, PDF, "application/pdf")
    cases: list[str] = []

    before = state(stack, owner_id, family_id, baby_id)
    wrong_purpose = expect(base, "POST", "/api/v1/medical/ocr-runs", 400,
                           {"babyId": baby_id, "attachmentId": growth_png}, owner_token,
                           "test_mgocr_wrong_purpose_" + suffix)
    if wrong_purpose.get("error", {}).get("code") != "BAD_REQUEST" or state(stack, owner_id, family_id, baby_id) != before:
        raise AssertionError("wrong_purpose_created_task_or_receipt")
    cases.append("ready_growth_photo_rejected_by_medical_ocr_before_task_or_receipt")

    before = state(stack, owner_id, family_id, baby_id)
    heic = expect(base, "POST", "/api/v1/growth/ocr-runs", 400,
                  {"babyId": baby_id, "attachmentId": growth_heic}, owner_token,
                  "test_mgocr_heic_" + suffix)
    if heic.get("error", {}).get("code") != "BAD_REQUEST" or state(stack, owner_id, family_id, baby_id) != before:
        raise AssertionError("unsupported_growth_heic_created_task_or_receipt")
    cases.append("ready_growth_photo_HEIC_rejected_before_task_or_receipt")

    before = state(stack, owner_id, family_id, baby_id)
    expect(base, "POST", "/api/v1/medical/ocr-runs", 404,
           {"babyId": baby_id, "attachmentId": foreign_attachment}, owner_token,
           "test_mgocr_foreign_attachment_" + suffix)
    expect(base, "GET", f"/api/v1/ai/runs/{uuid.uuid4()}", 404, token=outsider_token)
    expect(base, "GET", f"/api/v1/babies/{other_baby['id']}/medical-reports", 403, token=owner_token)
    if state(stack, owner_id, family_id, baby_id) != before:
        raise AssertionError("foreign_scope_access_created_task_or_record")
    cases.append("foreign_principal_and_baby_scope_denials")

    before = state(stack, owner_id, family_id, baby_id)
    mismatch = expect(base, "POST", "/api/v1/medical/ocr-runs", 404,
                      {"babyId": second_baby["id"], "attachmentId": med_png}, owner_token,
                      "test_mgocr_baby_mismatch_" + suffix)
    if mismatch.get("error", {}).get("code") != "RECORD_NOT_FOUND" or state(stack, owner_id, family_id, baby_id) != before:
        raise AssertionError("baby_mismatch_created_task_or_receipt")
    cases.append("explicit_request_baby_must_match_attachment_baby")

    cancel_key = "test_mgocr_cancel_" + suffix
    cancelled = expect(base, "POST", "/api/v1/medical/ocr-runs", 202,
                       {"babyId": baby_id, "attachmentId": med_png}, owner_token, cancel_key)["data"]["runId"]
    replay = expect(base, "POST", "/api/v1/medical/ocr-runs", 202,
                    {"babyId": baby_id, "attachmentId": med_png}, owner_token, cancel_key)["data"]["runId"]
    if replay != cancelled:
        raise AssertionError("same_key_ocr_queue_did_not_replay_same_run")
    queued_state = state(stack, owner_id, family_id, baby_id)
    if queued_state["tasks"] != before["tasks"] + 1 or queued_state["runs"] != before["runs"] + 1:
        raise AssertionError("same_key_ocr_queue_created_duplicate_task")
    expect(base, "POST", "/api/v1/medical/ocr-runs", 409,
           {"babyId": baby_id, "attachmentId": med_pdf}, owner_token, cancel_key)
    if state(stack, owner_id, family_id, baby_id) != queued_state:
        raise AssertionError("changed_body_replay_created_extra_task")
    expect(base, "POST", f"/api/v1/ai/runs/{cancelled}/cancel", 200, token=owner_token)
    cancelled_read = expect(base, "GET", f"/api/v1/ai/runs/{cancelled}", 200, token=owner_token)["data"]
    if cancelled_read["status"] != "cancelled" or cancelled_read.get("ocrDraft") is not None:
        raise AssertionError("cancelled_ocr_run_not_terminal_read_only")
    cancellation_body = {"title": "test cancelled OCR must not save", "reportDate": "2026-09-15",
                         "category": "blood", "ocrRunId": cancelled, "attachmentIds": [med_png]}
    before_cancel_confirmation = state(stack, owner_id, family_id, baby_id)
    expect(base, "POST", f"/api/v1/babies/{baby_id}/medical-reports", 409,
           cancellation_body, owner_token)
    if state(stack, owner_id, family_id, baby_id) != before_cancel_confirmation:
        raise AssertionError("cancelled_run_confirmation_wrote_record_or_receipt")
    cases.append("durable_cancel_same_key_replay_and_changed_body_conflict")

    failed_run = expect(base, "POST", "/api/v1/medical/ocr-runs", 202,
                        {"babyId": baby_id, "attachmentId": med_pdf}, owner_token,
                        "test_mgocr_retry_" + suffix)["data"]["runId"]
    stack.run_worker({"text": "test invalid typed result", "actions": [], "ocrDraft": {"title": {"value": "missing other fields"}}})
    failed = expect(base, "GET", f"/api/v1/ai/runs/{failed_run}", 200, token=owner_token)["data"]
    if failed["status"] != "failed" or not failed.get("errorCode"):
        raise AssertionError("invalid_fixture_did_not_fail_run_visibly")
    failed_body = {"title": "test failed OCR must not save", "reportDate": "2026-09-15",
                   "category": "blood", "ocrRunId": failed_run, "attachmentIds": [med_pdf]}
    before_failed_confirmation = state(stack, owner_id, family_id, baby_id)
    expect(base, "POST", f"/api/v1/babies/{baby_id}/medical-reports", 409,
           failed_body, owner_token)
    if state(stack, owner_id, family_id, baby_id) != before_failed_confirmation:
        raise AssertionError("failed_run_confirmation_wrote_record_or_receipt")
    retried = expect(base, "POST", f"/api/v1/ai/runs/{failed_run}/retry", 202, token=owner_token)["data"]
    if retried["runId"] != failed_run or retried.get("newAttempt") != 2:
        raise AssertionError("explicit_retry_did_not_reuse_run_with_new_attempt")
    stack.run_worker(medical_fixture())
    medical_run = expect(base, "GET", f"/api/v1/ai/runs/{failed_run}", 200, token=owner_token)["data"]
    draft = medical_run.get("ocrDraft")
    if medical_run["status"] != "succeeded" or not isinstance(draft, dict):
        raise AssertionError("medical_run_missing_typed_success")
    if (draft.get("kind") != "medical" or draft.get("attachmentId") != med_pdf or
            draft.get("title", {}).get("value") != "Blood test" or
            draft.get("category", {}).get("value") != "blood" or
            draft.get("items", [{}])[0].get("referenceRange", {}).get("value") != "110-150" or
            draft.get("growthData", {}).get("weightKg", {}).get("value") != "8.25"):
        raise AssertionError("medical_typed_draft_field_mapping_failed")
    if "diagnosis" in draft:
        raise AssertionError("medical_ocr_must_not_emit_diagnosis_field")
    expect(base, "POST", f"/api/v1/ai/runs/{failed_run}/cancel", 200, token=owner_token)
    completion_won = expect(base, "GET", f"/api/v1/ai/runs/{failed_run}", 200, token=owner_token)["data"]
    if completion_won["status"] != "succeeded" or completion_won.get("ocrDraft") != draft or completion_won.get("resultSummary") != medical_run.get("resultSummary"):
        raise AssertionError("cancel_moved_succeeded_worker_run_backwards")
    cases.append("worker_completion_wins_then_cancel_preserves_succeeded_result")

    in_flight_run = expect(base, "POST", "/api/v1/medical/ocr-runs", 202,
                           {"babyId": baby_id, "attachmentId": med_png}, owner_token,
                           "test_mgocr_inflight_cancel_" + suffix)["data"]["runId"]
    in_flight_before = state(stack, owner_id, family_id, baby_id)
    held_provider = HeldOCRProvider({"text": "test held provider OCR result", "actions": [],
                                     "ocrDraft": medical_fixture()["ocrDraft"]})
    worker = stack.start_worker("worker-held-provider-cancel",
                                {"GROWDESK_AI_PROVIDER": "openai-compatible",
                                 "GROWDESK_AI_BASE_URL": held_provider.base_url,
                                 "GROWDESK_AI_API_KEY": "test_virtual_provider_key",
                                 "GROWDESK_AI_MODEL": "test_virtual_ocr_model",
                                 "GROWDESK_AI_TIMEOUT_MS": "60000"})
    try:
        if not held_provider.wait_for_request():
            raise AssertionError("worker_did_not_enter_loopback_provider_request")
        running = expect(base, "GET", f"/api/v1/ai/runs/{in_flight_run}", 200, token=owner_token)["data"]
        if running["status"] != "running":
            raise AssertionError("provider_request_started_without_running_worker")
        expect(base, "POST", f"/api/v1/ai/runs/{in_flight_run}/cancel", 200, token=owner_token)
        cancelled_while_waiting = expect(base, "GET", f"/api/v1/ai/runs/{in_flight_run}", 200, token=owner_token)["data"]
        if cancelled_while_waiting["status"] != "cancelled" or cancelled_while_waiting.get("ocrDraft") is not None or cancelled_while_waiting.get("resultSummary") is not None:
            raise AssertionError("inflight_cancel_did_not_fence_provider_result")
        held_provider.release_response.set()
        stack.wait_worker(worker)
        if not held_provider.response_finished.wait(5):
            raise AssertionError("held_provider_response_was_not_released")
        after_worker = expect(base, "GET", f"/api/v1/ai/runs/{in_flight_run}", 200, token=owner_token)["data"]
        after_state = state(stack, owner_id, family_id, baby_id)
        unchanged = ("receipts", "taskResultRefs", "runSummaries", "ocrDrafts", "messages",
                     "medicalReports", "growthMeasurements", "timeline", "changes", "familyCursor")
        if after_worker["status"] != "cancelled" or after_worker.get("ocrDraft") is not None or after_worker.get("resultSummary") is not None:
            raise AssertionError("late_provider_result_reopened_cancelled_run")
        if any(after_state[key] != in_flight_before[key] for key in unchanged):
            raise AssertionError("inflight_cancel_published_result_or_business_write")
    finally:
        held_provider.close()
    cases.append("http_cancel_while_worker_waits_on_loopback_provider_then_release_valid_result_without_commit")
    outsider_run = expect(base, "GET", f"/api/v1/ai/runs/{failed_run}", 404, token=outsider_token)
    if outsider_run.get("error", {}).get("code") != "RECORD_NOT_FOUND":
        raise AssertionError("foreign_principal_read_leaked_run")
    cases.append("real_pdf_upload_worker_typed_medical_result_failed_retry_scope_and_no_diagnosis")

    before_confirm = state(stack, owner_id, family_id, baby_id)
    if before_confirm["medicalReports"] != 0 or before_confirm["growthMeasurements"] != 0:
        raise AssertionError("ocr_worker_wrote_business_records_before_confirmation")
    report_body = {
        "title": "test confirmed blood report", "category": "blood", "reportDate": "2026-09-15",
        "hospital": "test edited hospital", "department": "test lab", "diagnosis": None,
        "notes": "test user reviewed the draft", "attachmentIds": [med_pdf], "ocrRunId": failed_run,
        "items": [{"id": "test-item-1", "name": "Hemoglobin", "value": "121", "unit": "g/L",
                   "referenceRange": "110-150", "status": "normal", "interpretation": "test user corrected value"}],
        "growthData": {"weightKg": "8.25", "heightCm": "70.5", "headCircumferenceCm": "44.1"},
    }
    report_path = f"/api/v1/babies/{baby_id}/medical-reports"
    report_key = "test_mgocr_confirm_medical_" + suffix
    feed_before_state = state(stack, owner_id, family_id, baby_id)
    owner_feed_before = family_feed(base, family_id, owner_token)
    member_feed_before = family_feed(base, family_id, member_token)
    if (owner_feed_before["hasMore"] or member_feed_before["hasMore"] or
            owner_feed_before["highWater"] != str(feed_before_state["familyCursor"]) or
            member_feed_before["highWater"] != str(feed_before_state["familyCursor"]) or
            owner_feed_before["nextCursor"] != member_feed_before["nextCursor"]):
        raise AssertionError("two_member_feed_baseline_did_not_converge")
    stack.sql(f"""CREATE FUNCTION test_mgocr_fail_cursor() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test injected OCR confirmation rollback'; END; $$;
      CREATE TRIGGER test_mgocr_fail_cursor BEFORE UPDATE ON family_sync_states
      FOR EACH ROW WHEN (NEW.family_id='{family_id}') EXECUTE FUNCTION test_mgocr_fail_cursor();""")
    try:
        before_rollback = state(stack, owner_id, family_id, baby_id)
        expect(base, "POST", report_path, 500, report_body, owner_token, report_key)
        if state(stack, owner_id, family_id, baby_id) != before_rollback:
            raise AssertionError("medical_growth_confirmation_failure_leaked_partial_state")
    finally:
        stack.sql("DROP TRIGGER test_mgocr_fail_cursor ON family_sync_states; DROP FUNCTION test_mgocr_fail_cursor();")
    report = expect(base, "POST", report_path, 201, report_body, owner_token, report_key)["data"]
    after_first_confirmation = state(stack, owner_id, family_id, baby_id)
    replayed = expect(base, "POST", report_path, 201, report_body, owner_token, report_key)["data"]
    after_replay = state(stack, owner_id, family_id, baby_id)
    if (report["id"] != replayed["id"] or report.get("category") != "blood" or
            report["attachmentIds"] != [med_pdf] or after_replay != after_first_confirmation):
        raise AssertionError("medical_confirmation_replay_or_attachment_mismatch")
    expect(base, "POST", report_path, 409, {**report_body, "title": "test changed body"}, owner_token, report_key)
    wrong_baby_body = {**report_body, "title": "test out of scope"}
    expect(base, "POST", f"/api/v1/babies/{second_baby['id']}/medical-reports", 409,
           wrong_baby_body, owner_token, "test_mgocr_wrong_baby_save_" + suffix)
    report_read = expect(base, "GET", f"{report_path}/{report['id']}", 200, token=owner_token)["data"]
    growth_after_medical = expect(base, "GET", f"/api/v1/babies/{baby_id}/growth-measurements", 200,
                                  token=owner_token)["data"]
    if report_read["id"] != report["id"] or len(growth_after_medical) != 1:
        raise AssertionError("explicit_medical_confirm_readback_failed")
    medical_growth = growth_after_medical[0]
    if (medical_growth["weightKg"] != "8.25" or medical_growth["heightCm"] != "70.5" or
            medical_growth["headCircumferenceCm"] != "44.1"):
        raise AssertionError("optional_growth_data_not_created_atomically")
    owner_delta = family_feed(base, family_id, owner_token, owner_feed_before["nextCursor"])
    member_delta = family_feed(base, family_id, member_token, member_feed_before["nextCursor"])
    expected_cursors = [str(feed_before_state["familyCursor"] + 1), str(feed_before_state["familyCursor"] + 2)]
    for label, delta in (("owner", owner_delta), ("member", member_delta)):
        changes = delta["changes"]
        by_entity = {(change["entityType"], change["entityId"]): change for change in changes}
        medical_change = by_entity.get(("medical", report["id"]))
        growth_change = by_entity.get(("growth", medical_growth["id"]))
        if (len(changes) != 2 or medical_change is None or growth_change is None or
                [change["cursor"] for change in changes] != expected_cursors or
                medical_change["payload"].get("title") != report["title"] or
                growth_change["payload"].get("weightKg") != "8.25"):
            raise AssertionError(f"{label}_family_feed_missed_medical_or_optional_growth_change")
    cases.append("owner_and_second_family_member_receive_medical_and_growth_changes_at_consecutive_cursors")
    cases.append("human_edited_medical_confirmation_with_atomic_growth_rollback_readback_and_idempotency")

    growth_key = "test_mgocr_growth_queue_" + suffix
    growth_run = expect(base, "POST", "/api/v1/growth/ocr-runs", 202,
                        {"babyId": baby_id, "attachmentId": growth_png}, owner_token, growth_key)["data"]["runId"]
    if expect(base, "POST", "/api/v1/growth/ocr-runs", 202,
              {"babyId": baby_id, "attachmentId": growth_png}, owner_token, growth_key)["data"]["runId"] != growth_run:
        raise AssertionError("growth_ocr_same_key_replay_created_another_run")
    growth_state_before_worker = state(stack, owner_id, family_id, baby_id)
    if growth_state_before_worker["growthMeasurements"] != 1:
        raise AssertionError("growth_run_created_record_before_worker_or_confirmation")
    stack.run_worker(growth_fixture())
    growth_read = expect(base, "GET", f"/api/v1/ai/runs/{growth_run}", 200, token=owner_token)["data"]
    growth_draft = growth_read.get("ocrDraft")
    if (growth_read["status"] != "succeeded" or not isinstance(growth_draft, dict) or
            growth_draft.get("kind") != "growth" or growth_draft.get("measurementDate", {}).get("value") != "2026-09-16" or
            growth_draft.get("weightKg", {}).get("value") != "8.30" or
            growth_draft.get("heightCm", {}).get("value") != "71"):
        raise AssertionError("growth_typed_draft_mapping_failed")
    if state(stack, owner_id, family_id, baby_id)["growthMeasurements"] != 1:
        raise AssertionError("growth_worker_created_measurement_before_confirmation")
    growth_body = {"measurementDate": "2026-09-16", "weightKg": "8.30", "heightCm": "71",
                   "attachmentId": growth_png, "ocrRunId": growth_run, "notes": "test user confirmed OCR draft"}
    growth_path = f"/api/v1/babies/{baby_id}/growth-measurements"
    growth_record_key = "test_mgocr_confirm_growth_" + suffix
    measurement = expect(base, "POST", growth_path, 201, growth_body, owner_token, growth_record_key)["data"]
    measurement_replay = expect(base, "POST", growth_path, 201, growth_body, owner_token, growth_record_key)["data"]
    if measurement["id"] != measurement_replay["id"]:
        raise AssertionError("growth_confirmation_replay_created_duplicate")
    expect(base, "POST", growth_path, 409, {**growth_body, "weightKg": "8.31"}, owner_token, growth_record_key)
    wrong_baby_growth_body = {key: value for key, value in growth_body.items() if key != "attachmentId"}
    second_baby_confirmation = expect(base, "POST", f"/api/v1/babies/{second_baby['id']}/growth-measurements",
                                      409, wrong_baby_growth_body, owner_token, "test_mgocr_growth_wrong_baby_" + suffix)
    if second_baby_confirmation.get("error", {}).get("code") != "OCR_RUN_SCOPE_MISMATCH":
        raise AssertionError("growth_run_wrong_baby_not_rejected_by_scope")
    measurement_read = expect(base, "GET", f"{growth_path}/{measurement['id']}", 200, token=owner_token)["data"]
    if measurement_read["weightKg"] != "8.30" or measurement_read["attachmentId"] != growth_png:
        raise AssertionError("explicit_growth_confirm_readback_failed")

    before_update = state(stack, owner_id, family_id, baby_id)
    owner_before_update = family_feed(base, family_id, owner_token)
    member_before_update = family_feed(base, family_id, member_token)
    if (owner_before_update["hasMore"] or member_before_update["hasMore"] or
            owner_before_update["highWater"] != str(before_update["familyCursor"]) or
            member_before_update["highWater"] != str(before_update["familyCursor"])):
        raise AssertionError("two_member_medical_update_baseline_mismatch")
    updated_report = expect(base, "PATCH", f"{report_path}/{report['id']}", 200,
                            {"baseVersion": "1", "notes": "test updated after OCR review"}, owner_token)["data"]
    if updated_report["version"] != "2" or updated_report["notes"] != "test updated after OCR review":
        raise AssertionError("medical_report_update_readback_failed")
    owner_update_delta = family_feed(base, family_id, owner_token, owner_before_update["nextCursor"])["changes"]
    member_update_delta = family_feed(base, family_id, member_token, member_before_update["nextCursor"])["changes"]
    for label, changes in (("owner", owner_update_delta), ("member", member_update_delta)):
        if (len(changes) != 1 or changes[0]["entityType"] != "medical" or
                changes[0]["entityId"] != report["id"] or changes[0]["operation"] != "upsert" or
                changes[0]["version"] != "2" or
                changes[0]["payload"].get("notes") != "test updated after OCR review" or
                changes[0]["cursor"] != str(before_update["familyCursor"] + 1)):
            raise AssertionError(f"{label}_family_feed_missed_medical_report_update")

    before_delete = state(stack, owner_id, family_id, baby_id)
    owner_before_delete = family_feed(base, family_id, owner_token)
    member_before_delete = family_feed(base, family_id, member_token)
    if (owner_before_delete["hasMore"] or member_before_delete["hasMore"] or
            owner_before_delete["highWater"] != str(before_delete["familyCursor"]) or
            member_before_delete["highWater"] != str(before_delete["familyCursor"])):
        raise AssertionError("two_member_medical_delete_baseline_mismatch")
    deleted_report = expect(base, "POST", report_path, 201, {
        "title": "test medical feed delete", "category": "blood", "reportDate": "2026-09-17",
        "items": [], "attachmentIds": [],
    }, owner_token, "test_mgocr_feed_delete_create_" + suffix)["data"]
    owner_create_delta = family_feed(base, family_id, owner_token, owner_before_delete["nextCursor"])["changes"]
    member_create_delta = family_feed(base, family_id, member_token, member_before_delete["nextCursor"])["changes"]
    for label, changes in (("owner", owner_create_delta), ("member", member_create_delta)):
        if (len(changes) != 1 or changes[0]["entityType"] != "medical" or
                changes[0]["entityId"] != deleted_report["id"] or changes[0]["operation"] != "upsert" or
                changes[0]["payload"].get("title") != "test medical feed delete" or
                changes[0]["cursor"] != str(before_delete["familyCursor"] + 1)):
            raise AssertionError(f"{label}_family_feed_missed_medical_report_create")
    before_tombstone = state(stack, owner_id, family_id, baby_id)
    owner_before_tombstone = family_feed(base, family_id, owner_token)
    member_before_tombstone = family_feed(base, family_id, member_token)
    expect(base, "DELETE", f"{report_path}/{deleted_report['id']}?baseVersion=1", 200, token=owner_token)
    expect(base, "GET", f"{report_path}/{deleted_report['id']}", 404, token=owner_token)
    owner_delete_delta = family_feed(base, family_id, owner_token, owner_before_tombstone["nextCursor"])["changes"]
    member_delete_delta = family_feed(base, family_id, member_token, member_before_tombstone["nextCursor"])["changes"]
    for label, changes in (("owner", owner_delete_delta), ("member", member_delete_delta)):
        if (len(changes) != 1 or changes[0]["entityType"] != "medical" or
                changes[0]["entityId"] != deleted_report["id"] or changes[0]["operation"] != "delete" or
                changes[0]["cursor"] != str(before_tombstone["familyCursor"] + 1)):
            raise AssertionError(f"{label}_family_feed_missed_medical_report_delete")
    cases.append("two_member_medical_create_update_delete_feed_events")
    final_state = state(stack, owner_id, family_id, baby_id)
    if final_state["medicalReports"] != 1 or final_state["growthMeasurements"] != 2:
        raise AssertionError("confirmation_record_count_mismatch")
    cases.append("growth_photo_upload_queue_typed_worker_explicit_save_scope_and_exact_replay")

    return {
        "status": "PASS",
        "cases": cases,
        "httpAssertions": HTTP_EXPECT_COUNT,
        "workerRuns": ["medical-invalid-result", "medical-retry-success", "medical-held-provider-cancel-fence", "growth-success"],
        "businessCounts": {"medicalReports": final_state["medicalReports"], "growthMeasurements": final_state["growthMeasurements"]},
        "taskStateCounts": {key: final_state[key] for key in ("tasks", "outbox", "sessions", "messages", "runs", "events", "receipts")},
        "beforeExplicitConfirmation": {"medicalReports": before_confirm["medicalReports"],
                                       "growthMeasurements": before_confirm["growthMeasurements"]},
        "feed": {"twoMemberReadback": True, "medicalAndGrowthChanges": 2,
                 "rollbackCursorBefore": feed_before_state["familyCursor"],
                 "finalCursor": final_state["familyCursor"], "finalChangeCount": final_state["changes"]},
        "cancellationRaces": {"cancelWhileLoopbackProviderHeld": True,
                               "validResponseReleasedAfterCancel": True,
                               "lateWorkerCommitFenced": True,
                               "completedWorkerRemainedSucceededAfterCancel": True},
        "rollbackStateUnchanged": True,
        "fixtureOnly": True,
        "recognitionQualityClaimed": False,
        "externalProviderCalls": False,
        "productionOrLegacyServicesContacted": False,
        "principalIdsRecorded": False,
        "tokensOrPresignedUrlsRecorded": False,
    }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def write_evidence(result: dict, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() or path.is_symlink():
        raise RuntimeError("refuse_to_overwrite_evidence")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())


def main() -> int:
    suffix = uuid.uuid4().hex[:12]
    stack = OwnedStack(suffix)
    result: dict = {"status": "FAIL", "runId": suffix, "externalSecretsRead": False}
    failure = None
    try:
        base, minio_port = stack.start()
        result.update(run_scenarios(stack, base, minio_port))
        result["apiBinarySha256"] = sha256(stack.api_binary)
        result["workerBinarySha256"] = sha256(stack.worker_binary)
        result["migrationBinarySha256"] = sha256(stack.migrate_binary)
        result["apiSourceRevision"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        result["sourceHashes"] = {
            relative: sha256(ROOT / relative) for relative in (
                "packages/contracts/src/ocr.ts", "packages/contracts/src/routes.ts",
                "packages/contracts/src/medical.ts", "packages/contracts/src/growth.ts",
                "packages/contracts/src/ai.ts", "packages/contracts/src/index.ts",
                "packages/contracts/tests/contracts.test.ts",
                "internal/backend/ai_run_commands.go", "internal/backend/native_processors.go",
                "internal/backend/native_tasks.go",
                "internal/backend/medical_growth_ocr.go", "internal/backend/ai_provider.go",
                "internal/backend/ai_run_reads.go", "internal/backend/growth.go",
                "internal/backend/medical_reports.go", "internal/backend/medical_projections.go",
                "internal/backend/record_mutation.go", "prisma/schema.prisma",
                "internal/backend/foundation_test.go", "internal/backend/native_sync_test.go",
                "internal/backend/medical_growth_ocr_test.go",
                "prisma/migrations/202610030030_medical_growth_ocr_typed_drafts/migration.sql",
                "contracts/openapi.json", "scripts/go-medical-growth-ocr-typed-integration.py",
                "scripts/go-medical-integration.py",
            )
        }
        manifest = json.dumps(result["sourceHashes"], sort_keys=True, separators=(",", ":")).encode()
        result["sourceManifestSha256"] = hashlib.sha256(manifest).hexdigest()
    except Exception as error:
        failure = f"{type(error).__name__}:{str(error)[:240]}"
        result = {"status": "FAIL", "runId": suffix, "failure": failure,
                  "externalSecretsRead": False, "credentialsOrTokensRecorded": False}
    finally:
        result["privateStackCleaned"] = stack.close()
        result["privateDatabaseAndObjectDataRemoved"] = not stack.root.exists()
    result["status"] = "PASS" if failure is None and result["privateStackCleaned"] else "FAIL"
    evidence = ROOT / "evidence/tasks/BE_MEDICAL_GROWTH_OCR_TYPED_DRAFTS" / f"live-{suffix}.json"
    write_evidence(result, evidence)
    print(json.dumps({"status": result["status"], "runId": suffix, "evidence": str(evidence.relative_to(ROOT)),
                      "privateStackCleaned": result["privateStackCleaned"],
                      "failure": result.get("failure")}, ensure_ascii=False))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda signum, _frame: (_ for _ in ()).throw(KeyboardInterrupt(f"signal_{signum}")))
    raise SystemExit(main())
