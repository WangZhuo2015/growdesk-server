"""Promote legacy ``AiArchive`` rows into a private canonical archive table.

The legacy table has no owner foreign key.  This importer therefore treats an
owner as evidence, not as an input assumption: a row is mapped only when its
explicit scope or an unambiguous ``AiJob.inputArchiveId`` link proves the
user/family/baby relationship in the immutable snapshot.  Binary rows also
require a matching, ready private ``Attachment`` receipt.  Everything else is
retained as a quarantined canonical row and is excluded from online DTOs.

The generated SQL is one transaction with a transaction advisory lock.  It
checks the immutable import row hash, writes append-only target rows, and
records a replay/tamper-detecting ``LegacyIdempotencyMapping`` receipt.  The
object store is deliberately outside this module; attachment promotion must
complete and produce a machine-readable report before binary rows are mapped.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo

try:
    from import_sql import load_archive, literal  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - direct script import
    import importlib.util

    _path = Path(__file__).with_name("import_sql.py")
    _spec = importlib.util.spec_from_file_location("legacy_import_sql_ai_archive", _path)
    if _spec is None or _spec.loader is None:
        raise RuntimeError("Unable to load import_sql.py")
    _module = importlib.util.module_from_spec(_spec)
    _spec.loader.exec_module(_module)
    load_archive, literal = _module.load_archive, _module.literal


MAPPING_VERSION = "ai-archive-v1"
ATTACHMENT_MAPPING_VERSION = "attachment-promotion-v1"
SOURCE_SYSTEM_DEFAULT = "legacy_web"
ADVISORY_LOCK = 724019241
SOURCE_TABLE = "AiArchive"
ALLOWED_KINDS = {"input_image", "input_audio", "input_text", "output_json", "output_error"}
BINARY_KINDS = {"input_image", "input_audio"}
TEXT_KINDS = {"input_text", "output_json", "output_error"}
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _canonical_hash(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _rows(data: Mapping[str, Any], table: str) -> list[dict[str, Any]]:
    tables = data.get("tables")
    if not isinstance(tables, Mapping):
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


def _hash(value: Any, label: str) -> str:
    result = _text(value, label)
    assert result is not None
    if SHA256.fullmatch(result) is None:
        raise ValueError(f"{label} must be a lowercase SHA-256")
    return result


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
            parsed = parsed.replace(tzinfo=ZoneInfo(timezone_name))
    else:
        raise ValueError(f"{label} must be a timestamp")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _check_unique_ids(rows: Iterable[dict[str, Any]], table: str) -> None:
    seen: set[str] = set()
    for row in rows:
        row_id = _text(row.get("id"), f"{table}.id")
        assert row_id is not None
        if row_id in seen:
            raise ValueError(f"Duplicate {table} id {row_id}")
        seen.add(row_id)


def _identity(data: Mapping[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[tuple[str, str], dict[str, Any]]]:
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


def _active_families_for_user(user_id: str, families: Mapping[str, Mapping[str, Any]], members: Mapping[tuple[str, str], Mapping[str, Any]]) -> list[str]:
    result = []
    for family_id in families:
        member = members.get((family_id, user_id))
        if member is not None and member.get("status", "active") == "active":
            result.append(family_id)
    return sorted(result)


def _scope_tuple(
    *,
    user_id: str | None,
    family_id: str | None,
    baby_id: str | None,
    users: Mapping[str, Mapping[str, Any]],
    families: Mapping[str, Mapping[str, Any]],
    babies: Mapping[str, Mapping[str, Any]],
    members: Mapping[tuple[str, str], Mapping[str, Any]],
) -> tuple[str, str, str | None] | None:
    if user_id is None or user_id not in users:
        return None
    if baby_id is not None:
        baby = babies.get(baby_id)
        if baby is None:
            return None
        derived_family = _optional_text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
        if derived_family is None or derived_family not in families:
            return None
        if family_id not in (None, derived_family):
            return None
        family_id = derived_family
    if family_id is None:
        choices = _active_families_for_user(user_id, families, members)
        if len(choices) != 1:
            return None
        family_id = choices[0]
    if family_id not in families:
        return None
    member = members.get((family_id, user_id))
    if member is None or member.get("status", "active") != "active":
        return None
    return user_id, family_id, baby_id


def _owner_evidence(
    data: Mapping[str, Any],
    row: Mapping[str, Any],
    *,
    jobs_by_archive: Mapping[str, list[Mapping[str, Any]]],
) -> tuple[tuple[str, str, str | None] | None, str | None]:
    users, families, babies, members = _identity(data)
    archive_id = _text(row.get("id"), "AiArchive.id")
    assert archive_id is not None
    candidates: list[tuple[str, str, str | None]] = []
    # Explicit owner metadata is accepted only after the same identity proof
    # as a linked job. Legacy AiArchive does not normally have these fields,
    # but accepting them makes exported future snapshots forward-compatible.
    explicit = _scope_tuple(
        user_id=_optional_text(row.get("userId"), f"AiArchive/{archive_id}.userId"),
        family_id=_optional_text(row.get("familyId"), f"AiArchive/{archive_id}.familyId"),
        baby_id=_optional_text(row.get("babyId"), f"AiArchive/{archive_id}.babyId"),
        users=users,
        families=families,
        babies=babies,
        members=members,
    )
    if any(row.get(name) not in (None, "") for name in ("userId", "familyId", "babyId")) and explicit is None:
        return None, "OWNER_SCOPE_INVALID"
    if explicit is not None:
        candidates.append(explicit)
    for job in jobs_by_archive.get(archive_id, []):
        job_id = _text(job.get("id"), f"AiJob/{archive_id}.id")
        assert job_id is not None
        candidate = _scope_tuple(
            user_id=_optional_text(job.get("userId"), f"AiJob/{job_id}.userId"),
            family_id=_optional_text(job.get("familyId"), f"AiJob/{job_id}.familyId"),
            baby_id=_optional_text(job.get("babyId"), f"AiJob/{job_id}.babyId"),
            users=users,
            families=families,
            babies=babies,
            members=members,
        )
        if candidate is None:
            return None, "OWNER_SCOPE_INVALID"
        candidates.append(candidate)
    if not candidates:
        return None, "OWNER_UNPROVEN"
    if any(candidate != candidates[0] for candidate in candidates[1:]):
        return None, "OWNER_CONFLICT"
    return candidates[0], None


def _attachment_index(report: Mapping[str, Any] | None, checksum: str) -> dict[tuple[str, str, str, str], Mapping[str, Any]]:
    if report is None:
        return {}
    if report.get("mappingVersion") != ATTACHMENT_MAPPING_VERSION or not isinstance(report.get("receipts"), list):
        raise ValueError("Attachment report has an unsupported mapping version")
    result: dict[tuple[str, str, str, str], Mapping[str, Any]] = {}
    for index, raw in enumerate(report["receipts"]):
        if not isinstance(raw, Mapping):
            raise ValueError(f"Attachment report receipt {index} must be an object")
        source_batch = _hash(raw.get("sourceBatchId"), f"attachment receipt {index}.sourceBatchId")
        if source_batch != checksum:
            continue
        source_table = _text(raw.get("sourceTable"), f"attachment receipt {index}.sourceTable")
        source_id = _text(raw.get("sourceId"), f"attachment receipt {index}.sourceId")
        source_field = _text(raw.get("sourceField"), f"attachment receipt {index}.sourceField")
        source_path = _text(raw.get("sourcePath"), f"attachment receipt {index}.sourcePath")
        assert source_table is not None and source_id is not None and source_field is not None and source_path is not None
        key = source_table, source_id, source_field, source_path
        if key in result:
            raise ValueError(f"Duplicate attachment receipt for {'/'.join(key)}")
        result[key] = raw
    return result


def _attachment_for(
    row: Mapping[str, Any],
    row_id: str,
    source_hash: str,
    checksum: str,
    attachments: Mapping[tuple[str, str, str, str], Mapping[str, Any]],
) -> tuple[str | None, str | None, Mapping[str, Any] | None]:
    path = _optional_text(row.get("filePath"), f"AiArchive/{row_id}.filePath")
    if path is None:
        return None, None, None
    receipt = attachments.get((SOURCE_TABLE, row_id, "filePath", path))
    if receipt is None:
        return None, "ATTACHMENT_NOT_PROMOTED", None
    if _hash(receipt.get("sourceHash"), f"AiArchive/{row_id} attachment sourceHash") != source_hash:
        return None, "ATTACHMENT_SOURCE_HASH_MISMATCH", receipt
    target_hash = _hash(receipt.get("targetSha256"), f"AiArchive/{row_id} attachment targetSha256")
    content_hash = _hash(row.get("contentHash"), f"AiArchive/{row_id}.contentHash")
    if target_hash != content_hash:
        return None, "ATTACHMENT_CONTENT_HASH_MISMATCH", receipt
    target_size = receipt.get("targetByteSize")
    if isinstance(target_size, bool) or not isinstance(target_size, int) or target_size < 0:
        raise ValueError(f"AiArchive/{row_id} attachment targetByteSize is invalid")
    source_size = row.get("byteSize")
    if source_size is not None and source_size != target_size:
        return None, "ATTACHMENT_SIZE_MISMATCH", receipt
    target_id = _text(receipt.get("targetAttachmentId"), f"AiArchive/{row_id} attachment targetAttachmentId")
    assert target_id is not None
    return target_id, None, receipt


def _quarantine_metadata(code: str | None, owner: tuple[str, str, str | None] | None, receipt: Mapping[str, Any] | None) -> dict[str, Any]:
    value: dict[str, Any] = {
        "mappingVersion": MAPPING_VERSION,
        "status": "quarantined",
        "quarantineCode": code,
        "ownerProven": owner is not None,
        "binaryAttachmentProven": receipt is not None,
    }
    if owner is not None:
        value["ownerEvidence"] = {"userId": owner[0], "familyId": owner[1], "babyId": owner[2]}
    if receipt is not None:
        value["attachmentEvidence"] = {
            "sourceBatchId": receipt.get("sourceBatchId"),
            "targetAttachmentId": receipt.get("targetAttachmentId"),
            "targetSha256": receipt.get("targetSha256"),
            "targetByteSize": receipt.get("targetByteSize"),
        }
    return value


def prepare_materialization(
    data: Mapping[str, Any],
    checksum: str,
    attachment_report: Mapping[str, Any] | None = None,
) -> list[dict[str, Any]]:
    _hash(checksum, "archive checksum")
    if data.get("formatVersion") != 1 or data.get("timeZone") != "Asia/Shanghai":
        raise ValueError("Unsupported archive format or timezone")
    users, families, babies, members = _identity(data)
    del users, families, babies, members
    for table in ("User", "Family", "FamilyMember", "Baby", "AiJob", "AiArchive"):
        _check_unique_ids(_rows(data, table), table)
    timezone_name = data.get("timeZone")
    assert isinstance(timezone_name, str)
    attachments = _attachment_index(attachment_report, checksum)
    jobs_by_archive: dict[str, list[Mapping[str, Any]]] = {}
    for job in _rows(data, "AiJob"):
        archive_id = job.get("inputArchiveId")
        if isinstance(archive_id, str) and archive_id:
            jobs_by_archive.setdefault(archive_id, []).append(job)
    items: list[dict[str, Any]] = []
    for row in _rows(data, "AiArchive"):
        row_id = _text(row.get("id"), "AiArchive.id")
        assert row_id is not None
        source_hash = _canonical_hash(row)
        kind = _text(row.get("kind"), f"AiArchive/{row_id}.kind", max_length=32)
        content_hash = _hash(row.get("contentHash"), f"AiArchive/{row_id}.contentHash")
        content = _optional_text(row.get("content"), f"AiArchive/{row_id}.content")
        file_path = _optional_text(row.get("filePath"), f"AiArchive/{row_id}.filePath")
        byte_size = row.get("byteSize")
        if byte_size is not None and (isinstance(byte_size, bool) or not isinstance(byte_size, int) or byte_size < 0):
            raise ValueError(f"AiArchive/{row_id}.byteSize must be a non-negative integer")
        created_at = _instant(row.get("createdAt", data.get("capturedAt")), f"AiArchive/{row_id}.createdAt", timezone_name)
        owner, owner_code = _owner_evidence(data, row, jobs_by_archive=jobs_by_archive)
        attachment_id: str | None = None
        attachment_code: str | None = None
        attachment_receipt: Mapping[str, Any] | None = None
        if file_path is not None:
            attachment_id, attachment_code, attachment_receipt = _attachment_for(row, row_id, source_hash, checksum, attachments)
        elif kind in BINARY_KINDS:
            attachment_code = "BINARY_PATH_MISSING"

        quarantine_code: str | None = owner_code or attachment_code
        if kind not in ALLOWED_KINDS:
            quarantine_code = quarantine_code or "UNSUPPORTED_KIND"
        if kind in TEXT_KINDS:
            if content is None:
                quarantine_code = quarantine_code or "TEXT_CONTENT_MISSING"
            else:
                actual_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
                if actual_hash != content_hash:
                    quarantine_code = quarantine_code or "CONTENT_HASH_MISMATCH"
                actual_size = len(content.encode("utf-8"))
                if byte_size is not None and byte_size != actual_size:
                    quarantine_code = quarantine_code or "CONTENT_SIZE_MISMATCH"
                if byte_size is None:
                    byte_size = actual_size
        # An image/audio archive is mapped only through a private Attachment;
        # a file path on an otherwise textual row follows the same rule.
        if file_path is not None and attachment_id is None:
            quarantine_code = quarantine_code or "ATTACHMENT_NOT_PROMOTED"
        status = "mapped" if quarantine_code is None else "quarantined"
        user_id, family_id, baby_id = owner if owner is not None else (None, None, None)
        metadata = _quarantine_metadata(quarantine_code, owner, attachment_receipt)
        # Do not copy plaintext from an owner-unproven row into another
        # canonical table. The immutable source archive still retains the
        # original for a later, separately authorized reconciliation; this
        # row keeps its content hash/size and is not an online DTO.
        stored_content = content if status == "mapped" else None
        if status == "quarantined" and content is not None:
            metadata["contentRedacted"] = True
        if status == "mapped":
            metadata = {
                "mappingVersion": MAPPING_VERSION,
                "status": "mapped",
                "ownerEvidence": {"userId": user_id, "familyId": family_id, "babyId": baby_id},
                "binaryAttachmentProven": attachment_id is not None if file_path is not None else True,
            }
        columns = {
            "id": row_id,
            "source_batch_id": checksum,
            "source_system": str(data.get("sourceId") or SOURCE_SYSTEM_DEFAULT),
            "source_table": SOURCE_TABLE,
            "source_id": row_id,
            "source_hash": source_hash,
            "kind": kind,
            "file_path": file_path,
            "content": stored_content,
            "content_hash": content_hash,
            "byte_size": byte_size,
            "user_id": user_id,
            "family_id": family_id,
            "baby_id": baby_id,
            "attachment_id": attachment_id,
            "status": status,
            "quarantine_code": quarantine_code,
            "metadata": metadata,
            "created_at": created_at,
        }
        snapshot = dict(columns)
        items.append({
            "source_table": SOURCE_TABLE,
            "source_id": row_id,
            "source_hash": source_hash,
            "source_key": f"{SOURCE_TABLE}:{row_id}",
            "target_entity_type": "ai_archive_entry",
            "target_table": "ai_archive_entries",
            "target_id": row_id,
            "columns": columns,
            "target_snapshot": snapshot,
            "target_hash": _canonical_hash(snapshot),
            "status": status,
            "quarantine_code": quarantine_code,
        })
    return sorted(items, key=lambda item: item["target_id"])


def quarantine_report(data: Mapping[str, Any], checksum: str, attachment_report: Mapping[str, Any] | None = None) -> dict[str, Any]:
    items = prepare_materialization(data, checksum, attachment_report)
    entries = [
        {
            "sourceTable": item["source_table"],
            "sourceId": item["source_id"],
            "sourceHash": item["source_hash"],
            "code": item["quarantine_code"],
            "status": item["status"],
        }
        for item in items
        if item["status"] == "quarantined"
    ]
    return {
        "status": "quarantined" if entries else "ready",
        "archiveSha256": checksum,
        "mappingVersion": MAPPING_VERSION,
        "mapped": sum(item["status"] == "mapped" for item in items),
        "quarantined": len(entries),
        "entries": entries,
        "binaryPolicy": "filePath rows require a matching ready private Attachment receipt",
        "ownerPolicy": "owner/family/baby scope must be proven from snapshot identity and unambiguous AiJob links",
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
    result = literal(str(value))
    return f"{result}::{cast}" if cast else result


def _conditions(columns: Mapping[str, Any]) -> str:
    json_columns = {"metadata"}
    return " AND ".join(
        f'"{name}" IS NOT DISTINCT FROM {_sql(value, cast="jsonb" if name in json_columns and value is not None else None)}'
        for name, value in columns.items()
    )


def _render_target(item: Mapping[str, Any]) -> str:
    columns = item["columns"]
    assert isinstance(columns, Mapping)
    names = ",".join(f'"{name}"' for name in columns)
    values = ",".join(_sql(value, cast="jsonb" if name == "metadata" and value is not None else None) for name, value in columns.items())
    return f"""
