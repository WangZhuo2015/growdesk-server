from __future__ import annotations

import copy
import hashlib
import importlib.util
import json


def load_module(name: str, filename: str):
    path = __file__.replace("test_voice_log_materializer.py", filename)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load_module("materialize_voice_logs_test", "materialize_voice_logs.py")
STAMP = "2026-09-12T00:00:00+08:00"


def archive() -> dict:
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "sourceId": "test_voice_source",
        "sourceSha256": "a" * 64,
        "capturedAt": STAMP,
        "tables": {
            "User": [{"id": "test_voice_user", "username": "test_voice_user", "passwordHash": "$2b$12$" + "a" * 53, "displayName": "test voice"}],
            "Family": [{"id": "test_voice_family", "name": "test_voice_family"}],
            "FamilyMember": [{"id": "test_voice_member", "familyId": "test_voice_family", "userId": "test_voice_user", "role": "admin", "status": "active"}],
            "Baby": [{"id": "test_voice_baby", "familyId": "test_voice_family", "nickname": "test_voice_baby", "gender": "unknown"}],
            "AgentVoiceLog": [{
                "id": "test_voice_log_1",
                "userId": "test_voice_user",
                "babyId": "test_voice_baby",
                "prompt": "test voice prompt",
                "reply": "test voice reply",
                "isAsync": 1,
                "isFastPath": False,
                "acknowledged": 0,
                "createdAt": STAMP,
            }],
        },
    }


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def test_maps_scope_and_receipt_hash():
    data = archive()
    items = m.prepare_materialization(data, checksum(data))
    assert len(items) == 1
    item = items[0]
    assert item["target_entity_type"] == "voice_log"
    assert item["columns"]["family_id"] == "test_voice_family"
    assert item["columns"]["is_async"] is True
    assert len(item["source_hash"]) == 64
    assert item["metadata"]["targetHashSha256"] == item["target_hash"]


def test_sql_is_atomic_receipted_and_replay_safe():
    data = archive()
    sql = m.render_materialization(data, checksum(data))
    assert "BEGIN;" in sql and "COMMIT;" in sql
    assert "pg_advisory_xact_lock" in sql
    assert "legacy_idempotency_mappings" in sql
    assert "payload_hash" in sql
    assert "agent_voice_logs" in sql
    assert "Voice history source conflicts with immutable receipt" in sql
    assert "Voice history target conflicts with immutable receipt" in sql


def test_cross_family_scope_fails_closed():
    data = archive()
    data["tables"]["Family"].append({"id": "test_voice_other_family", "name": "test_voice_other_family"})
    data["tables"]["Baby"].append({"id": "test_voice_other_baby", "familyId": "test_voice_other_family", "nickname": "test_voice_other_baby", "gender": "unknown"})
    row = data["tables"]["AgentVoiceLog"][0]
    row["babyId"] = "test_voice_other_baby"
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "scope" in str(error)
    else:
        raise AssertionError("cross-family scope must fail closed")


def test_non_boolean_flags_fail_closed():
    data = archive()
    data["tables"]["AgentVoiceLog"][0]["acknowledged"] = "false"
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "acknowledged" in str(error)
    else:
        raise AssertionError("string boolean must fail closed")


def test_overlong_reply_fails_closed():
    data = archive()
    data["tables"]["AgentVoiceLog"][0]["reply"] = "x" * 100_001
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "reply" in str(error)
    else:
        raise AssertionError("oversized reply must fail closed")


def test_duplicate_source_id_fails_closed():
    data = archive()
    data["tables"]["AgentVoiceLog"].append(copy.deepcopy(data["tables"]["AgentVoiceLog"][0]))
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "Duplicate" in str(error)
    else:
        raise AssertionError("duplicate source ID must fail closed")


def main() -> None:
    tests = [
        test_maps_scope_and_receipt_hash,
        test_sql_is_atomic_receipted_and_replay_safe,
        test_cross_family_scope_fails_closed,
        test_non_boolean_flags_fail_closed,
        test_overlong_reply_fails_closed,
        test_duplicate_source_id_fails_closed,
    ]
    for test in tests:
        test()
    print(f"Voice log materializer pure tests PASS ({len(tests)})")


if __name__ == "__main__":
    main()
