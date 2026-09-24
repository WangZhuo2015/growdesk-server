"""Pure legacy GrowthMeasurement mapping.

This module deliberately has no database, filesystem, or object-storage access.
It maps only rows whose image reference is empty.  A non-empty legacy image URL
must wait for the attachment promotion lane instead of being copied into the
canonical measurement or notes.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import re
from decimal import Decimal, InvalidOperation
from typing import Any, Mapping
from zoneinfo import ZoneInfo


MAPPING_VERSION = "growth-v1"
SOURCE_SYSTEM_DEFAULT = "legacy_web"
TABLE = "GrowthMeasurement"
_CHECKSUM = re.compile(r"[0-9a-f]{64}")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
_SENSITIVE_KEY = re.compile(
    r"(?:password|passwd|token|secret|credential|authorization|cookie|refresh|access)[_-]?",
    re.IGNORECASE,
)


def _text(value: Any, field: str, *, allow_empty: bool = False) -> str:
    if not isinstance(value, str) or (not allow_empty and not value.strip()):
        raise ValueError(f"{TABLE}.{field} must be a string")
    return value


def _optional_text(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _text(value, field, allow_empty=True)


def _checksum(value: str) -> str:
    if not isinstance(value, str) or _CHECKSUM.fullmatch(value) is None:
        raise ValueError("Growth archive checksum must be a lowercase SHA-256")
    return value


def _canonical_hash(row: Mapping[str, Any]) -> str:
    payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _instant(value: Any, field: str, timezone_name: str) -> str:
    if isinstance(value, bool) or value is None:
        raise ValueError(f"{TABLE}.{field} must be a timestamp")
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"{TABLE}.{field} must be a finite timestamp")
        parsed = dt.datetime.fromtimestamp(value / 1000, dt.timezone.utc)
    elif isinstance(value, str) and value:
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as error:
            raise ValueError(f"{TABLE}.{field} has an invalid timestamp") from error
        if parsed.tzinfo is None:
            try:
                parsed = parsed.replace(tzinfo=ZoneInfo(timezone_name))
            except Exception as error:  # pragma: no cover - archive pins the timezone
                raise ValueError(f"Unsupported archive timezone {timezone_name}") from error
    else:
        raise ValueError(f"{TABLE}.{field} must be a timestamp")
    # The target is timestamptz(3); do not silently discard sub-millisecond data.
    if parsed.microsecond % 1000:
        raise ValueError(f"{TABLE}.{field} exceeds target millisecond precision")
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _date_only(value: Any, field: str) -> str:
    if not isinstance(value, str) or _DATE.fullmatch(value) is None:
        raise ValueError(f"{TABLE}.{field} must be YYYY-MM-DD")
    try:
        dt.date.fromisoformat(value)
    except ValueError as error:
        raise ValueError(f"{TABLE}.{field} must be a valid calendar date") from error
    return value


def _decimal(value: Any, field: str, *, precision: int, scale: int) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise ValueError(f"{TABLE}.{field} must be a positive decimal or null")
    try:
        number = Decimal(str(value))
        quantum = Decimal(1).scaleb(-scale)
        normalized = number.quantize(quantum)
    except (InvalidOperation, ValueError) as error:
        raise ValueError(f"{TABLE}.{field} must be a positive decimal or null") from error
    if not number.is_finite() or number <= 0:
        raise ValueError(f"{TABLE}.{field} must be a positive decimal or null")
    if normalized != number:
        raise ValueError(f"{TABLE}.{field} would lose precision at scale {scale}")
    if normalized >= Decimal(10) ** (precision - scale):
        raise ValueError(f"{TABLE}.{field} exceeds numeric({precision},{scale})")
    return format(normalized, "f")


def _nonnegative_int(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or type(value) is not int or value < 0:
        raise ValueError(f"{TABLE}.{field} must be a non-negative integer or null")
    return value


def _percentile(value: Any) -> int | None:
    result = _nonnegative_int(value, "percentile")
    if result is not None and result > 100:
        raise ValueError(f"{TABLE}.percentile must be between 0 and 100")
    return result


def _redact(value: Any, key: str | None = None) -> Any:
    if key is not None and _SENSITIVE_KEY.search(key):
        return "[redacted]"
    if isinstance(value, Mapping):
        return {str(k): _redact(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(item) for item in value]
    return value


def _identity_context(data: Mapping[str, Any], row: Mapping[str, Any]) -> tuple[str, str, str | None, str | None]:
    tables = data.get("tables")
    if not isinstance(tables, Mapping):
        raise ValueError("Archive tables must be an object")
    babies = {item.get("id"): item for item in tables.get("Baby", []) if isinstance(item, Mapping)}
    families = {item.get("id") for item in tables.get("Family", []) if isinstance(item, Mapping)}
    users = {item.get("id") for item in tables.get("User", []) if isinstance(item, Mapping)}
    family_members = {
        (item.get("familyId"), item.get("userId")): item
        for item in tables.get("FamilyMember", [])
        if isinstance(item, Mapping)
    }

    baby_id = _text(row.get("babyId"), "babyId")
    baby = babies.get(baby_id)
    if not isinstance(baby, Mapping):
        raise ValueError(f"{TABLE}/{row.get('id')}: baby is not in identity archive")
    family_id = _text(baby.get("familyId"), f"Baby/{baby_id}.familyId")
    if family_id not in families:
        raise ValueError(f"{TABLE}/{row.get('id')}: baby family is not in identity archive")

    explicit_family = row.get("familyId")
    if explicit_family is not None and explicit_family != family_id:
        raise ValueError(f"{TABLE}/{row.get('id')}: explicit familyId crosses baby family")

    actor_id = _optional_text(row.get("recordedById"), "recordedById")
    if actor_id is not None:
        if actor_id not in users:
            raise ValueError(f"{TABLE}/{row.get('id')}: recordedById is not an archived user")
        member = family_members.get((family_id, actor_id))
        if not isinstance(member, Mapping) or member.get("status", "active") != "active":
            raise ValueError(f"{TABLE}/{row.get('id')}: recordedById is outside the baby family")

    client_id = _optional_text(row.get("clientId"), "clientId") or None
    return family_id, baby_id, actor_id, client_id


def map_growth_measurement(
    data: Mapping[str, Any], row: Mapping[str, Any], checksum: str
) -> dict[str, Any]:
    """Map one image-free legacy row to canonical promotion values.

    ``ageInMonths``, ``ageLabel`` and ``percentile`` are intentionally kept in
    ``metadata['legacyGrowth']``.  They are historical context and must not be
    appended to the user-visible ``notes`` field.  The returned ``occurred_at``
    is UTC midnight only for the timeline projection; ``measurement_date`` stays
    a date-only value and is the business field.
    """

    checksum = _checksum(checksum)
    if data.get("timeZone") != "Asia/Shanghai":
        raise ValueError("Unsupported archive timezone")
    row_id = _text(row.get("id"), "id")
    family_id, baby_id, actor_id, client_id = _identity_context(data, row)

    attachment = row.get("attachmentId")
    if attachment not in (None, ""):
        raise ValueError(f"{TABLE}/{row_id}: attachmentId requires attachment promotion")
    image_url = row.get("imageUrl")
    if image_url is not None and not isinstance(image_url, str):
        raise ValueError(f"{TABLE}/{row_id}: imageUrl must be a string or null")

    raw_date = row.get("date")
    recorded_date = row.get("recordedDate")
    if raw_date is None:
        raw_date = recorded_date
    elif recorded_date is not None and recorded_date != raw_date:
        raise ValueError(f"{TABLE}/{row_id}: date and recordedDate disagree")
    measurement_date = _date_only(raw_date, f"{row_id}.date")

    age_in_months = _nonnegative_int(row.get("ageInMonths"), f"{row_id}.ageInMonths")
    age_label = row.get("ageLabel")
    if not isinstance(age_label, str):
        raise ValueError(f"{TABLE}/{row_id}.ageLabel must be a string")
    percentile = _percentile(row.get("percentile"))
    weight_kg = _decimal(row.get("weightKg"), f"{row_id}.weightKg", precision=5, scale=2)
    height_cm = _decimal(row.get("heightCm"), f"{row_id}.heightCm", precision=5, scale=1)
    head_circumference_cm = _decimal(
        row.get("headCircumferenceCm"), f"{row_id}.headCircumferenceCm", precision=4, scale=1
    )
    if weight_kg is None and height_cm is None and head_circumference_cm is None:
        raise ValueError(f"{TABLE}/{row_id} has no measurement")

    source = row.get("source")
    if source is not None and not isinstance(source, str):
        raise ValueError(f"{TABLE}/{row_id}.source must be a string or null")
    source_agent = _optional_text(row.get("sourceAgent"), f"{row_id}.sourceAgent")
    created_raw = row.get("createdAt", data.get("capturedAt"))
    updated_raw = row.get("updatedAt", created_raw)
    created_at = _instant(created_raw, f"{row_id}.createdAt", "Asia/Shanghai")
    updated_at = _instant(updated_raw, f"{row_id}.updatedAt", "Asia/Shanghai")
    notes = row.get("notes")
    if notes is not None and not isinstance(notes, str):
        raise ValueError(f"{TABLE}/{row_id}.notes must be a string or null")

    source_hash = _canonical_hash(row)
    mapped_keys = {
        "id", "babyId", "familyId", "clientId", "recordedById", "source", "sourceAgent",
        "date", "recordedDate", "ageInMonths", "ageLabel", "weightKg", "heightCm",
        "headCircumferenceCm", "percentile", "imageUrl", "attachmentId", "notes", "createdAt",
        "updatedAt",
    }
    metadata = {
        "sourceSystem": data.get("sourceId") or SOURCE_SYSTEM_DEFAULT,
        "sourceSnapshot": data.get("sourceSha256"),
        "sourceBatchId": checksum,
        "sourceTable": TABLE,
        "sourceId": row_id,
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "legacyClientId": client_id,
        "legacyRecordedById": actor_id,
        # Growth has no canonical source columns, so keep these legacy values
        # in the typed compatibility projection.  The API later exposes only
        # these two values, never the whole metadata object.
        "legacySource": source,
        "legacySourceAgent": source_agent,
        "legacyFamilyId": row.get("familyId"),
        "legacyBabyId": baby_id,
        "legacyDate": raw_date,
        "legacyCreatedAt": row.get("createdAt"),
        "legacyUpdatedAt": row.get("updatedAt"),
        "legacyImageUrl": image_url,
        "legacyGrowth": {
            "ageInMonths": age_in_months,
            "ageLabel": age_label,
            "percentile": percentile,
        },
        "extra": _redact({key: value for key, value in row.items() if key not in mapped_keys}),
    }

    values = [value for value in (weight_kg, height_cm, head_circumference_cm) if value is not None]
    summary = "Legacy growth: " + ", ".join(values)
    return {
        "table": TABLE,
        "entity_type": "growth",
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
        "mapping_version": MAPPING_VERSION,
        "measurement_date": measurement_date,
        "occurred_at": f"{measurement_date}T00:00:00.000Z",
        "weight_kg": weight_kg,
        "height_cm": height_cm,
        "head_circumference_cm": head_circumference_cm,
        "attachment_id": None,
        "notes": notes,
        "metadata": metadata,
        "summary": summary,
    }
