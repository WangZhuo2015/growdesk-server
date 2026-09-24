"""Promote legacy identity-v1 care rows into the canonical care tables.

The script intentionally has no database connection.  It validates a private
archive and renders one transaction which an import owner can pass to psql.
The archive is still the source of truth for the raw payload; the target tables
receive typed fields plus a small auditable metadata projection.

FeedingRecord, SleepRecord, DiaperRecord, GrowthMeasurement, and FormulaProduct
are handled here.
Formula products are promoted before feeding rows in the same transaction so a
feeding reference is never temporarily or silently detached. Other legacy
record types remain archived and are not promoted by this bounded slice; its
success is not an all-business migration completion signal.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import uuid
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo


CARE_TABLES = ("FeedingRecord", "SleepRecord", "DiaperRecord", "GrowthMeasurement")
MAPPING_VERSION = "care-v1"
FORMULA_MAPPING_VERSION = "formula-v1"
SOURCE_SYSTEM_DEFAULT = "legacy_web"
ADVISORY_LOCK = 724019232

FEEDING_TYPES = {
    "breast": "breast",
    "formula": "formula",
    # The current GrowDesk API contract exposes this legacy mixed bottle kind
    # as canonical `bottle`; `bottle_breast_milk` is no longer a readable API
    # value and would be projected as formula by the Web adapter.
    "bottle_breast": "bottle",
    "mixed": "mixed",
}
SLEEP_TYPES = {"day": "nap", "nap": "nap", "night": "night"}
DIAPER_TYPES = {"pee": "pee", "poop": "poop", "both": "both"}

_SENSITIVE_KEY = re.compile(
    r"(?:password|passwd|token|secret|credential|authorization|cookie|refresh|access)[_-]?",
    re.IGNORECASE,
)


def _import_identity_loader():
    """Load import_sql without making this directory a Python package."""

    try:
        from import_sql import load_archive, literal  # type: ignore

        return load_archive, literal
    except ModuleNotFoundError:
        path = Path(__file__).with_name("import_sql.py")
        spec = importlib.util.spec_from_file_location("legacy_import_sql", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load import_sql.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.load_archive, module.literal


load_archive, literal = _import_identity_loader()


def _import_formula_mapper():
    """Load the pure formula mapper without making this directory a package."""

    try:
        from formula_mapper import map_formula_product  # type: ignore

        return map_formula_product
    except ModuleNotFoundError:
        path = Path(__file__).with_name("formula_mapper.py")
        spec = importlib.util.spec_from_file_location("legacy_formula_mapper", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load formula_mapper.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.map_formula_product


map_formula_product = _import_formula_mapper()


def _import_growth_mapper():
    """Load the pure growth mapper without making this directory a package."""

    try:
        from growth_mapper import map_growth_measurement  # type: ignore

        return map_growth_measurement
    except ModuleNotFoundError:
        path = Path(__file__).with_name("growth_mapper.py")
        spec = importlib.util.spec_from_file_location("legacy_growth_mapper", path)
        if spec is None or spec.loader is None:
            raise RuntimeError("Unable to load growth_mapper.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.map_growth_measurement


map_growth_measurement = _import_growth_mapper()


def _require_checksum(value: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise ValueError("Archive checksum must be a lowercase SHA-256")
    return value


def _text(value: Any, label: str, *, allow_none: bool = False) -> str | None:
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not value:
        raise ValueError(f"{label} must be a non-empty string")
    return value


def _optional_text(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string or null")
    return value


def _nonnegative_int(value: Any, label: str, *, default: int | None = None) -> int | None:
    if value is None:
        return default
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{label} must be a non-negative integer")
    return value


def _boolean(value: Any, label: str) -> bool:
    """Accept JSON booleans and SQLite's exact INTEGER 0/1 representation."""

    if isinstance(value, bool):
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    raise ValueError(f"{label} must be boolean or SQLite integer 0/1")


def _decimal(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"{label} must be a finite number or null")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError(f"{label} must be a finite number or null") from error
    if not parsed.is_finite() or parsed < 0:
        raise ValueError(f"{label} must be a finite non-negative number")
    return format(parsed, "f")


def _instant(value: Any, label: str, timezone_name: str) -> str:
    """Normalize ISO/epoch legacy values, making naive values explicit."""

    if isinstance(value, bool) or value is None:
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
            except Exception as error:  # pragma: no cover - loader pins timezone
                raise ValueError(f"Unsupported archive timezone {timezone_name}") from error
    else:
        raise ValueError(f"{label} must be a timestamp")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _canonical_hash(row: dict[str, Any]) -> str:
    payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _redact(value: Any, key: str | None = None) -> Any:
    if key is not None and _SENSITIVE_KEY.search(key):
        return "[redacted]"
    if isinstance(value, dict):
        return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _metadata(
    *,
    data: dict[str, Any],
    table: str,
    row: dict[str, Any],
    source_hash: str,
    actor_id: str | None,
    client_id: str | None,
    mapped_keys: Iterable[str],
) -> dict[str, Any]:
    mapped = set(mapped_keys)
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceBatchId": data.get("sourceSha256"),
        "sourceTable": table,
        "sourceId": row["id"],
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "legacyClientId": client_id,
        "legacyRecordedById": actor_id,
        "legacyFamilyId": row.get("familyId"),
        "legacyBabyId": row.get("babyId"),
        "legacyType": row.get("type"),
        "legacyTimeValues": {
            key: row[key] for key in ("timestamp", "startTime", "endTime") if key in row
        },
        "legacyCreatedAt": row.get("createdAt"),
        "legacyUpdatedAt": row.get("updatedAt"),
        "extra": _redact({key: value for key, value in row.items() if key not in mapped}),
    }


