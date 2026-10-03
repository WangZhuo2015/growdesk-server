#!/usr/bin/env python3
"""Real isolated HTTP coverage for private account-export status and download.

Creates an owned test PostgreSQL/Redis environment, uses only loopback API and
virtual provider settings, creates all users/families/babies/records through
HTTP, and runs the bounded Go worker/scheduler binaries from this checkout.
SQL is limited to task-failure and expiry fixtures for the already-created
test_ export tasks; account and care data are never SQL seeded.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT_SPEC = importlib.util.spec_from_file_location(
    "owned_local_test_environment", ROOT / "scripts/go-sync-snapshot-integration.py"
)
assert SNAPSHOT_SPEC and SNAPSHOT_SPEC.loader
SNAPSHOT = importlib.util.module_from_spec(SNAPSHOT_SPEC)
SNAPSHOT_SPEC.loader.exec_module(SNAPSHOT)
TOOLS = SNAPSHOT.TOOLS

SOURCE_FILES = (
    "packages/contracts/src/user.ts",
    "packages/contracts/src/routes.ts",
    "packages/contracts/tests/contracts.test.ts",
    "scripts/contract-generator.mjs",
    "scripts/go-user-export-download-integration.py",
    "contracts/openapi.json",
    "prisma/schema.prisma",
    "prisma/migrations/202610030031_user_export_payload_expiry/migration.sql",
    "internal/backend/native_exports.go",
    "internal/backend/native_tasks.go",
    "internal/backend/native_snapshots.go",
    "internal/backend/read_snapshot.go",
    "internal/backend/native_export_idempotency_test.go",
    "internal/backend/native_sync_test.go",
    "internal/backend/foundation_test.go",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_uuid(value: str) -> str:
    parsed = uuid.UUID(value)
    return str(parsed)


def raw_http(base: str, path: str, token: str) -> tuple[int, dict[str, str], bytes]:
    request = urllib.request.Request(
        base + path,
        headers={"Accept": "application/json", "Authorization": "Bearer " + token},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, {key.lower(): value for key, value in response.headers.items()}, response.read()
    except urllib.error.HTTPError as error:
        headers = {key.lower(): value for key, value in error.headers.items()}
        return error.code, headers, error.read()


class ExportScenario:
    def __init__(self, owned, base: str, worker: Path, scheduler: Path):
        self.owned = owned
        self.base = base
        self.worker = worker.resolve()
        self.scheduler = scheduler.resolve()
        self.run_id = secrets.token_hex(5)
        self.http_checks = 0
        self.worker_runs = 0
        self.scheduler_runs = 0
        self.observations: list[dict[str, object]] = []
        self.credentials: dict[str, tuple[str, str]] = {}

    def call(self, method, path, expected_status, body=None, token=None, headers=None, observe=None):
        self.http_checks += 1
        status, value = TOOLS.http(self.base, method, path, body, token, headers)
        if status != expected_status:
            code = value.get("error", {}).get("code", "unexpected_success") if isinstance(value, dict) else type(value).__name__
            raise AssertionError(f"{method} {path}: expected {expected_status}, got {status}; {code}")
        if observe:
            self.observations.append({"case": observe, "status": status})
        return value

    def error(self, method, path, expected_status, error_code, token=None, observe=None):
        value = self.call(method, path, expected_status, token=token, observe=observe)
        actual = value.get("error", {}).get("code") if isinstance(value, dict) else None
        if actual != error_code:
            raise AssertionError(f"{method} {path}: expected error {error_code}, got {actual}")
        return value

    def register(self, role: str) -> dict[str, str]:
        username = f"test_export_{self.run_id}_{role}"
        password = "test_account_export_" + secrets.token_urlsafe(18)
        self.credentials[role] = (username, password)
        response = self.call("POST", "/api/v1/auth/register", 201, {
            "username": username,
            "password": password,
            "displayName": f"test_family_export_{self.run_id}_{role}",
            "deviceLabel": "test_account_export",
        }, observe=f"register isolated test_ principal {role}")["data"]
        if response["user"]["username"] != username:
            raise AssertionError("registration returned a different test username")
        # POST /me/export requires recent password reauthentication. Use a new
        # real login session for every principal rather than assuming register
        # or a prior task left fresh credentials behind.
        login = self.call("POST", "/api/v1/auth/login", 200, {
            "username": username,
            "password": password,
            "deviceLabel": "test_account_export_recent_login",
        }, observe=f"fresh login for export principal {role}")["data"]
        return {
            "userId": assert_uuid(login["user"]["id"]),
            "username": username,
            "accessToken": login["accessToken"],
        }

    def list_families(self, token: str, observe: str) -> dict[str, str]:
        rows = self.call("GET", "/api/v1/families", 200, token=token, observe=observe)["data"]
        families = {assert_uuid(row["id"]): row["name"] for row in rows}
        if len(families) != len(rows) or not families:
            raise AssertionError("test principal must have a stable, nonempty set of current families")
        if any(not name.startswith("test_family_") for name in families.values()):
            raise AssertionError("test principal has a family without the required test_family_ prefix")
        return families

    def create_family(self, token: str, suffix: str) -> tuple[str, str]:
        value = self.call("POST", "/api/v1/families", 201, {
            "name": f"test_family_export_{self.run_id}_{suffix}",
            "timeZone": "Asia/Shanghai",
        }, token, observe=f"create test family {suffix}")["data"]
        return assert_uuid(value["id"]), value["name"]

    def create_baby(self, family_id: str, token: str, suffix: str) -> str:
        value = self.call("POST", f"/api/v1/families/{family_id}/babies", 201, {
            "name": f"test_baby_export_{self.run_id}_{suffix}",
            "birthDate": "2026-04-01",
            "gender": "girl",
        }, token, observe=f"create test baby {suffix}")["data"]
        return assert_uuid(value["id"])

    def create_record(self, baby_id: str, token: str, suffix: str) -> str:
        value = self.call("POST", f"/api/v1/babies/{baby_id}/growth-measurements", 201, {
            "measurementDate": "2026-06-01",
            "weightKg": "9.40",
            "heightCm": "75.5",
            "headCircumferenceCm": None,
            "notes": f"test_export_record_{self.run_id}_{suffix}",
        }, token, observe=f"create test growth record {suffix}")["data"]
        return assert_uuid(value["id"])

    @staticmethod
    def status_path(task_id: str) -> str:
        return f"/api/v1/me/exports/{task_id}/status"

    @staticmethod
    def download_path(task_id: str) -> str:
        return f"/api/v1/me/exports/{task_id}"

    def queue_export(self, token: str, key: str | None = None, observe: str = "queue export") -> str:
        headers = {"Idempotency-Key": key} if key else None
        data = self.call("POST", "/api/v1/me/export", 202, token=token, headers=headers, observe=observe)["data"]
        if data.get("status") != "queued":
            raise AssertionError("POST /me/export must explicitly return queued")
        return assert_uuid(data["taskId"])

    def worker_once(self) -> None:
        result = subprocess.run(
            [str(self.worker), "--once"], cwd=ROOT, env=self.owned.env,
            text=True, capture_output=True, timeout=220,
        )
        self.worker_runs += 1
        if result.returncode != 0:
            # Do not copy worker stderr into test evidence; it may contain
            # database diagnostics. The exit status is sufficient to fail.
            raise AssertionError(f"owned bounded worker exited with status {result.returncode}")

    def scheduler_once(self) -> None:
        result = subprocess.run(
            [str(self.scheduler), "--once"], cwd=ROOT, env=self.owned.env,
            text=True, capture_output=True, timeout=45,
        )
        self.scheduler_runs += 1
        if result.returncode != 0:
            raise AssertionError(f"owned bounded scheduler exited with status {result.returncode}")

    def run_until_terminal(self, task_id: str, token: str) -> dict[str, object]:
        deadline = time.monotonic() + 8
        last = None
        while time.monotonic() < deadline:
            response = self.call("GET", self.status_path(task_id), 200, token=token)["data"]
            last = response
            if response["status"] in ("succeeded", "failed", "cancelled"):
                return response
            time.sleep(0.1)
        raise AssertionError(f"export worker did not reach a terminal state; last={last}")

    def status(self, task_id: str, token: str, expected_status: str) -> dict[str, object]:
        value = self.call("GET", self.status_path(task_id), 200, token=token,
                          observe=f"read owner export task status {expected_status}")["data"]
        if value.get("status") != expected_status:
            raise AssertionError(f"expected export state {expected_status}, got {value.get('status')}")
        if any(key in value for key in ("result", "payload", "error", "downloadPath", "hash", "fileSha256")):
            raise AssertionError("typed status response exposed private result or internal error details")
        return value

    def download(self, task_id: str, token: str) -> tuple[dict[str, object], bytes, dict[str, str]]:
        self.http_checks += 1
        status, headers, raw = raw_http(self.base, self.download_path(task_id), token)
        if status != 200:
            try:
                code = json.loads(raw).get("error", {}).get("code", "unexpected_error_body")
            except (ValueError, AttributeError):
                code = "non_json_error"
            raise AssertionError(f"GET {self.download_path(task_id)}: expected 200, got {status}; {code}")
        if headers.get("content-type") != "application/json":
            raise AssertionError("export download did not return application/json")
        expected_disposition = f'attachment; filename="growdesk-account-export-{task_id}.json"'
        if headers.get("content-disposition") != expected_disposition:
            raise AssertionError("export Content-Disposition filename was not stable and task-scoped")
        if headers.get("content-length") != str(len(raw)):
            raise AssertionError("export Content-Length did not match exact response bytes")
        exact_hash = hashlib.sha256(raw).hexdigest()
        if headers.get("x-content-sha256") != exact_hash:
            raise AssertionError("export SHA-256 header did not match exact downloaded bytes")
        try:
            payload = json.loads(raw)
        except ValueError as error:
            raise AssertionError("export download body was not valid JSON") from error
        if set(payload) != {"schemaVersion", "user", "families", "generatedAt"} or payload["schemaVersion"] != 1:
            raise AssertionError("downloaded export did not match versioned JSON schema v1")
        user = payload["user"]
        if set(user) != {"id", "username", "displayName", "createdAt", "updatedAt"}:
            raise AssertionError("account export user projection contains fields outside the public profile")
        self.observations.append({"case": "owner downloaded exact-hashed versioned JSON file", "status": status})
        return payload, raw, headers

    def download_error(self, task_id: str, token: str, status_expected: int, code_expected: str, observe: str) -> None:
        self.http_checks += 1
        status, _headers, raw = raw_http(self.base, self.download_path(task_id), token)
        try:
            body = json.loads(raw)
            code = body.get("error", {}).get("code")
        except (ValueError, AttributeError):
            code = None
        if status != status_expected or code != code_expected:
            raise AssertionError(f"{observe}: expected HTTP {status_expected} {code_expected}, got {status} {code}")
        self.observations.append({"case": observe, "status": status})

    @staticmethod
    def pages_for_family(payload: dict[str, object], family_id: str) -> dict[str, list[dict[str, object]]]:
        families = [family for family in payload["families"] if family["familyId"] == family_id]
        if len(families) != 1:
            raise AssertionError(f"export did not contain exactly one expected family: {family_id}")
        result: dict[str, list[dict[str, object]]] = {}
        for page in families[0]["pages"]:
            if page["entityType"] in result:
                result[page["entityType"]].extend(page["data"])
            else:
                result[page["entityType"]] = list(page["data"])
        return result

    def run(self) -> dict[str, object]:
        owner = self.register("owner")
        collaborator = self.register("collaborator")
        outsider = self.register("outsider")
        owner_families = self.list_families(owner["accessToken"], "read owner's registration-created test family")
        collaborator_families = self.list_families(
            collaborator["accessToken"], "read collaborator's registration-created test family"
        )
        if len(owner_families) != 1 or len(collaborator_families) != 1:
            raise AssertionError("fresh registrations must begin with one test-prefixed family")

        family_a, family_a_name = self.create_family(owner["accessToken"], "a")
        family_b, family_b_name = self.create_family(owner["accessToken"], "b")
        owner_families = self.list_families(owner["accessToken"], "read all owner families before export")
        baby_a1 = self.create_baby(family_a, owner["accessToken"], "a1")
        baby_a2 = self.create_baby(family_a, owner["accessToken"], "a2")
        baby_b1 = self.create_baby(family_b, owner["accessToken"], "b1")
        record_a = self.create_record(baby_a1, owner["accessToken"], "a1")
        record_b = self.create_record(baby_b1, owner["accessToken"], "b1")

        invite = self.call("POST", f"/api/v1/families/{family_a}/invites", 201, {
            "expiresInDays": 1,
        }, owner["accessToken"], observe="create test-only family invitation")["data"]["inviteCode"]
        self.call("POST", "/api/v1/families/join", 200, {"inviteCode": invite}, collaborator["accessToken"],
                  observe="collaborator joins only family A")
        collaborator_families = self.list_families(
            collaborator["accessToken"], "read collaborator families after joining test family A"
        )
        no_babies = self.call("GET", f"/api/v1/families/{family_a}/babies", 200,
                              token=collaborator["accessToken"], observe="family member initially has no baby grants")["data"]
        if no_babies:
            raise AssertionError("family membership alone exposed babies without BabyMember permission")

        owner_key = str(uuid.uuid4())
        owner_task = self.queue_export(owner["accessToken"], owner_key, "owner export queued with key")
        self.error("GET", self.status_path(owner_task), 401, "UNAUTHORIZED",
                   observe="unauthenticated principal cannot read export status")
        queued = self.status(owner_task, owner["accessToken"], "queued")
        if "expiresAt" in queued:
            raise AssertionError("queued export advertised a result expiry before completion")
        self.error("GET", self.download_path(owner_task), 401, "UNAUTHORIZED",
                   observe="unauthenticated principal cannot download an export")
        self.error("GET", self.download_path(owner_task), 409, "EXPORT_NOT_READY", token=owner["accessToken"],
                   observe="queued export is not falsely downloadable")
        replay = self.call("POST", "/api/v1/me/export", 202, token=owner["accessToken"],
                           headers={"Idempotency-Key": owner_key}, observe="queued export idempotency replay")["data"]
        if replay.get("taskId") != owner_task:
            raise AssertionError("same Idempotency-Key did not replay the exact export task")
        receipt_count = self.owned.sql(
            f"SELECT count(*) FROM idempotency_receipts WHERE actor_id='{owner['userId']}' "
            f"AND scope_id='{owner['userId']}' AND command_id='native-user-export:{owner_key}';"
        )
        if receipt_count != "1":
            raise AssertionError("HTTP export replay created more than one durable idempotency receipt")
        changed_body = self.call(
            "POST", "/api/v1/me/export", 409, {"format": "changed"}, owner["accessToken"],
            {"Idempotency-Key": owner_key},
            observe="same export key with changed request body is rejected",
        )
        if changed_body.get("error", {}).get("code") != "IDEMPOTENCY_KEY_REUSED":
            raise AssertionError("changed export request body did not produce an idempotency conflict")

        self.worker_once()
        terminal = self.run_until_terminal(owner_task, owner["accessToken"])
        if terminal["status"] != "succeeded":
            raise AssertionError("real export worker failed for a valid test account")
        self.status(owner_task, owner["accessToken"], "succeeded")
        owner_file, _owner_bytes, _owner_headers = self.download(owner_task, owner["accessToken"])
        if owner_file["user"]["id"] != owner["userId"] or owner_file["user"]["username"] != owner["username"]:
            raise AssertionError("export archive was not scoped to the authenticated user")
        exported_owner_families = {family["familyId"] for family in owner_file["families"]}
        if exported_owner_families != set(owner_families):
            raise AssertionError(
                "account export omitted or added an authenticated family: "
                f"expected {sorted(owner_families)}, got {sorted(exported_owner_families)}"
            )
        page_a = self.pages_for_family(owner_file, family_a)
        page_b = self.pages_for_family(owner_file, family_b)
        owner_default_family = next(family_id for family_id in owner_families if family_id not in {family_a, family_b})
        page_default = self.pages_for_family(owner_file, owner_default_family)
        owner_babies = {item["id"] for item in page_a.get("baby", []) + page_b.get("baby", [])}
        owner_babies.update(item["id"] for item in page_default.get("baby", []))
        if owner_babies != {baby_a1, baby_a2, baby_b1}:
            raise AssertionError("export did not contain exactly the authenticated test babies")
        owner_growth = {item["id"] for item in page_a.get("growth", []) + page_b.get("growth", [])}
        owner_growth.update(item["id"] for item in page_default.get("growth", []))
        if owner_growth != {record_a, record_b}:
            raise AssertionError("export omitted HTTP-created test records or included unrelated growth data")
        replay_after_worker = self.call("POST", "/api/v1/me/export", 202, token=owner["accessToken"],
                                        headers={"Idempotency-Key": owner_key}, observe="completed export replay remains same task")["data"]
        if replay_after_worker.get("taskId") != owner_task:
            raise AssertionError("same-key replay changed task identity after worker completion")

        # A family member with no BabyMember grant can export its family scope,
        # but that scope must contain no child profiles or records.
        collaborator_task = self.queue_export(collaborator["accessToken"], observe="collaborator export without BabyMember grant")
        self.error("GET", self.status_path(collaborator_task), 404, "RECORD_NOT_FOUND",
                   token=outsider["accessToken"], observe="foreign principal cannot read export status")
        self.error("GET", self.download_path(collaborator_task), 404, "RECORD_NOT_FOUND",
                   token=outsider["accessToken"], observe="foreign principal cannot download export")
        self.status(collaborator_task, collaborator["accessToken"], "queued")
        self.error("GET", self.download_path(collaborator_task), 409, "EXPORT_NOT_READY",
                   token=collaborator["accessToken"], observe="collaborator queued export is not downloadable")
        self.worker_once()
        collaborator_terminal = self.run_until_terminal(collaborator_task, collaborator["accessToken"])
        if collaborator_terminal["status"] != "succeeded":
            raise AssertionError("family collaborator export worker did not complete")
        collaborator_file, _, _ = self.download(collaborator_task, collaborator["accessToken"])
        if {family["familyId"] for family in collaborator_file["families"]} != set(collaborator_families):
            raise AssertionError("collaborator export omitted or added a currently accessible test family")
        collaborator_pages = self.pages_for_family(collaborator_file, family_a)
        collaborator_default_family = next(family_id for family_id in collaborator_families if family_id != family_a)
        collaborator_default_pages = self.pages_for_family(collaborator_file, collaborator_default_family)
        if (collaborator_pages.get("baby") != [] or collaborator_pages.get("growth")
                or collaborator_default_pages.get("baby") != [] or collaborator_default_pages.get("growth")):
            raise AssertionError("same-family membership leaked babies or records without baby permission")

        # Grant exactly one of two family-A babies, then prove the next export
        # contains only that authorized baby and its record.
        self.call("POST", f"/api/v1/babies/{baby_a1}/members", 201, {
            "userId": collaborator["userId"],
            "role": "member",
        }, owner["accessToken"], observe="grant collaborator access to baby A1 only")
        collaborator_babies = self.call("GET", f"/api/v1/families/{family_a}/babies", 200,
                                        token=collaborator["accessToken"])["data"]
        if {baby["id"] for baby in collaborator_babies} != {baby_a1}:
            raise AssertionError("explicit BabyMember grant exposed the wrong family babies")
        shared_key = str(uuid.uuid4())
        shared_task = self.queue_export(collaborator["accessToken"], shared_key, "authorized subset export queued")
        self.worker_once()
        shared_terminal = self.run_until_terminal(shared_task, collaborator["accessToken"])
        if shared_terminal["status"] != "succeeded":
            raise AssertionError("authorized subset export worker failed")
        shared_file, _, _ = self.download(shared_task, collaborator["accessToken"])
        if {family["familyId"] for family in shared_file["families"]} != set(collaborator_families):
            raise AssertionError("one-baby export omitted or added a current family")
        shared_pages = self.pages_for_family(shared_file, family_a)
        shared_baby_ids = {baby["id"] for baby in shared_pages.get("baby", [])}
        if shared_baby_ids != {baby_a1}:
            raise AssertionError("export included a same-family baby without current BabyMember permission")
        if {record["id"] for record in shared_pages.get("growth", [])} != {record_a}:
            raise AssertionError("export included a record from an unauthorized baby")

        # Revoking the only granted baby invalidates an already-created file;
        # status remains available while private bytes become non-downloadable.
        self.call("DELETE", f"/api/v1/babies/{baby_a1}/members/{collaborator['userId']}", 200,
                  token=owner["accessToken"], observe="revoke collaborator BabyMember grant")
        self.download_error(shared_task, collaborator["accessToken"], 410, "EXPORT_SCOPE_CHANGED",
                            "revoked baby permission prevents a stale export download")
        self.status(shared_task, collaborator["accessToken"], "succeeded")
        self.call("DELETE", f"/api/v1/families/{family_a}/members/{collaborator['userId']}", 200,
                  token=owner["accessToken"], observe="revoke collaborator family membership")
        self.download_error(collaborator_task, collaborator["accessToken"], 410, "EXPORT_SCOPE_CHANGED",
                            "revoked family membership prevents an old export download")

        # Exercise worker failure through a valid HTTP-created export task. The
        # private DB fixture adds an invalid account scope to this one task;
        # the real Go worker fails it and the public status endpoint returns
        # only a stable allowlisted code, never internal error text.
        failure_task = self.queue_export(owner["accessToken"], observe="queue task for worker failure status")
        mutation = self.owned.sql(
            "UPDATE task_outbox SET payload=jsonb_set(payload,'{__native,familyId}',"
            f"to_jsonb('{family_a}'::text),true) WHERE aggregate_id='{failure_task}' AND phase_key='native-initial';"
        )
        if mutation != "UPDATE 1":
            raise AssertionError("failure fixture did not modify exactly its own test export task")
        self.worker_once()
        failed_status = self.run_until_terminal(failure_task, owner["accessToken"])
        if failed_status["status"] != "failed" or failed_status.get("errorCode") != "EXPORT_FAILED":
            raise AssertionError("failed worker task did not expose only the stable sanitized export error")
        if set(failed_status) - {"taskId", "status", "attempt", "createdAt", "updatedAt", "errorCode"}:
            raise AssertionError("failed export status exposed internal result/error fields")
        self.observations.append({"case": "real worker failure is queryable without internal error details", "status": 200})

        # Age a real completed test export's expiry column, then run the normal
        # bounded scheduler reconciliation once and prove it physically removes
        # the JSONB payload while retaining minimal task status.
        expiry_task = self.queue_export(owner["accessToken"], observe="queue export for TTL cleanup")
        self.worker_once()
        expiry_status = self.run_until_terminal(expiry_task, owner["accessToken"])
        if expiry_status["status"] != "succeeded":
            raise AssertionError("TTL fixture export did not complete in the real worker")
        age_result = self.owned.sql(
            "UPDATE task_executions SET result_expires_at=clock_timestamp()-INTERVAL '1 second' "
            f"WHERE id='{expiry_task}' AND owner_scope='user:{owner['userId']}' "
            "AND kind='user_data_export' AND result_ref ? 'payload';"
        )
        if age_result != "UPDATE 1":
            raise AssertionError("expiry fixture did not age exactly its own completed export")
        self.download_error(expiry_task, owner["accessToken"], 410, "EXPORT_EXPIRED",
                            "expired export is rejected before the scheduler clears bytes")
        self.scheduler_once()
        retained = self.owned.sql(
            "SELECT status||'|'||(result_ref ? 'payload')::text||'|'||(result_ref->>'payloadPurged') "
            f"FROM task_executions WHERE id='{expiry_task}' AND owner_scope='user:{owner['userId']}';"
        )
        if retained != "succeeded|false|true":
            raise AssertionError("periodic scheduler did not clear expired export payload while retaining task status")
        self.status(expiry_task, owner["accessToken"], "succeeded")
        self.download_error(expiry_task, owner["accessToken"], 410, "EXPORT_EXPIRED",
                            "purged task retains status but cannot download expired bytes")

        # A different task kind owned by the same principal must not be
        # mistaken for an account export just because the UUID is valid.
        other_task = self.call(
            "POST", f"/api/v1/sync/families/{family_a}/snapshots", 202,
            token=owner["accessToken"], observe="queue a non-export owned task for type isolation",
        )["data"]["snapshotId"]
        self.error("GET", self.status_path(other_task), 404, "RECORD_NOT_FOUND",
                   token=owner["accessToken"], observe="owner cannot read another task kind as export status")
        self.error("GET", self.download_path(other_task), 404, "RECORD_NOT_FOUND",
                   token=owner["accessToken"], observe="owner cannot download another task kind as export")

        return {
            "httpAssertions": self.http_checks,
            "boundedExportWorkerRuns": self.worker_runs,
            "boundedSchedulerRuns": self.scheduler_runs,
            "testPrincipalsCreated": len(self.credentials),
            "allUsernamesUseTestPrefix": True,
            "familiesCreatedThroughHTTP": 2,
            "registrationCreatedTestFamilies": 3,
            "babiesCreatedThroughHTTP": 3,
            "growthRecordsCreatedThroughHTTP": 2,
            "exportTasks": 5,
            "observations": self.observations,
            "results": {
                "ownerFamilies": len(owner_families),
                "ownerAuthorizedBabies": 3,
                "ownerAuthorizedGrowthRecords": 2,
                "familyMembershipWithoutBabyGrantReturnsEmptyBabyPage": True,
                "singleBabyGrantExcludesSiblingBabyAndRecord": True,
                "sameKeyReplayTaskIDStableBeforeAndAfterWorker": True,
                "changedBodyUnderSameKeyRejected": True,
                "otherTaskKindHiddenByExportEndpoints": True,
                "foreignStatusAndDownloadReturn404": True,
                "revokedBabyAndFamilyScopesBlockOldDownload": True,
                "workerFailureStatusContainsOnlyAllowlistedCode": "EXPORT_FAILED",
                "expiredPayloadPurgedByBoundedScheduler": True,
                "downloadHeadersValidated": ["Content-Type", "Content-Disposition", "Content-Length", "X-Content-SHA256"],
            },
            "notes": [
                "registration, family, baby, record, export submission, status, and download all used the real Go HTTP API",
                "test-only SQL changed only one export task input for worker-failure proof and one result_expires_at for TTL proof",
                "export JSON contains only the authenticated user's current family and explicitly authorized baby projections",
                "no model provider, external billing, push credential, old Web database, or old Web service was used",
            ],
        }


def build_binary(target: str, path: Path, revision: str) -> None:
    subprocess.run(
        ["go", "build", "-ldflags", f"-X main.revision={revision}", "-o", str(path), target],
        cwd=ROOT,
        check=True,
        timeout=180,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


def main() -> int:
    if not __debug__:
        raise RuntimeError("Refusing optimized Python; HTTP assertions must remain enabled")
    parser = argparse.ArgumentParser(description="Owned loopback account export/download E2E")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    report_path = args.report.resolve()
    if report_path.exists():
        raise RuntimeError("Refusing to replace existing unique account-export evidence")

    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    report: dict[str, object] = {
        "scope": "BE_USER_EXPORT_DOWNLOAD real owner-scoped queue, worker, typed status, private JSON download, scope recheck, and TTL cleanup",
        "status": "RUNNING",
        "baseRevision": head,
        "apiBinarySHA256": None,
        "workerBinarySHA256": None,
        "schedulerBinarySHA256": None,
        "sourceSHA256": {},
        "ownedEnvironment": {},
    }
    temp_root = Path(tempfile.mkdtemp(prefix="growdesk-user-export-")).resolve()
    temp_root.chmod(0o700)
    owned = None
    child_processes = []
    try:
        binary_dir = temp_root / "bin"
        binary_dir.mkdir(mode=0o700)
        binaries = {
            "api": binary_dir / "growdesk-api",
            "worker": binary_dir / "growdesk-worker",
            "scheduler": binary_dir / "growdesk-scheduler",
        }
        build_binary("./cmd/growdesk-api", binaries["api"], head)
        build_binary("./cmd/growdesk-worker", binaries["worker"], head)
        build_binary("./cmd/growdesk-scheduler", binaries["scheduler"], head)
        for name, path in binaries.items():
            identity = json.loads(subprocess.check_output([str(path), "--version"], cwd=ROOT, text=True))
            if identity.get("revision") != head:
                raise RuntimeError(f"{name} binary revision differs from this worktree HEAD")
            report[f"{name}BinarySHA256"] = sha256_file(path)

        owned = SNAPSHOT.LocalOwnedEnvironment()
        owned.start()
        # The environment constructor starts from a small allowlist, so no
        # inherited provider/push secrets are available to the child process.
        owned.env.update(
            GROWDESK_AI_PROVIDER="fixture",
            GROWDESK_AI_FIXTURE_RESPONSE='{"text":"test_only_isolated_export_fixture","actions":[]}',
        )
        base = owned.serve(binaries["api"])
        child_processes = list(owned.processes)
        report["ownedEnvironment"] = {
            "postgresHost": "127.0.0.1",
            "postgresPort": owned.pg_port,
            "databasePrefix": "test_",
            "rolePrefix": "test_",
            "roleIsNonSuperuser": True,
            "redisHost": "127.0.0.1",
            "redisPort": owned.redis_port,
            "apiHost": "127.0.0.1",
            "aiProvider": "fixture-only",
            "pushCredentialsPresent": False,
            "objectStorage": "not used by account export; result bytes stay in owned PostgreSQL",
            "workerModelOrOCRProviderCall": False,
        }
        report["runtime"] = ExportScenario(owned, base, binaries["worker"], binaries["scheduler"]).run()
        report["status"] = "PASS"
    except BaseException as error:
        report["status"] = "FAIL"
        report["failureType"] = type(error).__name__
        report["failure"] = str(error)[:1000]
        raise
    finally:
        cleanup = owned.close() if owned is not None else {
            "apiProcessesStopped": True, "redisProcessStopped": True, "postgresStopped": True,
            "temporaryDirectoryRemoved": True, "noContainerResourcesCreated": True,
        }
        live_api_processes = sum(process.poll() is None for process in child_processes)
        cleanup["liveAPIProcesses"] = live_api_processes
        shutil.rmtree(temp_root, ignore_errors=True)
        cleanup["privateBuildDirectoryRemoved"] = not temp_root.exists()
        report["cleanup"] = cleanup
        required = (
            "apiProcessesStopped", "redisProcessStopped", "postgresStopped",
            "temporaryDirectoryRemoved", "noContainerResourcesCreated", "privateBuildDirectoryRemoved",
        )
        if live_api_processes or not all(cleanup.get(key) is True for key in required):
            report["status"] = "FAIL"
            report["cleanupFailure"] = True
        report["sourceSHA256"] = {
            name: sha256_file(ROOT / name) for name in SOURCE_FILES if (ROOT / name).is_file()
        }
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        if report.get("cleanupFailure"):
            raise RuntimeError("owned account-export test resources were not fully cleaned up")

    if report["status"] != "PASS":
        return 1
    print("PASS isolated account export/download HTTP E2E (" + str(report["runtime"]["httpAssertions"]) + " checks)")
    print("Evidence: " + str(report_path))
    print("PASS owned API, PostgreSQL, Redis, test tenant, and private build directory cleaned")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
