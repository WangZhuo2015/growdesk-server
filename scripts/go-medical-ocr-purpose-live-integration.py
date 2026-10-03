#!/usr/bin/env python3
"""Live HTTP OCR-purpose regression for an owned loopback API and database.

The caller must provide an isolated API backed by test_ PostgreSQL, Redis, and
MinIO, with no external providers. This module creates only test_ principals,
families, babies, and attachments through the real HTTP API. The SQL callback
is read-only and is used solely to compare task/receipt counts before and after
each request.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


PNG_1X1 = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x04\x00\x00\x00\xb5\x1c\x0c\x02\x00\x00\x00\x0bIDAT"
    b"\x08\xd7c\xfc\xff\x1f\x00\x03\x03\x02\x00\xef\xbf\xac\xb8\x00\x00\x00\x00IEND\xaeB`\x82"
)
PDF_1_PAGE = (
    b"%PDF-1.4\n"
    b"1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
    b"2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n"
    b"trailer << /Root 1 0 R >>\n%%EOF\n"
)
M4A_TEST_BYTES = b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A "

STATE_SQL = """SELECT json_build_object(
  'tasks',(SELECT COUNT(*) FROM task_executions),
  'outbox',(SELECT COUNT(*) FROM task_outbox),
  'sessions',(SELECT COUNT(*) FROM ai_sessions),
  'messages',(SELECT COUNT(*) FROM ai_messages),
  'runs',(SELECT COUNT(*) FROM ai_runs),
  'events',(SELECT COUNT(*) FROM ai_run_events),
  'receipts',(SELECT COUNT(*) FROM idempotency_receipts))::text;"""


def _loopback_base(base: str) -> str:
    parsed = urllib.parse.urlsplit(base)
    try:
        port = parsed.port
    except ValueError:
        port = None
    if (parsed.scheme != "http" or parsed.hostname != "127.0.0.1" or not port or
            port in (80, 443, 3088, 3089) or parsed.path not in ("", "/") or
            parsed.query or parsed.fragment or parsed.username or parsed.password):
        raise RuntimeError("medical_ocr_test_api_must_be_owned_loopback")
    return f"http://127.0.0.1:{port}"


def _request(base: str, method: str, path: str, body=None, token=None, key=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if key:
        headers["Idempotency-Key"] = key
    payload = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        payload = json.dumps(body, separators=(",", ":")).encode()
    request = urllib.request.Request(base + path, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.load(error)
        finally:
            error.close()


def _expect(base: str, method: str, path: str, expected: int, body=None, token=None, key=None):
    actual, result = _request(base, method, path, body, token, key)
    if actual != expected:
        error = result.get("error", {}) if isinstance(result, dict) else {}
        code = error.get("code", "none")
        raise AssertionError(f"{method} {path}: expected {expected}, received {actual}, code={code}")
    return result


def _register(base: str, label: str, suffix: str) -> dict:
    username = f"test_medical_ocr_{label}_{suffix}"
    return _expect(base, "POST", "/api/v1/auth/register", 201, {
        "username": username,
        "displayName": username,
        "password": "test_medical_ocr_password_8675309",
        "deviceLabel": "test_medical_ocr_purpose",
    })["data"]


def _scope(base: str, token: str, label: str, suffix: str) -> tuple[str, str]:
    family = _expect(base, "POST", "/api/v1/families", 201, {
        "name": f"test_family_medical_ocr_{label}_{suffix}", "timeZone": "UTC",
    }, token)["data"]
    baby = _expect(base, "POST", f"/api/v1/families/{family['id']}/babies", 201, {
        "name": f"test_baby_medical_ocr_{label}_{suffix}",
        "birthDate": "2026-01-02", "gender": "girl",
    }, token)["data"]
    return family["id"], baby["id"]


def _reserve_attachment(base: str, token: str, family: str, baby: str, purpose: str,
                        data: bytes, mime_type: str) -> dict[str, object]:
    digest = hashlib.sha256(data).hexdigest()
    return _expect(base, "POST", "/api/v1/attachments", 201, {
        "purpose": purpose, "mimeType": mime_type, "byteSize": len(data),
        "sha256": digest, "ownerScope": {"familyId": family, "babyId": baby},
    }, token)["data"]


def _ready_attachment(base: str, token: str, family: str, baby: str, purpose: str,
                      minio_port: int, data: bytes = PNG_1X1,
                      mime_type: str = "image/png") -> str:
    digest = hashlib.sha256(data).hexdigest()
    result = _reserve_attachment(base, token, family, baby, purpose, data, mime_type)
    upload = urllib.parse.urlsplit(result["uploadUrl"])
    if (upload.scheme != "http" or upload.hostname != "127.0.0.1" or upload.port != minio_port or
            upload.username or upload.password or upload.fragment):
        raise RuntimeError("medical_ocr_test_upload_must_be_owned_loopback")
    try:
        request = urllib.request.Request(result["uploadUrl"], data=data, method="PUT",
                                         headers={"Content-Type": mime_type})
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status not in (200, 204):
                raise AssertionError("private attachment upload was not accepted")
    except urllib.error.HTTPError as error:
        raise AssertionError(f"private attachment upload failed with HTTP {error.code}") from None
    except (OSError, urllib.error.URLError):
        raise RuntimeError("medical_ocr_test_upload_network_failed") from None
    _expect(base, "POST", f"/api/v1/attachments/{result['id']}/complete", 200, {
        "sha256": digest, "byteSize": len(data),
    }, token)
    return result["id"]


def _state(sql) -> dict[str, int]:
    value = json.loads(sql(STATE_SQL))
    if set(value) != {"tasks", "outbox", "sessions", "messages", "runs", "events", "receipts"}:
        raise AssertionError("task state query returned an unexpected shape")
    return {key: int(count) for key, count in value.items()}


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run(base: str, sql, minio_port: int) -> dict[str, object]:
    base = _loopback_base(base)
    if not isinstance(minio_port, int) or not (1024 <= minio_port <= 65535) or minio_port in (3088, 3089):
        raise RuntimeError("medical_ocr_test_minio_port_guard_failed")
    suffix = secrets.token_hex(6)
    owner, outsider = _register(base, "owner", suffix), _register(base, "outsider", suffix)
    owner_token, outsider_token = owner["accessToken"], outsider["accessToken"]
    owner_family, owner_baby = _scope(base, owner_token, "owner", suffix)
    foreign_family, foreign_baby = _scope(base, outsider_token, "foreign", suffix)
    pending = _reserve_attachment(base, owner_token, owner_family, owner_baby,
                                  "medical_report", PNG_1X1, "image/png")
    if pending.get("status") != "pending":
        raise AssertionError("attachment reservation did not remain pending before upload")
    medical_id = _ready_attachment(base, owner_token, owner_family, owner_baby,
                                   "medical_report", minio_port)
    growth_id = _ready_attachment(base, owner_token, owner_family, owner_baby,
                                  "growth_photo", minio_port)
    second_medical_id = _ready_attachment(base, owner_token, owner_family, owner_baby,
                                          "medical_report", minio_port)
    pdf_id = _ready_attachment(base, owner_token, owner_family, owner_baby,
                               "medical_report", minio_port, PDF_1_PAGE, "application/pdf")
    audio_id = _ready_attachment(base, owner_token, owner_family, owner_baby,
                                 "medical_report", minio_port, M4A_TEST_BYTES, "audio/m4a")
    foreign_id = _ready_attachment(base, outsider_token, foreign_family, foreign_baby,
                                   "medical_report", minio_port)

    # A rejected request must not claim the receipt key; the next valid request
    # intentionally reuses it, then a duplicate proves exactly-once queueing.
    receipt_key = "test_medical_ocr_purpose_" + suffix
    before_rejection = _state(sql)
    rejected = _expect(base, "POST", "/api/v1/medical/ocr-runs", 400,
                       {"attachmentId": growth_id}, owner_token, receipt_key)
    if rejected.get("error", {}).get("code") != "BAD_REQUEST":
        raise AssertionError("purpose mismatch did not use the existing 400 BAD_REQUEST contract")
    if _state(sql) != before_rejection:
        raise AssertionError("purpose rejection wrote task, outbox, run, event, or receipt state")

    before_pending = _state(sql)
    pending_rejection = _expect(base, "POST", "/api/v1/medical/ocr-runs", 400,
                                {"attachmentId": pending["id"]}, owner_token, receipt_key)
    if pending_rejection.get("error", {}).get("code") != "ATTACHMENT_NOT_READY":
        raise AssertionError("pending medical attachment did not use ATTACHMENT_NOT_READY")
    if _state(sql) != before_pending:
        raise AssertionError("pending attachment rejection wrote task, outbox, run, event, or receipt state")

    audio_key = "test_medical_ocr_audio_mime_" + suffix
    before_audio = _state(sql)
    audio_rejection = _expect(base, "POST", "/api/v1/medical/ocr-runs", 400,
                              {"attachmentId": audio_id}, owner_token, audio_key)
    if audio_rejection.get("error", {}).get("code") != "BAD_REQUEST":
        raise AssertionError("ready medical_report audio MIME did not use 400 BAD_REQUEST")
    if _state(sql) != before_audio:
        raise AssertionError("unsupported MIME rejection wrote task, outbox, run, event, or receipt state")

    accepted = _expect(base, "POST", "/api/v1/medical/ocr-runs", 202,
                       {"attachmentId": medical_id}, owner_token, receipt_key)
    run_id = accepted.get("data", {}).get("runId")
    if not run_id or accepted["data"].get("status") != "queued":
        raise AssertionError("medical_report attachment did not queue a run")
    after_accept = _state(sql)
    for field, count in before_rejection.items():
        if after_accept[field] != count + 1:
            raise AssertionError(f"valid medical OCR did not create exactly one {field} row")
    replay = _expect(base, "POST", "/api/v1/medical/ocr-runs", 202,
                     {"attachmentId": medical_id}, owner_token, receipt_key)
    if replay.get("data", {}).get("runId") != run_id or _state(sql) != after_accept:
        raise AssertionError("same-key medical OCR replay was not exactly-once")

    conflict = _expect(base, "POST", "/api/v1/medical/ocr-runs", 409,
                       {"attachmentId": second_medical_id}, owner_token, receipt_key)
    if conflict.get("error", {}).get("code") != "IDEMPOTENCY_KEY_REUSED":
        raise AssertionError("changed attachment did not use the existing 409 idempotency contract")
    if _state(sql) != after_accept:
        raise AssertionError("changed medical attachment under the same key wrote new task state")

    pdf_key = "test_medical_ocr_pdf_" + suffix
    before_pdf = _state(sql)
    pdf_run = _expect(base, "POST", "/api/v1/medical/ocr-runs", 202,
                      {"attachmentId": pdf_id}, owner_token, pdf_key)
    if not pdf_run.get("data", {}).get("runId") or pdf_run["data"].get("status") != "queued":
        raise AssertionError("medical_report PDF did not queue an OCR run")
    after_pdf = _state(sql)
    if any(after_pdf[key] != count + 1 for key, count in before_pdf.items()):
        raise AssertionError("valid medical_report PDF did not create exactly one task and receipt")

    before_foreign = _state(sql)
    foreign = _expect(base, "POST", "/api/v1/medical/ocr-runs", 404,
                      {"attachmentId": foreign_id}, owner_token,
                      "test_medical_ocr_foreign_" + suffix)
    if foreign.get("error", {}).get("code") != "RECORD_NOT_FOUND":
        raise AssertionError("foreign attachment did not use the existing 404 resource-hiding contract")
    if _state(sql) != before_foreign:
        raise AssertionError("foreign attachment rejection wrote task or receipt state")

    return {
        "status": "PASS",
        "apiHost": "127.0.0.1",
        "medicalReportReadyPng": "202 queued",
        "growthPhotoReadyPngSameMime": "400 BAD_REQUEST",
        "medicalReportPendingPng": "400 ATTACHMENT_NOT_READY before upload or complete",
        "medicalReportReadyAudioM4A": "400 BAD_REQUEST after real upload and complete",
        "foreignPrincipalAttachment": "404",
        "purposePendingMimeAndForeignRejectionsWriteNoTaskOrReceipt": True,
        "sameKeyReplayReturnsSameRunWithoutNewRows": True,
        "changedAttachmentUnderSameKey": "409 with no additional rows",
        "medicalReportReadyPDF": "202 queued",
        "successDelta": {key: 1 for key in after_accept},
        "pdfSuccessDelta": {key: 1 for key in after_pdf},
        "realMinIOUploadAndComplete": True,
        "pendingAttachmentWasReservedByHTTPAndNotUploadedOrCompleted": True,
        "audioAttachmentUsedRealHTTPUploadAndComplete": True,
        "audioPayloadIsMIMEFixtureOnlyNotMediaDecodingEvidence": True,
        "credentialsOrUploadCapabilityRecorded": False,
    }


def main() -> int:
    """Run only against a caller-owned test_ loopback stack; never starts workers."""
    try:
        api_url = os.environ.get("GROWDESK_TEST_API_URL", "")
        db_name = os.environ.get("GROWDESK_TEST_DB", "")
        db_role = os.environ.get("GROWDESK_TEST_DB_ROLE", "")
        db_password = os.environ.get("GROWDESK_TEST_DB_PASSWORD", "")
        db_port = int(os.environ.get("GROWDESK_TEST_DB_PORT", "0"))
        minio_port = int(os.environ.get("GROWDESK_TEST_MINIO_PORT", "0"))
        api = urllib.parse.urlsplit(_loopback_base(api_url))
        match = re.fullmatch(r"test_growdesk_([0-9a-f]{12})", db_name)
        if (not match or db_role != "test_app_" + match.group(1) or not db_password or
                not (1024 <= db_port <= 65535) or db_port in (5432, 6379, 3088, 3089) or
                not (1024 <= minio_port <= 65535) or minio_port in (3088, 3089) or
                minio_port == api.port or
                os.environ.get("GROWDESK_TEST_PROVIDER_MODE") != "fixture" or
                os.environ.get("GROWDESK_TEST_EXTERNAL_CALLS") != "disabled" or
                os.environ.get("GROWDESK_TEST_WORKER_STARTED") != "false"):
            raise RuntimeError("medical_ocr_test_environment_guard_failed")
        psql = shutil.which("psql")
        if not psql:
            raise RuntimeError("medical_ocr_test_psql_unavailable")
        pg_env = {key: os.environ[key] for key in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")
                  if key in os.environ}
        pg_env.update({"PGPASSWORD": db_password, "PGCONNECT_TIMEOUT": "5"})

        def sql(statement: str) -> str:
            result = subprocess.run(
                [psql, "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-h", "127.0.0.1",
                 "-p", str(db_port), "-U", db_role, "-d", db_name],
                input=statement, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                env=pg_env, timeout=20)
            if result.returncode:
                raise RuntimeError("medical_ocr_test_database_query_failed")
            return result.stdout.strip()

        identity = sql("SELECT current_database() || '|' || current_user || '|' || "
                       "(SELECT rolsuper::text FROM pg_roles WHERE rolname=current_user) || '|' || "
                       "host(inet_server_addr());")
        if identity != f"{db_name}|{db_role}|false|127.0.0.1":
            raise RuntimeError("medical_ocr_test_database_identity_guard_failed")
        result = run(api_url, sql, minio_port)
        result["status"] = "PASS"
        result["databaseGuard"] = {"database": db_name, "applicationRole": db_role,
                                   "superuser": False, "host": "127.0.0.1"}
        result["workerStarted"] = False
        result["externalProviderCalls"] = False
        root = Path(__file__).resolve().parents[1]
        result["sourceHashes"] = {
            "internal/backend/ai_run_commands.go": _sha256_file(root / "internal/backend/ai_run_commands.go"),
            "packages/contracts/src/routes.ts": _sha256_file(root / "packages/contracts/src/routes.ts"),
            "contracts/openapi.json": _sha256_file(root / "contracts/openapi.json"),
            "scripts/go-medical-ocr-purpose-live-integration.py": _sha256_file(Path(__file__).resolve()),
        }
        result["apiBinarySha256"] = os.environ.get("GROWDESK_TEST_API_BINARY_SHA256")
        result["apiRevision"] = os.environ.get("GROWDESK_TEST_API_REVISION")
    except Exception as error:
        result = {"status": "FAIL", "failureType": type(error).__name__,
                  "failure": str(error), "secretsRecorded": False}

    evidence_path = os.environ.get("GROWDESK_TEST_EVIDENCE_PATH")
    if evidence_path:
        path = os.path.abspath(evidence_path)
        if os.path.islink(path) or os.path.exists(path):
            print("medical_ocr_evidence_write=refused_existing_path")
            return 2
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