def _target_snapshot(item: dict[str, Any]) -> dict[str, Any]:
    """Return the exact canonical values written by the promotion SQL."""

    common = {
        "id": item["id"],
        "familyId": item["family_id"],
        "babyId": item["baby_id"],
        "source": item["source"],
        "sourceAgent": item["source_agent"],
        "recordedByUserId": item["actor_id"],
        "version": 1,
        "deletedAt": None,
        "createdAt": item["created_at"],
        "updatedAt": item["updated_at"],
        "legacyClientId": item["client_id"],
    }
    if item["entity_type"] == "feeding":
        common.update(
            {
                "feedingType": item["feeding_type"],
                "occurredAt": item["occurred_at"],
                "amountMl": item["amount_ml"],
                "leftMinutes": item["left_minutes"],
                "rightMinutes": item["right_minutes"],
                "durationMinutes": item["duration_minutes"],
                "spitUp": item["spit_up"],
                "formulaProductId": item["formula_product_id"],
                "notes": item["notes"],
            }
        )
    elif item["entity_type"] == "sleep":
        common.update(
            {
                "sleepType": item["sleep_type"],
                "startedAt": item["started_at"],
                "endedAt": item["ended_at"],
                "nightWakingCount": item["night_waking_count"],
                "notes": item["notes"],
            }
        )
    elif item["entity_type"] == "growth":
        common = {
            "id": item["id"],
            "familyId": item["family_id"],
            "babyId": item["baby_id"],
            "measurementDate": item["measurement_date"],
            "weightKg": item["weight_kg"],
            "heightCm": item["height_cm"],
            "headCircumferenceCm": item["head_circumference_cm"],
            "attachmentId": None,
            "notes": item["notes"],
            "version": 1,
            "deletedAt": None,
            "createdAt": item["created_at"],
            "updatedAt": item["updated_at"],
            "legacyClientId": item["client_id"],
            "legacyMetadata": item["metadata"],
        }
    else:
        common.update(
            {
                "diaperType": item["diaper_type"],
                "occurredAt": item["occurred_at"],
                "poopColor": item["poop_color"],
                "poopConsistency": item["poop_consistency"],
                "notes": item["notes"],
            }
        )
    return common


def _receipt_metadata(item: dict[str, Any]) -> dict[str, Any]:
    snapshot = _target_snapshot(item)
    return {
        "source": item["metadata"],
        "targetSnapshot": snapshot,
        # md5 is only a compact tamper/replay fingerprint; sourceHash remains
        # the SHA-256 archive-row integrity value.
        "targetHashMd5": hashlib.md5(_json(snapshot).encode("utf-8")).hexdigest(),
    }


def _formula_metadata(
    *, data: dict[str, Any], row: dict[str, Any], source_hash: str, mapped_keys: Iterable[str]
) -> dict[str, Any]:
    mapped = set(mapped_keys)
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceBatchId": data.get("sourceSha256"),
        "sourceTable": "FormulaProduct",
        "sourceId": row["id"],
        "sourceHash": source_hash,
        "mappingVersion": FORMULA_MAPPING_VERSION,
        "legacyFamilyId": row.get("familyId"),
        "legacyCreatedAt": row.get("createdAt"),
        "legacyUpdatedAt": row.get("updatedAt"),
        "extra": _redact({key: value for key, value in row.items() if key not in mapped}),
    }


def _formula_target_snapshot(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "familyId": item["family_id"],
        "brand": item["brand"],
        "name": item["name"],
        "stage": item["stage"],
        "scoopWeightG": item["scoop_weight_g"],
        "waterPerScoopMl": item["water_per_scoop_ml"],
        "reconstitutionRatio": item["reconstitution_ratio"],
        "servingSizeUnit": item["serving_size_unit"],
        # Keep the mapper's original JSON text in the receipt. The SQL insert
        # casts this text directly to jsonb and never JSON-encodes it again.
        "nutrientsJson": item["nutrients_json"],
        "notes": item["notes"],
        "isActive": item["is_active"],
        "isDefault": item["is_default"],
        "isArchived": item["is_archived"],
        "version": item["version"],
        "deletedAt": item["deleted_at"],
        "createdAt": item["created_at"],
        "updatedAt": item["updated_at"],
    }


def _formula_receipt_metadata(item: dict[str, Any]) -> dict[str, Any]:
    snapshot = _formula_target_snapshot(item)
    return {
        "source": item["metadata"],
        "targetSnapshot": snapshot,
        "targetHashMd5": hashlib.md5(_json(snapshot).encode("utf-8")).hexdigest(),
    }


