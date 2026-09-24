"""Pure legacy FormulaProduct mapping; no database or production file access."""
import datetime
import decimal
import json


def _text(value, field, nullable=False):
    if value is None and nullable:
        return None
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"Invalid {field}")
    return value


def _instant(value):
    if isinstance(value, bool):
        raise ValueError("Invalid timestamp")
    if isinstance(value, (int, float)):
        parsed = datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc)
    elif isinstance(value, str):
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    else:
        raise ValueError("Invalid timestamp")
    if parsed.tzinfo is None:
        raise ValueError("Ambiguous timestamp")
    if parsed.microsecond % 1000:
        raise ValueError("Timestamp exceeds target millisecond precision")
    return parsed.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds")


def _decimal(value, field):
    if isinstance(value, bool) or value is None:
        raise ValueError(f"Invalid {field}")
    try:
        number = decimal.Decimal(str(value))
    except decimal.InvalidOperation:
        raise ValueError(f"Invalid {field}") from None
    if not number.is_finite() or number <= 0 or number >= decimal.Decimal("10000000"):
        raise ValueError(f"Invalid {field}")
    if number != number.quantize(decimal.Decimal("0.00001")):
        raise ValueError(f"{field} would lose precision")
    return format(number, "f")


def _boolean(value, field):
    # SQLite snapshots can expose booleans as integer 0/1.
    if isinstance(value, bool):
        return value
    if type(value) is int and value in (0, 1):
        return bool(value)
    raise ValueError(f"Invalid {field}")


def map_formula_product(row, family_ids):
    """Return every runtime field; refuse lossy or orphan source rows.

    The caller owns batch validation, receipts, insertion order and SQL quoting.
    JSON stays validated raw JSON text, decimal values are exact strings. Inactive
    products remain available for historical feeding references.
    """
    family_id = _text(row.get("familyId"), "familyId")
    if family_id not in family_ids:
        raise ValueError("Unknown formula family")
    stage = row.get("stage")
    if stage is not None and (type(stage) is not int or stage < 0):
        raise ValueError("Invalid stage")
    raw_nutrients = row.get("nutrientsJson")
    if isinstance(raw_nutrients, dict):
        raw_nutrients = json.dumps(raw_nutrients, allow_nan=False, ensure_ascii=False)
    if not isinstance(raw_nutrients, str):
        raise ValueError("Invalid nutrients")
    def reject_constant(value):
        raise ValueError("Invalid JSON numeric constant")
    # Keep the original numeric tokens for PostgreSQL JSONB. A default float
    # parser would silently round high-precision nutrition values before SQL.
    nutrients = json.loads(raw_nutrients, parse_float=decimal.Decimal, parse_constant=reject_constant)
    if not isinstance(nutrients, dict):
        raise ValueError("Invalid nutrients")
    for name, nutrient in nutrients.items():
        if not isinstance(name, str) or not name or not isinstance(nutrient, dict):
            raise ValueError("Invalid nutrient")
        amount = nutrient.get("amount")
        if type(amount) not in (int, decimal.Decimal) or not decimal.Decimal(str(amount)).is_finite() or amount < 0:
            raise ValueError("Invalid nutrient amount")
        _text(nutrient.get("unit"), "nutrient unit")
    unit = row.get("servingSizeUnit")
    if unit not in ("per_100g", "per_100ml", "per_100kJ"):
        raise ValueError("Invalid serving size unit")
    notes = row.get("notes")
    if notes is not None and not isinstance(notes, str):
        raise ValueError("Invalid notes")
    # Both old and new storage allow empty labels; importing must not replace
    # those with guessed product names or silently discard the product.
    if not isinstance(row.get("brand"), str) or not isinstance(row.get("name"), str):
        raise ValueError("Invalid product label")
    return {
        "id": _text(row.get("id"), "id"), "family_id": family_id,
        "brand": row["brand"], "name": row["name"],
        "stage": None if stage is None else str(stage),
        "scoop_weight_g": _decimal(row.get("scoopWeightG"), "scoopWeightG"),
        "water_per_scoop_ml": _decimal(row.get("waterPerScoopMl"), "waterPerScoopMl"),
        "reconstitution_ratio": _decimal(row.get("reconstitutionRatio"), "reconstitutionRatio"),
        "serving_size_unit": unit, "nutrients_json": raw_nutrients, "notes": notes,
        "is_active": _boolean(row.get("isActive"), "isActive"),
        "is_default": _boolean(row.get("isDefault"), "isDefault"),
        "is_archived": False, "version": 1, "deleted_at": None,
        "created_at": _instant(row.get("createdAt")),
        "updated_at": _instant(row.get("updatedAt")),
    }
