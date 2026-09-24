from __future__ import annotations

import copy
import hashlib
import importlib.util
import json


def load_module(name: str, filename: str):
    path = __file__.replace("test_ai_archive_materializer.py", filename)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load_module("materialize_ai_archive_test", "materialize_ai_archive.py")
STAMP = "2026-09-12T08:00:00+08:00"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def checksum(data: dict) -> str:
    return digest(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")))


def archive() -> dict:
    text = "{\"summary\":\"private test\"}"
    binary = b"test audio bytes"
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "sourceId": "test_ai_archive_source",
        "sourceSha256": "a" * 64,
        "capturedAt": STAMP,
        "tables": {
            "User": [
                {"id": "test_archive_user", "username": "test_archive_user"},
                {"id": "test_archive_other_user", "username": "test_archive_other_user"},
            ],
            "Family": [
                {"id": "test_archive_family", "name": "test_archive_family"},
                {"id": "test_archive_other_family", "name": "test_archive_other_family"},
            ],
            "FamilyMember": [
                {"id": "test_archive_member", "familyId": "test_archive_family", "userId": "test_archive_user", "status": "active"},
                {"id": "test_archive_other_member", "familyId": "test_archive_other_family", "userId": "test_archive_other_user", "status": "active"},
            ],
            "Baby": [
                {"id": "test_archive_baby", "familyId": "test_archive_family", "nickname": "test_archive_baby"},
                {"id": "test_archive_other_baby", "familyId": "test_archive_other_family", "nickname": "test_archive_other_baby"},
            ],
            "AiJob": [
                {"id": "test_archive_job_text", "userId": "test_archive_user", "babyId": "test_archive_baby", "inputArchiveId": "test_archive_text"},
                {"id": "test_archive_job_audio", "userId": "test_archive_user", "babyId": "test_archive_baby", "inputArchiveId": "test_archive_audio"},
                {"id": "test_archive_job_conflict_a", "userId": "test_archive_user", "babyId": "test_archive_baby", "inputArchiveId": "test_archive_conflict"},
                {"id": "test_archive_job_conflict_b", "userId": "test_archive_other_user", "babyId": "test_archive_other_baby", "inputArchiveId": "test_archive_conflict"},
            ],
            "AiArchive": [
                {"id": "test_archive_text", "kind": "output_json", "content": text, "contentHash": digest(text), "byteSize": len(text.encode()), "createdAt": STAMP},
                {"id": "test_archive_audio", "kind": "input_audio", "filePath": "data/archive/test-audio.m4a", "contentHash": digest(binary.decode()), "byteSize": len(binary), "createdAt": STAMP},
                {"id": "test_archive_orphan", "kind": "output_error", "content": "orphan", "contentHash": digest("orphan"), "byteSize": 6, "createdAt": STAMP},
                {"id": "test_archive_conflict", "kind": "output_error", "content": "conflict", "contentHash": digest("conflict"), "byteSize": 8, "createdAt": STAMP},
            ],
        },
    }


def attachment_report(data: dict, batch: str) -> dict:
    row = data["tables"]["AiArchive"][1]
    source_hash = digest(json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":")))
    content_hash = row["contentHash"]
    return {
        "mappingVersion": m.ATTACHMENT_MAPPING_VERSION,
        "receipts": [{
            "sourceSystem": data["sourceId"],
            "sourceBatchId": batch,
            "sourceTable": "AiArchive",
            "sourceId": row["id"],
            "sourceField": "filePath",
            "sourcePath": row["filePath"],
            "sourceHash": source_hash,
            "targetAttachmentId": "test_archive_audio_attachment",
            "targetSha256": content_hash,
            "targetByteSize": row["byteSize"],
            "targetObjectKey": "families/test_archive_family/attachments/voice_note/legacy/test_archive_audio.m4a",
        }],
    }


def test_maps_owned_text_and_binary_receipt():
    data = archive()
    batch = checksum(data)
    items = m.prepare_materialization(data, batch, attachment_report(data, batch))
    by_id = {item["target_id"]: item for item in items}
    assert by_id["test_archive_text"]["status"] == "mapped"
    assert by_id["test_archive_text"]["columns"]["family_id"] == "test_archive_family"
    assert by_id["test_archive_audio"]["status"] == "mapped"
    assert by_id["test_archive_audio"]["columns"]["attachment_id"] == "test_archive_audio_attachment"
    assert by_id["test_archive_audio"]["columns"]["content_hash"] == data["tables"]["AiArchive"][1]["contentHash"]


def test_owner_and_attachment_gaps_fail_closed_but_are_retained():
    data = archive()
    batch = checksum(data)
    items = m.prepare_materialization(data, batch)
    by_id = {item["target_id"]: item for item in items}
    assert by_id["test_archive_orphan"]["status"] == "quarantined"
    assert by_id["test_archive_orphan"]["quarantine_code"] == "OWNER_UNPROVEN"
    assert by_id["test_archive_audio"]["quarantine_code"] == "ATTACHMENT_NOT_PROMOTED"
    assert by_id["test_archive_conflict"]["quarantine_code"] == "OWNER_CONFLICT"
    assert by_id["test_archive_audio"]["columns"]["file_path"] == "data/archive/test-audio.m4a"
    assert by_id["test_archive_orphan"]["columns"]["content"] is None
    assert by_id["test_archive_orphan"]["columns"]["metadata"]["contentRedacted"] is True


def test_content_hash_tampering_is_quarantined():
    data = archive()
    data["tables"]["AiArchive"][0]["contentHash"] = "b" * 64
    items = m.prepare_materialization(data, checksum(data))
    item = next(item for item in items if item["target_id"] == "test_archive_text")
    assert item["status"] == "quarantined"
    assert item["quarantine_code"] == "CONTENT_HASH_MISMATCH"


def test_sql_is_atomic_receipted_and_tamper_safe():
    data = archive()
    batch = checksum(data)
    sql = m.render_materialization(data, batch, attachment_report(data, batch))
    assert "BEGIN;" in sql and "COMMIT;" in sql
    assert "pg_advisory_xact_lock" in sql
    assert "ai_archive_entries" in sql
    assert "legacy_idempotency_mappings" in sql
    assert "source row hash mismatch" in sql
    assert "private attachment is missing" in sql
    assert "conflicts with immutable snapshot" in sql


def test_attachment_report_hash_mismatch_quarantines_binary():
    data = archive()
    batch = checksum(data)
    report = attachment_report(data, batch)
    report["receipts"][0]["sourceHash"] = "0" * 64
    item = next(item for item in m.prepare_materialization(data, batch, report) if item["target_id"] == "test_archive_audio")
    assert item["status"] == "quarantined"
    assert item["quarantine_code"] == "ATTACHMENT_SOURCE_HASH_MISMATCH"


def main() -> None:
    tests = [
        test_maps_owned_text_and_binary_receipt,
        test_owner_and_attachment_gaps_fail_closed_but_are_retained,
        test_content_hash_tampering_is_quarantined,
        test_sql_is_atomic_receipted_and_tamper_safe,
        test_attachment_report_hash_mismatch_quarantines_binary,
    ]
    for test in tests:
        test()
    print(f"AI archive materializer pure tests PASS ({len(tests)})")


if __name__ == "__main__":
    main()