def prepare_formula_products(data: dict[str, Any], checksum: str) -> list[dict[str, Any]]:
    """Map FormulaProduct rows before care SQL is rendered."""

    _require_checksum(checksum)
    tables = data.get("tables")
    if not isinstance(tables, dict):
        raise ValueError("Archive tables must be an object")
    rows = tables.get("FormulaProduct", [])
    if not isinstance(rows, list):
        raise ValueError("FormulaProduct must be an array")
    family_rows = tables.get("Family")
    if not isinstance(family_rows, list):
        raise ValueError("Family must be an array")
    family_ids = {row.get("id") for row in family_rows if isinstance(row, dict)}
    if any(not isinstance(family_id, str) or not family_id for family_id in family_ids):
        raise ValueError("Family contains an invalid ID")
    mapped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    mapped_keys = {
        "id", "familyId", "brand", "name", "stage", "scoopWeightG", "waterPerScoopMl",
        "reconstitutionRatio", "servingSizeUnit", "nutrientsJson", "notes", "isActive", "isDefault",
        "createdAt", "updatedAt",
    }
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("FormulaProduct row must be an object")
        source_id = _text(row.get("id"), "FormulaProduct.id")
        assert source_id is not None
        if source_id in seen_ids:
            raise ValueError(f"Duplicate FormulaProduct ID {source_id}")
        seen_ids.add(source_id)
        values = map_formula_product(row, family_ids)
        item: dict[str, Any] = {
            "table": "FormulaProduct",
            "entity_type": "formula_product",
            "id": source_id,
            "family_id": values["family_id"],
            "source_hash": _canonical_hash(row),
            "source": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
            "values": values,
        }
        item["metadata"] = _formula_metadata(
            data=data, row=row, source_hash=item["source_hash"], mapped_keys=mapped_keys
        )
        item["metadata"]["sourceBatchId"] = checksum
        item.update(values)
        item["receipt_metadata"] = _formula_receipt_metadata(item)
        mapped.append(item)
    return mapped


def _identity_context(
    data: dict[str, Any], table: str, row: dict[str, Any]
) -> tuple[str, str, str | None, str | None]:
    tables = data["tables"]
    babies = {item["id"]: item for item in tables["Baby"]}
    users = {item["id"]: item for item in tables["User"]}
    families = {item["id"]: item for item in tables["Family"]}
    family_members = {
        (item["familyId"], item["userId"]): item
        for item in tables["FamilyMember"]
    }

    baby_id = _text(row.get("babyId"), f"{table}.babyId")
    assert baby_id is not None
    baby = babies.get(baby_id)
    if baby is None:
        raise ValueError(f"{table}/{row.get('id')}: baby is not in identity archive")
    family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
    assert family_id is not None
    if family_id not in families:
        raise ValueError(f"{table}/{row.get('id')}: baby family is not in identity archive")

    explicit_family = row.get("familyId")
    if explicit_family is not None and explicit_family != family_id:
        raise ValueError(f"{table}/{row.get('id')}: explicit familyId crosses baby family")

    actor_id = _optional_text(row.get("recordedById"), f"{table}.recordedById")
    if actor_id is not None:
        if actor_id not in users:
            raise ValueError(f"{table}/{row.get('id')}: recordedById is not an archived user")
        membership = family_members.get((family_id, actor_id))
        if membership is None or membership.get("status", "active") != "active":
            raise ValueError(f"{table}/{row.get('id')}: recordedById is outside the baby family")

    client_id = _optional_text(row.get("clientId"), f"{table}.clientId") or None
    return family_id, baby_id, actor_id, client_id


def _base_context(
    data: dict[str, Any], table: str, row: dict[str, Any]
) -> dict[str, Any]:
    if not isinstance(row, dict):
        raise ValueError(f"{table} row must be an object")
    row_id = _text(row.get("id"), f"{table}.id")
    assert row_id is not None
    family_id, baby_id, actor_id, client_id = _identity_context(data, table, row)
    source = row.get("source")
    if source is not None and not isinstance(source, str):
        raise ValueError(f"{table}/{row_id}.source must be a string or null")
    source_agent = _optional_text(row.get("sourceAgent"), f"{table}/{row_id}.sourceAgent")
    created_raw = row.get("createdAt", data.get("capturedAt"))
    updated_raw = row.get("updatedAt", created_raw)
    created_at = _instant(created_raw, f"{table}/{row_id}.createdAt", data["timeZone"])
    updated_at = _instant(updated_raw, f"{table}/{row_id}.updatedAt", data["timeZone"])
    source_hash = _canonical_hash(row)
    return {
        "table": table,
        "id": row_id,
        "family_id": family_id,
        "baby_id": baby_id,
        "actor_id": actor_id,
        "client_id": client_id,
        "source": SOURCE_SYSTEM_DEFAULT if source is None else source,
        "source_agent": source_agent,
        "created_at": created_at,
        "updated_at": updated_at,
        "source_hash": source_hash,
        "row": row,
    }


