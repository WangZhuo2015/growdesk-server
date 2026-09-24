"""Promote the safely mappable legacy AI history into the canonical tables.

This is deliberately a small, offline promotion boundary.  It maps the old
private chat session/message graph and the old ``AiJob`` audit rows into the
existing ``AiSession``, ``AiChatMessage``, ``TaskExecution``, ``AiRun`` and
``AiRunEvent`` tables.  It never calls a provider and never copies provider
payloads into the online model.  The immutable ``legacy_import`` rows remain
the only source for the original result, tool trace, archive and file data.

``AiArchive``, ``AgentVoiceLog`` and ``RecordSnapshot`` are intentionally
quarantined by the report helpers.  There is no safe target for their raw
content in the current schema: archive files still need the attachment/object
store promotion, voice history needs a first-class canonical table, and undo
snapshots are not ``SyncSnapshot``.  The renderer refuses malformed or
ambiguous rows and emits one transaction, so a partial promotion cannot be
reported as complete.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import re
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


MAPPING_VERSION = "ai-history-v1"
ATTACHMENT_MAPPING_VERSION = "attachment-promotion-v1"
SOURCE_SYSTEM_DEFAULT = "legacy_web"
ADVISORY_LOCK = 724019238
MAPPED_TABLES = ("AiChatSession", "AiChatMessage", "AiJob")
QUARANTINED_TABLES = {
    "AiArchive": "AI_ARCHIVE_ATTACHMENT_MAPPING_REQUIRED",
    "AgentVoiceLog": "VOICE_HISTORY_CANONICAL_TABLE_REQUIRED",
    "RecordSnapshot": "UNDO_SNAPSHOT_CANONICAL_TABLE_REQUIRED",
}
ALLOWED_ROLES = {"user", "assistant", "system"}
ALLOWED_JOB_STATUSES = {"processing", "done", "failed"}
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_SENSITIVE_KEY = re.compile(
    r"(?:password|passwd|token|secret|credential|authorization|cookie|refresh|access|api[_-]?key)",
    re.IGNORECASE,
)


def _import_identity_loader():
    try:
        from import_sql import load_archive, literal  # type: ignore

        return load_archive, literal
    except ModuleNotFoundError:
        path = Path(__file__).with_name("import_sql.py")
        spec = importlib.util.spec_from_file_location("legacy_import_sql_ai_history", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load import_sql.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.load_archive, module.literal


load_archive, literal = _import_identity_loader()


def _require_checksum(value: str) -> str:
    if not isinstance(value, str) or not _SHA256_RE.fullmatch(value):
        raise ValueError("Archive checksum must be a lowercase SHA-256")
    return value


def _rows(data: dict[str, Any], table: str) -> list[dict[str, Any]]:
    tables = data.get("tables")
    if not isinstance(tables, dict):
        raise ValueError("Archive tables must be an object")
    rows = tables.get(table, [])
    if not isinstance(rows, list):
        raise ValueError(f"{table} must be an array")
    result: list[dict[str, Any]] = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise ValueError(f"{table}[{index}] must be an object")
        result.append(row)
    return result


def _text(value: Any, label: str, *, allow_none: bool = False, max_length: int | None = None) -> str | None:
    if value is None and allow_none:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"{label} exceeds {max_length} characters")
    return value


def _optional_text(value: Any, label: str, *, max_length: int | None = None) -> str | None:
    return _text(value, label, allow_none=True, max_length=max_length)


def _boolean(value: Any, label: str, *, default: bool | None = None) -> bool:
    if value is None and default is not None:
        return default
    if isinstance(value, bool):
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    raise ValueError(f"{label} must be boolean or SQLite integer 0/1")


def _instant(value: Any, label: str, timezone_name: str) -> str:
    if value is None or isinstance(value, bool):
        raise ValueError(f"{label} must be a timestamp")
    if isinstance(value, (int, float)):
        parsed = dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc)
    elif isinstance(value, str) and value:
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"{label} has invalid timestamp") from error
        if parsed.tzinfo is None:
            try:
                parsed = parsed.replace(tzinfo=ZoneInfo(timezone_name))
            except Exception as error:  # pragma: no cover - archive pins timezone
                raise ValueError(f"Unsupported archive timezone {timezone_name}") from error
    else:
        raise ValueError(f"{label} must be a timestamp")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _canonical_hash(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _redact(value: Any, key: str | None = None) -> Any:
    if key is not None and _SENSITIVE_KEY.search(key):
        return "[redacted]"
    if isinstance(value, dict):
        return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def _private_payload_ref(value: Any, label: str) -> dict[str, Any] | None:
    """Return only proof metadata for a provider/raw payload.

    The raw value remains in ``legacy_import.import_rows``.  This function is
    intentionally hash-only even when the payload is valid JSON: a sanitized
    provider response is still too easy to mistake for an authoritative
    canonical result or to expose through an online DTO.
    """

    if value is None:
        return None
    if isinstance(value, str):
        raw = value.encode("utf-8")
    else:
        raw = _canonical_json(value).encode("utf-8")
    return {
        "redacted": True,
        "label": label,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "byteLength": len(raw),
    }


def _trace_ref(value: Any) -> str | None:
    ref = _private_payload_ref(value, "legacy_tools_json")
    if ref is None:
        return None
    return _canonical_json({"legacyTrace": ref})


def _identity(data: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[tuple[str, str], dict[str, Any]]]:
    users = {str(row.get("id")): row for row in _rows(data, "User") if row.get("id") is not None}
    families = {str(row.get("id")): row for row in _rows(data, "Family") if row.get("id") is not None}
    babies = {str(row.get("id")): row for row in _rows(data, "Baby") if row.get("id") is not None}
    members: dict[tuple[str, str], dict[str, Any]] = {}
    for row in _rows(data, "FamilyMember"):
        family_id = _text(row.get("familyId"), "FamilyMember.familyId")
        user_id = _text(row.get("userId"), "FamilyMember.userId")
        assert family_id is not None and user_id is not None
        members[(family_id, user_id)] = row
    return users, families, babies, members


def _check_unique_ids(rows: Iterable[dict[str, Any]], table: str) -> None:
    seen: set[str] = set()
    for row in rows:
        row_id = _text(row.get("id"), f"{table}.id")
        assert row_id is not None
        if row_id in seen:
            raise ValueError(f"Duplicate {table} id {row_id}")
        seen.add(row_id)


def _scope(
    data: dict[str, Any],
    row: dict[str, Any],
    table: str,
    *,
    required_baby: bool = False,
) -> tuple[str, str | None]:
    users, families, babies, members = _identity(data)
    row_id = _text(row.get("id"), f"{table}.id")
    user_id = _text(row.get("userId"), f"{table}/{row_id}.userId")
    assert row_id is not None and user_id is not None
    if user_id not in users:
        raise ValueError(f"{table}/{row_id}: unknown userId")
    baby_id = _optional_text(row.get("babyId"), f"{table}/{row_id}.babyId")
    if required_baby and baby_id is None:
        raise ValueError(f"{table}/{row_id}: babyId is required")
    if baby_id is None:
        return user_id, None
    baby = babies.get(baby_id)
    if baby is None:
        raise ValueError(f"{table}/{row_id}: unknown babyId")
    family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
    assert family_id is not None
    if family_id not in families or (family_id, user_id) not in members:
        raise ValueError(f"{table}/{row_id}: user/baby family scope is not proven")
    member = members[(family_id, user_id)]
    if member.get("status", "active") != "active":
        raise ValueError(f"{table}/{row_id}: user is not an active family member")
    return user_id, baby_id


def _created_updated(data: dict[str, Any], row: dict[str, Any], table: str, row_id: str) -> tuple[str, str]:
    timezone_name = data.get("timeZone")
    if not isinstance(timezone_name, str) or not timezone_name:
        raise ValueError("Archive timeZone is required")
    created = _instant(row.get("createdAt", data.get("capturedAt")), f"{table}/{row_id}.createdAt", timezone_name)
    updated = _instant(row.get("updatedAt", row.get("createdAt", data.get("capturedAt"))), f"{table}/{row_id}.updatedAt", timezone_name)
    if updated < created:
        raise ValueError(f"{table}/{row_id}: updatedAt precedes createdAt")
    return created, updated


def _metadata(data: dict[str, Any], table: str, row: dict[str, Any], source_hash: str, *, redactions: list[str] | None = None) -> dict[str, Any]:
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceTable": table,
        "sourceId": row.get("id"),
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "redactedFields": sorted(redactions or []),
    }


def _item(
    *,
    source_table: str,
    source_id: str,
    source_hash: str,
    source_key: str,
    target_entity_type: str,
    target_table: str,
    target_id: str,
    columns: dict[str, Any],
    redactions: list[str] | None = None,
) -> dict[str, Any]:
    snapshot = dict(columns)
    return {
        "source_table": source_table,
        "source_id": source_id,
        "source_hash": source_hash,
        "source_key": source_key,
        "target_entity_type": target_entity_type,
        "target_table": target_table,
        "target_id": target_id,
        "columns": columns,
        "target_snapshot": snapshot,
        "target_hash": _canonical_hash(snapshot),
        "redactions": sorted(redactions or []),
    }


def _session_item(data: dict[str, Any], row: dict[str, Any], *, source_key: str | None = None, source_hash: str | None = None, source_id: str | None = None, synthetic_reason: str | None = None) -> dict[str, Any]:
    row_id = _text(row.get("id"), "AiChatSession.id")
    assert row_id is not None
    user_id, baby_id = _scope(data, row, "AiChatSession")
    created, updated = _created_updated(data, row, "AiChatSession", row_id)
    title = _text(row.get("title", "新对话"), f"AiChatSession/{row_id}.title", max_length=500)
    context = _text(row.get("contextType", "general"), f"AiChatSession/{row_id}.contextType", max_length=100)
    assert title is not None and context is not None
    metadata = {"legacySource": "AiChatSession"}
    if synthetic_reason:
        metadata.update({"synthetic": True, "reason": synthetic_reason})
    columns = {
        "id": row_id,
        "user_id": user_id,
        "baby_id": baby_id,
        "title": title,
        "context_type": context,
        "created_at": created,
        "updated_at": updated,
    }
    return _item(
        source_table="AiChatSession" if synthetic_reason is None else "AiJob",
        source_id=source_id or row_id,
        source_hash=source_hash or _canonical_hash(row),
        source_key=source_key or f"AiChatSession:{row_id}",
        target_entity_type="ai_session",
        target_table="ai_sessions",
        target_id=row_id,
        columns=columns,
        redactions=["syntheticSession"] if synthetic_reason else [],
    )


def _normalized_attachment_path(value: str, label: str) -> str:
    raw = value.strip()
    parts = urlsplit(raw)
    if not raw or parts.scheme or parts.netloc or parts.query or parts.fragment or "%" in raw or "\\" in raw:
        raise ValueError(f"{label} must be a local captured attachment path")
    normalized = raw.lstrip("/")
    if normalized.startswith("uploads/"):
        normalized = "public/" + normalized
    segments = normalized.split("/")
    if any(segment in {"", ".", ".."} for segment in segments):
        raise ValueError(f"{label} contains an unsafe path segment")
    if not normalized.startswith(("public/uploads/", "data/archive/")):
        raise ValueError(f"{label} is outside captured attachment roots")
    return normalized


def _attachment_index(report: Mapping[str, Any] | None, checksum: str) -> dict[tuple[str, str, str, str], Mapping[str, Any]]:
    if report is None:
        return {}
    if report.get("mappingVersion") != ATTACHMENT_MAPPING_VERSION or not isinstance(report.get("receipts"), list):
        raise ValueError("Attachment report has an unsupported mapping version")
    result: dict[tuple[str, str, str, str], Mapping[str, Any]] = {}
    for index, raw in enumerate(report["receipts"]):
        if not isinstance(raw, Mapping):
            raise ValueError(f"Attachment report receipt {index} must be an object")
        if _text(raw.get("sourceBatchId"), f"attachment receipt {index}.sourceBatchId") != checksum:
            continue
        table = _text(raw.get("sourceTable"), f"attachment receipt {index}.sourceTable")
        source_id = _text(raw.get("sourceId"), f"attachment receipt {index}.sourceId")
        field = _text(raw.get("sourceField"), f"attachment receipt {index}.sourceField")
        path = _text(raw.get("sourcePath"), f"attachment receipt {index}.sourcePath")
        assert table is not None and source_id is not None and field is not None and path is not None
        key = table, source_id, field, path
        if key in result:
            raise ValueError(f"Duplicate attachment receipt for {'/'.join(key)}")
        result[key] = raw
    return result


def _message_item(
    data: dict[str, Any],
    row: dict[str, Any],
    session_ids: set[str],
    attachments: Mapping[tuple[str, str, str, str], Mapping[str, Any]],
) -> dict[str, Any]:
    row_id = _text(row.get("id"), "AiChatMessage.id")
    session_id = _text(row.get("sessionId"), f"AiChatMessage/{row_id}.sessionId")
    role = _text(row.get("role"), f"AiChatMessage/{row_id}.role")
    content = _text(row.get("content"), f"AiChatMessage/{row_id}.content")
    assert row_id is not None and session_id is not None and role is not None and content is not None
    if session_id not in session_ids:
        raise ValueError(f"AiChatMessage/{row_id}: sessionId is not present in the archive")
    if role not in ALLOWED_ROLES:
        raise ValueError(f"AiChatMessage/{row_id}: unsupported role {role}")
    image = _optional_text(row.get("image"), f"AiChatMessage/{row_id}.image")
    attachment_id: str | None = None
    if image:
        normalized = _normalized_attachment_path(image, f"AiChatMessage/{row_id}.image")
        receipt = attachments.get(("AiChatMessage", row_id, "image", normalized))
        if receipt is not None:
            source_hash = _canonical_hash(row)
            if receipt.get("sourceHash") != source_hash:
                raise ValueError(f"AiChatMessage/{row_id}: image attachment source hash mismatch")
            attachment = receipt.get("attachment")
            if not isinstance(attachment, Mapping) or attachment.get("purpose") != "ai_input":
                raise ValueError(f"AiChatMessage/{row_id}: image attachment purpose mismatch")
            attachment_id = _text(receipt.get("targetAttachmentId"), f"AiChatMessage/{row_id} attachment id")
            if attachment.get("id") != attachment_id:
                raise ValueError(f"AiChatMessage/{row_id}: image attachment ID mismatch")
    created, _updated = _created_updated(data, row, "AiChatMessage", row_id)
    tools_json = _trace_ref(row.get("toolsJson"))
    redactions = ["toolsJson"] if row.get("toolsJson") is not None else []
    columns = {
        "id": row_id,
        "session_id": session_id,
        "role": role,
        "content": content,
        "image": f"/api/attachments/{attachment_id}" if attachment_id else None,
        "tools_json": tools_json,
        "created_at": created,
    }
    item = _item(
        source_table="AiChatMessage",
        source_id=row_id,
        source_hash=_canonical_hash(row),
        source_key=f"AiChatMessage:{row_id}",
        target_entity_type="ai_message",
        target_table="ai_messages",
        target_id=row_id,
        columns=columns,
        redactions=redactions,
    )
    if attachment_id:
        item["attachment_id"] = attachment_id
    return item


def _job_items(data: dict[str, Any], rows: list[dict[str, Any]], source_session_ids: set[str]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    sessions: list[dict[str, Any]] = []
    entities: list[dict[str, Any]] = []
    synthetic_ids: set[str] = set()
    for row in rows:
        row_id = _text(row.get("id"), "AiJob.id")
        job_type = _text(row.get("type"), f"AiJob/{row_id}.type", max_length=100)
        status = _text(row.get("status", "processing"), f"AiJob/{row_id}.status", max_length=50)
        assert row_id is not None and job_type is not None and status is not None
        if status not in ALLOWED_JOB_STATUSES:
            raise ValueError(f"AiJob/{row_id}: unsupported status {status}")
        user_id, baby_id = _scope(data, row, "AiJob")
        created, updated = _created_updated(data, row, "AiJob", row_id)
        finished = None
        if row.get("finishedAt") is not None:
            finished = _instant(row.get("finishedAt"), f"AiJob/{row_id}.finishedAt", data["timeZone"])
            if finished < created:
                raise ValueError(f"AiJob/{row_id}: finishedAt precedes createdAt")
        session_id = "legacy_ai_job_session_" + hashlib.sha256(row_id.encode("utf-8")).hexdigest()[:32]
        if session_id in source_session_ids or session_id in synthetic_ids:
            raise ValueError(f"AiJob/{row_id}: synthetic session ID collides with source session")
        synthetic_ids.add(session_id)
        synthetic = {
            "id": session_id,
            "userId": user_id,
            "babyId": baby_id,
            "title": "历史 AI 任务（迁移）",
            "contextType": "legacy_job",
            "createdAt": created,
            "updatedAt": updated,
        }
        sessions.append(
            _session_item(
                data,
                synthetic,
                source_key=f"AiJob:{row_id}:session",
                source_hash=_canonical_hash(row),
                source_id=row_id,
                synthetic_reason="AiJob has no legacy sessionId; deterministic private session preserves owner scope",
            )
        )
        result_ref = _private_payload_ref(row.get("resultJson"), "legacy_result_json")
        input_archive = _optional_text(row.get("inputArchiveId"), f"AiJob/{row_id}.inputArchiveId")
        if input_archive:
            result_ref = dict(result_ref or {})
            result_ref["legacyInputArchiveId"] = input_archive
            result_ref["archiveState"] = "quarantined_until_attachment_promotion"
        image_ref = _private_payload_ref(row.get("imageUrl"), "legacy_image_url")
        if image_ref:
            result_ref = dict(result_ref or {})
            result_ref["legacyImageRef"] = image_ref
            result_ref["imageState"] = "quarantined_until_attachment_promotion"
        result_ref = result_ref or None
        old_error = _private_payload_ref(row.get("errorMessage"), "legacy_error_message")
        mapped_status = {"done": "succeeded", "failed": "failed", "processing": "failed"}[status]
        error_code = None
        error_message = None
        if mapped_status == "failed":
            error_code = "LEGACY_INCOMPLETE_NOT_RESUMED" if status == "processing" else "LEGACY_JOB_FAILED"
            error_message = "Historical AI job imported as a terminal audit record; original provider/error payload remains in the private legacy archive."
        result_summary = None
        if row.get("resultJson") is not None:
            result_hash = _private_payload_ref(row.get("resultJson"), "legacy_result_json")
            assert result_hash is not None
            result_summary = f"legacy_result_json_sha256:{result_hash['sha256']}"
        details = {
            "legacySource": {"table": "AiJob", "id": row_id},
            "legacyStatus": status,
            "legacyType": job_type,
            "claimed": _boolean(row.get("claimed"), f"AiJob/{row_id}.claimed", default=False),
            "providerPayloadRedacted": True,
        }
        if old_error is not None:
            details["errorPayload"] = old_error
        task_columns = {
            "id": row_id,
            "kind": "legacy_ai_job",
            "owner_scope": f"user:{user_id}",
            "status": mapped_status,
            "attempt": 0,
            # Historical rows never receive an outbox and therefore cannot
            # be retried; keep the stored integer within the runtime task
            # contract instead of inventing a zero-attempt task.
            "max_attempts": 1,
            "fence_token": 0,
            "lease_owner": None,
            "lease_expires_at": None,
            "last_heartbeat_at": None,
            "cancel_requested_at": None,
            "progress": {"legacyType": job_type, "legacyStatus": status},
            "result_ref": result_ref,
            "error_details": details,
            "next_event_seq": 1,
            "created_at": created,
            "updated_at": updated,
        }
        run_columns = {
            "id": row_id,
            "session_id": session_id,
            "user_id": user_id,
            "baby_id": baby_id,
            "last_event_seq": 1,
            "result_summary": result_summary,
            "proposed_plan": None,
            "error_code": error_code,
            "error_message": error_message,
            "started_at": None,
            "finished_at": finished,
            "created_at": created,
            "updated_at": updated,
        }
        event_id = "legacy_ai_event_" + hashlib.sha256(row_id.encode("utf-8")).hexdigest()[:32]
        event_columns = {
            "id": event_id,
            "run_id": row_id,
            "sequence": 1,
            "event_type": "run_succeeded" if mapped_status == "succeeded" else "run_failed",
            "payload": {
                "legacy": True,
                "legacyStatus": status,
                "sourceHash": _canonical_hash(row),
                "providerPayloadRedacted": True,
            },
            "created_at": finished or updated,
        }
        entities.extend(
            [
                _item(
                    source_table="AiJob",
                    source_id=row_id,
                    source_hash=_canonical_hash(row),
                    source_key=f"AiJob:{row_id}:task",
                    target_entity_type="task_execution",
                    target_table="task_executions",
                    target_id=row_id,
                    columns=task_columns,
                    redactions=["resultJson", "errorMessage", "inputArchiveId", "imageUrl"] if (row.get("resultJson") is not None or row.get("errorMessage") is not None or input_archive or image_ref) else [],
                ),
                _item(
                    source_table="AiJob",
                    source_id=row_id,
                    source_hash=_canonical_hash(row),
                    source_key=f"AiJob:{row_id}:run",
                    target_entity_type="ai_run",
                    target_table="ai_runs",
                    target_id=row_id,
                    columns=run_columns,
                    redactions=["resultJson", "errorMessage", "inputArchiveId", "imageUrl"] if (row.get("resultJson") is not None or row.get("errorMessage") is not None or input_archive or image_ref) else [],
                ),
                _item(
                    source_table="AiJob",
                    source_id=row_id,
                    source_hash=_canonical_hash(row),
                    source_key=f"AiJob:{row_id}:event",
                    target_entity_type="ai_run_event",
                    target_table="ai_run_events",
                    target_id=event_id,
                    columns=event_columns,
                    redactions=["resultJson", "errorMessage", "inputArchiveId", "imageUrl"] if (row.get("resultJson") is not None or row.get("errorMessage") is not None or input_archive or image_ref) else [],
                ),
            ]
        )
    return sessions, entities


def prepare_materialization(
    data: dict[str, Any],
    checksum: str,
    attachment_report: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    _require_checksum(checksum)
    if data.get("formatVersion") != 1 or data.get("timeZone") != "Asia/Shanghai":
        raise ValueError("Unsupported archive format or timezone")
    _identity(data)
    for table in ("User", "Family", "FamilyMember", "Baby"):
        _check_unique_ids(_rows(data, table), table)
    for table in MAPPED_TABLES + tuple(QUARANTINED_TABLES):
        _check_unique_ids(_rows(data, table), table)
    sessions = _rows(data, "AiChatSession")
    messages = _rows(data, "AiChatMessage")
    jobs = _rows(data, "AiJob")
    attachments = _attachment_index(attachment_report, checksum)
    source_session_ids = {str(row["id"]) for row in sessions}
    items: list[dict[str, Any]] = []
    session_items = [_session_item(data, row) for row in sessions]
    synthetic_sessions, job_items = _job_items(data, jobs, source_session_ids)
    items.extend(synthetic_sessions)
    items.extend(session_items)
    items.extend(_message_item(data, row, source_session_ids | {item["target_id"] for item in synthetic_sessions}, attachments) for row in messages)
    items.extend(job_items)
    # The order is also the dependency order: sessions -> messages/tasks -> runs -> events.
    order = {"ai_session": 10, "ai_message": 20, "task_execution": 30, "ai_run": 40, "ai_run_event": 50}
    return sorted(items, key=lambda item: (order[item["target_entity_type"]], item["target_id"]))


def quarantine_report(data: dict[str, Any], checksum: str, attachment_report: Mapping[str, Any] | None = None) -> dict[str, Any]:
    _require_checksum(checksum)
    entries: list[dict[str, Any]] = []
    for table, code in QUARANTINED_TABLES.items():
        rows = _rows(data, table)
        if rows:
            entries.append({"sourceTable": table, "count": len(rows), "code": code, "status": "quarantined"})
    job_rows = _rows(data, "AiJob")
    archive_refs = sum(1 for row in job_rows if row.get("inputArchiveId") not in (None, ""))
    if archive_refs:
        entries.append({
            "sourceTable": "AiJob.inputArchiveId",
            "count": archive_refs,
            "code": "AI_ARCHIVE_REFERENCE_PENDING_ATTACHMENT_PROMOTION",
            "status": "quarantined",
        })
    image_refs = sum(1 for row in job_rows if row.get("imageUrl") not in (None, ""))
    if image_refs:
        entries.append({
            "sourceTable": "AiJob.imageUrl",
            "count": image_refs,
            "code": "AI_JOB_IMAGE_ATTACHMENT_REQUIRED",
            "status": "quarantined",
        })
    attachment_index = _attachment_index(attachment_report, checksum)
    unresolved_images = 0
    for row in _rows(data, "AiChatMessage"):
        image = row.get("image")
        if isinstance(image, str) and image:
            path = _normalized_attachment_path(image, f"AiChatMessage/{row.get('id')}.image")
            if ("AiChatMessage", str(row.get("id")), "image", path) not in attachment_index:
                unresolved_images += 1
    if unresolved_images:
        entries.append({
            "sourceTable": "AiChatMessage.image",
            "count": unresolved_images,
            "code": "AI_MESSAGE_IMAGE_ATTACHMENT_REQUIRED",
            "status": "quarantined",
        })
    invalid_job_status = sum(1 for row in job_rows if row.get("status", "processing") not in ALLOWED_JOB_STATUSES)
    if invalid_job_status:
        entries.append({
            "sourceTable": "AiJob.status",
            "count": invalid_job_status,
            "code": "AI_JOB_STATUS_UNMAPPED",
            "status": "quarantined",
        })
    invalid_message_role = sum(1 for row in _rows(data, "AiChatMessage") if row.get("role") not in ALLOWED_ROLES)
    if invalid_message_role:
        entries.append({
            "sourceTable": "AiChatMessage.role",
            "count": invalid_message_role,
            "code": "AI_MESSAGE_ROLE_UNMAPPED",
            "status": "quarantined",
        })
    return {
        "status": "quarantined" if entries else "ready",
        "archiveSha256": checksum,
        "mappingVersion": MAPPING_VERSION,
        "mappedTables": {table: len(_rows(data, table)) for table in MAPPED_TABLES},
        "quarantine": entries,
        "providerPayloadPolicy": "hash-only target references; raw result/tools/error values remain in legacy_import",
    }


def _sql(value: Any, *, cast: str | None = None) -> str:
    if value is None:
        return "NULL" if cast is None else f"NULL::{cast}"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, (dict, list)):
        return f"{literal(_canonical_json(value))}::jsonb"
    output = literal(str(value))
    return f"{output}::{cast}" if cast else output


def _conditions(columns: dict[str, Any]) -> str:
    checks = []
    json_columns = {"progress", "result_ref", "error_details", "proposed_plan", "payload"}
    for name, value in columns.items():
        checks.append(f'"{name}" IS NOT DISTINCT FROM {_sql(value, cast="jsonb" if name in json_columns and value is not None else None)}')
    return " AND ".join(checks)


def _render_target(item: dict[str, Any]) -> str:
    table = item["target_table"]
    columns = item["columns"]
    names = ",".join(f'"{name}"' for name in columns)
    values = ",".join(_sql(value, cast="jsonb" if name in {"progress", "result_ref", "error_details", "proposed_plan", "payload"} and value is not None else None) for name, value in columns.items())
    identity_column = '"id"'
    snapshot_hash = item["target_hash"]
    return f"""
