"""Promote legacy FoodItem/FoodLogRecord/FamilyFoodStatus rows.

This is a bounded, private import slice.  It never opens a database connection;
it validates an immutable identity-v1 archive and renders one PostgreSQL
transaction for an operator to review and run against an explicitly owned
target.  The archive remains the source of truth and every promoted row gets a
source hash, mapping version, and deterministic receipt in
``public.legacy_idempotency_mappings``.

The old Web stored a richer food item and food log shape than the first
GrowDesk schema.  The additive promotion columns preserve those values while
the canonical columns provide the current API projection.  Rows that cannot
be assigned to one tenant, cross a baby/family boundary, or exceed the
canonical representation fail before SQL is written; the surrounding SQL is a
single transaction, so a runtime conflict cannot leave a partial promotion.
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
from decimal import InvalidOperation
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo


FOOD_TABLES = ("FoodItem", "FoodLogRecord", "FamilyFoodStatus")
MAPPING_VERSION = "food-v1"
SOURCE_SYSTEM_DEFAULT = "legacy_web"
ADVISORY_LOCK = 724019234
NOTES_PREFIX = "[growdesk-web-food:v1]"
MEAL_TYPES = {"breakfast", "lunch", "dinner", "snack"}
REACTIONS = {"like", "normal", "dislike"}
BABY_STATES = {"happy", "neutral", "rejected"}
PORTIONS = {"little", "half", "most", "all"}


def _import_identity_loader():
    try:
        from import_sql import load_archive, literal  # type: ignore

        return load_archive, literal
    except ModuleNotFoundError:
        path = Path(__file__).with_name("import_sql.py")
        spec = importlib.util.spec_from_file_location("legacy_import_sql_food", path)
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


def _text(value: Any, label: str, *, allow_none: bool = False) -> str | None:
    if value is None and allow_none:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label} must be a non-empty string")
    return value.strip()


def _optional_text(value: Any, label: str, *, max_length: int | None = None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{label} must be a string or null")
    value = value.strip()
    if max_length is not None and len(value) > max_length:
        raise ValueError(f"{label} exceeds {max_length} characters")
    return value


def _boolean(value: Any, label: str, *, default: bool | None = None) -> bool:
    if value is None and default is not None:
        return default
    if isinstance(value, bool):
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    raise ValueError(f"{label} must be boolean or SQLite integer 0/1")


def _integer(value: Any, label: str, *, minimum: int | None = None, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{label} must be an integer")
    if minimum is not None and value < minimum:
        raise ValueError(f"{label} must be >= {minimum}")
    if maximum is not None and value > maximum:
        raise ValueError(f"{label} must be <= {maximum}")
    return value


def _instant(value: Any, label: str, timezone_name: str) -> str:
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
            except Exception as error:  # pragma: no cover - archive pins timezone
                raise ValueError(f"Unsupported archive timezone {timezone_name}") from error
    else:
        raise ValueError(f"{label} must be a timestamp")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _date(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{label} must be YYYY-MM-DD")
    try:
        parsed = dt.date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{label} must be YYYY-MM-DD") from error
    if parsed.isoformat() != value:
        raise ValueError(f"{label} must be YYYY-MM-DD")
    return value


def _time(value: Any, label: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
        raise ValueError(f"{label} must be HH:MM")
    return value


def _canonical_hash(row: dict[str, Any]) -> str:
    payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_array(value: Any, label: str) -> list[Any]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError(f"{label} is not valid JSON") from error
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError(f"{label} must be a JSON array")
    return value


def _redact(value: Any, key: str | None = None) -> Any:
    if key is not None and re.search(
        r"(?:password|passwd|token|secret|credential|authorization|cookie|refresh|access)[_-]?",
        key,
        re.IGNORECASE,
    ):
        return "[redacted]"
    if isinstance(value, dict):
        return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _uuid5(name: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, name))


def _same(column: str, value: Any, alias: str = "t") -> str:
    return f"{alias}.{column} IS NOT DISTINCT FROM {literal(value)}"


def _sql_json(value: Any) -> str:
    return f"{literal(_json(value))}::jsonb"


def _identity_maps(data: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[str, dict[str, Any]], dict[tuple[str, str], dict[str, Any]]]:
    tables = data.get("tables")
    if not isinstance(tables, dict):
        raise ValueError("Archive tables must be an object")
    users = {row.get("id"): row for row in tables.get("User", []) if isinstance(row, dict)}
    families = {row.get("id"): row for row in tables.get("Family", []) if isinstance(row, dict)}
    babies = {row.get("id"): row for row in tables.get("Baby", []) if isinstance(row, dict)}
    members: dict[tuple[str, str], dict[str, Any]] = {}
    for row in tables.get("FamilyMember", []):
        if not isinstance(row, dict):
            raise ValueError("FamilyMember row must be an object")
        family_id = _text(row.get("familyId"), "FamilyMember.familyId")
        user_id = _text(row.get("userId"), "FamilyMember.userId")
        assert family_id is not None and user_id is not None
        if family_id not in families or user_id not in users:
            raise ValueError("FamilyMember references an unknown identity")
        key = (family_id, user_id)
        if key in members:
            raise ValueError("Duplicate FamilyMember relation")
        members[key] = row
    if any(not isinstance(key, str) or not key for key in families):
        raise ValueError("Family contains an invalid ID")
    for baby_id, baby in babies.items():
        if not isinstance(baby_id, str) or not baby_id:
            raise ValueError("Baby contains an invalid ID")
        family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
        assert family_id is not None
        if family_id not in families:
            raise ValueError(f"Baby/{baby_id} references an unknown family")
    return users, families, babies, members


def _identity_context(
    data: dict[str, Any], table: str, row: dict[str, Any]
) -> tuple[str, str, str | None, str | None]:
    users, families, babies, members = _identity_maps(data)
    row_id = _text(row.get("id"), f"{table}.id")
    assert row_id is not None
    baby_id = _text(row.get("babyId"), f"{table}/{row_id}.babyId")
    assert baby_id is not None
    baby = babies.get(baby_id)
    if baby is None:
        raise ValueError(f"{table}/{row_id}: baby is not in identity archive")
    family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
    assert family_id is not None
    if family_id not in families:
        raise ValueError(f"{table}/{row_id}: baby family is not in identity archive")
    explicit_family = row.get("familyId")
    if explicit_family is not None and explicit_family != family_id:
        raise ValueError(f"{table}/{row_id}: explicit familyId crosses baby family")
    actor_id = _optional_text(row.get("recordedById"), f"{table}/{row_id}.recordedById")
    if actor_id is not None:
        if actor_id not in users or (family_id, actor_id) not in members:
            raise ValueError(f"{table}/{row_id}: recordedById is outside the baby family")
        if members[(family_id, actor_id)].get("status", "active") != "active":
            raise ValueError(f"{table}/{row_id}: recordedById is not an active family member")
    client_id = _optional_text(row.get("clientId"), f"{table}/{row_id}.clientId", max_length=128)
    return family_id, baby_id, actor_id, client_id


def _food_item_metadata(
    data: dict[str, Any], row: dict[str, Any], source_hash: str, target_id: str, family_id: str | None
) -> dict[str, Any]:
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceBatchId": data.get("sourceSha256"),
        "sourceTable": "FoodItem",
        "sourceId": row["id"],
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "targetId": target_id,
        "targetFamilyId": family_id,
        "legacyFoodId": row["foodId"],
        "legacyRow": _redact(row),
    }


def _food_status_metadata(data: dict[str, Any], row: dict[str, Any], source_hash: str, target_food_id: str) -> dict[str, Any]:
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceBatchId": data.get("sourceSha256"),
        "sourceTable": "FamilyFoodStatus",
        "sourceId": row["id"],
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "targetFoodItemId": target_food_id,
        "legacyRow": _redact(row),
    }


def _food_log_metadata(
    data: dict[str, Any], row: dict[str, Any], source_hash: str, family_id: str, baby_id: str, client_id: str | None
) -> dict[str, Any]:
    return {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceBatchId": data.get("sourceSha256"),
        "sourceTable": "FoodLogRecord",
        "sourceId": row["id"],
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "legacyFamilyId": family_id,
        "legacyBabyId": baby_id,
        "legacyClientId": client_id,
        "legacyRow": _redact(row),
    }


def _allergen_risk(row: dict[str, Any], label: str) -> str:
    common = _boolean(row.get("isCommonAllergen"), f"{label}.isCommonAllergen", default=False)
    medical = _boolean(row.get("highRiskInfantNeedsMedicalAdvice"), f"{label}.highRiskInfantNeedsMedicalAdvice", default=False)
    raw = row.get("allergenRisk")
    if raw is not None:
        raw = _text(raw, f"{label}.allergenRisk")
        if raw not in {"low", "medium", "high"}:
            raise ValueError(f"{label}.allergenRisk is invalid")
        return raw
    return "high" if common or medical else "low"


def _status_rows(data: dict[str, Any]) -> list[dict[str, Any]]:
    rows = data.get("tables", {}).get("FamilyFoodStatus", [])
    if not isinstance(rows, list):
        raise ValueError("FamilyFoodStatus must be an array")
    return rows


def _status_family_candidates(data: dict[str, Any]) -> dict[str, set[str]]:
    _, families, _, _ = _identity_maps(data)
    result: dict[str, set[str]] = {}
    for row in _status_rows(data):
        if not isinstance(row, dict):
            raise ValueError("FamilyFoodStatus row must be an object")
        family_id = _text(row.get("familyId"), "FamilyFoodStatus.familyId")
        food_id = _text(row.get("foodId", row.get("foodItemId")), "FamilyFoodStatus.foodId")
        assert family_id is not None and food_id is not None
        if family_id not in families:
            raise ValueError(f"FamilyFoodStatus/{row.get('id')}: unknown family")
        result.setdefault(food_id, set()).add(family_id)
    return result


def _food_item_target_id(row: dict[str, Any]) -> str:
    food_id = _text(row.get("foodId"), "FoodItem.foodId")
    legacy_id = _text(row.get("id"), "FoodItem.id")
    assert food_id is not None and legacy_id is not None
    # The checked-in reference catalogue uses food_* natural IDs.  Custom old
    # rows retain their old primary key so the Web adapter can expose it.
    target_id = food_id if food_id.startswith("food_") else legacy_id
    if len(target_id) > 64:
        raise ValueError(f"FoodItem/{legacy_id}: target ID exceeds 64 characters")
    return target_id


def prepare_food_items(data: dict[str, Any], checksum: str) -> tuple[list[dict[str, Any]], dict[str, str], dict[str, str]]:
    _require_checksum(checksum)
    _, families, _, _ = _identity_maps(data)
    rows = data.get("tables", {}).get("FoodItem", [])
    if not isinstance(rows, list):
        raise ValueError("FoodItem must be an array")
    status_families = _status_family_candidates(data)
    mapped: list[dict[str, Any]] = []
    by_food_id: dict[str, str] = {}
    by_name: dict[str, str] = {}
    seen_ids: set[str] = set()
    seen_food_ids: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("FoodItem row must be an object")
        legacy_id = _text(row.get("id"), "FoodItem.id")
        food_id = _text(row.get("foodId"), f"FoodItem/{legacy_id}.foodId")
        assert legacy_id is not None and food_id is not None
        if legacy_id in seen_ids or food_id in seen_food_ids:
            raise ValueError(f"Duplicate FoodItem identity {legacy_id}/{food_id}")
        seen_ids.add(legacy_id)
        seen_food_ids.add(food_id)
        target_id = _food_item_target_id(row)
        is_custom = not food_id.startswith("food_")
        explicit_family = _optional_text(row.get("familyId"), f"FoodItem/{legacy_id}.familyId")
        candidates = status_families.get(food_id, set())
        if is_custom:
            if explicit_family is not None and explicit_family not in families:
                raise ValueError(f"FoodItem/{legacy_id}: unknown familyId")
            if explicit_family is None and len(candidates) == 1:
                explicit_family = next(iter(candidates))
            elif explicit_family is None and len(candidates) == 0:
                raise ValueError(f"FoodItem/{legacy_id}: custom item has no provable family owner")
            elif explicit_family is None and len(candidates) > 1:
                raise ValueError(f"FoodItem/{legacy_id}: custom item crosses multiple family owners")
            if candidates and explicit_family not in candidates:
                raise ValueError(f"FoodItem/{legacy_id}: family owner disagrees with family status")
        elif explicit_family is not None:
            raise ValueError(f"FoodItem/{legacy_id}: reference item cannot carry familyId")
        name = _text(row.get("name"), f"FoodItem/{legacy_id}.name")
        category = _text(row.get("category"), f"FoodItem/{legacy_id}.category")
        assert name is not None and category is not None
        if len(name) > 100 or len(category) > 50:
            raise ValueError(f"FoodItem/{legacy_id}: name/category exceeds canonical length")
        recommended = row.get("recommendedFromMonth")
        recommended_age = 6 if recommended is None else _integer(recommended, f"FoodItem/{legacy_id}.recommendedFromMonth", minimum=0)
        if recommended_age > 120:
            raise ValueError(f"FoodItem/{legacy_id}: recommendedFromMonth exceeds 120")
        for field in ("preparationJson", "nutritionJson", "textureByAgeJson", "sourceRefsJson"):
            _json_array(row.get(field), f"FoodItem/{legacy_id}.{field}")
        risk = _allergen_risk(row, f"FoodItem/{legacy_id}")
        created_at = _instant(row.get("createdAt", data.get("capturedAt")), f"FoodItem/{legacy_id}.createdAt", data["timeZone"])
        updated_at = _instant(row.get("updatedAt", row.get("createdAt", data.get("capturedAt"))), f"FoodItem/{legacy_id}.updatedAt", data["timeZone"])
        source_hash = _canonical_hash(row)
        item = {
            "table": "FoodItem",
            "entity_type": "food_library_item",
            "id": target_id,
            "legacy_id": legacy_id,
            "food_id": food_id,
            "family_id": explicit_family,
            "is_custom": is_custom,
            "name": name,
            "category": category,
            "allergen_risk": risk,
            "recommended_age_months": recommended_age,
            "created_at": created_at,
            "updated_at": updated_at,
            "source_hash": source_hash,
            "legacy_row": _redact(row),
        }
        item["metadata"] = _food_item_metadata(data, row, source_hash, target_id, explicit_family)
        item["metadata"]["targetSnapshot"] = {
            "id": target_id,
            "name": name,
            "category": category,
            "allergenRisk": risk,
            "recommendedAgeMonths": recommended_age,
            "isCustom": is_custom,
            "familyId": explicit_family,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }
        item["metadata"]["reconciledExisting"] = not is_custom and target_id.startswith("food_")
        item["metadata"]["targetHashSha256"] = hashlib.sha256(_json(item["metadata"]["targetSnapshot"]).encode("utf-8")).hexdigest()
        mapped.append(item)
        by_food_id[food_id] = target_id
        # Some old exports kept the FoodItem primary key inside a structured
        # FoodLogRecord value.  Accept that legacy reference as well as the
        # public foodId, while keeping one deterministic canonical target.
        if legacy_id in by_food_id and by_food_id[legacy_id] != target_id:
            raise ValueError(f"FoodItem/{legacy_id}: legacy ID collides with another foodId")
        by_food_id[legacy_id] = target_id
        by_name.setdefault(name, target_id)
    return mapped, by_food_id, by_name


def _parse_foods(row: dict[str, Any], row_id: str) -> list[Any]:
    raw = row.get("foods", [])
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as error:
            raise ValueError(f"FoodLogRecord/{row_id}.foods is not valid JSON") from error
    else:
        parsed = raw
    if parsed is None:
        parsed = []
    if not isinstance(parsed, list):
        raise ValueError(f"FoodLogRecord/{row_id}.foods must be a JSON array")
    if len(parsed) > 20:
        raise ValueError(f"FoodLogRecord/{row_id}.foods exceeds 20 items")
    values: list[Any] = []
    for index, value in enumerate(parsed):
        if isinstance(value, str):
            text = value.strip()
        elif isinstance(value, dict):
            candidate = value.get("id")
            if not isinstance(candidate, str) or not candidate.strip():
                candidate = value.get("name")
            text = candidate.strip() if isinstance(candidate, str) else ""
        else:
            text = ""
        if not text or len(text) > 255:
            raise ValueError(f"FoodLogRecord/{row_id}.foods[{index}] is not a non-empty string")
        values.append(text)
    return values


def _meal_type(row: dict[str, Any], row_id: str, wall_time: str) -> str:
    raw = row.get("mealType")
    if raw is not None:
        raw = _text(raw, f"FoodLogRecord/{row_id}.mealType")
        assert raw is not None
        if raw not in MEAL_TYPES:
            raise ValueError(f"FoodLogRecord/{row_id}.mealType is invalid")
        return raw
    hour = int(wall_time[:2])
    return "breakfast" if hour < 11 else "lunch" if hour < 15 else "dinner" if hour < 20 else "snack"


def _reaction(row: dict[str, Any], row_id: str, baby_state: str | None, acceptance: int | None) -> str | None:
    raw = row.get("reaction")
    if raw is not None:
        raw = _optional_text(raw, f"FoodLogRecord/{row_id}.reaction")
        if raw and raw not in REACTIONS:
            raise ValueError(f"FoodLogRecord/{row_id}.reaction is invalid")
        return raw
    if baby_state is not None:
        return {"happy": "like", "neutral": "normal", "rejected": "dislike"}[baby_state]
    if acceptance is None or acceptance == 0:
        return None
    return "like" if acceptance >= 4 else "normal" if acceptance == 3 else "dislike"


def _notes(row: dict[str, Any], row_id: str, acceptance: int | None, baby_state: str | None, has_abnormal: bool, abnormal_notes: str | None) -> str | None:
    human_notes = _optional_text(row.get("notes"), f"FoodLogRecord/{row_id}.notes", max_length=1000)
    observations: dict[str, Any] = {}
    if acceptance is not None:
        observations["acceptance"] = acceptance
    if baby_state is not None:
        observations["babyState"] = baby_state
    if "hasAbnormal" in row or has_abnormal:
        observations["hasAbnormal"] = has_abnormal
    if abnormal_notes is not None:
        observations["abnormalNotes"] = abnormal_notes
    if not observations:
        return human_notes
    encoded = NOTES_PREFIX + _json({"notes": human_notes, "observations": observations})
    if len(encoded) > 1000:
        raise ValueError(f"FoodLogRecord/{row_id}: observations do not fit canonical notes limit")
    return encoded


def prepare_food_logs(
    data: dict[str, Any], checksum: str, by_food_id: dict[str, str], by_name: dict[str, str]
) -> list[dict[str, Any]]:
    rows = data.get("tables", {}).get("FoodLogRecord", [])
    if not isinstance(rows, list):
        raise ValueError("FoodLogRecord must be an array")
    mapped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_clients: set[tuple[str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("FoodLogRecord row must be an object")
        row_id = _text(row.get("id"), "FoodLogRecord.id")
        assert row_id is not None
        if row_id in seen_ids:
            raise ValueError(f"Duplicate FoodLogRecord ID {row_id}")
        seen_ids.add(row_id)
        family_id, baby_id, actor_id, client_id = _identity_context(data, "FoodLogRecord", row)
        if client_id is not None:
            key = (baby_id, client_id)
            if key in seen_clients:
                raise ValueError(f"Duplicate FoodLogRecord clientId for baby {baby_id}")
            seen_clients.add(key)
        record_date = _date(row.get("date", row.get("recordDate")), f"FoodLogRecord/{row_id}.date")
        wall_time = _time(row.get("time", "00:00"), f"FoodLogRecord/{row_id}.time")
        occurred_raw = row.get("occurredAt", row.get("timestamp"))
        occurred_at = (
            _instant(occurred_raw, f"FoodLogRecord/{row_id}.occurredAt", data["timeZone"])
            if occurred_raw is not None
            else _instant(f"{record_date}T{wall_time}:00", f"FoodLogRecord/{row_id}.time", data["timeZone"])
        )
        acceptance = row.get("acceptance")
        if acceptance is not None:
            acceptance = _integer(acceptance, f"FoodLogRecord/{row_id}.acceptance", minimum=0, maximum=5)
        baby_state = _optional_text(row.get("babyState"), f"FoodLogRecord/{row_id}.babyState")
        if baby_state is not None and baby_state not in BABY_STATES:
            raise ValueError(f"FoodLogRecord/{row_id}.babyState is invalid")
        has_abnormal = _boolean(row.get("hasAbnormal"), f"FoodLogRecord/{row_id}.hasAbnormal", default=False)
        abnormal_notes = _optional_text(row.get("abnormalNotes"), f"FoodLogRecord/{row_id}.abnormalNotes", max_length=1000)
        portion = _optional_text(row.get("portion"), f"FoodLogRecord/{row_id}.portion", max_length=255)
        if portion is not None and row.get("portion") in PORTIONS:
            pass
        elif portion is not None and row.get("portion") not in PORTIONS:
            # Keep unusual historical text for audit only when it is still a
            # valid canonical string; the old API accepted only four values,
            # so malformed values are safer as a hard failure than truncation.
            raise ValueError(f"FoodLogRecord/{row_id}.portion is invalid")
        foods = _parse_foods(row, row_id)
        # IDs are canonicalized only when the old payload clearly contained a
        # foodId.  Name strings remain names because the old UI stored names.
        food_item_ids = [by_food_id.get(value, value) for value in foods]
        source = _optional_text(row.get("source"), f"FoodLogRecord/{row_id}.source") or "ui_manual"
        source_agent = _optional_text(row.get("sourceAgent"), f"FoodLogRecord/{row_id}.sourceAgent")
        created_at = _instant(row.get("createdAt", data.get("capturedAt")), f"FoodLogRecord/{row_id}.createdAt", data["timeZone"])
        updated_at = _instant(row.get("updatedAt", row.get("createdAt", data.get("capturedAt"))), f"FoodLogRecord/{row_id}.updatedAt", data["timeZone"])
        encoded_notes = _notes(row, row_id, acceptance, baby_state, has_abnormal, abnormal_notes)
        meal_type = _meal_type(row, row_id, wall_time)
        reaction = _reaction(row, row_id, baby_state, acceptance)
        source_hash = _canonical_hash(row)
        metadata = _food_log_metadata(data, row, source_hash, family_id, baby_id, client_id)
        metadata["legacyFoods"] = foods
        metadata["targetFoodItemIds"] = food_item_ids
        metadata["targetNotes"] = encoded_notes
        item = {
            "table": "FoodLogRecord",
            "entity_type": "food",
            "id": row_id,
            "family_id": family_id,
            "baby_id": baby_id,
            "actor_id": actor_id,
            "client_id": client_id,
            "source": source,
            "source_agent": source_agent,
            "record_date": record_date,
            "meal_type": meal_type,
            "occurred_at": occurred_at,
            "food_item_ids": food_item_ids,
            "portion_description": portion,
            "reaction": reaction,
            "notes": encoded_notes,
            "created_at": created_at,
            "updated_at": updated_at,
            "source_hash": source_hash,
            "metadata": metadata,
        }
        metadata["targetSnapshot"] = {
            "id": row_id,
            "familyId": family_id,
            "babyId": baby_id,
            "recordDate": record_date,
            "mealType": meal_type,
            "occurredAt": occurred_at,
            "foodItemIds": food_item_ids,
            "portionDescription": portion,
            "reaction": reaction,
            "notes": encoded_notes,
            "source": source,
            "sourceAgent": source_agent,
            "recordedByUserId": actor_id,
            "legacyClientId": client_id,
            "version": 1,
            "deletedAt": None,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }
        metadata["targetHashSha256"] = hashlib.sha256(_json(metadata["targetSnapshot"]).encode("utf-8")).hexdigest()
        mapped.append(item)
    return mapped


def prepare_food_statuses(data: dict[str, Any], checksum: str, by_food_id: dict[str, str]) -> list[dict[str, Any]]:
    _, families, _, _ = _identity_maps(data)
    rows = _status_rows(data)
    mapped: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_pairs: set[tuple[str, str]] = set()
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("FamilyFoodStatus row must be an object")
        row_id = _text(row.get("id"), "FamilyFoodStatus.id")
        family_id = _text(row.get("familyId"), f"FamilyFoodStatus/{row_id}.familyId")
        source_food_id = _text(row.get("foodId", row.get("foodItemId")), f"FamilyFoodStatus/{row_id}.foodId")
        assert row_id is not None and family_id is not None and source_food_id is not None
        if row_id in seen_ids:
            raise ValueError(f"Duplicate FamilyFoodStatus ID {row_id}")
        seen_ids.add(row_id)
        if family_id not in families:
            raise ValueError(f"FamilyFoodStatus/{row_id}: unknown family")
        is_orphan = False
        if source_food_id not in by_food_id:
            # An orphaned custom food status may reference a food item deleted
            # from the active library. Allow mapping using the legacy identifier.
            target_food_id = source_food_id
            is_orphan = True
        else:
            target_food_id = by_food_id[source_food_id]
        pair = (family_id, target_food_id)
        if pair in seen_pairs:
            raise ValueError(f"Duplicate FamilyFoodStatus pair {family_id}/{source_food_id}")
        seen_pairs.add(pair)
        status = _text(row.get("status", "to_try"), f"FamilyFoodStatus/{row_id}.status")
        assert status is not None
        if status not in {"tried", "to_try"}:
            raise ValueError(f"FamilyFoodStatus/{row_id}.status is invalid")
        acceptance = row.get("acceptance", 0)
        acceptance = _integer(acceptance, f"FamilyFoodStatus/{row_id}.acceptance", minimum=0, maximum=5)
        first_added = row.get("firstAddedDate")
        if first_added is not None:
            first_added = _date(first_added, f"FamilyFoodStatus/{row_id}.firstAddedDate")
        updated_at = _instant(row.get("updatedAt", data.get("capturedAt")), f"FamilyFoodStatus/{row_id}.updatedAt", data["timeZone"])
        created_at = _instant(row.get("createdAt", row.get("updatedAt", data.get("capturedAt"))), f"FamilyFoodStatus/{row_id}.createdAt", data["timeZone"])
        source_hash = _canonical_hash(row)
        tried = status == "tried"
        reaction = None if acceptance == 0 else "like" if acceptance >= 4 else "normal" if acceptance == 3 else "dislike"
        metadata = _food_status_metadata(data, row, source_hash, target_food_id)
        metadata["targetSnapshot"] = {
            "id": row_id,
            "familyId": family_id,
            "foodItemId": target_food_id,
            "tried": tried,
            "reaction": reaction,
            "legacyStatus": status,
            "legacyAcceptance": acceptance,
            "legacyFirstAddedDate": first_added,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }
        metadata["targetHashSha256"] = hashlib.sha256(_json(metadata["targetSnapshot"]).encode("utf-8")).hexdigest()
        mapped.append({
            "table": "FamilyFoodStatus",
            "entity_type": "family_food_status",
            "id": row_id,
            "family_id": family_id,
            "source_food_id": source_food_id,
            "food_item_id": target_food_id,
            "is_orphan": is_orphan,
            "tried": tried,
            "reaction": reaction,
            "legacy_status": status,
            "legacy_acceptance": acceptance,
            "legacy_first_added_date": first_added,
            "created_at": created_at,
            "updated_at": updated_at,
            "source_hash": source_hash,
            "metadata": metadata,
        })
    return mapped


def _mapping_id(item: dict[str, Any], checksum: str) -> str:
    return _uuid5(f"growdesk/legacy-food-promotion/{item['entity_type']}/{checksum}/{item['table']}/{item['id']}")


def _timeline_id(item: dict[str, Any]) -> str:
    return _uuid5(f"growdesk/legacy-food-timeline/{item['id']}")


def _source_guard(item: dict[str, Any], checksum: str) -> str:
    return f"""
  IF NOT EXISTS (
    SELECT 1 FROM legacy_import.import_rows
    WHERE batch_id={literal(checksum)} AND source_table={literal(item['table'])}
      AND source_id={literal(item.get('legacy_id', item['id']))} AND payload_hash={literal(item['source_hash'])}
  ) THEN
    RAISE EXCEPTION 'Legacy food source row hash mismatch or missing: %', {literal(checksum + '/' + item['table'] + '/' + item['id'])};
  END IF;