def _map_feeding(data: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    context = _base_context(data, "FeedingRecord", row)
    row_id = context["id"]
    legacy_type = _text(row.get("type"), f"FeedingRecord/{row_id}.type")
    assert legacy_type is not None
    if legacy_type not in FEEDING_TYPES:
        raise ValueError(f"FeedingRecord/{row_id}: unsupported type {legacy_type}")
    spit_up = _boolean(row.get("spitUp", False), f"FeedingRecord/{row_id}.spitUp")
    formula_id = _optional_text(row.get("formulaProductId"), f"FeedingRecord/{row_id}.formulaProductId")
    mapped_keys = {
        "id", "babyId", "familyId", "clientId", "recordedById", "source", "sourceAgent",
        "timestamp", "type", "amountMl", "leftMinutes", "rightMinutes", "durationMinutes",
        "spitUp", "formulaProductId", "notes", "createdAt", "updatedAt",
    }
    context.update(
        {
            "feeding_type": FEEDING_TYPES[legacy_type],
            "occurred_at": _instant(row.get("timestamp"), f"FeedingRecord/{row_id}.timestamp", data["timeZone"]),
            "amount_ml": _decimal(row.get("amountMl"), f"FeedingRecord/{row_id}.amountMl"),
            "left_minutes": _nonnegative_int(row.get("leftMinutes"), f"FeedingRecord/{row_id}.leftMinutes"),
            "right_minutes": _nonnegative_int(row.get("rightMinutes"), f"FeedingRecord/{row_id}.rightMinutes"),
            "duration_minutes": _nonnegative_int(row.get("durationMinutes"), f"FeedingRecord/{row_id}.durationMinutes"),
            "spit_up": "true" if spit_up else "false",
            "formula_product_id": formula_id,
            "notes": _optional_text(row.get("notes"), f"FeedingRecord/{row_id}.notes"),
        }
    )
    context["metadata"] = _metadata(
        data=data, table="FeedingRecord", row=row, source_hash=context["source_hash"],
        actor_id=context["actor_id"], client_id=context["client_id"], mapped_keys=mapped_keys,
    )
    context["entity_type"] = "feeding"
    context["summary"] = f"Legacy feeding: {legacy_type}"
    return context


def _map_sleep(data: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    context = _base_context(data, "SleepRecord", row)
    row_id = context["id"]
    legacy_type = _text(row.get("type"), f"SleepRecord/{row_id}.type")
    assert legacy_type is not None
    if legacy_type not in SLEEP_TYPES:
        raise ValueError(f"SleepRecord/{row_id}: unsupported type {legacy_type}")
    mapped_keys = {
        "id", "babyId", "familyId", "clientId", "recordedById", "source", "sourceAgent",
        "startTime", "endTime", "type", "nightWakingCount", "notes", "createdAt", "updatedAt",
    }
    ended_at = row.get("endTime")
    context.update(
        {
            "sleep_type": SLEEP_TYPES[legacy_type],
            "started_at": _instant(row.get("startTime"), f"SleepRecord/{row_id}.startTime", data["timeZone"]),
            "ended_at": None if ended_at is None else _instant(ended_at, f"SleepRecord/{row_id}.endTime", data["timeZone"]),
            "night_waking_count": _nonnegative_int(row.get("nightWakingCount"), f"SleepRecord/{row_id}.nightWakingCount", default=0),
            "notes": _optional_text(row.get("notes"), f"SleepRecord/{row_id}.notes"),
        }
    )
    if context["ended_at"] is not None and context["ended_at"] < context["started_at"]:
        raise ValueError(f"SleepRecord/{row_id}: endTime is before startTime")
    context["metadata"] = _metadata(
        data=data, table="SleepRecord", row=row, source_hash=context["source_hash"],
        actor_id=context["actor_id"], client_id=context["client_id"], mapped_keys=mapped_keys,
    )
    context["entity_type"] = "sleep"
    context["summary"] = f"Legacy sleep: {legacy_type}"
    return context


def _map_diaper(data: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    context = _base_context(data, "DiaperRecord", row)
    row_id = context["id"]
    legacy_type = _text(row.get("type"), f"DiaperRecord/{row_id}.type")
    assert legacy_type is not None
    if legacy_type not in DIAPER_TYPES:
        raise ValueError(f"DiaperRecord/{row_id}: unsupported type {legacy_type}")
    mapped_keys = {
        "id", "babyId", "familyId", "clientId", "recordedById", "source", "sourceAgent",
        "timestamp", "type", "poopColor", "poopConsistency", "notes", "createdAt", "updatedAt",
    }
    context.update(
        {
            "diaper_type": DIAPER_TYPES[legacy_type],
            "occurred_at": _instant(row.get("timestamp"), f"DiaperRecord/{row_id}.timestamp", data["timeZone"]),
            "poop_color": _optional_text(row.get("poopColor"), f"DiaperRecord/{row_id}.poopColor"),
            "poop_consistency": _optional_text(row.get("poopConsistency"), f"DiaperRecord/{row_id}.poopConsistency"),
            "notes": _optional_text(row.get("notes"), f"DiaperRecord/{row_id}.notes"),
        }
    )
    context["metadata"] = _metadata(
        data=data, table="DiaperRecord", row=row, source_hash=context["source_hash"],
        actor_id=context["actor_id"], client_id=context["client_id"], mapped_keys=mapped_keys,
    )
    context["entity_type"] = "diaper"
    context["summary"] = f"Legacy diaper: {legacy_type}"
    return context


def _map_growth(data: dict[str, Any], row: dict[str, Any], checksum: str) -> dict[str, Any]:
    """Delegate GrowthMeasurement validation to the independent pure mapper."""

    return map_growth_measurement(data, row, checksum)


def prepare_records(data: dict[str, Any], checksum: str) -> list[dict[str, Any]]:
    """Validate and map all supported rows before any SQL is rendered."""

    _require_checksum(checksum)
    tables = data.get("tables")
    if not isinstance(tables, dict):
        raise ValueError("Archive tables must be an object")
    for identity_table in ("User", "Family", "FamilyMember", "Baby"):
        rows = tables.get(identity_table)
        if not isinstance(rows, list):
            raise ValueError(f"{identity_table} must be an array")
        ids = [row.get("id") for row in rows if isinstance(row, dict)]
        if len(ids) != len(set(ids)) or any(not isinstance(row_id, str) or not row_id for row_id in ids):
            raise ValueError(f"Duplicate or invalid identity IDs in {identity_table}")
    mapped: list[dict[str, Any]] = []
    seen_source_keys: set[str] = set()
    seen_client_ids: set[tuple[str, str, str]] = set()
    mappers = {
        "FeedingRecord": _map_feeding,
        "SleepRecord": _map_sleep,
        "DiaperRecord": _map_diaper,
    }
    for table in CARE_TABLES:
        rows = tables.get(table, [])
        if not isinstance(rows, list):
            raise ValueError(f"{table} must be an array")
        for row in rows:
            if table == "GrowthMeasurement":
                item = _map_growth(data, row, checksum)
            else:
                item = mappers[table](data, row)
            source_key = f"{checksum}/{table}/{item['id']}"
            if source_key in seen_source_keys:
                raise ValueError(f"Duplicate source key {source_key}")
            seen_source_keys.add(source_key)
            client_id = item["client_id"]
            if client_id is not None:
                client_key = (item["entity_type"], item["baby_id"], client_id)
                if client_key in seen_client_ids:
                    raise ValueError(f"Duplicate clientId for {table}/{item['baby_id']}")
                seen_client_ids.add(client_key)
            item["metadata"]["sourceBatchId"] = checksum
            item["receipt_metadata"] = _receipt_metadata(item)
            mapped.append(item)
    return mapped


def _timeline_id(item: dict[str, Any]) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk/legacy-timeline/{item['entity_type']}/{item['id']}"))


def _mapping_id(item: dict[str, Any], checksum: str) -> str:
    source_key = f"{checksum}/{item['table']}/{item['id']}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk/legacy-promotion/{source_key}"))


def _formula_mapping_id(item: dict[str, Any], checksum: str) -> str:
    source_key = f"{checksum}/{item['table']}/{item['id']}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk/legacy-promotion/formula/{source_key}"))


