#!/usr/bin/env python3
"""Convert an old Baby Panel snapshot into a GrowDesk iOS backup.

The input is the immutable ``legacy.json`` produced by ``snapshot.py``.  This
converter deliberately works on that JSON only; it never opens a SQLite
database and it never emits users, credentials, or a family membership graph.

The native iOS backup format is a JSON envelope (schema version 3) whose
``Date`` values are numeric seconds since the Unix epoch.  Swift's synthesized
encoding for ``RecordPayload`` wraps an associated value in ``{"_0": ...}``;
the payload builder below keeps that shape so the result can be decoded by the
current app without an iOS-side migration.

Example::

    python3 scripts/legacy-import/ios_backup.py \
        --input legacy.json \
        --output GrowDesk-backup.json \
        --report GrowDesk-backup.report.json \
        --family-id test_family \
        --baby-id test_baby

Rows which have no native representation are reported explicitly.  Selected
record rows that cannot be represented cause the command to fail unless
``--allow-quarantine`` is supplied.  Even in quarantine mode their IDs and
reasons are present in the report; they are never silently discarded.
"""

from __future__ import annotations

import argparse
from collections import Counter
import datetime as _datetime
from decimal import Decimal, InvalidOperation
import json
import math
from pathlib import Path
import sys
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


SCHEMA_VERSION = 3
MAX_NOTES = 10_000

RECORD_TABLES = {
    "FeedingRecord": "feeding",
    "SleepRecord": "sleep",
    "DiaperRecord": "diaper",
    "FoodLogRecord": "food",
    "SupplementRecord": "supplement",
    "GrowthMeasurement": "growth",
    "VaccineRecord": "vaccine",
    "MedicalReport": "medical",
}

LOOKUP_TABLES = {"FormulaProduct", "SupplementProduct"}

# These rows are intentionally excluded from a local backup.  A local vault
# has no users or auth/session tables, and copying one of these values would
# turn an offline trial artifact into a credential-bearing export.
SECURITY_TABLES = {
    "User",
    "FamilyMember",
    "OAuthClient",
    "OAuthAuthorizationCode",
    "OAuthRefreshToken",
    "OAuthConsent",
    "OAuthAuditLog",
    "PersonalAccessToken",
    "PushSubscription",
}

# Other tables may be useful to the old web application but have no native iOS
# destination.  They are counted in the report, including rows related to the
# selected family/baby where possible.
NATIVE_IDENTITY_TABLES = {"Family", "Baby"}

_MISSING = object()