DO $ai_archive_target$
BEGIN
  IF EXISTS (SELECT 1 FROM public.ai_archive_entries WHERE id={_sql(item['target_id'])} AND {_conditions(columns)}) THEN
    NULL;
  ELSIF EXISTS (SELECT 1 FROM public.ai_archive_entries WHERE id={_sql(item['target_id'])}) THEN
    RAISE EXCEPTION 'AI archive target row conflicts with immutable snapshot: %', {_sql(item['target_id'])};
  ELSE
    INSERT INTO public.ai_archive_entries ({names}) VALUES ({values});
  END IF;
END;
$ai_archive_target$;
"""


def _render_receipt(item: Mapping[str, Any], checksum: str, source_system: str) -> str:
    metadata = {
        "targetSnapshot": item["target_snapshot"],
        "targetSnapshotSha256": item["target_hash"],
        "mappingVersion": MAPPING_VERSION,
        "status": item["status"],
        "quarantineCode": item["quarantine_code"],
    }
    mapping_id = "legacy_ai_archive_mapping_" + hashlib.sha256(str(item["source_key"]).encode("utf-8")).hexdigest()[:32]
    status = item["status"]
    return f"""
DO $ai_archive_receipt$
BEGIN
  IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
    WHERE m.target_entity_type='ai_archive_entry' AND m.source_key={_sql(item['source_key'])}) THEN
    IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
      WHERE m.target_entity_type='ai_archive_entry' AND m.source_key={_sql(item['source_key'])}
        AND m.target_entity_id={_sql(item['target_id'])}
        AND m.source_hash={_sql(item['source_hash'])}
        AND m.mapping_version={_sql(MAPPING_VERSION)}
        AND m.status={_sql(status)}
        AND m.metadata->>'targetSnapshotSha256'={_sql(item['target_hash'])}) THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'AI archive mapping receipt conflicts with immutable source: %', {_sql(item['source_key'])};
    END IF;
  ELSE
    INSERT INTO public.legacy_idempotency_mappings
      (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,source_hash,mapping_version,metadata,created_at)
    VALUES
      ({_sql(mapping_id)},'ai_archive_entry',{_sql(item['target_id'])},{_sql(item['source_key'])},{_sql(status)},
       {_sql(source_system)},{_sql(checksum)},{_sql(item['source_table'])},{_sql(item['source_id'])},{_sql(item['source_hash'])},
       {_sql(MAPPING_VERSION)},{_sql(metadata, cast='jsonb')},CURRENT_TIMESTAMP);
  END IF;