def _same(column: str, value: Any, alias: str = "t") -> str:
    return f"{alias}.{column} IS NOT DISTINCT FROM {literal(value)}"


def _replay_target_predicate(item: dict[str, Any], target_table: str) -> str:
    """Compare every value this slice wrote before treating replay as a no-op."""

    if item["entity_type"] == "growth":
        common = [
            _same("id", item["id"]),
            _same("family_id", item["family_id"]),
            _same("baby_id", item["baby_id"]),
            _same("version", 1),
            "t.deleted_at IS NULL",
            _same("created_at", item["created_at"]),
            _same("updated_at", item["updated_at"]),
            _same("legacy_client_id", item["client_id"]),
            _same("legacy_metadata", _json(item["metadata"])),
        ]
    else:
        common = [
            _same("id", item["id"]),
            _same("family_id", item["family_id"]),
            _same("baby_id", item["baby_id"]),
            _same("source", item["source"]),
            _same("source_agent", item["source_agent"]),
            _same("recorded_by_user_id", item["actor_id"]),
            _same("version", 1),
            "t.deleted_at IS NULL",
            _same("created_at", item["created_at"]),
            _same("updated_at", item["updated_at"]),
            _same("legacy_client_id", item["client_id"]),
            _same("legacy_metadata", _json(item["metadata"])),
        ]
    if item["entity_type"] == "feeding":
        specific = [
            _same("feeding_type", item["feeding_type"]),
            _same("occurred_at", item["occurred_at"]),
            _same("amount_ml", item["amount_ml"]),
            _same("left_minutes", item["left_minutes"]),
            _same("right_minutes", item["right_minutes"]),
            _same("duration_minutes", item["duration_minutes"]),
            _same("spit_up", item["spit_up"]),
            _same("formula_product_id", item["formula_product_id"]),
            _same("notes", item["notes"]),
        ]
    elif item["entity_type"] == "sleep":
        specific = [
            _same("sleep_type", item["sleep_type"]),
            _same("started_at", item["started_at"]),
            _same("ended_at", item["ended_at"]),
            _same("night_waking_count", item["night_waking_count"]),
            _same("notes", item["notes"]),
        ]
    elif item["entity_type"] == "growth":
        specific = [
            _same("measurement_date", item["measurement_date"]),
            _same("weight_kg", item["weight_kg"]),
            _same("height_cm", item["height_cm"]),
            _same("head_circumference_cm", item["head_circumference_cm"]),
            _same("attachment_id", None),
            _same("notes", item["notes"]),
        ]
    else:
        specific = [
            _same("diaper_type", item["diaper_type"]),
            _same("occurred_at", item["occurred_at"]),
            _same("poop_color", item["poop_color"]),
            _same("poop_consistency", item["poop_consistency"]),
            _same("notes", item["notes"]),
        ]
    return " AND ".join([*common, *specific])


