"""Promote legacy RecordSnapshot rows into canonical durable undo storage.

The legacy archive and ``legacy_import.import_rows`` remain immutable sources.
This materializer only writes the typed ``record_snapshots`` table and an
immutable ``legacy_idempotency_mappings`` receipt.  Every row is checked for
family/baby scope, source hash, target hash and replay consistency.  A changed
source or target raises inside one transaction, so a rerun cannot silently
overwrite a snapshot or turn a rollback into a second record.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


MAPPING_VERSION = "record-snapshot-v1"
SOURCE_SYSTEM_DEFAULT = "legacy_web"
ADVISORY_LOCK = 724019244
SOURCE_TABLE = "RecordSnapshot"
ENTITY_TYPES = {
    "feeding",
    "sleep",
    "diaper",
    "food",
    "growth",
    "medical_report",
    "vaccine",
    "food_plan",
    "supplement",
}
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _load_sql_helpers():
    try:
        from import_sql import load_archive, literal  # type: ignore

        return load_archive, literal
    except ModuleNotFoundError:
        path = Path(__file__).with_name("import_sql.py")
        spec = importlib.util.spec_from_file_location("legacy_import_sql_record_snapshots", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load import_sql.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.load_archive, module.literal


load_archive, literal = _load_sql_helpers()


def _checksum(value: str) -> str:
    if not isinstance(value, str) or not SHA256_RE.fullmatch(value):
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
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"{label} exceeds {max_length} characters")
    return value


def _boolean(value: Any, label: str, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    raise ValueError(f"{label} must be boolean or SQLite integer 0/1")


def _instant(value: Any, label: str, timezone_name: str, *, allow_none: bool = False) -> str | None:
    if value is None and allow_none:
        return None
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


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _identity(data: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[tuple[str, str], dict[str, Any]]]:
    users = {str(row.get("id")): row for row in _rows(data, "User") if row.get("id") is not None}
    families = {str(row.get("id")): row for row in _rows(data, "Family") if row.get("id") is not None}
    babies = {str(row.get("id")): row for row in _rows(data, "Baby") if row.get("id") is not None}
    members: dict[tuple[str, str], dict[str, Any]] = {}
    for row in _rows(data, "FamilyMember"):
        family_id = _text(row.get("familyId"), "FamilyMember.familyId")
        user_id = _text(row.get("userId"), "FamilyMember.userId")
        assert family_id is not None and user_id is not None
        key = (family_id, user_id)
        if key in members:
            raise ValueError(f"Duplicate FamilyMember scope {family_id}/{user_id}")
        members[key] = row
    return users, families, babies, members


def _payload(row: dict[str, Any], row_id: str) -> dict[str, Any]:
    raw = row.get("payload", row.get("payloadJson"))
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"{SOURCE_TABLE}/{row_id}.payloadJson is invalid JSON") from error
    if not isinstance(raw, dict):
        raise ValueError(f"{SOURCE_TABLE}/{row_id}.payload must be an object")
    return raw


def _scope(data: dict[str, Any], row: dict[str, Any], row_id: str) -> tuple[str, str, str, str | None]:
    users, families, babies, members = _identity(data)
    baby_id = _text(row.get("babyId"), f"{SOURCE_TABLE}/{row_id}.babyId")
    assert baby_id is not None
    baby = babies.get(baby_id)
    if baby is None:
        raise ValueError(f"{SOURCE_TABLE}/{row_id}: unknown babyId")
    family_id = _text(row.get("familyId", baby.get("familyId")), f"{SOURCE_TABLE}/{row_id}.familyId")
    assert family_id is not None
    if baby.get("familyId") != family_id or family_id not in families:
        raise ValueError(f"{SOURCE_TABLE}/{row_id}: baby/family scope is not proven")
    user_id = _text(row.get("userId"), f"{SOURCE_TABLE}/{row_id}.userId", allow_none=True)
    if user_id is not None:
        if user_id not in users or (family_id, user_id) not in members:
            raise ValueError(f"{SOURCE_TABLE}/{row_id}: user/family scope is not proven")
        if members[(family_id, user_id)].get("status", "active") != "active":
            raise ValueError(f"{SOURCE_TABLE}/{row_id}: user is not an active family member")
    return family_id, baby_id, user_id or "", user_id


def _item(data: dict[str, Any], row: dict[str, Any], checksum: str) -> dict[str, Any]:
    row_id = _text(row.get("id"), f"{SOURCE_TABLE}.id", max_length=200)
    assert row_id is not None
    family_id, baby_id, _, user_id = _scope(data, row, row_id)
    entity_type = _text(row.get("entityType"), f"{SOURCE_TABLE}/{row_id}.entityType")
    assert entity_type is not None
    if entity_type not in ENTITY_TYPES:
        raise ValueError(f"{SOURCE_TABLE}/{row_id}: unsupported entityType {entity_type}")
    entity_id = _text(row.get("entityId"), f"{SOURCE_TABLE}/{row_id}.entityId")
    action = _text(row.get("action", "delete"), f"{SOURCE_TABLE}/{row_id}.action")
    assert entity_id is not None and action is not None
    if action not in {"delete", "update", "batch_overwrite"}:
        raise ValueError(f"{SOURCE_TABLE}/{row_id}: unsupported action {action}")
    timezone_name = _text(data.get("timeZone"), "Archive.timeZone")
    assert timezone_name is not None
    created_at = _instant(row.get("createdAt", data.get("capturedAt")), f"{SOURCE_TABLE}/{row_id}.createdAt", timezone_name)
    restored = _boolean(row.get("restored"), f"{SOURCE_TABLE}/{row_id}.restored")
    restored_at = _instant(row.get("restoredAt"), f"{SOURCE_TABLE}/{row_id}.restoredAt", timezone_name, allow_none=True)
    if restored and restored_at is None:
        raise ValueError(f"{SOURCE_TABLE}/{row_id}: restoredAt is required for restored snapshots")
    payload = _payload(row, row_id)
    payload_hash = row.get("payloadHash")
    if payload_hash is not None and (not isinstance(payload_hash, str) or not SHA256_RE.fullmatch(payload_hash)):
        raise ValueError(f"{SOURCE_TABLE}/{row_id}.payloadHash must be lowercase SHA-256")
    calculated_payload_hash = _hash(payload)
    if payload_hash is not None and payload_hash != calculated_payload_hash:
        raise ValueError(f"{SOURCE_TABLE}/{row_id}: payload hash mismatch")
    source_hash = _hash(row)
    columns = {
        "id": row_id,
        "family_id": family_id,
        "baby_id": baby_id,
        "user_id": user_id,
        "source": _text(row.get("source", "legacy_web"), f"{SOURCE_TABLE}/{row_id}.source", max_length=32),
        "source_agent": _text(row.get("sourceAgent"), f"{SOURCE_TABLE}/{row_id}.sourceAgent", allow_none=True, max_length=200),
        "action": action,
        "entity_type": entity_type,
        "entity_id": entity_id,
        "payload_json": payload,
        "payload_hash": calculated_payload_hash,
        "source_system": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "source_batch_id": checksum,
        "source_table": SOURCE_TABLE,
        "source_id": row_id,
        "source_hash": source_hash,
        "mapping_version": MAPPING_VERSION,
        "restored": restored,
        "restored_at": restored_at,
        "created_at": created_at,
    }
    target_hash = _hash(columns)
    return {
        "source_table": SOURCE_TABLE,
        "source_id": row_id,
        "source_hash": source_hash,
        "source_key": f"{SOURCE_TABLE}:{row_id}",
        "target_entity_type": "record_snapshot",
        "target_id": row_id,
        "columns": columns,
        "target_hash": target_hash,
        "metadata": {
            "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
            "sourceSnapshot": data.get("sourceSha256"),
            "sourceTable": SOURCE_TABLE,
            "sourceId": row_id,
            "sourceHash": source_hash,
            "mappingVersion": MAPPING_VERSION,
            "targetHashSha256": target_hash,
            "targetSnapshot": columns,
        },
    }


def prepare_materialization(data: dict[str, Any], checksum: str) -> list[dict[str, Any]]:
    checksum = _checksum(checksum)
    rows = _rows(data, SOURCE_TABLE)
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for row in rows:
        row_id = _text(row.get("id"), f"{SOURCE_TABLE}.id", max_length=200)
        assert row_id is not None
        if row_id in seen:
            raise ValueError(f"Duplicate {SOURCE_TABLE} id {row_id}")
        seen.add(row_id)
        items.append(_item(data, row, checksum))
    return items


def _sql_json(value: Any) -> str:
    return literal(_canonical_json(value)) + "::jsonb"


def _sql_value(column: str, value: Any) -> str:
    if column == "payload_json":
        return _sql_json(value)
    if column in {"created_at", "restored_at"}:
        if value is None:
            return "NULL"
        return literal(value) + "::timestamptz"
    return literal(value)


def _target_match(item: dict[str, Any]) -> str:
    return " AND ".join(
        f't."{column}" IS NOT DISTINCT FROM {_sql_value(column, value)}'
        for column, value in item["columns"].items()
    )


def _render_item(item: dict[str, Any], checksum: str, source_system: str) -> str:
    source_key = literal(item["source_key"])
    source_hash = literal(item["source_hash"])
    target_id = literal(item["target_id"])
    target_hash = literal(item["target_hash"])
    metadata = _sql_json(item["metadata"])
    mapping_id = literal("legacy_record_snapshot_" + hashlib.sha256(item["source_key"].encode()).hexdigest()[:32])
    columns = item["columns"]
    column_names = ",".join(f'"{name}"' for name in columns)
    values = ",".join(_sql_value(name, value) for name, value in columns.items())
    match = _target_match(item)
    return f"""
