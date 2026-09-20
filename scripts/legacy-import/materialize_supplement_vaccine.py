"""Promote the frozen legacy nutrition and vaccine graph into PostgreSQL.

This is an offline, typed promotion boundary.  It reads an immutable
identity-v1 archive, validates every family/baby/member edge before emitting
SQL, and renders one transaction containing all products, schedules, records,
reference data and vaccine selections.  ``legacy_import`` remains the source
of truth: each target row has a source SHA-256, mapping version and exact
target snapshot in ``legacy_idempotency_mappings``.

The target tables are additive because the first GrowDesk schema only carried
the simplified supplement and vaccine runtime records.  No archive row is
silently discarded: fields that do not have a first-class column remain in
redacted ``legacy_metadata`` and the receipt.  A missing or tampered raw row,
scope edge, target row, timeline projection or receipt aborts the whole batch.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import math
import re
import uuid
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo


MAPPING_VERSION = "supplement-vaccine-v1"
SOURCE_SYSTEM_DEFAULT = "legacy_web"
ADVISORY_LOCK = 724019236
SOURCE_TABLES = (
    "SupplementProduct",
    "SupplementSchedule",
    "SupplementRecord",
    "Vaccine",
    "VaccineDose",
    "VaccineScheduleEntry",
    "VaccineStrategyGroup",
    "VaccineSelection",
    "VaccineRecord",
    # The legacy schema has this join table, but the source inventory is
    # currently zero and the canonical SourceRef promotion is a separate
    # slice.  Count it and fail closed if that ever changes.
    "VaccineSourceRef",
    # ScheduleEngineRule is part of the legacy vaccine graph, but its
    # canonical reference-table promotion is a separate slice. Count it and
    # fail closed until that slice is present; never silently drop rules.
    "ScheduleEngineRule",
)
IMPORTED_SUPPLEMENT_SOURCE_DEFAULT = "ui_manual"
KIND_ORDER = {
    "vaccine": 10,
    "vaccine_dose": 20,
    "vaccine_schedule_entry": 30,
    "vaccine_strategy_group": 40,
    "supplement_product": 50,
    "supplement_schedule": 60,
    "supplement": 70,
    "vaccine_selection": 80,
    "vaccine_record": 90,
}
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TIME_RE = re.compile(r"^(?:[01]\d|2[0-3]):[0-5]\d$")
_SENSITIVE_KEY = re.compile(
    r"(?:password|passwd|token|secret|credential|authorization|cookie|refresh|access)[_-]?",
    re.IGNORECASE,
)


def _import_identity_loader():
    try:
        from import_sql import load_archive, literal  # type: ignore

        return load_archive, literal
    except ModuleNotFoundError:
        path = Path(__file__).with_name("import_sql.py")
        spec = importlib.util.spec_from_file_location("legacy_import_sql_supplement_vaccine", path)
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
    return value.strip()


def _optional_text(value: Any, label: str, *, max_length: int | None = None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string or null")
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"{label} exceeds {max_length} characters")
    return value.strip() or None


def _boolean(value: Any, label: str, *, default: bool | None = None) -> bool:
    if value is None and default is not None:
        return default
    if isinstance(value, bool):
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    raise ValueError(f"{label} must be boolean or SQLite integer 0/1")


def _integer(value: Any, label: str, *, default: int | None = None, minimum: int | None = None) -> int | None:
    if value is None and default is not None:
        value = default
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} must be an integer")
    if minimum is not None and value < minimum:
        raise ValueError(f"{label} must be >= {minimum}")
    return value


def _decimal(value: Any, label: str, *, default: str | None = None, positive: bool = False) -> str | None:
    if value in (None, "") and default is not None:
        value = default
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise ValueError(f"{label} must be a finite number")
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError(f"{label} must be a finite number") from error
    if not parsed.is_finite() or (positive and parsed <= 0) or (not positive and parsed < 0):
        raise ValueError(f"{label} must be a {'positive' if positive else 'non-negative'} finite number")
    # All decimal targets in this slice are numeric(12,5). Reject values that
    # PostgreSQL would round or overflow; otherwise the target snapshot would
    # no longer describe the stored row and replay checks would be unsound.
    integer_digits = max(parsed.adjusted() + 1, 0) if parsed else 0
    fractional_digits = max(-parsed.as_tuple().exponent, 0)
    if integer_digits > 7 or integer_digits + fractional_digits > 12 or fractional_digits > 5:
        raise ValueError(f"{label} exceeds numeric(12,5)")
    return format(parsed, "f")


def _date(value: Any, label: str, *, allow_none: bool = False) -> str | None:
    if value in (None, "") and allow_none:
        return None
    if not isinstance(value, str) or not _DATE_RE.fullmatch(value):
        raise ValueError(f"{label} must be YYYY-MM-DD")
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} must be a valid calendar date") from error
    if parsed.isoformat() != value:
        raise ValueError(f"{label} must be YYYY-MM-DD")
    return value


def _time(value: Any, label: str, *, allow_none: bool = False) -> str | None:
    if value in (None, "") and allow_none:
        return None
    if not isinstance(value, str) or not _TIME_RE.fullmatch(value):
        raise ValueError(f"{label} must be HH:MM")
    return value


def _instant(value: Any, label: str, timezone_name: str) -> str:
    if value is None or isinstance(value, bool):
        raise ValueError(f"{label} must be a timestamp")
    if isinstance(value, (int, float)):
        if not math.isfinite(float(value)):
            raise ValueError(f"{label} must be a finite timestamp")
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


def _canonical_hash(row: dict[str, Any]) -> str:
    payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_value(value: Any, label: str, *, default: Any = None, expected: type | tuple[type, ...] | None = None) -> Any:
    if value in (None, ""):
        value = default
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError as error:
            raise ValueError(f"{label} is not valid JSON") from error
    if expected is not None and not isinstance(value, expected):
        raise ValueError(f"{label} has an invalid JSON shape")
    return value


def _redact(value: Any, key: str | None = None) -> Any:
    if key is not None and _SENSITIVE_KEY.search(key):
        return "[redacted]"
    if isinstance(value, dict):
        return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _rows(data: dict[str, Any], table: str) -> list[dict[str, Any]]:
    tables = data.get("tables")
    if not isinstance(tables, dict):
        raise ValueError("Archive tables must be an object")
    value = tables.get(table, [])
    if not isinstance(value, list):
        raise ValueError(f"Archive table {table} must be an array")
    output: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, row in enumerate(value):
        if not isinstance(row, dict):
            raise ValueError(f"{table}[{index}] must be an object")
        row_id = _text(row.get("id"), f"{table}[{index}].id")
        if row_id in seen:
            raise ValueError(f"Duplicate {table} ID {row_id}")
        seen.add(row_id)
        output.append(row)
    return output


def _identity(data: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[tuple[str, str], dict[str, Any]], set[tuple[str, str, str]]]:
    users = {row["id"]: row for row in _rows(data, "User")}
    families = {row["id"]: row for row in _rows(data, "Family")}
    babies = {row["id"]: row for row in _rows(data, "Baby")}
    members: dict[tuple[str, str], dict[str, Any]] = {}
    for row in _rows(data, "FamilyMember"):
        family_id = _text(row.get("familyId"), "FamilyMember.familyId")
        user_id = _text(row.get("userId"), "FamilyMember.userId")
        if family_id not in families or user_id not in users:
            raise ValueError("FamilyMember references an unknown identity")
        key = (family_id, user_id)
        if key in members:
            raise ValueError("Duplicate FamilyMember relation")
        members[key] = row
    explicit_baby_members: set[tuple[str, str, str]] = set()
    for row in _rows(data, "BabyMember"):
        family_id = _text(row.get("familyId"), "BabyMember.familyId")
        baby_id = _text(row.get("babyId"), "BabyMember.babyId")
        user_id = _text(row.get("userId"), "BabyMember.userId")
        if family_id not in families or baby_id not in babies or user_id not in users:
            raise ValueError("BabyMember references an unknown identity")
        if babies[baby_id].get("familyId") != family_id or (family_id, user_id) not in members:
            raise ValueError("BabyMember crosses identity scope")
        explicit_baby_members.add((family_id, baby_id, user_id))
    for baby_id, baby in babies.items():
        family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
        if family_id not in families:
            raise ValueError(f"Baby/{baby_id} references an unknown family")
    return users, families, babies, members, explicit_baby_members


def _family_owner(
    family_id: str,
    users: dict[str, dict[str, Any]],
    families: dict[str, dict[str, Any]],
    members: dict[tuple[str, str], dict[str, Any]],
) -> str:
    if family_id not in families:
        raise ValueError(f"unknown family {family_id}")
    active = [
        (user_id, row)
        for (candidate_family, user_id), row in members.items()
        if candidate_family == family_id and row.get("status", "active") == "active" and user_id in users
    ]
    if not active:
        raise ValueError(f"family {family_id} has no active member")
    admins = sorted(user_id for user_id, row in active if row.get("role") == "admin")
    if not admins:
        raise ValueError(f"family {family_id} has no active administrator")
    return admins[0]


def _baby_context(
    data: dict[str, Any],
    row: dict[str, Any],
    table: str,
    *,
    require_actor: bool = True,
) -> tuple[str, str, str | None]:
    users, families, babies, members, explicit_baby_members = _identity(data)
    row_id = _text(row.get("id"), f"{table}.id")
    baby_id = _text(row.get("babyId", row.get("babyID")), f"{table}/{row_id}.babyId")
    baby = babies.get(baby_id)
    if baby is None:
        raise ValueError(f"{table}/{row_id}: baby is not in identity archive")
    family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
    if family_id not in families:
        raise ValueError(f"{table}/{row_id}: baby family is not in identity archive")
    explicit_family = row.get("familyId")
    if explicit_family is not None and explicit_family != family_id:
        raise ValueError(f"{table}/{row_id}: explicit familyId crosses baby family")
    actor = None
    for field in ("recordedById", "recordedByUserId", "caregiverId", "userId"):
        if row.get(field) not in (None, ""):
            actor = _text(row[field], f"{table}/{row_id}.{field}")
            break
    if actor is None and require_actor:
        actor = _family_owner(family_id, users, families, members)
    if actor is not None:
        if actor not in users or (family_id, actor) not in members:
            raise ValueError(f"{table}/{row_id}: actor is outside the baby family")
        if members[(family_id, actor)].get("status", "active") != "active":
            raise ValueError(f"{table}/{row_id}: actor is not an active family member")
        if explicit_baby_members and (family_id, baby_id, actor) not in explicit_baby_members:
            raise ValueError(f"{table}/{row_id}: actor is not a member of the baby")
    return family_id, baby_id, actor


def _family_context(data: dict[str, Any], row: dict[str, Any], table: str) -> tuple[str, str | None]:
    users, families, _babies, members, _explicit = _identity(data)
    row_id = _text(row.get("id"), f"{table}.id")
    family_id = _text(row.get("familyId"), f"{table}/{row_id}.familyId")
    actor = None
    for field in ("recordedById", "recordedByUserId", "userId"):
        if row.get(field) not in (None, ""):
            actor = _text(row[field], f"{table}/{row_id}.{field}")
            break
    _family_owner(family_id, users, families, members)
    if actor is not None and (family_id, actor) not in members:
        raise ValueError(f"{table}/{row_id}: actor is outside the family")
    if actor is not None and members[(family_id, actor)].get("status", "active") != "active":
        raise ValueError(f"{table}/{row_id}: actor is not an active family member")
    return family_id, actor


def _created_updated(data: dict[str, Any], row: dict[str, Any]) -> tuple[str, str]:
    timezone_name = data.get("timeZone")
    if not isinstance(timezone_name, str) or not timezone_name:
        raise ValueError("Archive timeZone is required")
    created = _instant(row.get("createdAt", data.get("capturedAt")), "createdAt", timezone_name)
    updated = _instant(row.get("updatedAt", row.get("createdAt", data.get("capturedAt"))), "updatedAt", timezone_name)
    return created, updated


def _legacy_metadata(data: dict[str, Any], table: str, row: dict[str, Any], source_hash: str) -> dict[str, Any]:
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceTable": table,
        "sourceId": row["id"],
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "legacyRow": _redact(row),
    }


def _target_hash(snapshot: dict[str, Any]) -> str:
    return hashlib.sha256(_json(snapshot).encode("utf-8")).hexdigest()


def _item(
    data: dict[str, Any],
    table: str,
    row: dict[str, Any],
    kind: str,
    target_table: str,
    columns: dict[str, Any],
    *,
    family_id: str | None = None,
    baby_id: str | None = None,
    occurred_at: str | None = None,
    timeline_summary: str | None = None,
    timeline_details: dict[str, Any] | None = None,
    unique_where: dict[str, Any] | None = None,
) -> dict[str, Any]:
    source_hash = _canonical_hash(row)
    target_snapshot = dict(columns)
    target_snapshot_hash = _target_hash(target_snapshot)
    return {
        "kind": kind,
        "source_table": table,
        "source_id": row["id"],
        "source_hash": source_hash,
        "target_table": target_table,
        "target_id": columns["id"],
        "columns": columns,
        "target_snapshot": target_snapshot,
        "target_hash": target_snapshot_hash,
        "family_id": family_id,
        "baby_id": baby_id,
        "occurred_at": occurred_at,
        "timeline_summary": timeline_summary,
        "timeline_details": timeline_details,
        "unique_where": unique_where,
        "legacy_metadata": columns.get("legacy_metadata"),
    }


def _supplement_products(data: dict[str, Any]) -> list[dict[str, Any]]:
    output = []
    for row in _rows(data, "SupplementProduct"):
        family_id, _actor = _family_context(data, row, "SupplementProduct")
        product_name = _text(row.get("name"), f"SupplementProduct/{row['id']}.name", max_length=200)
        brand = _text(row.get("brand"), f"SupplementProduct/{row['id']}.brand", max_length=100)
        dosage_form = _text(row.get("dosageForm"), f"SupplementProduct/{row['id']}.dosageForm", max_length=50)
        unit = _text(row.get("unitName", row.get("unit")), f"SupplementProduct/{row['id']}.unitName", max_length=50)
        default_dose = _decimal(row.get("defaultDose"), f"SupplementProduct/{row['id']}.defaultDose", default="1", positive=True)
        assert default_dose is not None
        nutrients = _json_value(
            row.get("nutrientsJson", row.get("nutrients")),
            f"SupplementProduct/{row['id']}.nutrientsJson",
            expected=dict,
        )
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "SupplementProduct", row, _canonical_hash(row))
        columns = {
            "id": row["id"], "family_id": family_id, "name": product_name,
            "brand": brand,
            "dosage_form": dosage_form,
            "unit_name": unit, "default_dose": default_dose,
            "nutrients_json": nutrients,
            "notes": _optional_text(row.get("notes"), "notes"),
            "is_active": _boolean(row.get("isActive"), "isActive", default=True),
            "is_archived": _boolean(row.get("isArchived"), "isArchived", default=False),
            "version": 1, "deleted_at": None, "created_at": created, "updated_at": updated,
            "legacy_metadata": metadata,
        }
        output.append(_item(data, "SupplementProduct", row, "supplement_product", "supplement_products", columns, family_id=family_id,
                            unique_where={"family_id": family_id, "name": product_name, "unit_name": unit}))
    return output


def _supplement_schedules(data: dict[str, Any], products: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for row in _rows(data, "SupplementSchedule"):
        family_id, baby_id, _actor = _baby_context(data, row, "SupplementSchedule", require_actor=False)
        product_id = _text(row.get("productId"), f"SupplementSchedule/{row['id']}.productId")
        product = products.get(product_id)
        if product is None or product["columns"]["family_id"] != family_id:
            raise ValueError(f"SupplementSchedule/{row['id']}: product is outside baby family")
        frequency = _text(row.get("frequency", "daily"), f"SupplementSchedule/{row['id']}.frequency", max_length=32)
        if frequency not in {"daily", "alternate_day", "specific_days"}:
            raise ValueError(f"SupplementSchedule/{row['id']}.frequency is invalid")
        custom_days = _json_value(row.get("customDaysJson", row.get("customDays")), f"SupplementSchedule/{row['id']}.customDaysJson", default=None, expected=(list, dict))
        target_dose = _decimal(row.get("targetDose"), f"SupplementSchedule/{row['id']}.targetDose", default="1", positive=True)
        assert target_dose is not None
        reminder = _time(row.get("reminderTime"), f"SupplementSchedule/{row['id']}.reminderTime", allow_none=True)
        start_date = _date(row.get("startDate"), f"SupplementSchedule/{row['id']}.startDate", allow_none=True)
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "SupplementSchedule", row, _canonical_hash(row))
        columns = {
            "id": row["id"], "family_id": family_id, "baby_id": baby_id, "product_id": product_id,
            "frequency": frequency, "custom_days_json": custom_days, "target_dose": target_dose,
            "reminder_time": reminder, "is_active": _boolean(row.get("isActive"), "isActive", default=True),
            "start_date": start_date, "notes": _optional_text(row.get("notes"), "notes"), "version": 1,
            "deleted_at": None, "created_at": created, "updated_at": updated, "legacy_metadata": metadata,
        }
        output.append(_item(data, "SupplementSchedule", row, "supplement_schedule", "supplement_schedules", columns,
                            family_id=family_id, baby_id=baby_id))
    return output


def _supplement_records(data: dict[str, Any], products: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    timezone_name = data["timeZone"]
    output = []
    for row in _rows(data, "SupplementRecord"):
        family_id, baby_id, actor = _baby_context(data, row, "SupplementRecord")
        product_id = _text(row.get("productId", row.get("productID")), f"SupplementRecord/{row['id']}.productId")
        product = products.get(product_id)
        if product is None or product["columns"]["family_id"] != family_id:
            raise ValueError(f"SupplementRecord/{row['id']}: product is outside baby family")
        name = _optional_text(row.get("productName"), "productName", max_length=100)
        if name is None and product is not None:
            name = product["columns"]["name"]
        if name is None:
            raise ValueError(f"SupplementRecord/{row['id']}: productName or productId is required")
        dose = _decimal(row.get("dose"), f"SupplementRecord/{row['id']}.dose", default=(product["columns"]["default_dose"] if product else "1"), positive=True)
        assert dose is not None
        unit = _optional_text(row.get("unitName", row.get("unit")), "unitName", max_length=50)
        if unit is None and product is not None:
            unit = product["columns"]["unit_name"]
        if unit is None:
            unit = "份"
        date_value = _date(row.get("date", row.get("recordedDate")), f"SupplementRecord/{row['id']}.date")
        time_value = _time(row.get("time", row.get("recordedTime")), f"SupplementRecord/{row['id']}.time")
        assert date_value is not None and time_value is not None
        occurred = _instant(f"{date_value}T{time_value}:00", f"SupplementRecord/{row['id']}.date/time", timezone_name)
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "SupplementRecord", row, _canonical_hash(row))
        columns = {
            "id": row["id"], "family_id": family_id, "baby_id": baby_id, "supplement_name": name,
            "occurred_at": occurred, "amount": f"{dose} {unit}", "notes": _optional_text(row.get("notes"), "notes", max_length=1000),
            "product_id": product_id, "dose": dose, "unit_name": unit, "source": _optional_text(row.get("source"), "source") or IMPORTED_SUPPLEMENT_SOURCE_DEFAULT,
            "source_agent": _optional_text(row.get("sourceAgent"), "sourceAgent"), "legacy_client_id": _optional_text(row.get("clientId"), "clientId", max_length=128),
            "legacy_metadata": metadata, "recorded_by_user_id": actor, "version": 1, "deleted_at": None,
            "created_at": created, "updated_at": updated,
        }
        output.append(_item(data, "SupplementRecord", row, "supplement", "supplement_records", columns,
                            family_id=family_id, baby_id=baby_id, occurred_at=occurred,
                            timeline_summary=f"补剂: {name}", timeline_details={"dose": dose, "unitName": unit},
                            unique_where={"baby_id": baby_id, "legacy_client_id": columns["legacy_client_id"]} if columns["legacy_client_id"] else None))
    return output


def _vaccine_maps(data: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    rows = _rows(data, "Vaccine")
    by_id = {row["id"]: row for row in rows}
    by_code: dict[str, dict[str, Any]] = {}
    for row in rows:
        code = _text(row.get("vaccineId", row.get("code")), f"Vaccine/{row['id']}.vaccineId", max_length=100)
        if code in by_code and by_code[code]["id"] != row["id"]:
            raise ValueError(f"Duplicate Vaccine code {code}")
        by_code[code] = row
    return by_id, by_code


def _resolve_vaccine(row: dict[str, Any], by_id: dict[str, dict[str, Any]], by_code: dict[str, dict[str, Any]], label: str, *, required: bool = True) -> dict[str, Any] | None:
    raw = next((row.get(field) for field in ("vaccineId", "vaccineID", "vaccineCode") if row.get(field) not in (None, "")), None)
    if raw not in (None, ""):
        value = _text(raw, f"{label}.vaccineId")
        resolved = by_id.get(value) or by_code.get(value)
        if resolved is None:
            raise ValueError(f"{label}: vaccine reference is unresolved")
        return resolved
    name = row.get("name")
    if isinstance(name, str) and name.strip():
        matches = {candidate["id"]: candidate for candidate in (*by_id.values(), *by_code.values()) if candidate.get("name") == name}
        if len(matches) == 1:
            return next(iter(matches.values()))
        if len(matches) > 1:
            raise ValueError(f"{label}: vaccine name reference is ambiguous")
    if not required:
        return None
    raise ValueError(f"{label}.vaccineId is required")


def _vaccine_rows(data: dict[str, Any]) -> list[dict[str, Any]]:
    by_id, _by_code = _vaccine_maps(data)
    output = []
    for row in _rows(data, "Vaccine"):
        source_hash = _canonical_hash(row)
        code = _text(row.get("vaccineId", row.get("code")), f"Vaccine/{row['id']}.vaccineId", max_length=100)
        name = _text(row.get("name"), f"Vaccine/{row['id']}.name", max_length=200)
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "Vaccine", row, source_hash)
        columns = {
            "id": row["id"], "vaccine_code": code, "name": name,
            "short_name": _text(row.get("shortName"), f"Vaccine/{row['id']}.shortName", max_length=200),
            "english_name": _optional_text(row.get("englishName"), "englishName", max_length=200),
            "program_type": _text(row.get("programType"), f"Vaccine/{row['id']}.programType", max_length=80),
            "legacy_label": _optional_text(row.get("legacyLabel"), "legacyLabel", max_length=100),
            "sex_restriction": _optional_text(row.get("sexRestriction"), "sexRestriction", max_length=20) or "all",
            "china_national": _boolean(row.get("chinaNational"), "chinaNational", default=False),
            "diseases": _json_value(row.get("diseases"), f"Vaccine/{row['id']}.diseases", expected=list),
            "target_population": _optional_text(row.get("targetPopulation"), "targetPopulation"),
            "policy_effective_date": _date(row.get("policyEffectiveDate"), "policyEffectiveDate", allow_none=True),
            "policy_version": _optional_text(row.get("policyVersion"), "policyVersion", max_length=100),
            "routine_healthy_child_option": _boolean(row.get("routineHealthyChildOption"), "routineHealthyChildOption", default=True),
            "manual_review_required": _boolean(row.get("manualReviewRequired"), "manualReviewRequired", default=False),
            "market_status": _optional_text(row.get("marketStatus"), "marketStatus", max_length=50),
            "product_brand_name": _optional_text(row.get("productBrandName"), "productBrandName", max_length=200),
            "product_manufacturer": _optional_text(row.get("productManufacturer"), "productManufacturer", max_length=200),
            "product_approval_number": _optional_text(row.get("productApprovalNumber"), "productApprovalNumber", max_length=100),
            "jiangsu_notes": _optional_text(row.get("jiangsuNotes"), "jiangsuNotes"),
            "suzhou_notes": _optional_text(row.get("suzhouNotes"), "suzhouNotes"),
            "catch_up_supported": _boolean(row.get("catchUpSupported"), "catchUpSupported", default=False),
            "catch_up_rules": _json_value(row.get("catchUpRules"), f"Vaccine/{row['id']}.catchUpRules", expected=list),
            "simultaneous_vaccination": _optional_text(row.get("simultaneousVaccination"), "simultaneousVaccination"),
            "substitution_rules": _json_value(row.get("substitutionRules"), f"Vaccine/{row['id']}.substitutionRules", expected=list),
            "contraindications": _json_value(row.get("contraindications"), f"Vaccine/{row['id']}.contraindications", expected=list),
            "precautions": _json_value(row.get("precautions"), f"Vaccine/{row['id']}.precautions", expected=list),
            "special_populations": _json_value(row.get("specialPopulations"), f"Vaccine/{row['id']}.specialPopulations", expected=list),
            "regional_overrides": _json_value(row.get("regionalOverrides"), f"Vaccine/{row['id']}.regionalOverrides", expected=list),
            "regimen_options": _json_value(row.get("regimenOptions"), f"Vaccine/{row['id']}.regimenOptions", expected=list),
            "source_refs_json": _json_value(row.get("sourceRefsJson", row.get("sourceRefs")), f"Vaccine/{row['id']}.sourceRefsJson", expected=list),
            "legacy_metadata": metadata, "created_at": created, "updated_at": updated,
        }
        output.append(_item(data, "Vaccine", row, "vaccine", "vaccines", columns))
    return output


def _vaccine_doses(data: dict[str, Any], by_id: dict[str, dict[str, Any]], by_code: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for row in _rows(data, "VaccineDose"):
        vaccine = _resolve_vaccine(row, by_id, by_code, f"VaccineDose/{row['id']}")
        assert vaccine is not None
        dose_number = _integer(row.get("doseNumber"), f"VaccineDose/{row['id']}.doseNumber", minimum=1)
        assert dose_number is not None
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "VaccineDose", row, _canonical_hash(row))
        columns = {
            "id": row["id"], "vaccine_id": vaccine["id"], "dose_number": dose_number,
            "dose_label": _text(row.get("doseLabel"), f"VaccineDose/{row['id']}.doseLabel", max_length=100),
            "recommended_age_months": _integer(row.get("recommendedAgeMonths"), "recommendedAgeMonths", minimum=0),
            "minimum_age_days": _integer(row.get("minimumAgeDays"), "minimumAgeDays", minimum=0),
            "maximum_age_days": _integer(row.get("maximumAgeDays"), "maximumAgeDays", minimum=0),
            "recommended_age_max_months": _integer(row.get("recommendedAgeMaxMonths"), "recommendedAgeMaxMonths", minimum=0),
            "minimum_interval_days_from_previous": _integer(row.get("minimumIntervalDaysFromPrevious"), "minimumIntervalDaysFromPrevious", minimum=0),
            "maximum_interval_days_from_previous": _integer(row.get("maximumIntervalDaysFromPrevious"), "maximumIntervalDaysFromPrevious", minimum=0),
            "route": _optional_text(row.get("route"), "route", max_length=50), "site": _optional_text(row.get("site"), "site", max_length=100),
            "dose_volume_ml": _decimal(row.get("doseVolumeMl"), "doseVolumeMl", positive=True), "notes": _optional_text(row.get("notes"), "notes"),
            "source_refs_json": _json_value(row.get("sourceRefsJson", row.get("sourceRefs")), f"VaccineDose/{row['id']}.sourceRefsJson", expected=list),
            "legacy_metadata": metadata, "created_at": created, "updated_at": updated,
        }
        output.append(_item(data, "VaccineDose", row, "vaccine_dose", "vaccine_doses", columns))
    return output


def _vaccine_schedule_entries(data: dict[str, Any], by_id: dict[str, dict[str, Any]], by_code: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for row in _rows(data, "VaccineScheduleEntry"):
        vaccine = _resolve_vaccine(row, by_id, by_code, f"VaccineScheduleEntry/{row['id']}")
        assert vaccine is not None
        dose_number = _integer(row.get("doseNumber"), f"VaccineScheduleEntry/{row['id']}.doseNumber", minimum=1)
        assert dose_number is not None
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "VaccineScheduleEntry", row, _canonical_hash(row))
        columns = {
            "id": row["id"], "vaccine_id": vaccine["id"],
            "age_months": _integer(row.get("ageMonths"), "ageMonths", minimum=0), "age_days": _integer(row.get("ageDays"), "ageDays", minimum=0),
            "age_label": _optional_text(row.get("ageLabel"), "ageLabel", max_length=100), "dose_number": dose_number,
            "priority": _text(row.get("priority"), f"VaccineScheduleEntry/{row['id']}.priority", max_length=30), "is_optional": _boolean(row.get("isOptional"), "isOptional", default=False),
            "action": _optional_text(row.get("action"), "action"), "selection_group": _optional_text(row.get("selectionGroup"), "selectionGroup", max_length=100),
            "notes": _optional_text(row.get("notes"), "notes"), "source_refs_json": _json_value(row.get("sourceRefsJson", row.get("sourceRefs")), f"VaccineScheduleEntry/{row['id']}.sourceRefsJson", expected=list),
            "legacy_metadata": metadata, "created_at": created, "updated_at": updated,
        }
        output.append(_item(data, "VaccineScheduleEntry", row, "vaccine_schedule_entry", "vaccine_schedule_entries", columns))
    return output


def _vaccine_strategy_groups(data: dict[str, Any], by_id: dict[str, dict[str, Any]], by_code: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for row in _rows(data, "VaccineStrategyGroup"):
        vaccine = _resolve_vaccine(row, by_id, by_code, f"VaccineStrategyGroup/{row['id']}", required=False)
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "VaccineStrategyGroup", row, _canonical_hash(row))
        strategy_id = _text(row.get("strategyId"), f"VaccineStrategyGroup/{row['id']}.strategyId", max_length=100)
        name = _text(row.get("name"), f"VaccineStrategyGroup/{row['id']}.name", max_length=200)
        columns = {
            "id": row["id"], "strategy_id": strategy_id, "vaccine_id": vaccine["id"] if vaccine else None,
            "name": name, "scope": _optional_text(row.get("scope"), "scope", max_length=100), "base_program": _optional_text(row.get("baseProgram"), "baseProgram", max_length=100),
            "options_json": _json_value(row.get("optionsJson", row.get("options")), f"VaccineStrategyGroup/{row['id']}.optionsJson", expected=list),
            "source_refs_json": _json_value(row.get("sourceRefsJson", row.get("sourceRefs")), f"VaccineStrategyGroup/{row['id']}.sourceRefsJson", expected=list),
            "legacy_metadata": metadata, "created_at": created, "updated_at": updated,
        }
        output.append(_item(data, "VaccineStrategyGroup", row, "vaccine_strategy_group", "vaccine_strategy_groups", columns,
                            unique_where={"strategy_id": strategy_id}))
    return output


def _vaccine_selections(data: dict[str, Any], by_id: dict[str, dict[str, Any]], by_code: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for row in _rows(data, "VaccineSelection"):
        family_id, baby_id, _actor = _baby_context(data, row, "VaccineSelection", require_actor=False)
        vaccine = _resolve_vaccine(row, by_id, by_code, f"VaccineSelection/{row['id']}")
        assert vaccine is not None
        dose_number = _integer(row.get("doseNumber"), f"VaccineSelection/{row['id']}.doseNumber", default=1, minimum=1)
        assert dose_number is not None
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "VaccineSelection", row, _canonical_hash(row))
        columns = {
            "id": row["id"], "family_id": family_id, "baby_id": baby_id, "vaccine_id": vaccine["id"], "dose_number": dose_number,
            "selected": _boolean(row.get("selected"), "selected", default=True), "completed": _boolean(row.get("completed"), "completed", default=False),
            "version": 1, "legacy_metadata": metadata, "created_at": created, "updated_at": updated,
        }
        output.append(_item(data, "VaccineSelection", row, "vaccine_selection", "vaccine_selections", columns,
                            family_id=family_id, baby_id=baby_id, unique_where={"baby_id": baby_id, "vaccine_id": vaccine["id"], "dose_number": dose_number}))
    return output


def _vaccine_records(data: dict[str, Any], by_id: dict[str, dict[str, Any]], by_code: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    output = []
    for row in _rows(data, "VaccineRecord"):
        family_id, baby_id, caregiver = _baby_context(data, row, "VaccineRecord")
        name = _text(row.get("name"), f"VaccineRecord/{row['id']}.name", max_length=200)
        vaccine = _resolve_vaccine(row, by_id, by_code, f"VaccineRecord/{row['id']}", required=False)
        code = (vaccine.get("vaccineId") or vaccine["id"]) if vaccine else (_optional_text(row.get("vaccineCode"), "vaccineCode", max_length=100) or f"legacy:{hashlib.sha256(name.encode()).hexdigest()[:32]}")
        scheduled = _date(row.get("scheduledDate", row.get("date")), f"VaccineRecord/{row['id']}.scheduledDate")
        completed = _date(row.get("completedDate"), f"VaccineRecord/{row['id']}.completedDate", allow_none=True)
        administered = completed or scheduled
        assert administered is not None
        is_completed = _boolean(row.get("isCompleted"), "isCompleted", default=completed is not None)
        if is_completed and completed is None:
            raise ValueError(f"VaccineRecord/{row['id']}: completed record requires completedDate")
        if not is_completed and completed is not None:
            raise ValueError(f"VaccineRecord/{row['id']}: incomplete record cannot have completedDate")
        if scheduled is not None and completed is not None and completed < scheduled:
            raise ValueError(f"VaccineRecord/{row['id']}: completedDate precedes scheduledDate")
        dose_text = _text(row.get("dose"), f"VaccineRecord/{row['id']}.dose", max_length=100)
        dose_number = _integer(row.get("doseNumber"), "doseNumber", minimum=1)
        created, updated = _created_updated(data, row)
        metadata = _legacy_metadata(data, "VaccineRecord", row, _canonical_hash(row))
        columns = {
            "id": row["id"], "family_id": family_id, "baby_id": baby_id, "caregiver_id": caregiver, "vaccine_code": code,
            "vaccine_id": vaccine["id"] if vaccine else None, "dose_number": dose_number, "legacy_name": name, "legacy_dose": dose_text,
            "administered_date": administered,
            "scheduled_date": scheduled, "completed_date": completed, "is_completed": is_completed,
            "clinic": _optional_text(row.get("clinic"), "clinic", max_length=200), "batch_number": _optional_text(row.get("batchNumber"), "batchNumber", max_length=100),
            "notes": _optional_text(row.get("notes"), "notes", max_length=1000), "legacy_metadata": metadata,
            "version": 1, "deleted_at": None, "created_at": created, "updated_at": updated,
        }
        output.append(_item(data, "VaccineRecord", row, "vaccine_record", "vaccine_records", columns,
                            family_id=family_id, baby_id=baby_id, occurred_at=administered,
                            timeline_summary=f"疫苗: {name} ({dose_text})", timeline_details={"name": name, "dose": dose_text, "isCompleted": columns["is_completed"]}))
    return output


def prepare_materialization(data: dict[str, Any], checksum: str) -> list[dict[str, Any]]:
    """Validate and map the complete supplement/vaccine slice before SQL."""

    _require_checksum(checksum)
    if data.get("formatVersion") != 1 or data.get("timeZone") != "Asia/Shanghai":
        raise ValueError("Unsupported archive format or timezone")
    _identity(data)
    unsupported_tables = {
        "VaccineSourceRef": "VaccineSourceRef rows require the canonical source-reference promotion slice",
        "ScheduleEngineRule": "ScheduleEngineRule rows require the canonical vaccine-rule promotion slice",
    }
    for table, message in unsupported_tables.items():
        if _rows(data, table):
            raise ValueError(message)
    products = {item["target_id"]: item for item in _supplement_products(data)}
    by_id, by_code = _vaccine_maps(data)
    items = []
    items.extend(_vaccine_rows(data))
    items.extend(_vaccine_doses(data, by_id, by_code))
    items.extend(_vaccine_schedule_entries(data, by_id, by_code))
    items.extend(_vaccine_strategy_groups(data, by_id, by_code))
    items.extend(products.values())
    items.extend(_supplement_schedules(data, products))
    items.extend(_supplement_records(data, products))
    items.extend(_vaccine_selections(data, by_id, by_code))
    items.extend(_vaccine_records(data, by_id, by_code))
    seen_target: set[tuple[str, str]] = set()
    for item in items:
        key = (item["target_table"], item["target_id"])
        if key in seen_target:
            raise ValueError(f"Duplicate target ID {key[0]}/{key[1]}")
        seen_target.add(key)
    return sorted(items, key=lambda item: (KIND_ORDER[item["kind"]], item["source_id"]))


JSON_COLUMNS = {
    "nutrients_json", "custom_days_json", "legacy_metadata", "diseases", "catch_up_rules", "substitution_rules",
    "contraindications", "precautions", "special_populations", "regional_overrides", "regimen_options", "source_refs_json",
    "options_json", "details",
}


def _sql_value(value: Any, column: str | None = None) -> str:
    if column in JSON_COLUMNS:
        if value is None:
            return "NULL"
        return f"{literal(_json(value))}::jsonb"
    return literal(value)


def _predicate(columns: dict[str, Any], alias: str) -> str:
    return " AND ".join(f"{alias}.\"{column}\" IS NOT DISTINCT FROM {_sql_value(value, column)}" for column, value in columns.items())


def _mapping_id(item: dict[str, Any], checksum: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk/legacy-supplement-vaccine/{checksum}/{item['kind']}/{item['source_id']}"))


def _source_key(item: dict[str, Any], checksum: str) -> str:
    return f"{checksum}:{item['source_table']}:{item['source_id']}"


def _receipt_metadata(data: dict[str, Any], item: dict[str, Any], checksum: str) -> dict[str, Any]:
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceBatchId": checksum,
        "sourceTable": item["source_table"],
        "sourceId": item["source_id"],
        "sourceHashSha256": item["source_hash"],
        "mappingVersion": MAPPING_VERSION,
        "targetSnapshot": item["target_snapshot"],
        "targetHashSha256": item["target_hash"],
        "familyId": item["family_id"],
        "babyId": item["baby_id"],
    }


def _timeline_columns(item: dict[str, Any]) -> dict[str, Any] | None:
    if item["timeline_summary"] is None:
        return None
    return {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"growdesk/legacy-supplement-vaccine-timeline/{item['kind']}/{item['target_id']}")),
        "family_id": item["family_id"], "baby_id": item["baby_id"], "entity_type": "supplement" if item["kind"] == "supplement" else "vaccine",
        "entity_id": item["target_id"], "occurred_at": item["occurred_at"], "summary": item["timeline_summary"],
        "details": item["timeline_details"] or {}, "source": SOURCE_SYSTEM_DEFAULT, "version": 1, "deleted_at": None,
        "created_at": item["columns"]["created_at"], "updated_at": item["columns"]["updated_at"],
    }


def _render_item(item: dict[str, Any], data: dict[str, Any], checksum: str, source_system: str) -> str:
    source_key = _source_key(item, checksum)
    mapping_id = _mapping_id(item, checksum)
    receipt = _receipt_metadata(data, item, checksum)
    receipt_sql = _sql_value(receipt, "legacy_metadata")
    raw_guard = (
        f"IF NOT EXISTS (SELECT 1 FROM legacy_import.import_rows r WHERE r.batch_id={literal(checksum)} "
        f"AND r.source_table={literal(item['source_table'])} AND r.source_id={literal(item['source_id'])} "
        f"AND r.payload_hash={literal(item['source_hash'])}) THEN "
        f"RAISE EXCEPTION 'Legacy supplement/vaccine source hash mismatch: %', {literal(source_key)}; END IF;"
    )
    target_predicate = _predicate(item["columns"], "t")
    unique_guard = ""
    if item.get("unique_where"):
        unique_guard = (
            f"IF EXISTS (SELECT 1 FROM public.{item['target_table']} u WHERE "
            + " AND ".join(f"u.\"{key}\" IS NOT DISTINCT FROM {_sql_value(value, key)}" for key, value in item["unique_where"].items())
            + f" AND u.\"id\" <> {literal(item['target_id'])}) THEN RAISE EXCEPTION 'Legacy target unique scope conflict: %', {literal(source_key)}; END IF;"
        )
    insert_columns = ",".join(f'"{key}"' for key in item["columns"])
    insert_values = ",".join(_sql_value(value, key) for key, value in item["columns"].items())
    timeline = _timeline_columns(item)
    timeline_sql = ""
    replay_timeline = "TRUE"
    if timeline is not None:
        timeline_columns = ",".join(f'"{key}"' for key in timeline)
        timeline_values = ",".join(_sql_value(value, key) for key, value in timeline.items())
        timeline_sql = f"INSERT INTO public.timeline_entries ({timeline_columns}) VALUES ({timeline_values});"
        replay_timeline = _predicate(timeline, "e")
    else:
        target_predicate = target_predicate or "TRUE"
        replay_timeline = f"NOT EXISTS (SELECT 1 FROM public.timeline_entries e WHERE e.\"entity_id\"={literal(item['target_id'])})"
    mapping_check = (
        f"IF NOT EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m "
        f"WHERE m.target_entity_type={literal(item['kind'])} AND m.source_key={literal(source_key)} "
        f"AND m.target_entity_id={literal(item['target_id'])} AND m.source_hash={literal(item['source_hash'])} "
        f"AND m.mapping_version={literal(MAPPING_VERSION)} AND m.metadata={receipt_sql} "
        f"AND EXISTS (SELECT 1 FROM public.{item['target_table']} t WHERE {target_predicate}) "
        f"AND EXISTS (SELECT 1 FROM public.timeline_entries e WHERE {replay_timeline})) THEN "
        f"RAISE EXCEPTION 'Legacy supplement/vaccine receipt conflict or missing target: %', {literal(source_key)}; END IF;"
    )
    mapping_insert = (
        "INSERT INTO public.legacy_idempotency_mappings "
        "(id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,source_hash,mapping_version,metadata,created_at) "
        f"VALUES ({literal(mapping_id)},{literal(item['kind'])},{literal(item['target_id'])},{literal(source_key)},'mapped',"
        f"{literal(source_system)},{literal(checksum)},{literal(item['source_table'])},{literal(item['source_id'])},{literal(item['source_hash'])},"
        f"{literal(MAPPING_VERSION)},{receipt_sql},{literal(item['columns']['created_at'])});"
    )
    return f"""
    {raw_guard}
    IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings m
      WHERE m.target_entity_type={literal(item['kind'])} AND m.source_key={literal(source_key)}) THEN
      {mapping_check}
    ELSE
      IF EXISTS (SELECT 1 FROM public.{item['target_table']} t WHERE t.\"id\"={literal(item['target_id'])}) THEN
        RAISE EXCEPTION 'Legacy target ID already exists without matching receipt: %', {literal(source_key)};
      END IF;
      {unique_guard}
      INSERT INTO public.{item['target_table']} ({insert_columns}) VALUES ({insert_values});
      {timeline_sql}
      {mapping_insert}
    END IF;
    """


def render_materialization(data: dict[str, Any], checksum: str) -> str:
    _require_checksum(checksum)
    items = prepare_materialization(data, checksum)
    tables = {table: _rows(data, table) for table in SOURCE_TABLES}
    expected_counts = {table: len(rows) for table, rows in tables.items()}
    archive_tables = data.get("tables")
    if not isinstance(archive_tables, dict):
        raise ValueError("Archive tables must be an object")
    archive_counts = {str(table): len(_rows(data, str(table))) for table in archive_tables}
    total_rows = sum(archive_counts.values())
    source_system = data.get("sourceId") or SOURCE_SYSTEM_DEFAULT
    delimiter = f"$legacy_sv_{checksum}$"
    body = "\n".join(_render_item(item, data, checksum, source_system) for item in items)
    if delimiter in body:
        raise ValueError("SQL dollar-quote delimiter collision")
    table_checks_parts: list[str] = []
    for table, count in expected_counts.items():
        table_checks_parts.append(
            f"IF (SELECT count(*) FROM legacy_import.import_rows WHERE batch_id={literal(checksum)} AND source_table={literal(table)}) <> {count} THEN RAISE EXCEPTION 'Legacy {table} source count mismatch'; END IF;"
        )
        if count:
            source_ids = ",".join(literal(row["id"]) for row in tables[table])
            table_checks_parts.append(
                f"IF EXISTS (SELECT 1 FROM legacy_import.import_rows WHERE batch_id={literal(checksum)} AND source_table={literal(table)} AND source_id NOT IN ({source_ids})) THEN RAISE EXCEPTION 'Legacy {table} source ID mismatch'; END IF;"
            )
    table_checks = "\n".join(table_checks_parts)
    return f"""BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='120s';
SELECT pg_advisory_xact_lock({ADVISORY_LOCK});
DO {delimiter}
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM legacy_import.import_batches b
    WHERE b.batch_id={literal(checksum)} AND b.checksum={literal(checksum)}
      AND b.mapping_version='identity-v1' AND b.row_count={total_rows}
      AND b.table_counts={literal(_json(archive_counts))}::jsonb
  ) THEN
    RAISE EXCEPTION 'Legacy supplement/vaccine identity batch mismatch: %', {literal(checksum)};
  END IF;
  {table_checks}
  {body}