def _replay_timeline_predicate(item: dict[str, Any]) -> str:
    metadata = _json(item["metadata"])
    occurred_at = item.get("occurred_at", item.get("started_at"))
    return " AND ".join(
        [
            _same("family_id", item["family_id"], "e"),
            _same("baby_id", item["baby_id"], "e"),
            _same("entity_type", item["entity_type"], "e"),
            _same("entity_id", item["id"], "e"),
            _same("occurred_at", occurred_at, "e"),
            _same("summary", item["summary"], "e"),
            _same("details", metadata, "e"),
            _same("source", item["source"], "e"),
            _same("version", 1, "e"),
            "e.deleted_at IS NULL",
            _same("created_at", item["created_at"], "e"),
            _same("updated_at", item["updated_at"], "e"),
        ]
    )


def _formula_replay_target_predicate(item: dict[str, Any]) -> str:
    fields = [
        _same("id", item["id"], "f"),
        _same("family_id", item["family_id"], "f"),
        _same("brand", item["brand"], "f"),
        _same("name", item["name"], "f"),
        _same("stage", item["stage"], "f"),
        _same("scoop_weight_g", item["scoop_weight_g"], "f"),
        _same("water_per_scoop_ml", item["water_per_scoop_ml"], "f"),
        _same("reconstitution_ratio", item["reconstitution_ratio"], "f"),
        _same("serving_size_unit", item["serving_size_unit"], "f"),
        f"f.nutrients_json IS NOT DISTINCT FROM {literal(item['nutrients_json'])}::jsonb",
        _same("notes", item["notes"], "f"),
        _same("is_active", item["is_active"], "f"),
        _same("is_default", item["is_default"], "f"),
        _same("is_archived", item["is_archived"], "f"),
        _same("version", item["version"], "f"),
        "f.deleted_at IS NULL",
        _same("created_at", item["created_at"], "f"),
        _same("updated_at", item["updated_at"], "f"),
    ]
    return " AND ".join(fields)


def _formula_sql(item: dict[str, Any], checksum: str, delimiter: str, source_system: str) -> str:
    source_key = f"{checksum}/{item['table']}/{item['id']}"
    mapping_id = _formula_mapping_id(item, checksum)
    raw_hash = item["source_hash"]
    receipt_metadata_sql = literal(_json(item["receipt_metadata"]))
    values = [
        literal(item["id"]),
        literal(item["family_id"]),
        literal(item["brand"]),
        literal(item["name"]),
        literal(item["stage"]),
        literal(item["scoop_weight_g"]),
        literal(item["water_per_scoop_ml"]),
        literal(item["reconstitution_ratio"]),
        literal(item["serving_size_unit"]),
        literal(item["nutrients_json"]) + "::jsonb",
        literal(item["notes"]),
        literal(item["is_active"]),
        literal(item["is_default"]),
        literal(item["is_archived"]),
        literal(item["version"]),
        "NULL",
        literal(item["created_at"]),
        literal(item["updated_at"]),
    ]
    replay_target = _formula_replay_target_predicate(item)
    common_guard = f"""
  IF NOT EXISTS (
    SELECT 1 FROM legacy_import.import_rows
    WHERE batch_id={literal(checksum)} AND source_table='FormulaProduct'
      AND source_id={literal(item['id'])} AND payload_hash={literal(raw_hash)}
  ) THEN
    RAISE EXCEPTION 'Legacy formula source row hash mismatch or missing: %', {literal(source_key)};
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.families
    WHERE id={literal(item['family_id'])} AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy formula product family is missing: %', {literal(source_key)};
  END IF;
"""
    return f"""DO {delimiter}
BEGIN
{common_guard}
  IF EXISTS (
    SELECT 1 FROM public.legacy_idempotency_mappings
    WHERE target_entity_type='formula_product' AND source_key={literal(source_key)}
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.legacy_idempotency_mappings
      WHERE target_entity_type='formula_product' AND source_key={literal(source_key)}
        AND target_entity_id={literal(item['id'])}
        AND source_hash={literal(raw_hash)} AND mapping_version={literal(FORMULA_MAPPING_VERSION)}
        AND metadata={receipt_metadata_sql}
        AND EXISTS (SELECT 1 FROM public.formula_products f WHERE {replay_target})
    ) THEN
      RAISE EXCEPTION 'Legacy formula receipt conflict or missing target: %', {literal(source_key)};
    END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.formula_products WHERE id={literal(item['id'])}) THEN
    RAISE EXCEPTION 'Formula target ID already exists without matching legacy receipt: %', {literal(item['id'])};
  END IF;
  INSERT INTO public.formula_products
    (id,family_id,brand,name,stage,scoop_weight_g,water_per_scoop_ml,reconstitution_ratio,
     serving_size_unit,nutrients_json,notes,is_active,is_default,is_archived,version,deleted_at,created_at,updated_at)
  VALUES ({','.join(values)});
  INSERT INTO public.legacy_idempotency_mappings
    (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,
     source_hash,mapping_version,metadata,created_at)
  VALUES
    ({literal(mapping_id)},'formula_product',{literal(item['id'])},{literal(source_key)},'mapped',
     {literal(source_system)},{literal(checksum)},'FormulaProduct',{literal(item['id'])},
     {literal(raw_hash)},{literal(FORMULA_MAPPING_VERSION)},{receipt_metadata_sql},{literal(item['created_at'])});
END;
{delimiter};
"""


