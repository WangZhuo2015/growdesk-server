"""Promote legacy ``MedicalReport`` rows into the canonical medical tables.

This module deliberately has no database or object-storage client.  It validates
an immutable identity-v1 archive and renders one PostgreSQL transaction.  The
transaction can be passed to ``psql`` by an import owner after the identity/raw
archive import has completed.

The legacy table does not have a required caregiver, while the canonical table
does.  A recordedById that belongs to the baby family is preserved.  For a
legacy NULL recordedById, the lowest user-id active family administrator from
the same archive is selected deterministically and the choice is recorded in
the promotion receipt.  Image URLs are never made public and are not guessed
into ``medical_report_attachments``: they are retained as an unresolved
reference in the receipt until the separate attachment promotion has verified
the object hash, size, MIME and ownership.

Any invalid row fails before SQL is written.  Any target-side error aborts the
whole transaction, so a later bad row cannot leave an earlier report promoted.
Repeated execution is a no-op only when the source hash, mapping receipt,
target report and timeline projection all still match.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import os
import re
import uuid
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


MEDICAL_TABLE = "MedicalReport"
MAPPING_VERSION = "medical-v1"
SOURCE_SYSTEM_DEFAULT = "legacy_web"
ADVISORY_LOCK = 724019235
ALLOWED_ITEM_STATUSES = {"normal", "high", "low", "abnormal", "positive", "negative"}
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _import_identity_loader():
    try:
        from import_sql import load_archive, literal  # type: ignore

        return load_archive, literal
    except ModuleNotFoundError:
        path = Path(__file__).with_name("import_sql.py")
        spec = importlib.util.spec_from_file_location("legacy_import_sql_for_medical", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load import_sql.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.load_archive, module.literal


load_archive, literal = _import_identity_loader()


def _require_checksum(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Archive checksum must be a lowercase SHA-256")
    return value


def _text(value: Any, label: str, *, max_length: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"{label} exceeds {max_length} characters")
    return value


def _optional_text(value: Any, label: str, *, max_length: int | None = None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string or null")
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"{label} exceeds {max_length} characters")
    return value


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
            except Exception as error:  # pragma: no cover - archive loader pins timezone
                raise ValueError(f"Unsupported archive timezone {timezone_name}") from error
    else:
        raise ValueError(f"{label} must be a timestamp")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _date(value: Any, label: str) -> str:
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise ValueError(f"{label} must be an ISO date YYYY-MM-DD")
    try:
        return dt.date.fromisoformat(value).isoformat()
    except ValueError as error:
        raise ValueError(f"{label} is not a valid calendar date") from error


def _canonical_hash(row: dict[str, Any]) -> str:
    payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _medical_item_id(report_id: str, index: int) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk/legacy-medical-item/{report_id}/{index}"))


def _parse_items(raw: Any, report_id: str) -> tuple[list[dict[str, Any]], list[str]]:
    """Parse items without discarding unknown legacy keys.

    The canonical JSONB column is intentionally allowed to retain additional
    legacy item fields.  We validate the fields needed for a usable report,
    reject malformed clinical values, and generate only missing item IDs.  A
    generated ID is reported so a reviewer can distinguish it from source data.
    """

    if raw is None or raw == "":
        return [], []
    if not isinstance(raw, str):
        raise ValueError(f"MedicalReport/{report_id}.itemsJson must be JSON text")
    try:
        decoded = json.loads(raw)
    except json.JSONDecodeError as error:
        raise ValueError(f"MedicalReport/{report_id}.itemsJson is invalid JSON") from error
    if not isinstance(decoded, list):
        raise ValueError(f"MedicalReport/{report_id}.itemsJson must contain an array")
    output: list[dict[str, Any]] = []
    normalizations: list[str] = []
    for index, raw_item in enumerate(decoded):
        if not isinstance(raw_item, dict):
            raise ValueError(f"MedicalReport/{report_id}.items[{index}] must be an object")
        item = dict(raw_item)
        item_id = item.get("id")
        if item_id is None or item_id == "":
            item["id"] = _medical_item_id(report_id, index)
            normalizations.append(f"items[{index}].id generated deterministically")
        elif not isinstance(item_id, str):
            raise ValueError(f"MedicalReport/{report_id}.items[{index}].id must be a string")
        name = item.get("name")
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            raise ValueError(f"MedicalReport/{report_id}.items[{index}].name is invalid")
        if "value" not in item or item["value"] is None or isinstance(item["value"], bool):
            raise ValueError(f"MedicalReport/{report_id}.items[{index}].value is invalid")
        if not isinstance(item["value"], (str, int, float)):
            raise ValueError(f"MedicalReport/{report_id}.items[{index}].value is invalid")
        if isinstance(item["value"], float) and not math.isfinite(item["value"]):
            raise ValueError(f"MedicalReport/{report_id}.items[{index}].value is invalid")
        if isinstance(item["value"], str) and not item["value"].strip():
            raise ValueError(f"MedicalReport/{report_id}.items[{index}].value is empty")
        for field, max_length in (("unit", 100), ("referenceRange", 500), ("interpretation", 2000)):
            value = item.get(field)
            if value is not None and (not isinstance(value, str) or len(value) > max_length):
                raise ValueError(f"MedicalReport/{report_id}.items[{index}].{field} is invalid")
        status = item.get("status")
        if status is not None and status not in ALLOWED_ITEM_STATUSES:
            raise ValueError(f"MedicalReport/{report_id}.items[{index}].status is invalid")
        output.append(item)
    return output, normalizations


def _identity_context(data: dict[str, Any], row: dict[str, Any]) -> tuple[str, str, str, str | None, str | None]:
    tables = data["tables"]
    babies = {item["id"]: item for item in tables["Baby"]}
    users = {item["id"]: item for item in tables["User"]}
    families = {item["id"]: item for item in tables["Family"]}
    members = [item for item in tables["FamilyMember"] if isinstance(item, dict)]
    member_by_pair = {(item.get("familyId"), item.get("userId")): item for item in members}

    report_id = _text(row.get("id"), "MedicalReport.id")
    baby_id = _text(row.get("babyId"), f"MedicalReport/{report_id}.babyId")
    baby = babies.get(baby_id)
    if baby is None:
        raise ValueError(f"MedicalReport/{report_id}: baby is not in identity archive")
    family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
    if family_id not in families:
        raise ValueError(f"MedicalReport/{report_id}: baby family is not in identity archive")
    explicit_family = row.get("familyId")
    if explicit_family is not None and explicit_family != family_id:
        raise ValueError(f"MedicalReport/{report_id}: explicit familyId crosses baby family")

    raw_recorded_by = row.get("recordedById")
    recorded_by = _optional_text(raw_recorded_by, f"MedicalReport/{report_id}.recordedById")
    fallback = None
    if recorded_by is not None:
        if recorded_by not in users:
            raise ValueError(f"MedicalReport/{report_id}: recordedById is not an archived user")
        member = member_by_pair.get((family_id, recorded_by))
        if member is None or member.get("status", "active") != "active":
            raise ValueError(f"MedicalReport/{report_id}: recordedById is outside the baby family")
        caregiver_id = recorded_by
    else:
        admins = [
            member
            for member in members
            if member.get("familyId") == family_id
            and member.get("role") == "admin"
            and member.get("status", "active") == "active"
            and member.get("userId") in users
        ]
        if not admins:
            raise ValueError(f"MedicalReport/{report_id}: no active family administrator for caregiver fallback")
        admins.sort(key=lambda member: (str(member.get("userId")), str(member.get("id"))))
        caregiver_id = _text(admins[0].get("userId"), f"MedicalReport/{report_id}.fallbackCaregiverId")
        fallback = "family_admin_lowest_user_id"
    return family_id, baby_id, caregiver_id, recorded_by, fallback


def _metadata(data: dict[str, Any], row: dict[str, Any], *, source_hash: str, caregiver_id: str, recorded_by: str | None, fallback: str | None, normalizations: list[str], unresolved: list[dict[str, str]]) -> dict[str, Any]:
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceBatchId": data.get("sourceSha256"),
        "sourceTable": MEDICAL_TABLE,
        "sourceId": row["id"],
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "legacyRecordedById": recorded_by,
        "caregiverId": caregiver_id,
        "caregiverFallback": fallback,
        "legacyCategory": row.get("category"),
        "legacyImageUrl": row.get("imageUrl"),
        "normalizations": normalizations,
        "unresolvedReferences": unresolved,
    }


def _target_snapshot(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "familyId": item["family_id"],
        "babyId": item["baby_id"],
        "caregiverId": item["caregiver_id"],
        "reportDate": item["report_date"],
        "title": item["title"],
        "hospital": item["hospital"],
        "department": item["department"],
        "diagnosis": item["diagnosis"],
        "items": item["items"],
        "notes": item["notes"],
        "version": 1,
        "deletedAt": None,
        "createdAt": item["created_at"],
        "updatedAt": item["updated_at"],
    }


def _receipt_metadata(item: dict[str, Any]) -> dict[str, Any]:
    snapshot = _target_snapshot(item)
    return {
        "source": item["metadata"],
        "targetSnapshot": snapshot,
        "sourceHashSha256": item["source_hash"],
        "targetHashSha256": hashlib.sha256(_json(snapshot).encode("utf-8")).hexdigest(),
        "unresolvedReferences": item["unresolved_references"],
    }


def prepare_reports(data: dict[str, Any], checksum: str) -> list[dict[str, Any]]:
    """Validate and map all MedicalReport rows before SQL rendering."""

    _require_checksum(checksum)
    tables = data.get("tables")
    if not isinstance(tables, dict):
        raise ValueError("Archive tables must be an object")
    for identity_table in ("User", "Family", "FamilyMember", "Baby"):
        rows = tables.get(identity_table)
        if not isinstance(rows, list):
            raise ValueError(f"{identity_table} must be an array")
    rows = tables.get(MEDICAL_TABLE, [])
    if not isinstance(rows, list):
        raise ValueError("MedicalReport must be an array")

    mapped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("MedicalReport row must be an object")
        report_id = _text(row.get("id"), "MedicalReport.id")
        if report_id in seen_ids:
            raise ValueError(f"Duplicate MedicalReport ID {report_id}")
        seen_ids.add(report_id)
        family_id, baby_id, caregiver_id, recorded_by, fallback = _identity_context(data, row)
        report_date = _date(row.get("date"), f"MedicalReport/{report_id}.date")
        title = _text(row.get("title"), f"MedicalReport/{report_id}.title", max_length=100)
        category = _text(row.get("category"), f"MedicalReport/{report_id}.category", max_length=100)
        hospital = _optional_text(row.get("hospital"), f"MedicalReport/{report_id}.hospital", max_length=100)
        diagnosis = _optional_text(row.get("doctorNotes"), f"MedicalReport/{report_id}.doctorNotes", max_length=500)
        notes = _optional_text(row.get("aiSummary"), f"MedicalReport/{report_id}.aiSummary", max_length=2000)
        items, normalizations = _parse_items(row.get("itemsJson"), report_id)
        image_url = _optional_text(row.get("imageUrl"), f"MedicalReport/{report_id}.imageUrl")
        raw_source = row.get("source")
        if raw_source is not None and not isinstance(raw_source, str):
            raise ValueError(f"MedicalReport/{report_id}.source must be a string or null")
        unresolved: list[dict[str, str]] = []
        if image_url:
            unresolved.append({"field": "imageUrl", "value": image_url, "reason": "attachment promotion required"})
        created_at = _instant(row.get("createdAt", data.get("capturedAt")), f"MedicalReport/{report_id}.createdAt", data["timeZone"])
        updated_at = _instant(row.get("updatedAt", row.get("createdAt", data.get("capturedAt"))), f"MedicalReport/{report_id}.updatedAt", data["timeZone"])
        source_hash = _canonical_hash(row)
        item: dict[str, Any] = {
            "table": MEDICAL_TABLE,
            "entity_type": "medical",
            "id": report_id,
            "family_id": family_id,
            "baby_id": baby_id,
            "caregiver_id": caregiver_id,
            "recorded_by": recorded_by,
            "caregiver_fallback": fallback,
            "report_date": report_date,
            "title": title,
            "hospital": hospital,
            "department": category,
            "diagnosis": diagnosis,
            "items": items,
            "items_json": _json(items),
            "notes": notes,
            "created_at": created_at,
            "updated_at": updated_at,
            "source": raw_source or "ui_manual",
            "source_hash": source_hash,
            "unresolved_references": unresolved,
        }
        item["metadata"] = _metadata(
            data,
            row,
            source_hash=source_hash,
            caregiver_id=caregiver_id,
            recorded_by=recorded_by,
            fallback=fallback,
            normalizations=normalizations,
            unresolved=unresolved,
        )
        item["receipt_metadata"] = _receipt_metadata(item)
        item["mapping_status"] = "mapped_with_unresolved_attachment" if unresolved else "mapped"
        mapped.append(item)
    return mapped


def _mapping_id(item: dict[str, Any], checksum: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk/legacy-promotion/{checksum}/{MEDICAL_TABLE}/{item['id']}"))


def _timeline_id(item: dict[str, Any]) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk/legacy-timeline/medical/{item['id']}"))


def _same(column: str, value: Any, alias: str = "t") -> str:
    return f"{alias}.{column} IS NOT DISTINCT FROM {literal(value)}"


def _jsonb_same(column: str, value: Any, alias: str = "t") -> str:
    return f"{alias}.{column} IS NOT DISTINCT FROM {literal(_json(value))}::jsonb"


def _replay_target_predicate(item: dict[str, Any]) -> str:
    return " AND ".join([
        _same("id", item["id"]),
        _same("family_id", item["family_id"]),
        _same("baby_id", item["baby_id"]),
        _same("caregiver_id", item["caregiver_id"]),
        _same("report_date", item["report_date"]),
        _same("title", item["title"]),
        _same("hospital", item["hospital"]),
        _same("department", item["department"]),
        _same("diagnosis", item["diagnosis"]),
        _jsonb_same("items", item["items"]),
        _same("notes", item["notes"]),
        _same("version", 1),
        "t.deleted_at IS NULL",
        _same("created_at", item["created_at"]),
        _same("updated_at", item["updated_at"]),
    ])


def _replay_timeline_predicate(item: dict[str, Any]) -> str:
    details = {
        "hospital": item["hospital"],
        "department": item["department"],
        "diagnosis": item["diagnosis"],
    }
    return " AND ".join([
        _same("family_id", item["family_id"], "e"),
        _same("baby_id", item["baby_id"], "e"),
        _same("entity_type", "medical", "e"),
        _same("entity_id", item["id"], "e"),
        _same("occurred_at", f"{item['report_date']}T00:00:00.000Z", "e"),
        _same("summary", f"医疗就诊/检查: {item['title']}", "e"),
        _jsonb_same("details", details, "e"),
        _same("source", item["source"], "e"),
        _same("version", 1, "e"),
        "e.deleted_at IS NULL",
        _same("created_at", item["created_at"], "e"),
        _same("updated_at", item["updated_at"], "e"),
    ])


def _medical_sql(item: dict[str, Any], checksum: str, delimiter: str, source_system: str) -> str:
    source_key = f"{checksum}/{MEDICAL_TABLE}/{item['id']}"
    mapping_id = _mapping_id(item, checksum)
    raw_hash = item["source_hash"]
    receipt_metadata_sql = literal(_json(item["receipt_metadata"]))
    target_values = [
        literal(item["id"]), literal(item["family_id"]), literal(item["baby_id"]), literal(item["caregiver_id"]),
        literal(item["report_date"]), literal(item["title"]), literal(item["hospital"]), literal(item["department"]),
        literal(item["diagnosis"]), literal(item["items_json"]) + "::jsonb", literal(item["notes"]),
        "1", "NULL", literal(item["created_at"]), literal(item["updated_at"]),
    ]
    details = {"hospital": item["hospital"], "department": item["department"], "diagnosis": item["diagnosis"]}
    common_guard = f"""
  IF NOT EXISTS (
    SELECT 1 FROM legacy_import.import_rows
    WHERE batch_id={literal(checksum)} AND source_table={literal(MEDICAL_TABLE)}
      AND source_id={literal(item['id'])} AND payload_hash={literal(raw_hash)}
  ) THEN
    RAISE EXCEPTION 'Legacy medical source row hash mismatch or missing: %', {literal(source_key)};
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.babies
    WHERE id={literal(item['baby_id'])} AND family_id={literal(item['family_id'])} AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy medical row is outside its canonical baby family: %', {literal(source_key)};
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.family_members fm
    JOIN public.users u ON u.id=fm.user_id
    WHERE fm.family_id={literal(item['family_id'])} AND fm.user_id={literal(item['caregiver_id'])}
      AND fm.status='active' AND fm.deleted_at IS NULL AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy medical caregiver is not an active family member: %', {literal(source_key)};
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.baby_members bm
    JOIN public.users u ON u.id=bm.user_id
    WHERE bm.family_id={literal(item['family_id'])} AND bm.baby_id={literal(item['baby_id'])}
      AND bm.user_id={literal(item['caregiver_id'])} AND bm.status='active'
      AND bm.deleted_at IS NULL AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy medical caregiver is not assigned to the target baby: %', {literal(source_key)};
  END IF;