"""


def _library_target_predicate(item: dict[str, Any], *, alias: str = "f", include_timestamps: bool = True) -> str:
    fields = [
        _same("id", item["id"], alias),
        _same("name", item["name"], alias),
        _same("category", item["category"], alias),
        _same("allergen_risk", item["allergen_risk"], alias),
        _same("recommended_age_months", item["recommended_age_months"], alias),
        _same("is_custom", item["is_custom"], alias),
        _same("family_id", item["family_id"], alias),
    ]
    if include_timestamps:
        fields.extend([_same("created_at", item["created_at"], alias), _same("updated_at", item["updated_at"], alias)])
    return " AND ".join(fields)


def _food_log_target_predicate(item: dict[str, Any], *, alias: str = "f") -> str:
    fields = [
        _same("id", item["id"], alias),
        _same("family_id", item["family_id"], alias),
        _same("baby_id", item["baby_id"], alias),
        _same("record_date", item["record_date"], alias),
        _same("meal_type", item["meal_type"], alias),
        _same("occurred_at", item["occurred_at"], alias),
        f"{alias}.food_item_ids IS NOT DISTINCT FROM ARRAY[{','.join(literal(v) for v in item['food_item_ids'])}]::text[]",
        _same("portion_description", item["portion_description"], alias),
        _same("reaction", item["reaction"], alias),
        _same("notes", item["notes"], alias),
        _same("source", item["source"], alias),
        _same("source_agent", item["source_agent"], alias),
        _same("recorded_by_user_id", item["actor_id"], alias),
        _same("legacy_client_id", item["client_id"], alias),
        _same("version", 1, alias),
        f"{alias}.deleted_at IS NULL",
        _same("created_at", item["created_at"], alias),
        _same("updated_at", item["updated_at"], alias),
    ]
    return " AND ".join(fields)


def _status_target_predicate(item: dict[str, Any], *, alias: str = "s") -> str:
    return " AND ".join([
        _same("id", item["id"], alias),
        _same("family_id", item["family_id"], alias),
        _same("food_item_id", item["food_item_id"], alias),
        _same("tried", item["tried"], alias),
        _same("reaction", item["reaction"], alias),
        _same("legacy_status", item["legacy_status"], alias),
        _same("legacy_acceptance", item["legacy_acceptance"], alias),
        _same("legacy_first_added_date", item["legacy_first_added_date"], alias),
        _same("created_at", item["created_at"], alias),
        _same("updated_at", item["updated_at"], alias),
    ])


def _library_sql(item: dict[str, Any], checksum: str, delimiter: str, source_system: str) -> str:
    source_key = f"{checksum}/{item['table']}/{item['legacy_id']}"
    mapping_id = _mapping_id(item, checksum)
    metadata_sql = _sql_json(item["metadata"])
    raw_hash = item["source_hash"]
    existing_predicate = _library_target_predicate(item, include_timestamps=False)
    target_predicate = _library_target_predicate(item, include_timestamps=True)
    values = [
        literal(item["id"]), literal(item["name"]), literal(item["category"]), literal(item["allergen_risk"]),
        literal(item["recommended_age_months"]), literal(item["is_custom"]), literal(item["family_id"]),
        literal(item["created_at"]), literal(item["updated_at"]), _sql_json(item["metadata"]),
    ]
    return f"""DO {delimiter}