END;
$ai_archive_receipt$;
"""


def render_materialization(data: Mapping[str, Any], checksum: str, attachment_report: Mapping[str, Any] | None = None) -> str:
    checksum = _hash(checksum, "archive checksum")
    items = prepare_materialization(data, checksum, attachment_report)
    body: list[str] = []
    for item in items:
        body.append(f"""
DO $ai_archive_source$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM legacy_import.import_rows
    WHERE batch_id={_sql(checksum)} AND source_table={_sql(item['source_table'])}
      AND source_id={_sql(item['source_id'])} AND payload_hash={_sql(item['source_hash'])}) THEN
    RAISE EXCEPTION 'AI archive source row hash mismatch or missing: %', {_sql(item['source_id'])};
  END IF;
END;
$ai_archive_source$;
""")
        # A mapped binary archive must point at a ready, owner-matching private
        # attachment at execution time. Missing evidence is already a
        # quarantine row; a stale/deleted attachment is a fail-stop condition.
        columns = item["columns"]
        assert isinstance(columns, Mapping)
        if item["status"] == "mapped" and columns.get("attachment_id") is not None:
            body.append(f"""
DO $ai_archive_attachment$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.attachments a
    WHERE a.id={_sql(columns['attachment_id'])} AND a.status='ready' AND a.deleted_at IS NULL
      AND a.family_id={_sql(columns['family_id'])}
      AND a.baby_id IS NOT DISTINCT FROM {_sql(columns['baby_id'])}
      AND a.sha256={_sql(columns['content_hash'])} AND a.byte_size={_sql(columns['byte_size'])}) THEN
    RAISE EXCEPTION 'AI archive private attachment is missing or does not match: %', {_sql(columns['attachment_id'])};
  END IF;
END;
$ai_archive_attachment$;
""")
        body.append(_render_target(item))
        body.append(_render_receipt(item, checksum, str(data.get("sourceId") or SOURCE_SYSTEM_DEFAULT)))
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
  'mapped',(SELECT count(*) FROM public.ai_archive_entries WHERE source_batch_id={_sql(checksum)} AND status='mapped'),
  'quarantined',(SELECT count(*) FROM public.ai_archive_entries WHERE source_batch_id={_sql(checksum)} AND status='quarantined')
);
"""
    return sql


def _write_new(path: Path, value: str) -> None:
    fd = path.open("x", encoding="utf-8")
    try:
        fd.write(value)
    finally:
        fd.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--attachment-report")
    parser.add_argument("--quarantine-output")
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
    _write_new(Path(args.output), render_materialization(data, checksum, attachment_report))
    if args.quarantine_output:
        _write_new(Path(args.quarantine_output), json.dumps(quarantine_report(data, checksum, attachment_report), ensure_ascii=False, indent=2) + "\n")
    report = quarantine_report(data, checksum, attachment_report)
    print(json.dumps({"status": report["status"], "mapped": report["mapped"], "quarantined": report["quarantined"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