DO $ai_target$
BEGIN
  IF EXISTS (SELECT 1 FROM public.{table} WHERE {identity_column}={_sql(item['target_id'])} AND {_conditions(columns)}) THEN
    NULL;
  ELSIF EXISTS (SELECT 1 FROM public.{table} WHERE {identity_column}={_sql(item['target_id'])}) THEN
    RAISE EXCEPTION 'AI target row conflicts with immutable snapshot: {item['target_entity_type']} %', {_sql(item['target_id'])};
  ELSE
    INSERT INTO public.{table} ({names}) VALUES ({values});
  END IF;
END;
$ai_target$;
"""


def _render_receipt(item: dict[str, Any], checksum: str, source_system: str) -> str:
    metadata = {
        "sourceHashSha256": item["source_hash"],
        "targetSnapshot": item["target_snapshot"],
        "targetSnapshotSha256": item["target_hash"],
        "mappingVersion": MAPPING_VERSION,
        "redactedFields": item["redactions"],
        "providerPayloadPolicy": "hash-only",
    }
    mapping_id = "legacy_ai_mapping_" + hashlib.sha256(f"{item['target_entity_type']}:{item['source_key']}".encode("utf-8")).hexdigest()[:32]
    return f"""
DO $ai_receipt$
BEGIN
  IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
    WHERE m.target_entity_type={_sql(item['target_entity_type'])} AND m.source_key={_sql(item['source_key'])}) THEN
    IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
      WHERE m.target_entity_type={_sql(item['target_entity_type'])} AND m.source_key={_sql(item['source_key'])}
        AND m.target_entity_id={_sql(item['target_id'])}
        AND m.source_hash={_sql(item['source_hash'])}
        AND m.metadata->>'targetSnapshotSha256'={_sql(item['target_hash'])}) THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'AI mapping receipt conflicts with immutable source: {item['target_entity_type']} %', {_sql(item['source_key'])};
    END IF;
  ELSE
    INSERT INTO public.legacy_idempotency_mappings
      (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,source_hash,mapping_version,metadata,created_at)
    VALUES
      ({_sql(mapping_id)},{_sql(item['target_entity_type'])},{_sql(item['target_id'])},{_sql(item['source_key'])},'mapped',
       {_sql(source_system)},{_sql(checksum)},{_sql(item['source_table'])},{_sql(item['source_id'])},{_sql(item['source_hash'])},
       {_sql(MAPPING_VERSION)},{_sql(metadata, cast='jsonb')},CURRENT_TIMESTAMP);
  END IF;
