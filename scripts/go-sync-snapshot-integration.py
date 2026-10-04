#!/usr/bin/env python3
"""Owned loopback HTTP coverage for Go family snapshot pages and cursor retention.

The suite starts private disposable PostgreSQL/Redis processes on random
loopback ports, registers test_ users, creates business data through HTTP, and
runs the real native Go worker for snapshot generation. Object storage and
external provider configuration are excluded. SQL is used only to age a real
test_ family_changes row past the documented retention window.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import signal
import shutil
import socket
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("sync_snapshot_support", ROOT / "scripts/go-parity-support.py")
assert SPEC and SPEC.loader
SUPPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SUPPORT)
TOOLS = SUPPORT.DOMAIN.TOOLS


def free_loopback_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = int(sock.getsockname()[1])
    if port in (5432, 6379, 3088, 3089):
        return free_loopback_port()
    return port


class LocalOwnedEnvironment(TOOLS.OwnedEnvironment):
    """A private local PG18/Redis pair for hosts without Docker.

    The cluster and Redis process bind only random loopback ports. The API gets
    a freshly-created non-superuser role/database and random credentials. No
    caller-supplied service URLs or existing databases are accepted.
    """

    def __init__(self):
        super().__init__()
        # Start from a tiny allowlist rather than inheriting credentials or
        # provider endpoints. Snapshot pages are persisted in PostgreSQL and
        # this scenario does not need object storage or paid/external APIs.
        self.env = {
            key: value
            for key, value in self.env.items()
            if key in {"PATH", "HOME", "TMPDIR", "TMP", "LANG", "LC_ALL", "LC_CTYPE"}
        }
        self.env["LC_ALL"] = "C"
        self.root = Path(tempfile.mkdtemp(prefix="growdesk-sync-snapshot-"))
        self.root.chmod(0o700)
        self.pgdata = self.root / "postgres"
        self.pg_port = free_loopback_port()
        self.redis_port = free_loopback_port()
        self.pg_started = False
        self.redis_process: subprocess.Popen | None = None
        self.redis_log = None
        self.cleanup_state: dict[str, object] = {}

    def _run(self, command: list[str], *, env=None, input_text=None):
        return subprocess.run(
            command,
            cwd=ROOT,
            env=env or self.env,
            input=input_text,
            text=True,
            check=True,
            capture_output=True,
        ).stdout.strip()

    def _psql(self, role: str, password: str, database: str, statement: str) -> str:
        return self._run(
            [
                "psql", "-X", "-v", "ON_ERROR_STOP=1", "-At",
                "-h", "127.0.0.1", "-p", str(self.pg_port),
                "-U", role, "-d", database,
            ],
            env={**self.env, "PGPASSWORD": password},
            input_text=statement,
        )

    @staticmethod
    def _redis_command(sock: socket.socket, *parts: str) -> str:
        payload = [f"*{len(parts)}\r\n"]
        for part in parts:
            encoded = part.encode()
            payload.extend((f"${len(encoded)}\r\n", encoded.decode(), "\r\n"))
        sock.sendall("".join(payload).encode())
        with sock.makefile("rb") as stream:
            return stream.readline().decode().strip()

    def _probe_redis(self, password: str) -> None:
        with socket.create_connection(("127.0.0.1", self.redis_port), timeout=2) as sock:
            if self._redis_command(sock, "AUTH", "default", password) != "+OK":
                raise RuntimeError("owned Redis authentication failed")
            if self._redis_command(sock, "PING") != "+PONG":
                raise RuntimeError("owned Redis health check failed")

    def start(self):
        pg_version = self._run(["postgres", "--version"])
        if not pg_version.startswith("postgres (PostgreSQL) 18."):
            raise RuntimeError(f"isolated harness requires PostgreSQL 18, found {pg_version}")
        redis_version = self._run(["redis-server", "--version"])
        if not redis_version.startswith("Redis server v=8."):
            raise RuntimeError(f"isolated harness requires Redis 8, found {redis_version}")

        admin_password = secrets.token_urlsafe(32)
        pwfile = self.root / "postgres-password"
        pwfile.write_text(admin_password + "\n")
        pwfile.chmod(0o600)
        self._run([
            "initdb", "-D", str(self.pgdata), "-U", "postgres",
            "--pwfile", str(pwfile), "--auth-local=trust", "--auth-host=scram-sha-256",
            "--no-instructions",
        ])
        self._run([
            "pg_ctl", "-D", str(self.pgdata), "-l", str(self.root / "postgres.log"),
            "-o", f"-h 127.0.0.1 -p {self.pg_port} -c listen_addresses=127.0.0.1",
            "-w", "-t", "40", "start",
        ])
        self.pg_started = True

        create = (
            f"CREATE ROLE {self.role} LOGIN PASSWORD '{self.password}' "
            "NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;\n"
            f"CREATE DATABASE {self.database} OWNER {self.role};\n"
        )
        self._psql("postgres", admin_password, "postgres", create)
        identity = self._psql(
            self.role, self.password, self.database,
            "SELECT current_database(),current_user,rolsuper "
            "FROM pg_roles WHERE rolname=current_user;",
        )
        if identity != self.database + "|" + self.role + "|f":
            raise RuntimeError("owned PostgreSQL role/database guard failed")

        for directory in sorted((ROOT / "prisma/migrations").iterdir()):
            migration = directory / "migration.sql"
            if migration.is_file():
                self._psql(self.role, self.password, self.database, migration.read_text())

        self.redis_log = (self.root / "redis.log").open("w+")
        self.redis_process = subprocess.Popen(
            [
                "redis-server", "--bind", "127.0.0.1", "--port", str(self.redis_port),
                "--requirepass", self.password, "--save", "", "--appendonly", "no",
                "--dir", str(self.root), "--daemonize", "no",
            ],
            cwd=ROOT,
            env=self.env,
            stdout=self.redis_log,
            stderr=self.redis_log,
        )
        for _ in range(100):
            if self.redis_process.poll() is not None:
                self.redis_log.flush()
                self.redis_log.seek(0)
                raise RuntimeError("owned Redis exited: " + self.redis_log.read()[-2000:])
            try:
                self._probe_redis(self.password)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("owned Redis readiness timed out")

        self.env.update(
            DATABASE_URL=(
                f"postgresql://{self.role}:{self.password}@127.0.0.1:{self.pg_port}/"
                f"{self.database}?sslmode=disable"
            ),
            REDIS_URL=f"redis://default:{self.password}@127.0.0.1:{self.redis_port}/0",
            JWT_SECRET=self.jwt,
            SESSION_ENCRYPTION_KEY=self.jwt,
            GROWDESK_ENV="test",
            GROWDESK_GO_EXPERIMENTAL="1",
            GROWDESK_AI_BUDGET_UNIT="ai_run_attempt",
            GROWDESK_AI_BUDGET_PERIOD="utc_day",
            GROWDESK_AI_BUDGET_USER_LIMIT="100",
            GROWDESK_AI_BUDGET_FAMILY_LIMIT="1000",
            GROWDESK_AI_BUDGET_GLOBAL_LIMIT="10000",
            DB_POOL_MAX="10",
            HOST="127.0.0.1",
        )
        return self

    def sql(self, statement: str) -> str:
        return self._psql(self.role, self.password, self.database, statement)

    def close(self):
        for proc in reversed(self.processes):
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=5)
        api_processes_stopped = all(proc.poll() is not None for proc in self.processes)

        if self.redis_process is not None and self.redis_process.poll() is None:
            self.redis_process.terminate()
            try:
                self.redis_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.redis_process.kill()
                self.redis_process.wait(timeout=5)
        redis_stopped = self.redis_process is None or self.redis_process.poll() is not None
        if self.redis_log is not None:
            self.redis_log.close()

        postgres_stopped = not self.pg_started
        if self.pg_started:
            result = subprocess.run(
                ["pg_ctl", "-D", str(self.pgdata), "-m", "fast", "-w", "-t", "30", "stop"],
                cwd=ROOT,
                env=self.env,
                text=True,
                capture_output=True,
            )
            postgres_stopped = result.returncode == 0
            if not postgres_stopped:
                self.cleanup_state["postgresStopError"] = (result.stderr or result.stdout)[-2000:]

        shutil.rmtree(self.root, ignore_errors=True)
        self.cleanup_state.update({
            "apiProcessesStopped": api_processes_stopped,
            "redisProcessStopped": redis_stopped,
            "postgresStopped": postgres_stopped,
            "temporaryDirectoryRemoved": not self.root.exists(),
            "noContainerResourcesCreated": True,
        })
        return dict(self.cleanup_state)


class SnapshotScenario:
    def __init__(self, owned, base: str, worker: Path):
        self.owned = owned
        self.base = base
        self.worker = worker.resolve()
        self.calls = 0
        self.observations: list[dict[str, object]] = []
        self.snapshot_workers = 0

    def call(self, method, path, status, body=None, token=None, observe=None):
        self.calls += 1
        actual, value = TOOLS.http(self.base, method, path, body, token)
        if actual != status:
            code = value.get("error", {}).get("code", "unexpected_success") if isinstance(value, dict) else type(value).__name__
            raise AssertionError(f"{method} {path}: expected {status}, got {actual}; {code}")
        if observe:
            self.observations.append({"case": observe, "status": actual})
        return value

    def error(self, method, path, status, error_code, token=None, observe=None):
        value = self.call(method, path, status, token=token, observe=observe)
        actual_code = value.get("error", {}).get("code") if isinstance(value, dict) else None
        if actual_code != error_code:
            raise AssertionError(f"{method} {path}: expected error {error_code}, got {actual_code}")
        return value

    def register(self, label: str) -> dict[str, object]:
        username = f"test_sync_snapshot_{label}_{self.owned.owner}"
        result = self.call("POST", "/api/v1/auth/register", 201, {
            "username": username,
            "password": "test_sync_snapshot_password_8675309",
            "displayName": f"Test Sync Snapshot {label}",
            "deviceLabel": "test_sync_snapshot",
        })["data"]
        if result["user"]["username"] != username:
            raise AssertionError("registration did not preserve the isolated test username")
        return result

    def family_page(self, family_id: str, snapshot_id: str, page: int) -> str:
        return f"/api/v1/sync/families/{family_id}/snapshots/{snapshot_id}/pages/{page}"

    def family_snapshot(self, family_id: str, snapshot_id: str) -> str:
        return f"/api/v1/sync/families/{family_id}/snapshots/{snapshot_id}"

    def cursor_claims(self, token: str, family_id: str) -> dict[str, object]:
        encoded, signature = token.split(".", 1)
        raw = base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4))
        secret = self.owned.env.get("SESSION_SECRET") or self.owned.env["JWT_SECRET"]
        expected = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, expected):
            raise AssertionError("Go family feed did not return a valid signed cursor")
        cursor = json.loads(raw)
        if cursor.get("scope") != "family" or cursor.get("scopeId") != family_id:
            raise AssertionError("Go family feed cursor has the wrong scope")
        return cursor

    def cursor_position(self, token: str, family_id: str) -> int:
        return int(self.cursor_claims(token, family_id)["position"])

    def run_worker_until_ready(self, family_id: str, snapshot_id: str, token: str):
        status_path = f"/api/v1/sync/families/{family_id}/snapshots/{snapshot_id}"
        for _ in range(4):
            outcome = subprocess.run(
                [str(self.worker), "--once"],
                cwd=ROOT,
                env=self.owned.env,
                check=False,
                capture_output=True,
                timeout=220,
            )
            self.snapshot_workers += 1
            if outcome.returncode != 0:
                raise AssertionError(f"native snapshot worker exited with status {outcome.returncode}")
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                response = self.call("GET", status_path, 200, token=token)
                metadata = response["data"]
                status = metadata["status"]
                if status == "ready":
                    if not metadata.get("nextCursor"):
                        raise AssertionError("ready snapshot metadata omitted its signed nextCursor")
                    claims = self.cursor_claims(metadata["nextCursor"], family_id)
                    if claims.get("epoch") != metadata["epoch"]:
                        raise AssertionError("snapshot tail cursor epoch differs from ready metadata")
                    if claims.get("position") != metadata["highWater"] or claims.get("highWater") != metadata["highWater"]:
                        raise AssertionError("snapshot tail cursor does not start exactly at its highWater")
                    if claims.get("mode") != "tail" or claims.get("schemaVersion") != 1:
                        raise AssertionError("snapshot cursor is not a supported tail cursor")
                    return metadata
                if status == "failed":
                    raise AssertionError("real native snapshot worker persisted failed status")
                time.sleep(0.1)
        raise AssertionError("real native snapshot worker did not make the queued snapshot ready")

    def download_all_pages(self, family_id: str, snapshot_id: str, token: str, manifest: dict[str, object]):
        count = manifest["pageCount"]
        if not isinstance(count, int) or count < 1:
            raise AssertionError(f"ready snapshot has invalid pageCount={count!r}")
        pages = []
        for index in range(count):
            response = self.call(
                "GET", self.family_page(family_id, snapshot_id, index), 200,
                token=token, observe=f"authorized page {index} download",
            )["data"]
            expected_keys = {"snapshotId", "page", "pageCount", "highWater", "content", "contentJSON", "sha256"}
            if set(response) != expected_keys:
                raise AssertionError("snapshot page response omitted its typed content or byte-verifiable digest")
            if response["snapshotId"] != snapshot_id or response["page"] != index:
                raise AssertionError("snapshot page identity does not match the requested page")
            if response["pageCount"] != count or response["highWater"] != manifest["highWater"]:
                raise AssertionError("snapshot page metadata is inconsistent with its manifest")
            content = response["content"]
            if set(content) != {"entityType", "data"} or not isinstance(content["data"], list):
                raise AssertionError("snapshot page content has an invalid native projection shape")
            content_json = response["contentJSON"]
            if not isinstance(content_json, str) or hashlib.sha256(content_json.encode("utf-8")).hexdigest() != response["sha256"]:
                raise AssertionError("snapshot page byte string does not match its SHA-256 digest")
            if json.loads(content_json) != content:
                raise AssertionError("decoded exact page bytes differ from the typed content projection")
            pages.append(content)
        out_of_range = self.call(
            "GET", self.family_page(family_id, snapshot_id, count), 404,
            token=token, observe="snapshot page index at pageCount is not found",
        )
        if out_of_range.get("error", {}).get("code") != "RECORD_NOT_FOUND":
            raise AssertionError("out-of-range snapshot page must be an explicit not-found response")
        return pages

    def run(self):
        owner = self.register("owner")
        guest = self.register("guest")
        outsider = self.register("outsider")
        owner_token = owner["accessToken"]
        guest_token = guest["accessToken"]
        outsider_token = outsider["accessToken"]
        guest_user_id = guest["user"]["id"]

        family = self.call("POST", "/api/v1/families", 201, {
            "name": f"test_sync_snapshot_family_{self.owned.owner}",
            "timeZone": "Asia/Shanghai",
        }, owner_token)["data"]
        family_id = family["id"]
        baby = self.call("POST", f"/api/v1/families/{family_id}/babies", 201, {
            "name": f"test_sync_snapshot_baby_{self.owned.owner}",
            "birthDate": "2026-04-01",
            "gender": "girl",
        }, owner_token)["data"]
        baby_id = baby["id"]
        baby_path = f"/api/v1/babies/{baby_id}"
        growth_path = baby_path + "/growth-measurements"

        older_feed = self.call(
            "GET", f"/api/v1/sync/families/{family_id}/changes?limit=200", 200,
            token=owner_token, observe="family feed before test record",
        )
        growth = self.call("POST", growth_path, 201, {
            "measurementDate": "2026-05-01",
            "weightKg": "9.40",
            "heightCm": "75.5",
            "headCircumferenceCm": None,
            "notes": "test_sync_snapshot_projection",
        }, owner_token)["data"]
        growth_id = growth["id"]
        latest_feed = self.call(
            "GET", f"/api/v1/sync/families/{family_id}/changes?limit=200", 200,
            token=owner_token, observe="family feed after test record",
        )
        if not older_feed["nextCursor"] or not latest_feed["nextCursor"]:
            raise AssertionError("native feeds must issue signed cursor tokens")
        old_position = self.cursor_position(older_feed["nextCursor"], family_id)
        latest_position = self.cursor_position(latest_feed["nextCursor"], family_id)
        if old_position >= latest_position:
            raise AssertionError("retention fixture must use an earlier real family cursor")

        # This changes only created_at on an HTTP-created test_ change row to
        # exercise the real 90-day floor; the record and cursor are never SQL-seeded.
        aged = self.owned.sql(
            "UPDATE family_changes SET created_at=NOW()-INTERVAL '91 days' "
            f"WHERE family_id='{family_id}' AND entity_id='{growth_id}';"
        )
        if aged != "UPDATE 1":
            raise AssertionError(f"expected to age exactly one HTTP-created test change, got {aged!r}")
        self.error(
            "GET", f"/api/v1/sync/families/{family_id}/changes?cursor={older_feed['nextCursor']}",
            410, "SYNC_RESET_REQUIRED", token=owner_token, observe="cursor before retained floor",
        )
        current_feed = self.call(
            "GET", f"/api/v1/sync/families/{family_id}/changes?cursor={latest_feed['nextCursor']}", 200,
            token=owner_token, observe="cursor at retention floor remains usable",
        )
        if current_feed["changes"] or current_feed["hasMore"]:
            raise AssertionError("latest tail cursor should read an empty normal page")
        token_to_tamper = latest_feed["nextCursor"]
        tampered = token_to_tamper[:-1] + ("0" if token_to_tamper[-1] != "0" else "1")
        self.error(
            "GET", f"/api/v1/sync/families/{family_id}/changes?cursor={tampered}",
            400, "INVALID_SYNC_CURSOR", token=owner_token, observe="tampered signed cursor rejected",
        )
        other_family = self.call("POST", "/api/v1/families", 201, {
            "name": f"test_sync_snapshot_other_family_{self.owned.owner}",
            "timeZone": "Asia/Shanghai",
        }, owner_token)["data"]["id"]
        self.error(
            "GET", f"/api/v1/sync/families/{other_family}/changes?cursor={latest_feed['nextCursor']}",
            400, "INVALID_SYNC_CURSOR", token=owner_token, observe="cross-family signed cursor rejected",
        )

        # The real native worker generates and hashes this manifest.
        snapshot = self.call(
            "POST", f"/api/v1/sync/families/{family_id}/snapshots", 202,
            token=owner_token, observe="snapshot creation queued",
        )["data"]
        snapshot_id = snapshot["snapshotId"]
        queued_metadata = self.call(
            "GET", self.family_snapshot(family_id, snapshot_id), 200,
            token=owner_token, observe="queued snapshot metadata has no resume cursor",
        )["data"]
        if queued_metadata["status"] != "queued" or "nextCursor" in queued_metadata:
            raise AssertionError("queued snapshot must not advertise a resume cursor before its baseline is ready")
        self.error(
            "GET", self.family_page(family_id, snapshot_id, 0), 409, "SNAPSHOT_NOT_READY",
            token=owner_token, observe="queued snapshot page not falsely ready",
        )
        owner_manifest = self.run_worker_until_ready(family_id, snapshot_id, owner_token)
        owner_pages = self.download_all_pages(family_id, snapshot_id, owner_token, owner_manifest)
        baby_page = next((page for page in owner_pages if page["entityType"] == "baby"), None)
        growth_page = next((page for page in owner_pages if page["entityType"] == "growth"), None)
        if baby_page is None or not any(item.get("id") == baby_id for item in baby_page["data"]):
            raise AssertionError("worker snapshot omitted the authorized test baby")
        if growth_page is None or not any(item.get("id") == growth_id for item in growth_page["data"]):
            raise AssertionError("worker snapshot omitted the HTTP-created test growth measurement")
        # getNativeSnapshotPage recomputes snapshotHash over the stored complete
        # page manifest before returning any page. Successful full-page reads
        # therefore exercise the existing integrity check over the real worker output.
        snapshot_cursor = owner_manifest["nextCursor"]
        snapshot_claims = self.cursor_claims(snapshot_cursor, family_id)
        if int(snapshot_claims["position"]) != latest_position:
            raise AssertionError("ready snapshot cursor did not preserve its captured feed highWater")
        post_snapshot_growth = self.call("POST", growth_path, 201, {
            "measurementDate": "2026-06-01",
            "weightKg": "9.65",
            "heightCm": "76.0",
            "headCircumferenceCm": None,
            "notes": "test_sync_snapshot_after_baseline",
        }, owner_token, observe="write after ready snapshot baseline")['data']
        caught_up = self.call(
            "GET", f"/api/v1/sync/families/{family_id}/changes?cursor={snapshot_cursor}", 200,
            token=owner_token, observe="resume family feed from ready snapshot cursor",
        )
        if len(caught_up["changes"]) != 1:
            raise AssertionError(f"snapshot catch-up returned {len(caught_up['changes'])} changes; expected exactly the later write")
        caught_up_change = caught_up["changes"][0]
        if caught_up_change["entityType"] != "growth" or caught_up_change["entityId"] != post_snapshot_growth["id"]:
            raise AssertionError("snapshot catch-up replayed an old record or missed the later HTTP write")

        invite = self.call("POST", f"/api/v1/families/{family_id}/invites", 201, {
            "expiresInDays": 1,
        }, owner_token)["data"]
        self.call("POST", "/api/v1/families/join", 200, {
            "inviteCode": invite["inviteCode"],
        }, guest_token, observe="test guest joins test family")
        self.error(
            "GET", self.family_page(family_id, snapshot_id, 0), 404, "RECORD_NOT_FOUND",
            token=guest_token, observe="other snapshot creator hidden from family member",
        )

        # A family member without BabyMember can create a family bootstrap, but
        # its real snapshot projection must contain no private baby records.
        no_baby_snapshot = self.call(
            "POST", f"/api/v1/sync/families/{family_id}/snapshots", 202,
            token=guest_token, observe="family member queues own scoped snapshot",
        )["data"]["snapshotId"]
        no_baby_manifest = self.run_worker_until_ready(family_id, no_baby_snapshot, guest_token)
        no_baby_pages = self.download_all_pages(family_id, no_baby_snapshot, guest_token, no_baby_manifest)
        no_baby_page = next((page for page in no_baby_pages if page["entityType"] == "baby"), None)
        if no_baby_page is None or no_baby_page["data"]:
            raise AssertionError("snapshot worker exposed baby data without BabyMember permission")

        self.call("POST", baby_path + "/members", 201, {
            "userId": guest_user_id,
            "role": "member",
        }, owner_token, observe="explicit BabyMember grant")
        self.error(
            "GET", self.family_page(family_id, no_baby_snapshot, 0), 410, "SYNC_RESET_REQUIRED",
            token=guest_token, observe="permission change invalidates old snapshot",
        )
        self.error(
            "GET", self.family_snapshot(family_id, no_baby_snapshot), 410, "SYNC_RESET_REQUIRED",
            token=guest_token, observe="permission change withholds stale snapshot cursor",
        )

        shared_snapshot = self.call(
            "POST", f"/api/v1/sync/families/{family_id}/snapshots", 202,
            token=guest_token, observe="guest queues snapshot after BabyMember grant",
        )["data"]["snapshotId"]
        shared_manifest = self.run_worker_until_ready(family_id, shared_snapshot, guest_token)
        shared_pages = self.download_all_pages(family_id, shared_snapshot, guest_token, shared_manifest)
        shared_baby_page = next((page for page in shared_pages if page["entityType"] == "baby"), None)
        shared_growth_page = next((page for page in shared_pages if page["entityType"] == "growth"), None)
        if shared_baby_page is None or not any(item.get("id") == baby_id for item in shared_baby_page["data"]):
            raise AssertionError("authorized guest snapshot omitted the explicitly shared test baby")
        if shared_growth_page is None or not any(item.get("id") == growth_id for item in shared_growth_page["data"]):
            raise AssertionError("authorized guest snapshot omitted the scoped test growth measurement")

        # Family membership alone is insufficient to fetch somebody else's
        # snapshot. A foreign-family bearer cannot enumerate the owner snapshot.
        foreign_status, _ = TOOLS.http(
            self.base, "GET", self.family_page(family_id, shared_snapshot, 0), token=outsider_token
        )
        self.calls += 1
        if foreign_status not in (403, 404):
            raise AssertionError(f"foreign family snapshot page unexpectedly returned HTTP {foreign_status}")
        self.observations.append({"case": "foreign tenant snapshot page denied", "status": foreign_status})
        foreign_metadata_status, _ = TOOLS.http(
            self.base, "GET", self.family_snapshot(family_id, shared_snapshot), token=outsider_token
        )
        self.calls += 1
        if foreign_metadata_status not in (403, 404):
            raise AssertionError(f"foreign family snapshot metadata returned HTTP {foreign_metadata_status}")
        self.observations.append({"case": "foreign tenant snapshot cursor metadata denied", "status": foreign_metadata_status})

        self.call("DELETE", f"/api/v1/babies/{baby_id}/members/{guest_user_id}", 200,
                  token=owner_token, observe="BabyMember revoke")
        self.error(
            "GET", self.family_page(family_id, shared_snapshot, 0), 410, "SYNC_RESET_REQUIRED",
            token=guest_token, observe="revoked BabyMember cannot download prior snapshot",
        )
        self.error(
            "GET", self.family_snapshot(family_id, shared_snapshot), 410, "SYNC_RESET_REQUIRED",
            token=guest_token, observe="revoked BabyMember cannot receive snapshot cursor",
        )
        self.call("DELETE", f"/api/v1/families/{family_id}/members/{guest_user_id}", 200,
                  token=owner_token, observe="family member removed")
        family_denial_status, _ = TOOLS.http(
            self.base, "GET", self.family_page(family_id, shared_snapshot, 0), token=guest_token
        )
        self.calls += 1
        if family_denial_status not in (403, 404):
            raise AssertionError(f"removed family member snapshot page returned HTTP {family_denial_status}")
        self.observations.append({"case": "removed family member snapshot page denied", "status": family_denial_status})

        self.error(
            "GET", self.family_page(family_id, str(uuid.uuid4()), 0), 404, "RECORD_NOT_FOUND",
            token=owner_token, observe="deleted or absent snapshot id is not found",
        )
        return {
            "httpAssertions": self.calls,
            "snapshotWorkerRuns": self.snapshot_workers,
            "snapshots": 3,
            "downloadedPages": len(owner_pages) + len(no_baby_pages) + len(shared_pages),
            "verifiedContentJSONPageHashes": len(owner_pages) + len(no_baby_pages) + len(shared_pages),
            "snapshotTailCatchUp": {
                "baselineHighWater": str(latest_position),
                "laterGrowthID": post_snapshot_growth["id"],
                "returnedChangeCount": len(caught_up["changes"]),
                "returnedEntityID": caught_up_change["entityId"],
            },
            "observations": self.observations,
            "notes": [
                "snapshot pages came from the real Go worker output; no task/record rows were SQL seeded",
                "each downloaded page's sha256 matched contentJSON UTF-8 bytes and decoding contentJSON reproduced typed content",
                "retention simulation changed created_at only for the existing HTTP-created test_ growth change",
                "successful page responses exercise the existing whole-manifest snapshot hash verification",
            ],
        }


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--worker", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    api_binary, worker_binary = args.binary.resolve(), args.worker.resolve()
    for binary in (api_binary, worker_binary):
        if not binary.is_file():
            raise RuntimeError("Build the Go API and worker binaries from this checkout first")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    version = json.loads(subprocess.check_output([str(api_binary), "--version"], cwd=ROOT, text=True))
    if version.get("revision") != commit:
        raise RuntimeError("API binary source revision differs from this worktree HEAD")
    report: dict[str, object] = {
        "scope": "Go snapshot bootstrap cursor, verifiable pages, and 90-day family feed cursor floor",
        "status": "RUNNING",
        "commit": commit,
        "apiBinarySHA256": sha256_file(api_binary),
        "workerBinarySHA256": sha256_file(worker_binary),
        "sourceSHA256": {},
        "runtimes": {},
    }
    report_path = args.report.resolve()
    owned = LocalOwnedEnvironment()
    child_processes = []

    def interrupted(signum, _frame):
        raise KeyboardInterrupt(f"signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        owned.start()
        base = owned.serve(api_binary)
        child_processes = list(owned.processes)
        report["ownedEnvironment"] = {
            "kind": "private disposable local PostgreSQL 18 and Redis 8",
            "database": owned.database,
            "role": owned.role,
            "postgresHost": "127.0.0.1",
            "postgresPort": owned.pg_port,
            "redisHost": "127.0.0.1",
            "redisPort": owned.redis_port,
            "apiHost": "127.0.0.1",
            "objectStorage": "disabled; all AWS/S3 environment is excluded and snapshot pages are stored in PostgreSQL JSONB",
        }
        report["runtimes"] = {"go": SnapshotScenario(owned, base, worker_binary).run()}
        report["status"] = "PASS"
    except BaseException as error:
        report["status"] = "FAIL"
        report["failureType"] = type(error).__name__
        report["failure"] = str(error)[:1000]
        raise
    finally:
        cleanup = owned.close()
        live_processes = sum(process.poll() is None for process in child_processes)
        cleanup["liveAPIProcesses"] = live_processes
        report["cleanup"] = cleanup
        if live_processes or not all(
            cleanup.get(key) is True
            for key in (
                "apiProcessesStopped", "redisProcessStopped", "postgresStopped",
                "temporaryDirectoryRemoved", "noContainerResourcesCreated",
            )
        ):
            report["status"] = "FAIL"
            report["cleanupFailure"] = True
        source_files = [
            "apps/api/src/services/sync-service.ts",
            "apps/api/src/routes/sync-routes.ts",
            "packages/contracts/src/sync.ts",
            "packages/contracts/src/routes.ts",
            "packages/contracts/tests/contracts.test.ts",
            "internal/backend/native_snapshots.go",
            "internal/backend/native_sync_test.go",
            "internal/backend/sync_feed.go",
            "internal/backend/foundation_test.go",
            "scripts/go-sync-snapshot-integration.py",
            "contracts/openapi.json",
        ]
        report["sourceSHA256"] = {
            name: sha256_file(ROOT / name) for name in source_files if (ROOT / name).is_file()
        }
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        if live_processes or not all(
            cleanup.get(key) is True
            for key in (
                "apiProcessesStopped", "redisProcessStopped", "postgresStopped",
                "temporaryDirectoryRemoved", "noContainerResourcesCreated",
            )
        ):
            raise RuntimeError("owned Go sync integration resources were not fully cleaned up")


if __name__ == "__main__":
    main()