IF NOT EXISTS (SELECT 1 FROM legacy_import.import_rows r
  WHERE r.batch_id={literal(checksum)} AND r.source_table={literal(SOURCE_TABLE)}
    AND r.source_id={literal(item['source_id'])} AND r.payload_hash={source_hash}) THEN
  RAISE EXCEPTION 'Record snapshot source row hash mismatch: %', {source_key};
END IF;
IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
  WHERE m.target_entity_type='record_snapshot' AND m.source_key={source_key}) THEN
  IF NOT EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
    WHERE m.target_entity_type='record_snapshot' AND m.source_key={source_key}
      AND m.target_entity_id={target_id} AND m.source_hash={source_hash}
      AND m.mapping_version={literal(MAPPING_VERSION)}
      AND m.metadata->>'targetHashSha256'={target_hash}
      AND EXISTS (SELECT 1 FROM public.record_snapshots t WHERE t.id={target_id} AND {match})) THEN
    RAISE EXCEPTION 'Record snapshot receipt or target was tampered: %', {source_key};
  END IF;
ELSE
  IF EXISTS (SELECT 1 FROM public.record_snapshots t WHERE t.id={target_id}) THEN
    RAISE EXCEPTION 'Record snapshot target ID already exists without matching receipt: %', {target_id};
  END IF;
  INSERT INTO public.record_snapshots ({column_names}) VALUES ({values});
  INSERT INTO public.legacy_idempotency_mappings
    (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,source_hash,mapping_version,metadata,created_at)
  VALUES ({mapping_id},'record_snapshot',{target_id},{source_key},'mapped',{literal(source_system)},{literal(checksum)},
    {literal(SOURCE_TABLE)},{literal(item['source_id'])},{source_hash},{literal(MAPPING_VERSION)},{metadata},CURRENT_TIMESTAMP);