def _record_sql(item: dict[str, Any], checksum: str, delimiter: str, source_system: str) -> str:
    table = item["table"]
    source_key = f"{checksum}/{table}/{item['id']}"
    target_table = {
        "FeedingRecord": "feeding_records",
        "SleepRecord": "sleep_records",
        "DiaperRecord": "diaper_records",
        "GrowthMeasurement": "growth_measurements",
    }[table]
    target_id = item["id"]
    timeline_id = _timeline_id(item)
    mapping_id = _mapping_id(item, checksum)
    metadata = _json(item["metadata"])
    receipt_metadata = _json(item["receipt_metadata"])
    receipt_metadata_sql = literal(receipt_metadata)
    raw_hash = item["source_hash"]
    mapping_version = item.get("mapping_version", MAPPING_VERSION)
    actor = item["actor_id"]
    client = item["client_id"]
    family = item["family_id"]
    baby = item["baby_id"]

    common_guard = f"""
  IF NOT EXISTS (
    SELECT 1 FROM legacy_import.import_rows
    WHERE batch_id={literal(checksum)} AND source_table={literal(table)}
      AND source_id={literal(item['id'])} AND payload_hash={literal(raw_hash)}
  ) THEN
    RAISE EXCEPTION 'Legacy source row hash mismatch or missing: %', {literal(source_key)};
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.babies
    WHERE id={literal(baby)} AND family_id={literal(family)} AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy row is outside its canonical baby family: %', {literal(source_key)};
  END IF;
"""
    if actor is not None:
        common_guard += f"""
  IF NOT EXISTS (
    SELECT 1 FROM public.family_members fm
    JOIN public.users u ON u.id = fm.user_id
    WHERE fm.family_id={literal(family)} AND fm.user_id={literal(actor)}
      AND fm.status='active' AND fm.deleted_at IS NULL
      AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy actor is not an active member of the baby family: %', {literal(source_key)};
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.baby_members bm
    JOIN public.users u ON u.id = bm.user_id
    WHERE bm.family_id={literal(family)} AND bm.baby_id={literal(baby)} AND bm.user_id={literal(actor)}
      AND bm.status='active' AND bm.deleted_at IS NULL
      AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy actor is not an active member of the target baby: %', {literal(source_key)};
  END IF;
"""

    if table == "FeedingRecord":
        if item["formula_product_id"] is not None:
            common_guard += f"""
  IF NOT EXISTS (
    SELECT 1 FROM public.formula_products
    WHERE id={literal(item['formula_product_id'])} AND family_id={literal(family)}
      AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy feeding formula product is missing or crosses family: %', {literal(source_key)};
  END IF;
"""
        target_values = [
            literal(target_id), literal(family), literal(baby), literal(item["feeding_type"]),
            literal(item["occurred_at"]), literal(item["amount_ml"]), literal(item["left_minutes"]),
            literal(item["right_minutes"]), literal(item["duration_minutes"]), literal(item["spit_up"]),
            literal(item["formula_product_id"]), literal(item["notes"]), literal(item["source"]),
            literal(item["source_agent"]), literal(actor), "1", "NULL", literal(item["created_at"]),
            literal(item["updated_at"]), literal(client), literal(metadata),
        ]
        columns = (
            "id,family_id,baby_id,feeding_type,occurred_at,amount_ml,left_minutes,right_minutes,"
            "duration_minutes,spit_up,formula_product_id,notes,source,source_agent,recorded_by_user_id,"
            "version,deleted_at,created_at,updated_at,legacy_client_id,legacy_metadata"
        )
    elif table == "SleepRecord":
        target_values = [
            literal(target_id), literal(family), literal(baby), literal(item["sleep_type"]),
            literal(item["started_at"]), literal(item["ended_at"]), literal(item["night_waking_count"]),
            literal(item["notes"]), literal(item["source"]), literal(item["source_agent"]), literal(actor),
            "1", "NULL", literal(item["created_at"]), literal(item["updated_at"]), literal(client), literal(metadata),
        ]
        columns = (
            "id,family_id,baby_id,sleep_type,started_at,ended_at,night_waking_count,notes,source,source_agent,"
            "recorded_by_user_id,version,deleted_at,created_at,updated_at,legacy_client_id,legacy_metadata"
        )
    elif table == "GrowthMeasurement":
        target_values = [
            literal(target_id), literal(family), literal(baby), literal(item["measurement_date"]),
            literal(item["weight_kg"]), literal(item["height_cm"]), literal(item["head_circumference_cm"]),
            literal(None), literal(item["notes"]), "1", "NULL", literal(item["created_at"]),
            literal(item["updated_at"]), literal(client), literal(metadata),
        ]
        columns = (
            "id,family_id,baby_id,measurement_date,weight_kg,height_cm,head_circumference_cm,"
            "attachment_id,notes,version,deleted_at,created_at,updated_at,legacy_client_id,legacy_metadata"
        )
    else:
        target_values = [
            literal(target_id), literal(family), literal(baby), literal(item["diaper_type"]),
            literal(item["occurred_at"]), literal(item["poop_color"]), literal(item["poop_consistency"]),
            literal(item["notes"]), literal(item["source"]), literal(item["source_agent"]), literal(actor),
            "1", "NULL", literal(item["created_at"]), literal(item["updated_at"]), literal(client), literal(metadata),
        ]
        columns = (
            "id,family_id,baby_id,diaper_type,occurred_at,poop_color,poop_consistency,notes,source,source_agent,"
            "recorded_by_user_id,version,deleted_at,created_at,updated_at,legacy_client_id,legacy_metadata"
        )

    summary = literal(item["summary"])
    timeline_details = literal(metadata)
    source = literal(item["source"])
    updated_at = literal(item["updated_at"])
    occurred_at = literal(item.get("occurred_at", item.get("started_at")))
    replay_target = _replay_target_predicate(item, target_table)
    replay_timeline = _replay_timeline_predicate(item)
    return f"""DO {delimiter}
BEGIN
{common_guard}
  IF EXISTS (
    SELECT 1 FROM public.legacy_idempotency_mappings
    WHERE target_entity_type={literal(item['entity_type'])} AND source_key={literal(source_key)}
  ) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.legacy_idempotency_mappings
      WHERE target_entity_type={literal(item['entity_type'])} AND source_key={literal(source_key)}
        AND source_hash={literal(raw_hash)} AND mapping_version={literal(mapping_version)}
        AND metadata={receipt_metadata_sql}
        AND EXISTS (SELECT 1 FROM public.{target_table} t WHERE {replay_target})
        AND EXISTS (SELECT 1 FROM public.timeline_entries e WHERE {replay_timeline})
    ) THEN
      RAISE EXCEPTION 'Legacy promotion receipt conflict or missing target: %', {literal(source_key)};
    END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.{target_table} WHERE id={literal(target_id)}) THEN
    RAISE EXCEPTION 'Target ID already exists without matching legacy receipt: %', {literal(target_id)};
  END IF;
  INSERT INTO public.{target_table} ({columns}) VALUES ({','.join(target_values)});
  INSERT INTO public.timeline_entries
    (id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,source,version,deleted_at,created_at,updated_at)
  VALUES
    ({literal(timeline_id)},{literal(family)},{literal(baby)},{literal(item['entity_type'])},{literal(target_id)},
     {occurred_at},{summary},{timeline_details},{source},1,NULL,{literal(item['created_at'])},{updated_at});
  INSERT INTO public.legacy_idempotency_mappings
    (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,
     source_hash,mapping_version,metadata,created_at)
  VALUES
    ({literal(mapping_id)},{literal(item['entity_type'])},{literal(target_id)},{literal(source_key)},'mapped',
     {literal(source_system)},{literal(checksum)},{literal(table)},{literal(target_id)},
     {literal(raw_hash)},{literal(mapping_version)},{receipt_metadata_sql},{literal(item['created_at'])});
END;
{delimiter};
"""


