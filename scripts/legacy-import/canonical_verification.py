"""Read-only canonical reconciliation, independently of migration receipt counts.

Reuse the pure, versioned mappers, but never execute their INSERT/replay SQL.
Every predicate below is evaluated against an actual public runtime table in
one PostgreSQL statement. Only aggregate counts leave the query boundary.
"""
from __future__ import annotations

import importlib.util
import re
from pathlib import Path
from typing import Any, Callable, Mapping


TABLES = {
    "FeedingRecord": "feeding_records", "SleepRecord": "sleep_records",
    "DiaperRecord": "diaper_records", "GrowthMeasurement": "growth_measurements",
}
IDENTIFIER = re.compile(r"^[a-z][a-z0-9_]*$")
MAX_CHECKS = 100_000


def _module(name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    if spec is None or spec.loader is None:
        raise RuntimeError("canonical mapper unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_checks(data: dict[str, Any], checksum: str, attachment_report: Mapping[str, Any] | None = None) -> list[tuple[str, str]]:
    if re.fullmatch(r"[0-9a-f]{64}", checksum) is None:
        raise ValueError("invalid immutable archive checksum")
    care = _module("materialize_care")
    literal = care.literal
    checks: list[tuple[str, str]] = []

    def add(source: str, table: str, predicate: str, alias: str = "t") -> None:
        if not IDENTIFIER.fullmatch(table) or not IDENTIFIER.fullmatch(alias):
            raise ValueError("invalid canonical target identifier")
        checks.append((source, f"EXISTS (SELECT 1 FROM public.{table} {alias} WHERE {predicate})"))
        if len(checks) > MAX_CHECKS:
            raise ValueError("canonical reconciliation exceeds bounded statement size")

    tables = data["tables"]
    source_rows = {name: {row["id"]: row for row in rows} for name, rows in tables.items()}
    attachments: dict[tuple[str, str, str], Mapping[str, Any]] = {}
    if attachment_report is not None:
        if attachment_report.get("mappingVersion") != "attachment-promotion-v1":
            raise ValueError("unsupported attachment receipt version")
        receipts = attachment_report.get("receipts")
        if not isinstance(receipts, list):
            raise ValueError("attachment receipts are required")
        for receipt in receipts:
            if not isinstance(receipt, dict) or receipt.get("sourceBatchId") != checksum:
                raise ValueError("attachment receipt belongs to another source batch")
            attachment = receipt.get("attachment")
            if not isinstance(attachment, dict) or not isinstance(attachment.get("id"), str):
                raise ValueError("attachment receipt lacks canonical identity")
            key = (receipt["sourceTable"], receipt["sourceId"], receipt["sourceField"])
            previous = attachments.get(key)
            if previous is not None and previous["id"] != attachment["id"]:
                raise ValueError("ambiguous canonical attachment reference")
            attachments[key] = attachment
            fields = {
                "id": "id", "familyId": "family_id", "uploaderId": "uploader_id",
                "purpose": "purpose", "mimeType": "mime_type", "byteSize": "byte_size",
                "sha256": "sha256", "objectKey": "object_key",
            }
            predicates = []
            for field, column in fields.items():
                if field not in attachment:
                    raise ValueError("incomplete canonical attachment receipt")
                predicates.append(f"t.{column} IS NOT DISTINCT FROM {literal(attachment[field])}")
            baby_id = attachment.get("babyId")
            if receipt["sourceTable"] == "Baby" and receipt["sourceField"] == "avatarUrl":
                baby_id = receipt["sourceId"]
            predicates.extend([f"t.baby_id IS NOT DISTINCT FROM {literal(baby_id)}", "t.status = 'ready'", "t.deleted_at IS NULL"])
            add("Attachment", "attachments", " AND ".join(predicates))

    def image_id(table: str, row_id: str, field: str) -> str | None:
        source = source_rows.get(table, {}).get(row_id, {})
        value = source.get(field)
        if value is None or value == "":
            return None
        target = attachments.get((table, row_id, field))
        if target is None:
            raise ValueError("source attachment has no verified canonical mapping")
        return str(target["id"])

    for row in care.prepare_formula_products(data, checksum):
        add("FormulaProduct", "formula_products", care._formula_replay_target_predicate(row), "f")
    for row in care.prepare_records(data, checksum):
        target_table = TABLES[row["table"]]
        predicate = care._replay_target_predicate(row, target_table)
        if row["table"] == "GrowthMeasurement":
            old = "t.attachment_id IS NOT DISTINCT FROM NULL"
            if old not in predicate:
                raise RuntimeError("growth mapper contract changed")
            predicate = predicate.replace(old, "t.attachment_id IS NOT DISTINCT FROM " + literal(image_id(row["table"], row["id"], "imageUrl")))
        add(row["table"], target_table, predicate)
        if row["entity_type"] != "growth":
            add(row["table"], "timeline_entries", care._replay_timeline_predicate(row), "e")

    food = _module("materialize_food")
    items, by_food_id, by_name = food.prepare_food_items(data, checksum)
    for row in items:
        add("FoodItem", "food_library_items", food._library_target_predicate(row), "f")
    for row in food.prepare_food_logs(data, checksum, by_food_id, by_name):
        add("FoodLogRecord", "food_records", food._food_log_target_predicate(row), "f")
    for row in food.prepare_food_statuses(data, checksum, by_food_id):
        add("FamilyFoodStatus", "family_food_statuses", food._status_target_predicate(row), "s")

    medical = _module("materialize_medical")
    for row in medical.prepare_reports(data, checksum):
        add("MedicalReport", "medical_reports", medical._replay_target_predicate(row))
        attachment_id = image_id("MedicalReport", row["id"], "imageUrl")
        if attachment_id is not None:
            add("MedicalReport", "medical_report_attachments", "t.medical_report_id = " + literal(row["id"]) + " AND t.attachment_id = " + literal(attachment_id))

    supplements = _module("materialize_supplement_vaccine")
    for row in supplements.prepare_materialization(data, checksum):
        add(row["source_table"], row["target_table"], supplements._predicate(row["columns"], "t"))
    for name in ("materialize_ai_history", "materialize_ai_archive"):
        mapper = _module(name)
        for row in mapper.prepare_materialization(data, checksum, attachment_report=attachment_report):
            add(row["source_table"], row["target_table"], mapper._conditions(row["columns"]))
    voice = _module("materialize_voice_logs")
    for row in voice.prepare_materialization(data, checksum):
        add("AgentVoiceLog", "agent_voice_logs", voice._target_matches(row))
    snapshots = _module("materialize_record_snapshots")
    for row in snapshots.prepare_materialization(data, checksum):
        add("RecordSnapshot", "record_snapshots", snapshots._target_match(row))
    for row in tables.get("Baby", []):
        attachment_id = image_id("Baby", row["id"], "avatarUrl")
        if attachment_id is not None:
            add("Baby", "babies", "t.id = " + literal(row["id"]) + " AND t.avatar_url = " + literal("/api/attachments/" + attachment_id))
    return checks


def verify_canonical(data: dict[str, Any], checksum: str, query: Callable[[str], Any], attachment_report: Mapping[str, Any] | None = None) -> dict[str, Any]:
    checks = build_checks(data, checksum, attachment_report)
    if not checks:
        return {"passed": True, "checked": 0, "mismatched": 0, "tables": []}
    literal = _module("materialize_care").literal
    unions = " UNION ALL ".join(f"SELECT {literal(table)}::text AS source_table, ({predicate}) AS matches" for table, predicate in checks)
    sql = "SELECT json_build_object('checked',count(*),'mismatched',count(*) FILTER (WHERE NOT matches),'tables',COALESCE(json_agg(DISTINCT source_table) FILTER (WHERE NOT matches),'[]'::json)) FROM (" + unions + ") AS verified;"
    result = query(sql)
    if (not isinstance(result, dict) or type(result.get("checked")) is not int
            or result["checked"] != len(checks) or type(result.get("mismatched")) is not int
            or not 0 <= result["mismatched"] <= len(checks) or not isinstance(result.get("tables"), list)):
        raise RuntimeError("canonical verifier returned an invalid aggregate")
    return {"passed": result["mismatched"] == 0, **result}