END IF;
""".strip()


def render_materialization(data: dict[str, Any], checksum: str) -> str:
    checksum = _checksum(checksum)
    items = prepare_materialization(data, checksum)
    source_system = data.get("sourceId") or SOURCE_SYSTEM_DEFAULT
    if not isinstance(source_system, str) or not source_system:
        raise ValueError("Archive sourceId must be a non-empty string")
    body = "\n".join(_render_item(item, checksum, source_system) for item in items)
    delimiter = f"$record_snapshots_{checksum}$"
    if delimiter in body or delimiter in _canonical_json(data):
        raise ValueError("SQL delimiter collision")
    return f"""BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});
DO {delimiter}
BEGIN
IF NOT EXISTS (SELECT 1 FROM legacy_import.import_batches WHERE batch_id={literal(checksum)} AND checksum={literal(checksum)}) THEN
  RAISE EXCEPTION 'Record snapshot import batch is missing: %', {literal(checksum)};
END IF;
{body}
END;
{delimiter};
COMMIT;
SELECT json_build_object(
  'status','materialized',
  'recordSnapshots',(SELECT count(*) FROM public.record_snapshots WHERE id IN (SELECT target_entity_id FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='record_snapshot')),
  'receipts',(SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='record_snapshot'),
  'batchId',{literal(checksum)}
);
"""


def quarantine_report(data: dict[str, Any], checksum: str) -> dict[str, Any]:
    checksum = _checksum(checksum)
    items = prepare_materialization(data, checksum)
    return {
        "status": "ready" if items else "empty",
        "mappingVersion": MAPPING_VERSION,
        "sourceBatchId": checksum,
        "recordSnapshotCount": len(items),
        "quarantine": [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        data, actual_checksum = load_archive(args.archive)
        expected_checksum = _checksum(args.sha256)
        if actual_checksum != expected_checksum:
            raise ValueError("Archive checksum mismatch")
        sql = render_materialization(data, actual_checksum)
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(sql)
        print(json.dumps({"status": "prepared", "mappingVersion": MAPPING_VERSION, "recordSnapshotCount": len(_rows(data, SOURCE_TABLE))}))
        return 0
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