def render_materialization(data: dict[str, Any], checksum: str) -> str:
    """Render a single atomic, replay-safe promotion transaction."""

    checksum = _require_checksum(checksum)
    if data.get("formatVersion") != 1 or data.get("timeZone") != "Asia/Shanghai":
        raise ValueError("Unsupported archive")
    source_system = data.get("sourceId") or SOURCE_SYSTEM_DEFAULT
    if not isinstance(source_system, str) or not source_system:
        raise ValueError("Archive sourceId must be a non-empty string")
    # Formula products must be rendered first: feeding rows may reference a
    # product, and the same transaction must either create both sides or
    # create neither side.
    formula_items = prepare_formula_products(data, checksum)
    items = prepare_records(data, checksum)
    delimiter = f"$care_{checksum[:24]}$"
    statements = "\n".join(
        [
            *(_formula_sql(item, checksum, delimiter, source_system) for item in formula_items),
            *(_record_sql(item, checksum, delimiter, source_system) for item in items),
        ]
    )
    # Check source material, not the generated DO blocks (which necessarily
    # contain their own dollar-quote delimiter).
    if delimiter in _json(data):
        raise ValueError("SQL delimiter collision")
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
END;
{delimiter};
{statements}
COMMIT;
SELECT json_build_object(
  'formulaProducts', (SELECT count(*) FROM public.formula_products WHERE id IN (
    SELECT target_entity_id FROM public.legacy_idempotency_mappings
    WHERE target_entity_type='formula_product' AND source_batch_id={literal(checksum)}
  )),
  'feeding', (SELECT count(*) FROM public.feeding_records WHERE legacy_metadata->>'sourceBatchId'={literal(checksum)}),
  'sleep', (SELECT count(*) FROM public.sleep_records WHERE legacy_metadata->>'sourceBatchId'={literal(checksum)}),
  'diaper', (SELECT count(*) FROM public.diaper_records WHERE legacy_metadata->>'sourceBatchId'={literal(checksum)}),
  'growth', (SELECT count(*) FROM public.growth_measurements WHERE legacy_metadata->>'sourceBatchId'={literal(checksum)}),
  'receipts', (SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)})
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
            "formulaMappingVersion": FORMULA_MAPPING_VERSION,
            "rows": {table: len(data["tables"].get(table, [])) for table in ("FormulaProduct", *CARE_TABLES)},
        }))
        return 0
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
