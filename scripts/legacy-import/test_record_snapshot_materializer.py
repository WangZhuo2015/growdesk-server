from __future__ import annotations

import copy
import hashlib
import importlib.util
import json


def load_module(name: str, filename: str):
    path = __file__.replace("test_record_snapshot_materializer.py", filename)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load_module("materialize_record_snapshots_test", "materialize_record_snapshots.py")
STAMP = "2026-09-12T00:00:00+08:00"


def archive() -> dict:
    payload = {
        "id": "test_snapshot_record",
        "familyId": "test_snapshot_family",
        "babyId": "test_snapshot_baby",
        "timestamp": "2026-09-12T10:00:00Z",
        "type": "breast",
        "amountMl": 90,
    }
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "sourceId": "test_snapshot_source",
        "sourceSha256": "a" * 64,
        "capturedAt": STAMP,
        "tables": {
            "User": [{"id": "test_snapshot_user", "username": "test_snapshot_user"}],
            "Family": [{"id": "test_snapshot_family", "name": "test_snapshot_family"}],
            "FamilyMember": [{"id": "test_snapshot_member", "familyId": "test_snapshot_family", "userId": "test_snapshot_user", "role": "admin", "status": "active"}],
            "Baby": [{"id": "test_snapshot_baby", "familyId": "test_snapshot_family", "nickname": "test_snapshot_baby"}],
            "RecordSnapshot": [{
                "id": "test_snapshot_1",
                "familyId": "test_snapshot_family",
                "babyId": "test_snapshot_baby",
                "userId": "test_snapshot_user",
                "source": "mcp",
                "sourceAgent": None,
                "action": "delete",
                "entityType": "feeding",
                "entityId": "test_snapshot_record",
                "payload": payload,
                "payloadHash": hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest(),
                "restored": False,
                "restoredAt": None,
                "createdAt": STAMP,
            }],
        },
    }


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def test_maps_payload_scope_and_hashes():
    data = archive()
    items = m.prepare_materialization(data, checksum(data))
    assert len(items) == 1
    item = items[0]
    assert item["target_entity_type"] == "record_snapshot"
    assert item["columns"]["family_id"] == "test_snapshot_family"
    assert item["columns"]["payload_json"]["amountMl"] == 90
    assert len(item["source_hash"]) == 64
    assert item["metadata"]["targetHashSha256"] == item["target_hash"]


def test_sql_is_atomic_receipted_replay_tamper_safe_and_rollback_safe():
    data = archive()
    sql = m.render_materialization(data, checksum(data))
    assert "BEGIN;" in sql and "COMMIT;" in sql
    assert "pg_advisory_xact_lock" in sql
    assert "record_snapshots" in sql
    assert "legacy_idempotency_mappings" in sql
    assert "source row hash mismatch" in sql
    assert "tampered" in sql
    assert "target ID already exists" in sql


def test_cross_family_scope_fails_closed():
    data = archive()
    data["tables"]["Baby"][0]["familyId"] = "test_snapshot_other_family"
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "scope" in str(error)
    else:
        raise AssertionError("cross-family scope must fail closed")


def test_payload_tamper_fails_closed():
    data = archive()
    data["tables"]["RecordSnapshot"][0]["payload"]["amountMl"] = 100
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "payload hash" in str(error)
    else:
        raise AssertionError("payload hash tampering must fail closed")


def test_food_plan_and_null_actor_are_supported_without_faking_scope():
    data = archive()
    row = copy.deepcopy(data["tables"]["RecordSnapshot"][0])
    row["id"] = "test_snapshot_food_plan"
    row["entityType"] = "food_plan"
    row["entityId"] = "test_snapshot_plan"
    row["userId"] = None
    row["payload"] = {"id": "test_snapshot_plan", "familyId": "test_snapshot_family", "babyId": "test_snapshot_baby", "planData": {"days": []}, "version": "1", "createdAt": STAMP, "updatedAt": STAMP}
    row["payloadHash"] = hashlib.sha256(json.dumps(row["payload"], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    data["tables"]["RecordSnapshot"].append(row)
    items = m.prepare_materialization(data, checksum(data))
    assert {item["columns"]["entity_type"] for item in items} == {"feeding", "food_plan"}


def main() -> None:
    tests = [
        test_maps_payload_scope_and_hashes,
        test_sql_is_atomic_receipted_replay_tamper_safe_and_rollback_safe,
        test_cross_family_scope_fails_closed,
        test_payload_tamper_fails_closed,
        test_food_plan_and_null_actor_are_supported_without_faking_scope,
    ]
    for test in tests:
        test()
    print(f"Record snapshot materializer pure tests PASS ({len(tests)})")


if __name__ == "__main__":
    main()
