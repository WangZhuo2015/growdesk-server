"""Promote legacy ``AgentVoiceLog`` rows into canonical PostgreSQL history.

The archive remains immutable.  This renderer only emits one transactional SQL
promotion, verifies every source row against ``legacy_import.import_rows`` and
records a target snapshot in ``legacy_idempotency_mappings``.  It never copies
provider secrets or follows client supplied scope without proving the legacy
user, family and baby relationship.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import re
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


MAPPING_VERSION = "voice-history-v1"
ADVISORY_LOCK = 724019243
SOURCE_SYSTEM_DEFAULT = "legacy_web"
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _load_literal():
    try:
        from import_sql import literal  # type: ignore

        return literal
    except ModuleNotFoundError:
        path = Path(__file__).with_name("import_sql.py")
        spec = importlib.util.spec_from_file_location("legacy_import_sql_voice_logs", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load import_sql.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.literal


literal = _load_literal()


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


def _text(value: Any, label: str, *, max_length: int | None = None) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string")
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
            except Exception as error:  # pragma: no cover
                raise ValueError(f"Unsupported archive timezone {timezone_name}") from error
    else:
        raise ValueError(f"{label} must be a timestamp")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _hash(value: Any) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _identity(data: dict[str, Any]):
    users = {str(row.get("id")): row for row in _rows(data, "User") if row.get("id") is not None}
    families = {str(row.get("id")): row for row in _rows(data, "Family") if row.get("id") is not None}
    babies = {str(row.get("id")): row for row in _rows(data, "Baby") if row.get("id") is not None}
    members: dict[tuple[str, str], dict[str, Any]] = {}
    for row in _rows(data, "FamilyMember"):
        family_id = _text(row.get("familyId"), "FamilyMember.familyId")
        user_id = _text(row.get("userId"), "FamilyMember.userId")
        key = (family_id, user_id)
        if key in members:
            raise ValueError(f"Duplicate FamilyMember scope {family_id}/{user_id}")
        members[key] = row
    return users, families, babies, members


def _scope(data: dict[str, Any], row: dict[str, Any], row_id: str) -> tuple[str, str, str]:
    users, families, babies, members = _identity(data)
    user_id = _text(row.get("userId"), f"AgentVoiceLog/{row_id}.userId")
    baby_id = _text(row.get("babyId"), f"AgentVoiceLog/{row_id}.babyId")
    if user_id not in users:
        raise ValueError(f"AgentVoiceLog/{row_id}: unknown userId")
    baby = babies.get(baby_id)
    if baby is None:
        raise ValueError(f"AgentVoiceLog/{row_id}: unknown babyId")
    family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
    if family_id not in families:
        raise ValueError(f"AgentVoiceLog/{row_id}: unknown familyId")
    member = members.get((family_id, user_id))
    if member is None or member.get("status", "active") != "active":
        raise ValueError(f"AgentVoiceLog/{row_id}: user/baby family scope is not proven")
    return user_id, family_id, baby_id


def _item(data: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    row_id = _text(row.get("id"), "AgentVoiceLog.id")
    user_id, family_id, baby_id = _scope(data, row, row_id)
    timezone_name = _text(data.get("timeZone"), "Archive.timeZone")
    created_at = _instant(row.get("createdAt", data.get("capturedAt")), f"AgentVoiceLog/{row_id}.createdAt", timezone_name)
    prompt = _text(row.get("prompt"), f"AgentVoiceLog/{row_id}.prompt", max_length=4_000)
    reply = _text(row.get("reply"), f"AgentVoiceLog/{row_id}.reply", max_length=100_000)
    columns = {
        "id": row_id,
        "user_id": user_id,
        "family_id": family_id,
        "baby_id": baby_id,
        "prompt": prompt,
        "reply": reply,
        "is_async": _boolean(row.get("isAsync"), f"AgentVoiceLog/{row_id}.isAsync"),
        "is_fast_path": _boolean(row.get("isFastPath"), f"AgentVoiceLog/{row_id}.isFastPath"),
        "acknowledged": _boolean(row.get("acknowledged"), f"AgentVoiceLog/{row_id}.acknowledged"),
        "created_at": created_at,
    }
    source_hash = _hash(row)
    target_hash = _hash(columns)
    return {
        "source_table": "AgentVoiceLog",
        "source_id": row_id,
        "source_hash": source_hash,
        "source_key": f"AgentVoiceLog:{row_id}",
        "target_entity_type": "voice_log",
        "target_table": "agent_voice_logs",
        "target_id": row_id,
        "columns": columns,
        "target_hash": target_hash,
        "metadata": {
            "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
            "sourceSnapshot": data.get("sourceSha256"),
            "sourceTable": "AgentVoiceLog",
            "sourceId": row_id,
            "sourceHash": source_hash,
            "mappingVersion": MAPPING_VERSION,
            "targetHashSha256": target_hash,
            "targetSnapshot": columns,
        },
    }


def prepare_materialization(data: dict[str, Any], checksum: str) -> list[dict[str, Any]]:
    _checksum(checksum)
    rows = _rows(data, "AgentVoiceLog")
    seen: set[str] = set()
    items: list[dict[str, Any]] = []
    for row in rows:
        row_id = _text(row.get("id"), "AgentVoiceLog.id")
        if row_id in seen:
            raise ValueError(f"Duplicate AgentVoiceLog id {row_id}")
        seen.add(row_id)
        items.append(_item(data, row))
    return items


def _target_insert(item: dict[str, Any]) -> str:
    columns = item["columns"]
    return (
        "INSERT INTO public.agent_voice_logs ("
        + ",".join(f'"{column}"' for column in columns)
        + ") VALUES ("
        + ",".join(literal(value) + ("::timestamptz" if column == "created_at" else "") for column, value in columns.items())
        + ");"
    )


def _target_matches(item: dict[str, Any], *, allow_runtime_acknowledgement: bool = False) -> str:
    columns = item["columns"]
    clauses = []
    for column, value in columns.items():
        if allow_runtime_acknowledgement and column == "acknowledged":
            continue
        sql_value = literal(value) + ("::timestamptz" if column == "created_at" else "")
        clauses.append(f'"{column}"={sql_value}')
    return " AND ".join(clauses)


def _render_item(item: dict[str, Any], checksum: str, source_system: str) -> str:
    source_key = literal(item["source_key"])
    source_hash = literal(item["source_hash"])
    target_type = literal(item["target_entity_type"])
    target_id = literal(item["target_id"])
    metadata = literal(_canonical_json(item["metadata"])) + "::jsonb"
    mapping_id = literal("legacy_voice_log_" + hashlib.sha256(item["source_key"].encode()).hexdigest()[:32])
    target_match = _target_matches(item)
    replay_target_match = _target_matches(item, allow_runtime_acknowledgement=True)
    return f"""