"""
    replay_target = _replay_target_predicate(item)
    replay_timeline = _replay_timeline_predicate(item)
    timeline_id = _timeline_id(item)
    status = item["mapping_status"]
    return f"""DO {delimiter}
BEGIN
{common_guard}
  IF EXISTS (
    SELECT 1 FROM public.legacy_idempotency_mappings
    WHERE target_entity_type='medical' AND source_key={literal(source_key)}
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.legacy_idempotency_mappings
      WHERE target_entity_type='medical' AND source_key={literal(source_key)}
        AND target_entity_id={literal(item['id'])}
        AND status={literal(status)}
        AND source_hash={literal(raw_hash)}
        AND mapping_version={literal(MAPPING_VERSION)}
        AND metadata={receipt_metadata_sql}::jsonb
        AND EXISTS (SELECT 1 FROM public.medical_reports t WHERE {replay_target})
        AND EXISTS (SELECT 1 FROM public.timeline_entries e WHERE {replay_timeline})
    ) THEN
      RAISE EXCEPTION 'Legacy medical receipt conflict or missing target: %', {literal(source_key)};
    END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.medical_reports WHERE id={literal(item['id'])}) THEN
    RAISE EXCEPTION 'Medical target ID already exists without matching legacy receipt: %', {literal(item['id'])};
  END IF;
  INSERT INTO public.medical_reports
    (id,family_id,baby_id,caregiver_id,report_date,title,hospital,department,diagnosis,items,notes,version,deleted_at,created_at,updated_at)
  VALUES ({','.join(target_values)});
  INSERT INTO public.timeline_entries
    (id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,source,version,deleted_at,created_at,updated_at)
  VALUES
    ({literal(timeline_id)},{literal(item['family_id'])},{literal(item['baby_id'])},'medical',{literal(item['id'])},
     {literal(f"{item['report_date']}T00:00:00.000Z")},{literal(f"医疗就诊/检查: {item['title']}")},{literal(_json(details))}::jsonb,
     {literal(item['source'])},1,NULL,{literal(item['created_at'])},{literal(item['updated_at'])});
  INSERT INTO public.legacy_idempotency_mappings
    (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,
     source_hash,mapping_version,metadata,created_at)
  VALUES
    ({literal(mapping_id)},'medical',{literal(item['id'])},{literal(source_key)},{literal(status)},
     {literal(source_system)},{literal(checksum)},{literal(MEDICAL_TABLE)},{literal(item['id'])},
     {literal(raw_hash)},{literal(MAPPING_VERSION)},{receipt_metadata_sql}::jsonb,{literal(item['created_at'])});