BEGIN
{_source_guard(item, checksum)}
  IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings WHERE target_entity_type='food_library_item' AND source_key={literal(source_key)}) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.legacy_idempotency_mappings
      WHERE target_entity_type='food_library_item' AND source_key={literal(source_key)}
        AND target_entity_id={literal(item['id'])} AND source_hash={literal(raw_hash)}
        AND mapping_version={literal(MAPPING_VERSION)} AND metadata={metadata_sql}
        AND EXISTS (SELECT 1 FROM public.food_library_items f WHERE {target_predicate})
    ) THEN
      RAISE EXCEPTION 'Legacy food item receipt conflict or missing target: %', {literal(source_key)};
    END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.food_library_items f WHERE f.id={literal(item['id'])}) THEN
    IF {str(not item['is_custom']).upper()} AND EXISTS (SELECT 1 FROM public.food_library_items f WHERE {existing_predicate}) THEN
      UPDATE public.food_library_items
      SET created_at={literal(item['created_at'])}, updated_at={literal(item['updated_at'])}, legacy_metadata={metadata_sql}
      WHERE id={literal(item['id'])};
    ELSE
      RAISE EXCEPTION 'Food library target ID already exists without matching legacy receipt: %', {literal(item['id'])};
    END IF;
  ELSE
    INSERT INTO public.food_library_items
      (id,name,category,allergen_risk,recommended_age_months,is_custom,family_id,created_at,updated_at,legacy_metadata)
    VALUES ({','.join(values)});
  END IF;
  INSERT INTO public.legacy_idempotency_mappings
    (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,
     source_hash,mapping_version,metadata,created_at)
  VALUES ({literal(mapping_id)},'food_library_item',{literal(item['id'])},{literal(source_key)},'mapped',
    {literal(source_system)},{literal(checksum)},'FoodItem',{literal(item['legacy_id'])},{literal(raw_hash)},
    {literal(MAPPING_VERSION)},{metadata_sql},{literal(item['created_at'])});