END;
{delimiter};
COMMIT;
SELECT json_build_object(
  'mappingVersion',{literal(MAPPING_VERSION)},
  'sourceCounts',{literal(_json(expected_counts))}::jsonb,
  'targetCount',(SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND mapping_version={literal(MAPPING_VERSION)}),
  'supplementRecords',(SELECT count(*) FROM public.supplement_records WHERE id IN (SELECT target_entity_id FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='supplement')),
  'vaccineRecords',(SELECT count(*) FROM public.vaccine_records WHERE id IN (SELECT target_entity_id FROM public.legacy_idempotency_mappings WHERE source_batch_id={literal(checksum)} AND target_entity_type='vaccine_record'))
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
        expected = _require_checksum(args.sha256)
        if actual_checksum != expected:
            raise ValueError("Archive checksum mismatch")
        sql = render_materialization(data, actual_checksum)
        fd = __import__("os").open(args.output, __import__("os").O_WRONLY | __import__("os").O_CREAT | __import__("os").O_EXCL, 0o600)
        with __import__("os").fdopen(fd, "w") as output:
            output.write(sql)
        print(json.dumps({"status": "prepared", "mappingVersion": MAPPING_VERSION, "sourceCounts": {table: len(_rows(data, table)) for table in SOURCE_TABLES}}))
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