END;
$ai_receipt$;
"""


def render_materialization(data: dict[str, Any], checksum: str, attachment_report: Mapping[str, Any] | None = None) -> str:
    checksum = _require_checksum(checksum)
    items = prepare_materialization(data, checksum, attachment_report)
    source_system = data.get("sourceId") or SOURCE_SYSTEM_DEFAULT
    body: list[str] = []
    for item in items:
        if item.get("attachment_id"):
            body.append(f"""
DO $ai_attachment$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.attachments
    WHERE id={_sql(item['attachment_id'])} AND purpose='ai_input' AND status='ready' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'AI message attachment is not ready: %', {_sql(item['attachment_id'])};
  END IF;
END;
$ai_attachment$;
""")
        body.append(f"""
DO $ai_source$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM legacy_import.import_rows
    WHERE batch_id={_sql(checksum)} AND source_table={_sql(item['source_table'])}
      AND source_id={_sql(item['source_id'])} AND payload_hash={_sql(item['source_hash'])}) THEN
    RAISE EXCEPTION 'AI source row hash mismatch or missing: {item['source_table']} %', {_sql(item['source_id'])};
  END IF;
END;
$ai_source$;
""")
        body.append(_render_target(item))
        body.append(_render_receipt(item, checksum, source_system))
    delimiter = "$ai_import_" + checksum + "$"
    sql = f"""BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});
{''.join(body)}
COMMIT;
SELECT json_build_object(
  'mappingVersion',{_sql(MAPPING_VERSION)},
  'sourceBatchId',{_sql(checksum)},
  'sessions',(SELECT count(*) FROM public.ai_sessions s WHERE s.id IN (SELECT target_entity_id FROM public.legacy_idempotency_mappings WHERE source_batch_id={_sql(checksum)} AND target_entity_type='ai_session')),
  'messages',(SELECT count(*) FROM public.ai_messages m WHERE m.id IN (SELECT target_entity_id FROM public.legacy_idempotency_mappings WHERE source_batch_id={_sql(checksum)} AND target_entity_type='ai_message')),
  'runs',(SELECT count(*) FROM public.ai_runs r WHERE r.id IN (SELECT target_entity_id FROM public.legacy_idempotency_mappings WHERE source_batch_id={_sql(checksum)} AND target_entity_type='ai_run')),
  'quarantinedTables',{_sql(sorted(table for table in QUARANTINED_TABLES if _rows(data, table)) , cast='jsonb')}
);
"""
    if delimiter in sql:
        raise ValueError("SQL delimiter collision")
    return sql


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--quarantine-output")
    parser.add_argument("--attachment-report")
    args = parser.parse_args()
    data, checksum = load_archive(args.archive)
    if checksum != args.sha256:
        raise ValueError("Archive checksum mismatch")
    attachment_report: Mapping[str, Any] | None = None
    if args.attachment_report:
        raw = json.loads(Path(args.attachment_report).read_text(encoding="utf-8"))
        if not isinstance(raw, Mapping):
            raise ValueError("Attachment report must be an object")
        attachment_report = raw
    sql = render_materialization(data, checksum, attachment_report)
    output = Path(args.output)
    fd = output.open("x", encoding="utf-8")
    try:
        fd.write(sql)
    finally:
        fd.close()
    if args.quarantine_output:
        quarantine_path = Path(args.quarantine_output)
        qfd = quarantine_path.open("x", encoding="utf-8")
        try:
            qfd.write(json.dumps(quarantine_report(data, checksum, attachment_report), ensure_ascii=False, indent=2) + "\n")
        finally:
            qfd.close()
    print(json.dumps({"status": "prepared", "mapped": len(prepare_materialization(data, checksum, attachment_report)), "quarantine": len(quarantine_report(data, checksum, attachment_report)["quarantine"])}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