END;
{delimiter};
"""


def _food_log_sql(item: dict[str, Any], checksum: str, delimiter: str, source_system: str) -> str:
    source_key = f"{checksum}/{item['table']}/{item['id']}"
    mapping_id = _mapping_id(item, checksum)
    metadata_sql = _sql_json(item["metadata"])
    raw_hash = item["source_hash"]
    target_predicate = _food_log_target_predicate(item)
    timeline_id = _timeline_id(item)
    occurred = item["occurred_at"]
    details_sql = metadata_sql
    values = [
        literal(item["id"]), literal(item["family_id"]), literal(item["baby_id"]), literal(item["record_date"]),
        literal(item["meal_type"]), literal(item["occurred_at"]),
        f"ARRAY[{','.join(literal(v) for v in item['food_item_ids'])}]::text[]", literal(item["portion_description"]),
        literal(item["reaction"]), literal(item["notes"]), literal(item["source"]), literal(item["source_agent"]),
        literal(item["actor_id"]), literal(item["client_id"]), "1", "NULL", literal(item["created_at"]), literal(item["updated_at"]), metadata_sql,
    ]
    source_guard = _source_guard(item, checksum)
    actor_guard = ""
    if item["actor_id"] is not None:
        actor_guard = f"""
  IF NOT EXISTS (
    SELECT 1 FROM public.family_members fm
    JOIN public.users u ON u.id=fm.user_id
    JOIN public.baby_members bm ON bm.family_id=fm.family_id AND bm.user_id=fm.user_id
    WHERE fm.family_id={literal(item['family_id'])} AND fm.user_id={literal(item['actor_id'])}
      AND bm.baby_id={literal(item['baby_id'])} AND fm.status='active' AND bm.status='active'
      AND fm.deleted_at IS NULL AND bm.deleted_at IS NULL AND u.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Legacy food actor is not an active member of the target baby: %', {literal(source_key)};
  END IF;
"""
    replay_timeline = " AND ".join([
        _same("id", timeline_id, "e"), _same("family_id", item["family_id"], "e"), _same("baby_id", item["baby_id"], "e"),
        _same("entity_type", "food", "e"), _same("entity_id", item["id"], "e"), _same("occurred_at", occurred, "e"),
        _same("summary", f"Legacy food: {item['meal_type']}", "e"),
        f"e.details IS NOT DISTINCT FROM {_sql_json(item['metadata'])}",
        _same("source", item["source"], "e"), _same("version", 1, "e"), "e.deleted_at IS NULL",
        _same("created_at", item["created_at"], "e"), _same("updated_at", item["updated_at"], "e"),
    ])
    return f"""DO {delimiter}
BEGIN
{source_guard}{actor_guard}
  IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings WHERE target_entity_type='food' AND source_key={literal(source_key)}) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.legacy_idempotency_mappings
      WHERE target_entity_type='food' AND source_key={literal(source_key)} AND target_entity_id={literal(item['id'])}
        AND source_hash={literal(raw_hash)} AND mapping_version={literal(MAPPING_VERSION)} AND metadata={metadata_sql}
        AND EXISTS (SELECT 1 FROM public.food_records f WHERE {target_predicate})
        AND EXISTS (SELECT 1 FROM public.timeline_entries e WHERE {replay_timeline})
    ) THEN
      RAISE EXCEPTION 'Legacy food log receipt conflict or missing target: %', {literal(source_key)};
    END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.food_records WHERE id={literal(item['id'])}) THEN
    RAISE EXCEPTION 'Food record target ID already exists without matching legacy receipt: %', {literal(item['id'])};
  END IF;
  INSERT INTO public.food_records
    (id,family_id,baby_id,record_date,meal_type,occurred_at,food_item_ids,portion_description,reaction,notes,
     source,source_agent,recorded_by_user_id,legacy_client_id,version,deleted_at,created_at,updated_at,legacy_metadata)
  VALUES ({','.join(values)});
  INSERT INTO public.timeline_entries
    (id,family_id,baby_id,entity_type,entity_id,occurred_at,summary,details,source,version,deleted_at,created_at,updated_at)
  VALUES ({literal(timeline_id)},{literal(item['family_id'])},{literal(item['baby_id'])},'food',{literal(item['id'])},
    {literal(item['occurred_at'])},{literal('Legacy food: ' + item['meal_type'])},{details_sql},{literal(item['source'])},1,NULL,
    {literal(item['created_at'])},{literal(item['updated_at'])});
  INSERT INTO public.legacy_idempotency_mappings
    (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,
     source_hash,mapping_version,metadata,created_at)
  VALUES ({literal(mapping_id)},'food',{literal(item['id'])},{literal(source_key)},'mapped',{literal(source_system)},
    {literal(checksum)},'FoodLogRecord',{literal(item['id'])},{literal(raw_hash)},{literal(MAPPING_VERSION)},
    {metadata_sql},{literal(item['created_at'])});