class ConversionError(ValueError):
    """A conversion could not produce a safe, complete import artifact."""

    def __init__(self, message: str, report: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.report = dict(report) if report is not None else None


class _RowError(ValueError):
    """A selected source row cannot be represented in the iOS model."""


def _table(snapshot: Mapping[str, Any], name: str) -> list[Mapping[str, Any]]:
    tables = snapshot.get("tables")
    if not isinstance(tables, Mapping):
        raise ConversionError("snapshot.tables must be an object")
    rows = tables.get(name, [])
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise ConversionError(f"snapshot.tables.{name} must be an array")
    return rows


def _take(row: Mapping[str, Any], used: set[str], *names: str, default: Any = None) -> Any:
    """Read the first present alias and remember the source key."""

    for name in names:
        if name in row:
            used.add(name)
            return row[name]
    return default


def _row_id(row: Mapping[str, Any]) -> str:
    value = row.get("id")
    if not isinstance(value, str) or not value:
        raise _RowError("missing non-empty id")
    return value


def _as_string(value: Any, field: str, *, required: bool = False) -> str:
    if value is None:
        if required:
            raise _RowError(f"{field} is required")
        return ""
    if isinstance(value, str):
        result = value
    elif isinstance(value, (int, float, bool)):
        result = str(value)
    else:
        result = json.dumps(_json_safe(value), ensure_ascii=False, sort_keys=True)
    if required and not result.strip():
        raise _RowError(f"{field} is required")
    return result


def _as_bool(value: Any, field: str, *, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if value in (0, 1):
            return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y", "是"}:
            return True
        if normalized in {"false", "0", "no", "n", "否"}:
            return False
    raise _RowError(f"{field} is not boolean")


def _as_int(value: Any, field: str, *, default: int | None = None) -> int | None:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        raise _RowError(f"{field} is not an integer")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise _RowError(f"{field} is not an integer") from None
    if not number.is_finite() or number != number.to_integral_value():
        raise _RowError(f"{field} is not an integer")
    return int(number)


def _as_number(value: Any, field: str, *, positive: bool = False) -> int | float | None:
    """Return a JSON number suitable for Swift Decimal/Double decoding."""

    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise _RowError(f"{field} is not numeric")
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise _RowError(f"{field} is not numeric") from None
    if not number.is_finite():
        raise _RowError(f"{field} is not finite")
    if positive and number <= 0:
        raise _RowError(f"{field} must be greater than zero")
    if number == number.to_integral_value():
        return int(number)
    result = float(number)
    if not math.isfinite(result):
        raise _RowError(f"{field} is outside JSON number range")
    return result


def _source_timezone(name: Any) -> ZoneInfo:
    if not isinstance(name, str) or not name:
        raise ConversionError("snapshot.timeZone must be a named IANA timezone")
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError:
        raise ConversionError(f"unknown source timezone: {name}") from None


def _parse_timestamp(value: Any, timezone: ZoneInfo, field: str, *, default: float | None = None) -> float:
    if value is None or value == "":
        if default is not None:
            return default
        raise _RowError(f"{field} is required")
    if isinstance(value, bool):
        raise _RowError(f"{field} is not a timestamp")
    if isinstance(value, (int, float)):
        result = float(value)
        if math.isfinite(result):
            return result
        raise _RowError(f"{field} is not finite")
    if not isinstance(value, str):
        raise _RowError(f"{field} is not a timestamp")
    text = value.strip()
    if not text:
        if default is not None:
            return default
        raise _RowError(f"{field} is required")
    # SQLite snapshots can contain an epoch serialized as text.
    try:
        if text.replace(".", "", 1).replace("-", "", 1).isdigit() and "-" not in text[1:]:
            result = float(text)
            if math.isfinite(result):
                return result
    except ValueError:
        pass
    normalized = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        parsed = _datetime.datetime.fromisoformat(normalized)
    except ValueError:
        raise _RowError(f"{field} is not ISO-8601 or epoch") from None
    if isinstance(parsed, _datetime.datetime):
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone)
        result = parsed.timestamp()
    else:
        result = _datetime.datetime.combine(parsed, _datetime.time(), timezone).timestamp()
    if not math.isfinite(result):
        raise _RowError(f"{field} is not finite")
    return float(result)


def _parse_date_only(value: Any, timezone: ZoneInfo, field: str) -> str:
    if value is None or value == "":
        raise _RowError(f"{field} is required")
    if not isinstance(value, str):
        raise _RowError(f"{field} must be a date")
    text = value.strip()
    try:
        if len(text) == 10:
            parsed_date = _datetime.date.fromisoformat(text)
            return parsed_date.isoformat()
        timestamp = _parse_timestamp(text, timezone, field)
        instant = _datetime.datetime.fromtimestamp(timestamp, timezone)
        return instant.date().isoformat()
    except (ValueError, OverflowError):
        raise _RowError(f"{field} is not YYYY-MM-DD") from None


def _parse_date_and_time(date_value: Any, time_value: Any, timezone: ZoneInfo, field: str) -> float:
    if date_value is None or date_value == "":
        raise _RowError(f"{field} date is required")
    date_text = _as_string(date_value, f"{field} date", required=True).strip()
    time_text = "" if time_value is None else _as_string(time_value, f"{field} time").strip()
    if not time_text:
        return _parse_timestamp(date_text, timezone, field)
    # A time column may already include a timezone or seconds.
    if "T" in date_text:
        combined = date_text
    else:
        combined = f"{date_text}T{time_text}"
    return _parse_timestamp(combined, timezone, field)


def _json_safe(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


def _json_compact(value: Any) -> str:
    return json.dumps(_json_safe(value), ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _inc(mapping: dict[str, int], key: str, amount: int = 1) -> None:
    mapping[key] = mapping.get(key, 0) + amount


def _report_field(report: dict[str, Any], section: str, field: str) -> None:
    _inc(report[section], field)


SENSITIVE_FIELD_MARKERS = (
    "password",
    "secret",
    "token",
    "authorization",
    "cookie",
    "privatekey",
    "keyshash",
)
SENSITIVE_FIELD_NAMES = {
    "code",
    "codechallenge",
    "keysjson",
    "metadatajson",
}
METADATA_FIELD_NAMES = {
    "clientid",
    "recordedbyid",
    "source",
    "sourceagent",
    "createdbyid",
    "updatedbyid",
}


def _is_sensitive_field(field: str) -> bool:
    lower = field.lower()
    return lower in SENSITIVE_FIELD_NAMES or any(marker in lower for marker in SENSITIVE_FIELD_MARKERS)


def _is_metadata_field(field: str) -> bool:
    return field.lower() in METADATA_FIELD_NAMES


def _unmapped_fields(
    row: Mapping[str, Any],
    used: set[str],
    report: dict[str, Any],
    table: str,
) -> dict[str, Any]:
    """Collect unhandled fields while accounting for every omission."""

    result: dict[str, Any] = {}
    for field, value in row.items():
        lower_field = str(field).lower()
        # Common identity and envelope columns are consumed by the native
        # record wrapper after the payload-specific mapping.  They are not
        # clinical fields and should not appear as false-positive unmapped
        # data merely because that wrapper runs after this helper.
        if lower_field in {
            "id",
            "babyid",
            "familyid",
            "createdat",
            "created_at",
            "updatedat",
            "updated_at",
        }:
            continue
        if field in used or value is None or value == "":
            continue
        if _is_sensitive_field(str(field)):
            _report_field(report, "sensitiveFieldsOmitted", f"{table}.{field}")
        elif _is_metadata_field(str(field)):
            _report_field(report, "metadataFieldsOmitted", f"{table}.{field}")
        else:
            result[str(field)] = _json_safe(value)
            _report_field(report, "unmappedClinicalFields", f"{table}.{field}")
    return result


def _add_explicit_unmapped(report: dict[str, Any], table: str, field: str) -> None:
    _report_field(report, "unmappedClinicalFields", f"{table}.{field}")


def _add_coercion(report: dict[str, Any], table: str, row_id: str, text: str) -> None:
    report["coercions"].append({"table": table, "id": row_id, "detail": text})


def _add_generated_id(report: dict[str, Any], table: str, row_id: str, generated: str) -> None:
    report["generatedIDs"].append({"table": table, "recordID": row_id, "generated": generated})


def _attachment_link(
    report: dict[str, Any],
    table: str,
    row_id: str,
    field: str,
    value: Any,
) -> str | None:
    if value is None or value == "":
        return None
    link = _as_string(value, f"{table}.{field}")
    report["attachmentLinks"].append({"table": table, "id": row_id, "field": field, "value": link})
    return link


def _notes(
    base: Any,
    *,
    unmapped: Mapping[str, Any] | None = None,
    extras: Iterable[tuple[str, Any]] = (),
    links: Iterable[tuple[str, str]] = (),
    table: str,
    row_id: str,
) -> str:
    parts: list[str] = []
    base_text = _as_string(base, f"{table}.{row_id}.notes") if base not in (None, "") else ""
    if base_text:
        parts.append(base_text)
    if unmapped:
        parts.append("[Legacy import: unmapped clinical fields]\n" + _json_compact(unmapped))
    extra_list = [(label, value) for label, value in extras if value not in (None, "")]
    if extra_list:
        parts.append(
            "[Legacy import: preserved fields not supported by iOS]\n"
            + _json_compact({label: _json_safe(value) for label, value in extra_list})
        )
    link_list = [(field, value) for field, value in links if value]
    if link_list:
        parts.append(
            "[Legacy import: attachment links; file bytes not copied]\n"
            + _json_compact({field: value for field, value in link_list})
        )
    result = "\n".join(parts)
    if len(result) > MAX_NOTES:
        raise _RowError(f"converted notes exceed iOS limit of {MAX_NOTES} characters")
    return result


def _common_record(
    row: Mapping[str, Any],
    used: set[str],
    *,
    baby_id: str,
    record_id: str,
    occurred_at: float,
    created_at: Any,
    updated_at: Any,
    timezone: ZoneInfo,
    payload: Mapping[str, Any],
    notes: str,
) -> dict[str, Any]:
    created_value = _take(row, used, "createdAt", "created_at", default=created_at)
    created = _parse_timestamp(created_value, timezone, f"{record_id}.createdAt", default=occurred_at)
    updated_value = _take(row, used, "updatedAt", "updated_at", default=updated_at)
    updated = _parse_timestamp(updated_value, timezone, f"{record_id}.updatedAt", default=created)
    return {
        "id": record_id,
        "babyID": baby_id,
        "occurredAt": occurred_at,
        "payload": payload,
        "notes": notes,
        "attachmentIDs": [],
        "revision": 0,
        "createdAt": created,
        "updatedAt": updated,
        "deletedAt": None,
    }


def _payload(case: str, value: Mapping[str, Any]) -> dict[str, Any]:
    # This is the exact shape emitted by Swift's synthesized Codable for an
    # enum case carrying one associated value.
    return {case: {"_0": dict(value)}}


def _related_baby(row: Mapping[str, Any]) -> Any:
    return row.get("babyId", row.get("babyID"))


def _record_common_values(
    row: Mapping[str, Any],
    used: set[str],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    occurred_at: float,
    record_id: str,
    payload: Mapping[str, Any],
    notes: str,
) -> dict[str, Any]:
    _take(row, used, "id")
    _take(row, used, "babyId", "babyID")
    return _common_record(
        row,
        used,
        baby_id=baby_id,
        record_id=record_id,
        occurred_at=occurred_at,
        created_at=occurred_at,
        updated_at=occurred_at,
        timezone=timezone,
        payload=payload,
        notes=notes,
    )


def _formula_name(products: Mapping[str, Mapping[str, Any]], product_id: str | None) -> str:
    if not product_id:
        return ""
    product = products.get(product_id)
    if not product:
        return ""
    return _as_string(product.get("name"), "FormulaProduct.name")


def _supplement_product(products: Mapping[str, Mapping[str, Any]], product_id: str | None) -> Mapping[str, Any] | None:
    return products.get(product_id) if product_id else None


def _map_feeding(
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    formula_products: Mapping[str, Mapping[str, Any]],
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "FeedingRecord"
    used: set[str] = set()
    record_id = _row_id(row)
    raw_type = _take(row, used, "type", "method")
    method_map = {"breast": "breast", "formula": "formula", "mixed": "mixed", "expressed": "expressed", "bottle_breast": "expressed"}
    method = method_map.get(_as_string(raw_type, f"{table}.type").strip().lower())
    if method is None:
        raise _RowError(f"unsupported feeding type: {raw_type!r}")
    if raw_type == "bottle_breast":
        _add_coercion(report, table, record_id, "type bottle_breast mapped to native method expressed")
    amount = _as_number(_take(row, used, "amountMl", "amountML"), f"{table}.amountMl", positive=True)
    left = _as_int(_take(row, used, "leftMinutes"), f"{table}.leftMinutes")
    right = _as_int(_take(row, used, "rightMinutes"), f"{table}.rightMinutes")
    for label, value in (("leftMinutes", left), ("rightMinutes", right)):
        if value is not None and not 0 <= value <= 1440:
            raise _RowError(f"{table}.{label} outside native range")
    if method != "breast" and amount is None:
        raise _RowError(f"{table}.amountMl required for method {method}")
    spit_up = _as_bool(_take(row, used, "spitUp"), f"{table}.spitUp")
    product_id = _take(row, used, "formulaProductId", "formulaProductID")
    product_id = _as_string(product_id, f"{table}.formulaProductId") or None
    formula_name = _as_string(_take(row, used, "formulaName"), f"{table}.formulaName")
    if not formula_name:
        formula_name = _formula_name(formula_products, product_id)
    extras: list[tuple[str, Any]] = []
    food_name = _take(row, used, "foodName")
    food_amount = _take(row, used, "foodAmount")
    if food_name not in (None, ""):
        extras.append(("foodName", food_name))
        _add_explicit_unmapped(report, table, "foodName")
    if food_amount not in (None, ""):
        extras.append(("foodAmount", food_amount))
        _add_explicit_unmapped(report, table, "foodAmount")
    if product_id and product_id not in formula_products:
        report["unresolvedReferences"].append({"table": table, "id": record_id, "field": "formulaProductId", "value": product_id})
        extras.append(("formulaProductId unresolved", product_id))
    occurred = _parse_timestamp(_take(row, used, "timestamp", "occurredAt"), timezone, f"{record_id}.timestamp")
    unmapped = _unmapped_fields(row, used, report, table)
    links: list[tuple[str, str]] = []
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, links=links, table=table, row_id=record_id)
    value = {
        "method": method,
        "amountML": amount,
        "leftMinutes": left,
        "rightMinutes": right,
        "spitUp": spit_up,
        "formulaName": formula_name,
        "formulaProductID": product_id,
    }
    return _record_common_values(row, used, baby_id=baby_id, timezone=timezone, occurred_at=occurred, record_id=record_id, payload=_payload("feeding", value), notes=notes)


def _map_sleep(
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "SleepRecord"
    used: set[str] = set()
    record_id = _row_id(row)
    start = _parse_timestamp(_take(row, used, "startTime", "startAt"), timezone, f"{record_id}.startTime")
    raw_end = _take(row, used, "endTime", "endAt")
    end = None if raw_end in (None, "") else _parse_timestamp(raw_end, timezone, f"{record_id}.endTime")
    if end is not None and end <= start:
        raise _RowError("sleep endTime must be later than startTime")
    raw_kind = _as_string(_take(row, used, "type", "kind", default="night"), f"{table}.type").strip().lower()
    if raw_kind not in {"day", "night"}:
        raise _RowError(f"unsupported sleep type: {raw_kind!r}")
    night_wakings = _as_int(_take(row, used, "nightWakingCount", "nightWakings"), f"{table}.nightWakingCount", default=0)
    if night_wakings is None or night_wakings < 0:
        raise _RowError("nightWakingCount cannot be negative")
    extras: list[tuple[str, Any]] = []
    for field in ("fallingAsleepMethod", "wakeUpMood"):
        value = _take(row, used, field)
        if value not in (None, ""):
            extras.append((field, value))
            _add_explicit_unmapped(report, table, field)
    unmapped = _unmapped_fields(row, used, report, table)
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, table=table, row_id=record_id)
    value = {"startAt": start, "endAt": end, "kind": raw_kind, "nightWakings": night_wakings}
    return _record_common_values(row, used, baby_id=baby_id, timezone=timezone, occurred_at=start, record_id=record_id, payload=_payload("sleep", value), notes=notes)


def _map_diaper(
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "DiaperRecord"
    used: set[str] = set()
    record_id = _row_id(row)
    kind = _as_string(_take(row, used, "type", "kind"), f"{table}.type", required=True).strip().lower()
    if kind not in {"pee", "poop", "both"}:
        raise _RowError(f"unsupported diaper type: {kind!r}")
    color = _take(row, used, "poopColor", "color")
    color = _as_string(color, f"{table}.poopColor").strip().lower() or None
    consistency = _take(row, used, "poopConsistency", "consistency")
    consistency = _as_string(consistency, f"{table}.poopConsistency").strip().lower() or None
    if color is not None and color not in {"yellow", "green", "brown", "other"}:
        raise _RowError(f"unsupported stool color: {color!r}")
    if consistency is not None and consistency not in {"loose", "paste", "formed"}:
        raise _RowError(f"unsupported stool consistency: {consistency!r}")
    extras: list[tuple[str, Any]] = []
    if kind == "pee" and (color is not None or consistency is not None):
        if color is not None:
            extras.append(("legacy poopColor", color))
            _add_explicit_unmapped(report, table, "poopColor")
        if consistency is not None:
            extras.append(("legacy poopConsistency", consistency))
            _add_explicit_unmapped(report, table, "poopConsistency")
        color = None
        consistency = None
        _add_coercion(report, table, record_id, "pee records cannot carry stool fields in the native model; original values are in notes")
    occurred = _parse_timestamp(_take(row, used, "timestamp", "occurredAt"), timezone, f"{record_id}.timestamp")
    unmapped = _unmapped_fields(row, used, report, table)
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, table=table, row_id=record_id)
    value = {"kind": kind, "color": color, "consistency": consistency}
    return _record_common_values(row, used, baby_id=baby_id, timezone=timezone, occurred_at=occurred, record_id=record_id, payload=_payload("diaper", value), notes=notes)


def _decode_json_field(value: Any, field: str) -> Any:
    if isinstance(value, str):
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            raise _RowError(f"{field} is not valid JSON") from None
    return value


def _map_food(
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "FoodLogRecord"
    used: set[str] = set()
    record_id = _row_id(row)
    foods_raw = _decode_json_field(_take(row, used, "foods"), f"{record_id}.foods")
    if not isinstance(foods_raw, list) or not foods_raw:
        raise _RowError("foods must be a non-empty array")
    foods: list[dict[str, Any]] = []
    extras: list[tuple[str, Any]] = []
    for index, item in enumerate(foods_raw):
        item_used: set[str] = set()
        if isinstance(item, Mapping):
            item_id = item.get("id")
            reference_id = item.get("referenceFoodID", item.get("foodId"))
            name = item.get("name", item.get("foodName"))
            grams_raw = item.get("grams", item.get("amount", item.get("foodAmount")))
            for key in ("id", "referenceFoodID", "foodId", "name", "foodName", "grams", "amount", "foodAmount"):
                if key in item:
                    item_used.add(key)
            if not isinstance(item_id, str) or not item_id:
                item_id = f"{record_id}:food:{index}"
                _add_generated_id(report, table, record_id, item_id)
            if isinstance(reference_id, str) and not reference_id:
                reference_id = None
            if reference_id is not None and not isinstance(reference_id, str):
                reference_id = _as_string(reference_id, f"{record_id}.foods[{index}].referenceFoodID")
            item_name = _as_string(name, f"{record_id}.foods[{index}].name", required=True)
            grams = _as_number(grams_raw, f"{record_id}.foods[{index}].grams", positive=True)
            remaining = {key: value for key, value in item.items() if key not in item_used and value not in (None, "")}
            if remaining:
                extras.append((f"food item {item_id} unmapped fields", remaining))
                for key in remaining:
                    _add_explicit_unmapped(report, table, f"foods[{index}].{key}")
        else:
            item_id = f"{record_id}:food:{index}"
            _add_generated_id(report, table, record_id, item_id)
            reference_id = None
            item_name = _as_string(item, f"{record_id}.foods[{index}].name", required=True)
            grams = None
        foods.append({"id": item_id, "name": item_name, "grams": grams, "referenceFoodID": reference_id})
    portion = _as_string(_take(row, used, "portion", default="all"), f"{table}.portion").strip().lower()
    if portion not in {"little", "half", "most", "all"}:
        raise _RowError(f"unsupported food portion: {portion!r}")
    acceptance = _as_int(_take(row, used, "acceptance"), f"{table}.acceptance")
    if acceptance is None or not 1 <= acceptance <= 5:
        raise _RowError("food acceptance must be between 1 and 5")
    baby_state = _as_string(_take(row, used, "babyState", default="neutral"), f"{table}.babyState").strip().lower()
    if baby_state not in {"happy", "neutral", "rejected"}:
        raise _RowError(f"unsupported babyState: {baby_state!r}")
    has_abnormal = _as_bool(_take(row, used, "hasAbnormal"), f"{table}.hasAbnormal")
    abnormal_notes = _as_string(_take(row, used, "abnormalNotes"), f"{table}.abnormalNotes")
    date_value = _take(row, used, "date", "recordedDate")
    time_value = _take(row, used, "time", "recordedTime")
    occurred = _parse_date_and_time(date_value, time_value, timezone, f"{record_id}.date")
    unmapped = _unmapped_fields(row, used, report, table)
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, table=table, row_id=record_id)
    value = {
        "foods": foods,
        "portion": portion,
        "acceptance": acceptance,
        "babyState": baby_state,
        "hasAbnormal": has_abnormal,
        "abnormalNotes": abnormal_notes,
    }
    return _record_common_values(row, used, baby_id=baby_id, timezone=timezone, occurred_at=occurred, record_id=record_id, payload=_payload("food", value), notes=notes)


def _map_supplement(
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    supplement_products: Mapping[str, Mapping[str, Any]],
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "SupplementRecord"
    used: set[str] = set()
    record_id = _row_id(row)
    product_id = _as_string(_take(row, used, "productId", "productID"), f"{table}.productId") or None
    product = _supplement_product(supplement_products, product_id)
    product_name = _as_string(_take(row, used, "productName"), f"{table}.productName")
    if not product_name and product:
        product_name = _as_string(product.get("name"), f"{table}.product.name")
    extras: list[tuple[str, Any]] = []
    if not product_name and product_id:
        product_name = product_id
        extras.append(("unresolved productName; productId used as display name", product_id))
        _add_coercion(report, table, record_id, "missing product name represented by legacy product ID")
    if not product_name:
        raise _RowError("supplement productName or productId is required")
    dose_raw = _take(row, used, "dose")
    if dose_raw in (None, "") and product:
        dose_raw = product.get("defaultDose")
        _add_coercion(report, table, record_id, "missing dose filled from SupplementProduct.defaultDose")
    dose = _as_number(dose_raw if dose_raw not in (None, "") else 1, f"{table}.dose", positive=True)
    unit = _as_string(_take(row, used, "unitName", "unit"), f"{table}.unitName")
    if not unit and product:
        unit = _as_string(product.get("unitName"), f"{table}.product.unitName")
    if not unit:
        unit = "份"
        extras.append(("unitName defaulted because legacy value was empty", unit))
        _add_coercion(report, table, record_id, "missing unitName defaulted to native default 份")
    if product_id and product_id not in supplement_products:
        report["unresolvedReferences"].append({"table": table, "id": record_id, "field": "productId", "value": product_id})
        extras.append(("productId unresolved", product_id))
    occurred = _parse_date_and_time(_take(row, used, "date"), _take(row, used, "time"), timezone, f"{record_id}.date")
    unmapped = _unmapped_fields(row, used, report, table)
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, table=table, row_id=record_id)
    value = {"productName": product_name, "productID": product_id, "dose": dose, "unit": unit}
    return _record_common_values(row, used, baby_id=baby_id, timezone=timezone, occurred_at=occurred, record_id=record_id, payload=_payload("supplement", value), notes=notes)


def _map_growth(
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "GrowthMeasurement"
    used: set[str] = set()
    record_id = _row_id(row)
    date_text = _parse_date_only(_take(row, used, "date", "recordedDate"), timezone, f"{record_id}.date")
    occurred = _parse_timestamp(date_text, timezone, f"{record_id}.date")
    values: dict[str, int | float | None] = {}
    for output, names in {
        "weightKG": ("weightKg", "weightKG"),
        "heightCM": ("heightCm", "heightCM"),
        "headCircumferenceCM": ("headCircumferenceCm", "headCircumferenceCM"),
    }.items():
        raw = _take(row, used, *names)
        values[output] = _as_number(raw, f"{table}.{output}", positive=True)
    if not any(value is not None for value in values.values()):
        raise _RowError("growth row has no measurement")
    extras: list[tuple[str, Any]] = []
    for field in ("ageInMonths", "ageLabel", "percentile"):
        value = _take(row, used, field)
        if value not in (None, ""):
            extras.append((field, value))
            _add_explicit_unmapped(report, table, field)
    links: list[tuple[str, str]] = []
    image_url = _attachment_link(report, table, record_id, "imageUrl", _take(row, used, "imageUrl"))
    if image_url:
        links.append(("imageUrl", image_url))
    unmapped = _unmapped_fields(row, used, report, table)
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, links=links, table=table, row_id=record_id)
    return _record_common_values(row, used, baby_id=baby_id, timezone=timezone, occurred_at=occurred, record_id=record_id, payload=_payload("growth", values), notes=notes)


def _map_vaccine(
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "VaccineRecord"
    used: set[str] = set()
    record_id = _row_id(row)
    name = _as_string(_take(row, used, "name"), f"{table}.name", required=True)
    dose = _as_string(_take(row, used, "dose"), f"{table}.dose")
    scheduled_raw = _take(row, used, "scheduledDate", "date")
    completed_raw = _take(row, used, "completedDate")
    if scheduled_raw in (None, "") and completed_raw not in (None, ""):
        scheduled_raw = completed_raw
        _add_coercion(report, table, record_id, "missing scheduledDate filled from completedDate")
    scheduled = _parse_date_only(scheduled_raw, timezone, f"{record_id}.scheduledDate")
    completed = None if completed_raw in (None, "") else _parse_date_only(completed_raw, timezone, f"{record_id}.completedDate")
    is_completed = _as_bool(_take(row, used, "isCompleted"), f"{table}.isCompleted")
    extras: list[tuple[str, Any]] = []
    if is_completed and completed is None:
        extras.append(("legacy isCompleted without completedDate", True))
        _add_explicit_unmapped(report, table, "isCompleted")
    occurred = _parse_timestamp(completed or scheduled, timezone, f"{record_id}.scheduledDate")
    unmapped = _unmapped_fields(row, used, report, table)
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, table=table, row_id=record_id)
    value = {"name": name, "dose": dose, "scheduledDate": scheduled, "completedDate": completed}
    return _record_common_values(row, used, baby_id=baby_id, timezone=timezone, occurred_at=occurred, record_id=record_id, payload=_payload("vaccine", value), notes=notes)


def _medical_items(
    row: Mapping[str, Any],
    raw_items: Any,
    *,
    record_id: str,
    report: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[tuple[str, Any]]]:
    table = "MedicalReport"
    if raw_items in (None, ""):
        return [], []
    try:
        items = _decode_json_field(raw_items, f"{record_id}.itemsJson")
    except _RowError:
        # The raw source value is still kept in notes by the caller; no item is
        # fabricated from malformed JSON.
        return [], [("itemsJson raw (invalid JSON)", raw_items)]
    if not isinstance(items, list):
        raise _RowError("itemsJson must contain an array")
    output: list[dict[str, Any]] = []
    extras: list[tuple[str, Any]] = []
    for index, item in enumerate(items):
        if not isinstance(item, Mapping):
            raise _RowError(f"medical item {index} is not an object")
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            item_id = f"{record_id}:item:{index}"
            _add_generated_id(report, table, record_id, item_id)
        name = _as_string(item.get("name"), f"{record_id}.items[{index}].name", required=True)
        value = item.get("value")
        if value is None or (isinstance(value, str) and not value.strip()):
            raise _RowError(f"medical item {index} value is required")
        value_text = _as_string(value, f"{record_id}.items[{index}].value", required=True)
        unit = _as_string(item.get("unit"), f"{record_id}.items[{index}].unit")
        reference = _as_string(item.get("referenceRange"), f"{record_id}.items[{index}].referenceRange")
        output.append({"id": item_id, "name": name, "value": value_text, "unit": unit, "referenceRange": reference})
        metadata = {}
        for field in ("status", "interpretation"):
            if item.get(field) not in (None, ""):
                metadata[field] = item[field]
                _add_explicit_unmapped(report, table, f"items[{index}].{field}")
        known = {"id", "name", "value", "unit", "referenceRange", "status", "interpretation"}
        remainder = {key: value for key, value in item.items() if key not in known and value not in (None, "")}
        if remainder:
            metadata["other"] = remainder
            for field in remainder:
                _add_explicit_unmapped(report, table, f"items[{index}].{field}")
        if metadata:
            extras.append((f"medical item {item_id} metadata", metadata))
    return output, extras


def _map_medical(
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "MedicalReport"
    used: set[str] = set()
    record_id = _row_id(row)
    title = _as_string(_take(row, used, "title"), f"{table}.title", required=True)
    raw_category = _as_string(_take(row, used, "category", default="general"), f"{table}.category").strip().lower()
    categories = {"blood", "growth", "trace_element", "allergy", "general"}
    extras: list[tuple[str, Any]] = []
    if raw_category not in categories:
        extras.append(("legacy category", raw_category))
        _add_explicit_unmapped(report, table, "category")
        _add_coercion(report, table, record_id, "unknown category mapped to general")
        raw_category = "general"
    hospital = _as_string(_take(row, used, "hospital"), f"{table}.hospital")
    doctor_notes = _as_string(_take(row, used, "doctorNotes"), f"{table}.doctorNotes")
    ai_summary = _take(row, used, "aiSummary")
    if ai_summary not in (None, ""):
        extras.append(("aiSummary", ai_summary))
        _add_explicit_unmapped(report, table, "aiSummary")
    raw_items = _take(row, used, "itemsJson", "items")
    items, item_extras = _medical_items(row, raw_items, record_id=record_id, report=report)
    extras.extend(item_extras)
    date_text = _parse_date_only(_take(row, used, "date", "recordedDate"), timezone, f"{record_id}.date")
    occurred = _parse_timestamp(date_text, timezone, f"{record_id}.date")
    links: list[tuple[str, str]] = []
    image_url = _attachment_link(report, table, record_id, "imageUrl", _take(row, used, "imageUrl"))
    if image_url:
        links.append(("imageUrl", image_url))
    unmapped = _unmapped_fields(row, used, report, table)
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, links=links, table=table, row_id=record_id)
    value = {"title": title, "category": raw_category, "hospital": hospital, "doctorNotes": doctor_notes, "items": items}
    return _record_common_values(row, used, baby_id=baby_id, timezone=timezone, occurred_at=occurred, record_id=record_id, payload=_payload("medical", value), notes=notes)


def _map_record(
    table: str,
    row: Mapping[str, Any],
    *,
    baby_id: str,
    timezone: ZoneInfo,
    formula_products: Mapping[str, Mapping[str, Any]],
    supplement_products: Mapping[str, Mapping[str, Any]],
    report: dict[str, Any],
) -> dict[str, Any]:
    kwargs = {
        "row": row,
        "baby_id": baby_id,
        "timezone": timezone,
        "report": report,
    }
    if table == "FeedingRecord":
        return _map_feeding(**kwargs, formula_products=formula_products)
    if table == "SleepRecord":
        return _map_sleep(**kwargs)
    if table == "DiaperRecord":
        return _map_diaper(**kwargs)
    if table == "FoodLogRecord":
        return _map_food(**kwargs)
    if table == "SupplementRecord":
        return _map_supplement(**kwargs, supplement_products=supplement_products)
    if table == "GrowthMeasurement":
        return _map_growth(**kwargs)
    if table == "VaccineRecord":
        return _map_vaccine(**kwargs)
    if table == "MedicalReport":
        return _map_medical(**kwargs)
    raise _RowError(f"unsupported record table: {table}")


def _new_report(snapshot: Mapping[str, Any], family_id: str, baby_id: str, timezone: ZoneInfo) -> dict[str, Any]:
    tables = snapshot.get("tables") if isinstance(snapshot.get("tables"), Mapping) else {}
    return {
        "reportVersion": 1,
        "sourceId": snapshot.get("sourceId"),
        "familyId": family_id,
        "babyId": baby_id,
        "timeZone": getattr(timezone, "key", str(timezone)),
        "sourceTableCounts": {str(name): len(rows) if isinstance(rows, list) else None for name, rows in tables.items()},
        "mappedRecords": {kind: 0 for kind in RECORD_TABLES.values()},
        "unsupportedTables": {},
        "excludedTables": {},
        "quarantinedRecords": [],
        "unmappedClinicalFields": {},
        "metadataFieldsOmitted": {},
        "sensitiveFieldsOmitted": {},
        "generatedIDs": [],
        "coercions": [],
        "unresolvedReferences": [],
        "attachmentLinks": [],
        "warnings": [],
    }


def _matching_count(rows: list[Mapping[str, Any]], *, family_id: str, baby_id: str, table: str) -> int:
    if table in {"FormulaProduct", "SupplementProduct", "FamilyFoodStatus", "FamilyBookStatus"}:
        return sum(1 for row in rows if isinstance(row, Mapping) and row.get("familyId") == family_id)
    if table in {"FoodPlan", "VaccineSelection", "SupplementSchedule", "AiJob", "AiChatSession", "AgentVoiceLog", "RecordSnapshot"}:
        return sum(1 for row in rows if isinstance(row, Mapping) and _related_baby(row) == baby_id)
    if table == "FamilyMember":
        return sum(1 for row in rows if isinstance(row, Mapping) and row.get("familyId") == family_id)
    if table in {"Baby"}:
        return sum(1 for row in rows if isinstance(row, Mapping) and row.get("id") == baby_id)
    if table in {"Family"}:
        return sum(1 for row in rows if isinstance(row, Mapping) and row.get("id") == family_id)
    return len(rows)


def _build_baby(
    row: Mapping[str, Any],
    *,
    family_id: str,
    baby_id: str,
    timezone: ZoneInfo,
    report: dict[str, Any],
) -> dict[str, Any]:
    table = "Baby"
    used: set[str] = set()
    actual_id = _row_id(row)
    if actual_id != baby_id:
        raise ConversionError("selected Baby row does not match baby_id")
    if row.get("familyId") != family_id:
        raise ConversionError("selected Baby row does not belong to family_id")
    name = _as_string(_take(row, used, "nickname", "name"), f"{table}.nickname", required=True)
    birth_date = _parse_date_only(_take(row, used, "birthDate"), timezone, f"{baby_id}.birthDate")
    raw_sex = _as_string(_take(row, used, "gender", "sex", default="unspecified"), f"{table}.gender").strip().lower()
    sex = raw_sex if raw_sex in {"female", "male", "unspecified"} else "unspecified"
    extras: list[tuple[str, Any]] = []
    if sex != raw_sex:
        extras.append(("legacy gender", raw_sex))
        _add_explicit_unmapped(report, table, "gender")
        _add_coercion(report, table, baby_id, "unknown gender mapped to unspecified")
    gestational = _as_int(_take(row, used, "gestationalAge", "gestationalAgeWeeks"), f"{table}.gestationalAge")
    if gestational is not None and not 1 <= gestational <= 45:
        extras.append(("legacy gestationalAge", gestational))
        _add_explicit_unmapped(report, table, "gestationalAge")
        _add_coercion(report, table, baby_id, "gestational age outside native range omitted from field and preserved in notes")
        gestational = None
    avatar_link = _attachment_link(report, table, baby_id, "avatarUrl", _take(row, used, "avatarUrl"))
    links = [("avatarUrl", avatar_link)] if avatar_link else []
    unmapped = _unmapped_fields(row, used, report, table)
    notes = _notes(_take(row, used, "notes"), unmapped=unmapped, extras=extras, links=links, table=table, row_id=baby_id)
    birth_epoch = _parse_timestamp(birth_date, timezone, f"{baby_id}.birthDate")
    created = _parse_timestamp(_take(row, used, "createdAt", "created_at"), timezone, f"{baby_id}.createdAt", default=birth_epoch)
    updated = _parse_timestamp(_take(row, used, "updatedAt", "updated_at"), timezone, f"{baby_id}.updatedAt", default=created)
    return {
        "id": baby_id,
        "name": name,
        "birthDate": birth_date,
        "sex": sex,
        "gestationalAgeWeeks": gestational,
        "timeZoneIdentifier": getattr(timezone, "key", str(timezone)),
        "notes": notes,
        "revision": 0,
        "createdAt": created,
        "updatedAt": updated,
        "archivedAt": None,
    }


def _validate_snapshot(snapshot: Mapping[str, Any]) -> tuple[str, ZoneInfo]:
    if not isinstance(snapshot, Mapping):
        raise ConversionError("snapshot must be a JSON object")
    if snapshot.get("formatVersion") != 1:
        raise ConversionError("only legacy snapshot formatVersion 1 is supported")
    source_id = snapshot.get("sourceId")
    if not isinstance(source_id, str) or not source_id.strip():
        raise ConversionError("snapshot.sourceId is required")
    timezone = _source_timezone(snapshot.get("timeZone"))
    if not isinstance(snapshot.get("tables"), Mapping):
        raise ConversionError("snapshot.tables must be an object")
    return source_id, timezone


def convert_snapshot(
    snapshot: Mapping[str, Any],
    *,
    family_id: str,
    baby_id: str,
    allow_quarantine: bool = False,
    vault_id: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Convert one explicitly selected legacy family/baby.

    Returns ``(backup, report)``.  ``ConversionError.report`` contains the
    same report when strict conversion fails, which lets a caller persist the
    reason without writing an incomplete backup.
    """

    if not isinstance(family_id, str) or not family_id:
        raise ConversionError("family_id is required")
    if not isinstance(baby_id, str) or not baby_id:
        raise ConversionError("baby_id is required")
    source_id, timezone = _validate_snapshot(snapshot)
    report = _new_report(snapshot, family_id, baby_id, timezone)
    tables = snapshot["tables"]

    family_rows = _table(snapshot, "Family")
    if not any(isinstance(row, Mapping) and row.get("id") == family_id for row in family_rows):
        raise ConversionError(f"family_id not found in snapshot: {family_id}", report)
    baby_rows = [row for row in _table(snapshot, "Baby") if isinstance(row, Mapping) and row.get("id") == baby_id]
    if len(baby_rows) != 1:
        raise ConversionError(f"expected exactly one Baby row for baby_id: {baby_id}", report)
    baby_row = baby_rows[0]
    if baby_row.get("familyId") != family_id:
        raise ConversionError("selected baby does not belong to selected family", report)
    try:
        baby = _build_baby(baby_row, family_id=family_id, baby_id=baby_id, timezone=timezone, report=report)
    except (_RowError, ConversionError) as error:
        raise ConversionError(f"Baby {baby_id} cannot be converted: {error}", report) from error

    formula_products = {
        str(row.get("id")): row
        for row in _table(snapshot, "FormulaProduct")
        if isinstance(row, Mapping) and row.get("familyId") == family_id and row.get("id")
    }
    supplement_products = {
        str(row.get("id")): row
        for row in _table(snapshot, "SupplementProduct")
        if isinstance(row, Mapping) and row.get("familyId") == family_id and row.get("id")
    }

    records: list[dict[str, Any]] = []
    seen_record_ids: set[str] = set()
    for table, kind in RECORD_TABLES.items():
        for row in _table(snapshot, table):
            if not isinstance(row, Mapping):
                report["quarantinedRecords"].append({"table": table, "id": "<non-object>", "reason": "row is not an object"})
                continue
            related_baby = _related_baby(row)
            if related_baby is None:
                row_id = row.get("id", "<missing>")
                report["quarantinedRecords"].append({"table": table, "id": row_id, "reason": "missing babyId"})
                continue
            if related_baby != baby_id:
                continue
            try:
                record = _map_record(
                    table,
                    row,
                    baby_id=baby_id,
                    timezone=timezone,
                    formula_products=formula_products,
                    supplement_products=supplement_products,
                    report=report,
                )
                record_id = record["id"]
                if record_id in seen_record_ids:
                    raise _RowError(f"duplicate record ID across source tables: {record_id}")
                seen_record_ids.add(record_id)
                records.append(record)
                report["mappedRecords"][kind] += 1
            except (_RowError, ValueError) as error:
                report["quarantinedRecords"].append({"table": table, "id": row.get("id", "<missing>"), "reason": str(error)})

    # Every table is accounted for in the report.  Identity and auth tables
    # never enter the native envelope; static/planning/chat tables have no
    # native destination and are counted with the selected scope where known.
    for table_name, rows in tables.items():
        if table_name in RECORD_TABLES or table_name in {"Baby", "Family", *LOOKUP_TABLES}:
            continue
        if table_name in SECURITY_TABLES:
            report["excludedTables"][table_name] = len(rows) if isinstance(rows, list) else None
            continue
        if not isinstance(rows, list):
            report["unsupportedTables"][table_name] = {"count": None, "selectedCount": None, "reason": "table rows are not an array"}
            continue
        if not rows:
            continue
        selected_count = _matching_count(rows, family_id=family_id, baby_id=baby_id, table=table_name)
        report["unsupportedTables"][table_name] = {
            "count": len(rows),
            "selectedCount": selected_count,
            "reason": "no native iOS backup field",
        }
    excluded = snapshot.get("excluded")
    if isinstance(excluded, Mapping):
        for name, count in excluded.items():
            report["excludedTables"][str(name)] = count

    records.sort(key=lambda record: record["id"])
    backup_vault = vault_id or f"legacy:{source_id}"
    if not isinstance(backup_vault, str) or not backup_vault:
        raise ConversionError("vault_id must be non-empty", report)
    captured = snapshot.get("capturedAt")
    try:
        exported_at = _parse_timestamp(captured, timezone, "capturedAt", default=0.0)
    except _RowError:
        exported_at = 0.0
        report["warnings"].append("capturedAt was absent or invalid; exportedAt set to Unix epoch")
    backup = {
        "schemaVersion": SCHEMA_VERSION,
        "vaultID": backup_vault,
        "exportedAt": exported_at,
        "babies": [baby],
        "records": records,
        "states": [],
        "attachments": [],
    }
    report["output"] = {
        "babyCount": len(backup["babies"]),
        "recordCount": len(records),
        "attachmentCount": 0,
        "attachmentLinksNeedingCopy": len(report["attachmentLinks"]),
        "schemaVersion": SCHEMA_VERSION,
    }
    report["complete"] = not report["quarantinedRecords"] and not report["unsupportedTables"] and not report["attachmentLinks"]
    if report["unsupportedTables"]:
        report["warnings"].append("unsupported source tables were counted but have no native iOS destination")
    if report["attachmentLinks"]:
        report["warnings"].append("attachment links were preserved in notes; attachment bytes were not copied")
    if report["quarantinedRecords"] and not allow_quarantine:
        raise ConversionError(
            f"{len(report['quarantinedRecords'])} selected source row(s) require quarantine; rerun with --allow-quarantine only after reviewing the report",
            report,
        )
    return backup, report


# Short alias for callers that prefer an imperative name.
convert = convert_snapshot


def _write_json(path: Path, value: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", "--source", dest="input_path", required=True, type=Path, help="legacy.json snapshot")
    parser.add_argument("--output", required=True, type=Path, help="schema v3 iOS backup JSON")
    parser.add_argument("--report", type=Path, help="conversion report JSON (recommended)")
    parser.add_argument("--family-id", required=True)
    parser.add_argument("--baby-id", required=True)
    parser.add_argument("--vault-id", help="optional native vaultID; defaults to legacy:<sourceId>")
    parser.add_argument("--allow-quarantine", action="store_true", help="write a partial backup after explicit quarantine reporting")
    args = parser.parse_args(argv)
    try:
        snapshot = json.loads(args.input_path.read_text(encoding="utf-8"))
        backup, report = convert_snapshot(
            snapshot,
            family_id=args.family_id,
            baby_id=args.baby_id,
            allow_quarantine=args.allow_quarantine,
            vault_id=args.vault_id,
        )
    except ConversionError as error:
        if args.report and error.report is not None:
            _write_json(args.report, error.report)
        print(json.dumps({"error": str(error), "report": error.report}, ensure_ascii=False, sort_keys=True), file=sys.stderr)
        return 1
    except (OSError, json.JSONDecodeError) as error:
        print(json.dumps({"error": f"input/output: {error}"}, ensure_ascii=False), file=sys.stderr)
        return 1
    _write_json(args.output, backup)
    if args.report:
        _write_json(args.report, report)
    print(json.dumps(report["output"], ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
