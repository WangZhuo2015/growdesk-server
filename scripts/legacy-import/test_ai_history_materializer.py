"""Pure checks for the bounded legacy AI history promotion."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
from pathlib import Path


def load_module():
    path = Path(__file__).with_name("materialize_ai_history.py")
    spec = importlib.util.spec_from_file_location("materialize_ai_history_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load_module()


STAMP = "2026-09-12T08:00:00+08:00"


def archive() -> dict:
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "capturedAt": STAMP,
        "sourceId": "test_ai_history",
        "sourceSha256": "source-snapshot",
        "excluded": [],
        "tables": {
            "User": [
                {
                    "id": "test_ai_user",
                    "username": "test_ai_user",
                    "passwordHash": "$2b$10$" + "a" * 53,
                    "displayName": "test_ai_user",
                    "createdAt": STAMP,
                    "updatedAt": STAMP,
                },
                {
                    "id": "test_ai_other_user",
                    "username": "test_ai_other_user",
                    "passwordHash": "$2b$10$" + "b" * 53,
                    "displayName": "test_ai_other_user",
                    "createdAt": STAMP,
                    "updatedAt": STAMP,
                },
            ],
            "Family": [
                {"id": "test_ai_family", "name": "test_ai_family", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_ai_other_family", "name": "test_ai_other_family", "createdAt": STAMP, "updatedAt": STAMP},
            ],
            "FamilyMember": [
                {"id": "test_ai_member", "familyId": "test_ai_family", "userId": "test_ai_user", "role": "admin", "status": "active", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_ai_other_member", "familyId": "test_ai_other_family", "userId": "test_ai_other_user", "role": "admin", "status": "active", "createdAt": STAMP, "updatedAt": STAMP},
            ],
            "Baby": [
                {"id": "test_ai_baby", "familyId": "test_ai_family", "nickname": "test_ai_baby", "gender": "unknown", "birthDate": "2026-01-01", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_ai_other_baby", "familyId": "test_ai_other_family", "nickname": "test_ai_other_baby", "gender": "unknown", "birthDate": "2026-01-02", "createdAt": STAMP, "updatedAt": STAMP},
            ],
            "AiChatSession": [
                {"id": "test_ai_session", "userId": "test_ai_user", "babyId": "test_ai_baby", "title": "test chat", "contextType": "general", "createdAt": STAMP, "updatedAt": STAMP},
            ],
            "AiChatMessage": [
                {"id": "test_ai_message_user", "sessionId": "test_ai_session", "role": "user", "content": "test question", "image": None, "toolsJson": None, "createdAt": STAMP},
                {"id": "test_ai_message_assistant", "sessionId": "test_ai_session", "role": "assistant", "content": "test answer", "image": None, "toolsJson": '{"apiKey":"test_secret","evidence":[1]}', "createdAt": "2026-09-12T08:01:00+08:00"},
            ],
            "AiJob": [
                {"id": "test_ai_job_done", "userId": "test_ai_user", "babyId": "test_ai_baby", "type": "growth_ocr", "status": "done", "inputArchiveId": "test_ai_archive_1", "resultJson": '{"providerSecret":"do-not-copy","weightKg":7.2}', "imageUrl": "legacy/path.png", "errorMessage": None, "claimed": 1, "createdAt": STAMP, "finishedAt": "2026-09-12T08:02:00+08:00"},
                {"id": "test_ai_job_processing", "userId": "test_ai_user", "babyId": None, "type": "medical_ocr", "status": "processing", "inputArchiveId": None, "resultJson": None, "imageUrl": None, "errorMessage": None, "claimed": False, "createdAt": STAMP, "finishedAt": None},
            ],
            "AiArchive": [{"id": "test_ai_archive_1", "kind": "output_json", "content": "test provider payload", "contentHash": "a" * 64, "byteSize": 22, "createdAt": STAMP}],
            "AgentVoiceLog": [{"id": "test_ai_voice_1", "userId": "test_ai_user", "babyId": "test_ai_baby", "prompt": "test prompt", "reply": "test reply", "isAsync": False, "isFastPath": True, "acknowledged": False, "createdAt": STAMP}],
            "RecordSnapshot": [{"id": "test_ai_snapshot_1", "babyId": "test_ai_baby", "userId": "test_ai_user", "source": "ui_manual", "action": "delete", "entityType": "feeding", "entityId": "test_ai_record", "payloadJson": "{}", "restored": False, "restoredAt": None, "createdAt": STAMP}],
        },
    }


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def attachment_report(data: dict, batch: str, message_id: str, path: str, attachment_id: str = "11111111-1111-4111-8111-111111111111") -> dict:
    row = next(item for item in data["tables"]["AiChatMessage"] if item["id"] == message_id)
    return {
        "mappingVersion": "attachment-promotion-v1",
        "receipts": [{
            "sourceBatchId": batch,
            "sourceTable": "AiChatMessage",
            "sourceId": message_id,
            "sourceField": "image",
            "sourcePath": path,
            "sourceHash": m._canonical_hash(row),
            "targetAttachmentId": attachment_id,
            "attachment": {"id": attachment_id, "purpose": "ai_input"},
        }],
    }


def test_valid_items_are_dependency_ordered_and_hash_receipted():
    data = archive()
    items = m.prepare_materialization(data, checksum(data))
    assert [item["target_entity_type"] for item in items] == [
        "ai_session", "ai_session", "ai_session", "ai_message", "ai_message",
        "task_execution", "task_execution", "ai_run", "ai_run", "ai_run_event", "ai_run_event",
    ]
    assert all(len(item["source_hash"]) == 64 and len(item["target_hash"]) == 64 for item in items)
    synthetic = next(item for item in items if item["source_key"] == "AiJob:test_ai_job_done:session")
    assert synthetic["columns"]["user_id"] == "test_ai_user"
    assert synthetic["columns"]["baby_id"] == "test_ai_baby"
    assert synthetic["redactions"] == ["syntheticSession"]


def test_provider_and_tool_payloads_are_hash_only():
    data = archive()
    items = m.prepare_materialization(data, checksum(data))
    message = next(item for item in items if item["target_entity_type"] == "ai_message" and item["target_id"] == "test_ai_message_assistant")
    assert "test_secret" not in message["columns"]["tools_json"]
    assert "evidence" not in message["columns"]["tools_json"]
    task = next(item for item in items if item["target_entity_type"] == "task_execution" and item["target_id"] == "test_ai_job_done")
    assert "providerSecret" not in json.dumps(task["columns"])
    assert "test provider payload" not in json.dumps(task["columns"])
    assert task["columns"]["result_ref"]["legacyInputArchiveId"] == "test_ai_archive_1"
    assert task["columns"]["result_ref"]["archiveState"] == "quarantined_until_attachment_promotion"
    assert task["columns"]["result_ref"]["legacyImageRef"]["redacted"] is True
    assert "legacy/path.png" not in json.dumps(task["columns"])


def test_processing_job_is_terminal_failed_and_never_outboxed():
    data = archive()
    items = m.prepare_materialization(data, checksum(data))
    task = next(item for item in items if item["target_entity_type"] == "task_execution" and item["target_id"] == "test_ai_job_processing")
    run = next(item for item in items if item["target_entity_type"] == "ai_run" and item["target_id"] == "test_ai_job_processing")
    event = next(item for item in items if item["target_entity_type"] == "ai_run_event" and item["target_id"].startswith("legacy_ai_event_"))
    assert task["columns"]["status"] == "failed"
    assert task["columns"]["error_details"]["legacyStatus"] == "processing"
    assert task["columns"]["error_details"]["providerPayloadRedacted"] is True
    assert run["columns"]["error_code"] == "LEGACY_INCOMPLETE_NOT_RESUMED"
    assert event["columns"]["event_type"] == "run_failed"


def test_quarantine_report_is_machine_readable_without_payloads():
    data = archive()
    report = m.quarantine_report(data, checksum(data))
    codes = {item["code"] for item in report["quarantine"]}
    assert report["status"] == "quarantined"
    assert {"AI_ARCHIVE_ATTACHMENT_MAPPING_REQUIRED", "AI_JOB_IMAGE_ATTACHMENT_REQUIRED", "VOICE_HISTORY_CANONICAL_TABLE_REQUIRED", "UNDO_SNAPSHOT_CANONICAL_TABLE_REQUIRED"} <= codes
    assert "test provider payload" not in json.dumps(report)
    assert "test reply" not in json.dumps(report)


def test_image_message_fails_closed_before_sql_render():
    data = archive()
    data["tables"]["AiChatMessage"][0]["image"] = "https://legacy.invalid/private.png"
    try:
        m.render_materialization(data, checksum(data))
    except ValueError as error:
        assert "local captured attachment path" in str(error)
    else:
        raise AssertionError("image message must not be copied as an online URL")


def test_image_message_uses_verified_private_attachment_path():
    data = archive()
    data["tables"]["AiChatMessage"][0]["image"] = "/uploads/ai/test.png"
    batch = checksum(data)
    report = attachment_report(data, batch, "test_ai_message_user", "public/uploads/ai/test.png")
    items = m.prepare_materialization(data, batch, report)
    message = next(item for item in items if item["target_id"] == "test_ai_message_user")
    assert message["columns"]["image"] == "/api/attachments/11111111-1111-4111-8111-111111111111"
    sql = m.render_materialization(data, batch, report)
    assert "purpose='ai_input'" in sql
    assert "status='ready'" in sql
    assert "public/uploads/ai/test.png" not in sql
    assert not any(item["sourceTable"] == "AiChatMessage.image" for item in m.quarantine_report(data, batch, report)["quarantine"])


def test_cross_family_job_fails_closed():
    data = archive()
    data["tables"]["AiJob"][0]["babyId"] = "test_ai_other_baby"
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "scope" in str(error)
    else:
        raise AssertionError("cross-family AI job must fail closed")


def test_claimed_flag_does_not_coerce_arbitrary_strings():
    data = archive()
    data["tables"]["AiJob"][0]["claimed"] = "false"
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "claimed" in str(error)
    else:
        raise AssertionError("non-boolean claimed value must fail closed")


def test_target_conflict_sql_has_a_real_raise_branch():
    data = archive()
    sql = m.render_materialization(data, checksum(data))
    # Keep this regression guard close to the renderer: an empty ELSIF branch
    # is accepted by neither PostgreSQL nor the intended immutable-snapshot
    # contract, and would only be discovered after producing import SQL.
    assert "ELSIF EXISTS" in sql
    assert sql.count("RAISE EXCEPTION 'AI target row conflicts with immutable snapshot") == 11
    assert "ELSIF EXISTS (SELECT 1 FROM public.ai_sessions" in sql


def test_synthetic_session_id_collision_fails_closed():
    data = archive()
    synthetic_id = "legacy_ai_job_session_" + hashlib.sha256("test_ai_job_done".encode()).hexdigest()[:32]
    data["tables"]["AiChatSession"].append({
        "id": synthetic_id,
        "userId": "test_ai_user",
        "babyId": "test_ai_baby",
        "title": "collision",
        "contextType": "general",
        "createdAt": STAMP,
        "updatedAt": STAMP,
    })
    try:
        m.prepare_materialization(data, checksum(data))
    except ValueError as error:
        assert "synthetic session ID collides" in str(error)
    else:
        raise AssertionError("synthetic session collision must fail closed")


def main() -> None:
    tests = [
        test_valid_items_are_dependency_ordered_and_hash_receipted,
        test_provider_and_tool_payloads_are_hash_only,
        test_processing_job_is_terminal_failed_and_never_outboxed,
        test_quarantine_report_is_machine_readable_without_payloads,
        test_image_message_fails_closed_before_sql_render,
        test_image_message_uses_verified_private_attachment_path,
        test_cross_family_job_fails_closed,
        test_claimed_flag_does_not_coerce_arbitrary_strings,
        test_target_conflict_sql_has_a_real_raise_branch,
        test_synthetic_session_id_collision_fails_closed,
    ]
    for test in tests:
        test()
    print(f"AI history materializer pure tests PASS ({len(tests)})")


if __name__ == "__main__":
    main()