END;
{delimiter};
"""


def _status_sql(item: dict[str, Any], checksum: str, delimiter: str, source_system: str) -> str:
    source_key = f"{checksum}/{item['table']}/{item['id']}"
    mapping_id = _mapping_id(item, checksum)
    metadata_sql = _sql_json(item["metadata"])
    raw_hash = item["source_hash"]
    target_predicate = _status_target_predicate(item)
    values = [
        literal(item["id"]), literal(item["family_id"]), literal(item["food_item_id"]), literal(item["tried"]),
        literal(item["reaction"]), literal(item["legacy_status"]), literal(item["legacy_acceptance"]),
        literal(item["legacy_first_added_date"]), literal(item["created_at"]), literal(item["updated_at"]), metadata_sql,
    ]
    library_guard = ""
    if not item.get("is_orphan"):
        library_guard = f"""
  IF NOT EXISTS (
    SELECT 1 FROM public.food_library_items f
    WHERE f.id={literal(item['food_item_id'])} AND (f.is_custom=false OR f.family_id={literal(item['family_id'])})
  ) THEN
    RAISE EXCEPTION 'Legacy food status item is missing or crosses family: %', {literal(source_key)};
  END IF;
"""
    return f"""DO {delimiter}
BEGIN
{_source_guard(item, checksum)}
  IF NOT EXISTS (SELECT 1 FROM public.families WHERE id={literal(item['family_id'])} AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'Legacy food status family is missing: %', {literal(source_key)};
  END IF;{library_guard}
  IF EXISTS (SELECT 1 FROM public.legacy_idempotency_mappings WHERE target_entity_type='family_food_status' AND source_key={literal(source_key)}) THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.legacy_idempotency_mappings
      WHERE target_entity_type='family_food_status' AND source_key={literal(source_key)} AND target_entity_id={literal(item['id'])}
        AND source_hash={literal(raw_hash)} AND mapping_version={literal(MAPPING_VERSION)} AND metadata={metadata_sql}
        AND EXISTS (SELECT 1 FROM public.family_food_statuses s WHERE {target_predicate})
    ) THEN
      RAISE EXCEPTION 'Legacy food status receipt conflict or missing target: %', {literal(source_key)};
    END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM public.family_food_statuses WHERE id={literal(item['id'])}) THEN
    RAISE EXCEPTION 'Family food status target ID already exists without matching legacy receipt: %', {literal(item['id'])};
  END IF;
  IF EXISTS (SELECT 1 FROM public.family_food_statuses WHERE family_id={literal(item['family_id'])} AND food_item_id={literal(item['food_item_id'])}) THEN
    RAISE EXCEPTION 'Family food status target pair already exists without matching legacy receipt: %', {literal(source_key)};
  END IF;
  INSERT INTO public.family_food_statuses
    (id,family_id,food_item_id,tried,reaction,legacy_status,legacy_acceptance,legacy_first_added_date,created_at,updated_at,legacy_metadata)
  VALUES ({','.join(values)});
  INSERT INTO public.legacy_idempotency_mappings
    (id,target_entity_type,target_entity_id,source_key,status,source_system,source_batch_id,source_table,source_id,
     source_hash,mapping_version,metadata,created_at)
  VALUES ({literal(mapping_id)},'family_food_status',{literal(item['id'])},{literal(source_key)},'mapped',{literal(source_system)},
    {literal(checksum)},'FamilyFoodStatus',{literal(item['id'])},{literal(raw_hash)},{literal(MAPPING_VERSION)},
    {metadata_sql},{literal(item['created_at'])});