IF NOT EXISTS (SELECT 1 FROM legacy_import.import_rows r
  WHERE r.batch_id={literal(checksum)} AND r.source_table='AgentVoiceLog'
    AND r.source_id={literal(item['source_id'])} AND r.payload_hash={source_hash}) THEN
  RAISE EXCEPTION 'Voice history source row hash mismatch: %', {source_key};
END IF;
IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
  WHERE m.target_entity_type={target_type} AND m.source_key={source_key}) THEN
  IF NOT EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
    WHERE m.target_entity_type={target_type} AND m.source_key={source_key}
      AND m.target_entity_id={target_id} AND m.source_hash={source_hash}
      AND m.mapping_version={literal(MAPPING_VERSION)}
      AND m.metadata->>'targetHashSha256'={literal(item['target_hash'])}) THEN
    RAISE EXCEPTION 'Voice history source conflicts with immutable receipt: %', {source_key};
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.agent_voice_logs t
    WHERE t.id={target_id} AND {replay_target_match}) THEN
    RAISE EXCEPTION 'Voice history target conflicts with immutable receipt: %', {target_id};
  END IF;
ELSE
  IF EXISTS (SELECT 1 FROM public.agent_voice_logs t WHERE t.id={target_id}) THEN
    IF NOT EXISTS (SELECT 1 FROM public.agent_voice_logs t WHERE t.id={target_id} AND {target_match}) THEN
      RAISE EXCEPTION 'Voice history target row conflicts with immutable snapshot: %', {target_id};
    END IF;
  ELSE
    {_target_insert(item)}
  END IF;
  INSERT INTO public.legacy_idempotency_mappings
    (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,source_hash,mapping_version,metadata,created_at)
  VALUES ({mapping_id},{target_type},{target_id},{source_key},'mapped',{literal(source_system)},{literal(checksum)},'AgentVoiceLog',{literal(item['source_id'])},{source_hash},{literal(MAPPING_VERSION)},{metadata},CURRENT_TIMESTAMP);
END IF;
""".strip()


def render_materialization(data: dict[str, Any], checksum: str) -> str:
    _checksum(checksum)
    items = prepare_materialization(data, checksum)
    source_system = str(data.get("sourceId") or SOURCE_SYSTEM_DEFAULT)
    body = "\n".join(_render_item(item, checksum, source_system) for item in items)
    delimiter = f"$voice_{checksum}$"
    if delimiter in body:
        raise ValueError("SQL delimiter collision")
    return f"""BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});
DO {delimiter}
BEGIN
IF NOT EXISTS (SELECT 1 FROM legacy_import.import_batches WHERE batch_id={literal(checksum)} AND checksum={literal(checksum)}) THEN
  RAISE EXCEPTION 'Voice history import batch is missing: %', {literal(checksum)};
END IF;
{body}
END;
{delimiter};
COMMIT;
SELECT json_build_object(
  'status','materialized',
  'voiceLogs',(SELECT count(*) FROM public.agent_voice_logs WHERE id IN (SELECT target_entity_id FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='voice_log')),
  'receipts',(SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='voice_log'),
  'batchId',{literal(checksum)}
);
"""


def quarantine_report(data: dict[str, Any], checksum: str) -> dict[str, Any]:
    _checksum(checksum)
    rows = _rows(data, "AgentVoiceLog")
    return {
        "status": "ready" if rows else "empty",
        "mappingVersion": MAPPING_VERSION,
        "sourceBatchId": checksum,
        "voiceLogCount": len(rows),
        "quarantine": [],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        load_path = Path(__file__).with_name("import_sql.py")
        spec = importlib.util.spec_from_file_location("legacy_import_sql_voice_cli", load_path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load import_sql.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        data, archive_checksum = module.load_archive(args.archive)
        if archive_checksum != args.sha256:
            raise ValueError("Archive checksum mismatch")
        sql = render_materialization(data, archive_checksum)
        fd = __import__("os").open(args.output, __import__("os").O_WRONLY | __import__("os").O_CREAT | __import__("os").O_EXCL, 0o600)
        with __import__("os").fdopen(fd, "w") as output:
            output.write(sql)
        print(json.dumps({"status": "prepared", "voiceLogCount": len(_rows(data, "AgentVoiceLog"))}))
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