END;
{delimiter};
"""


def render_materialization(data: dict[str, Any], checksum: str) -> str:
    """Render one atomic, count-guarded, replay-safe medical promotion."""

    checksum = _require_checksum(checksum)
    if data.get("formatVersion") != 1 or data.get("timeZone") != "Asia/Shanghai":
        raise ValueError("Unsupported archive")
    source_system = data.get("sourceId") or SOURCE_SYSTEM_DEFAULT
    if not isinstance(source_system, str) or not source_system:
        raise ValueError("Archive sourceId must be a non-empty string")
    items = prepare_reports(data, checksum)
    delimiter = f"$medical_{checksum[:24]}$"
    if delimiter in _json(data):
        raise ValueError("SQL delimiter collision")
    statements = "\n".join(_medical_sql(item, checksum, delimiter, source_system) for item in items)
    expected_count = len(items)
    return f"""BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});
DO {delimiter}
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM legacy_import.import_batches
    WHERE batch_id={literal(checksum)} AND checksum={literal(checksum)} AND mapping_version='identity-v1'
  ) THEN
    RAISE EXCEPTION 'Identity-v1 batch is not present or has a mismatched checksum: %', {literal(checksum)};
  END IF;
  IF (SELECT count(*) FROM legacy_import.import_rows
      WHERE batch_id={literal(checksum)} AND source_table={literal(MEDICAL_TABLE)}) <> {expected_count} THEN
    RAISE EXCEPTION 'Legacy medical source count mismatch for batch %', {literal(checksum)};
  END IF;
END;
{delimiter};
{statements}
COMMIT;
SELECT json_build_object(
  'sourceCount',{expected_count},
  'targetCount',(SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='medical'),
  'timelineCount',(SELECT count(*) FROM public.timeline_entries WHERE entity_type='medical' AND entity_id IN (SELECT target_entity_id FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='medical')),
  'unresolvedAttachmentCount',(SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='medical' AND status='mapped_with_unresolved_attachment'),
  'batchId',{literal(checksum)},
  'mappingVersion',{literal(MAPPING_VERSION)}
);
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    try:
        data, actual_checksum = load_archive(args.archive)
        expected_checksum = _require_checksum(args.sha256)
        if actual_checksum != expected_checksum:
            raise ValueError("Archive checksum mismatch")
        sql = render_materialization(data, actual_checksum)
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(sql)
        print(json.dumps({
            "status": "prepared",
            "mappingVersion": MAPPING_VERSION,
            "rows": {MEDICAL_TABLE: len(data["tables"].get(MEDICAL_TABLE, []))},
        }))
        return 0
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