END;
{delimiter};
"""


def render_materialization(data: dict[str, Any], checksum: str) -> str:
    checksum = _require_checksum(checksum)
    if data.get("formatVersion") != 1 or data.get("timeZone") != "Asia/Shanghai":
        raise ValueError("Unsupported archive")
    source_system = data.get("sourceId") or SOURCE_SYSTEM_DEFAULT
    if not isinstance(source_system, str) or not source_system:
        raise ValueError("Archive sourceId must be a non-empty string")
    items, by_food_id, by_name = prepare_food_items(data, checksum)
    logs = prepare_food_logs(data, checksum, by_food_id, by_name)
    statuses = prepare_food_statuses(data, checksum, by_food_id)
    delimiter = f"$food_{checksum[:24]}$"
    if delimiter in _json(data):
        raise ValueError("SQL delimiter collision")
    statements = "\n".join([
        *(_library_sql(item, checksum, delimiter, source_system) for item in items),
        *(_status_sql(item, checksum, delimiter, source_system) for item in statuses),
        *(_food_log_sql(item, checksum, delimiter, source_system) for item in logs),
    ])
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
  IF (SELECT count(*) FROM legacy_import.import_rows WHERE batch_id={literal(checksum)} AND source_table='FoodItem') <> {len(items)} THEN
    RAISE EXCEPTION 'Legacy FoodItem source count mismatch for batch %', {literal(checksum)};
  END IF;
  IF (SELECT count(*) FROM legacy_import.import_rows WHERE batch_id={literal(checksum)} AND source_table='FoodLogRecord') <> {len(logs)} THEN
    RAISE EXCEPTION 'Legacy FoodLogRecord source count mismatch for batch %', {literal(checksum)};
  END IF;
  IF (SELECT count(*) FROM legacy_import.import_rows WHERE batch_id={literal(checksum)} AND source_table='FamilyFoodStatus') <> {len(statuses)} THEN
    RAISE EXCEPTION 'Legacy FamilyFoodStatus source count mismatch for batch %', {literal(checksum)};
  END IF;
END;
{delimiter};
{statements}
COMMIT;
SELECT json_build_object(
  'foodItems', (SELECT count(*) FROM public.legacy_idempotency_mappings WHERE target_entity_type='food_library_item' AND source_batch_id={literal(checksum)}),
  'foodLogs', (SELECT count(*) FROM public.food_records WHERE legacy_metadata->>'sourceBatchId'={literal(checksum)}),
  'familyFoodStatuses', (SELECT count(*) FROM public.family_food_statuses WHERE legacy_metadata->>'sourceBatchId'={literal(checksum)}),
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
        expected = _require_checksum(args.sha256)
        if actual_checksum != expected:
            raise ValueError("Archive checksum mismatch")
        sql = render_materialization(data, actual_checksum)
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            output.write(sql)
        print(json.dumps({
            "status": "prepared",
            "mappingVersion": MAPPING_VERSION,
            "rows": {table: len(data["tables"].get(table, [])) for table in FOOD_TABLES},
        }))
        return 0
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
