"""Pure validation checks for the legacy MedicalReport materializer.

These tests do not connect to a database.  The companion integration test is
run by the owned PostgreSQL integration runner and exercises the rendered SQL.
"""

from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path


def load_module():
    path = Path(__file__).with_name("materialize_medical.py")
    spec = importlib.util.spec_from_file_location("materialize_medical_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


m = load_module()


def archive() -> dict:
    stamp = "2026-09-12T08:00:00+08:00"
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "capturedAt": stamp,
        "sourceId": "test_legacy_medical",
        "sourceSha256": "a" * 64,
        "excluded": {},
        "tables": {
            "User": [
                {"id": "test_user_a", "username": "test_user_a", "passwordHash": "$2b$10$" + "a" * 53, "displayName": "test_a", "createdAt": stamp, "updatedAt": stamp},
                {"id": "test_user_b", "username": "test_user_b", "passwordHash": "$2b$10$" + "b" * 53, "displayName": "test_b", "createdAt": stamp, "updatedAt": stamp},
                {"id": "test_user_other", "username": "test_user_other", "passwordHash": "$2b$10$" + "c" * 53, "displayName": "test_other", "createdAt": stamp, "updatedAt": stamp},
            ],
            "Family": [
                {"id": "test_family_a", "name": "test_family_a", "createdAt": stamp, "updatedAt": stamp},
                {"id": "test_family_b", "name": "test_family_b", "createdAt": stamp, "updatedAt": stamp},
            ],
            "FamilyMember": [
                {"id": "test_member_a", "familyId": "test_family_a", "userId": "test_user_a", "role": "admin", "createdAt": stamp, "updatedAt": stamp},
                {"id": "test_member_b", "familyId": "test_family_a", "userId": "test_user_b", "role": "member", "createdAt": stamp, "updatedAt": stamp},
                {"id": "test_member_other", "familyId": "test_family_b", "userId": "test_user_other", "role": "admin", "createdAt": stamp, "updatedAt": stamp},
            ],
            "Baby": [
                {"id": "test_baby_a", "familyId": "test_family_a", "nickname": "test_baby_a", "gender": "female", "birthDate": "2026-01-01", "createdAt": stamp, "updatedAt": stamp},
                {"id": "test_baby_b", "familyId": "test_family_b", "nickname": "test_baby_b", "gender": "male", "birthDate": "2026-01-01", "createdAt": stamp, "updatedAt": stamp},
            ],
            "MedicalReport": [
                {
                    "id": "test_medical_a",
                    "babyId": "test_baby_a",
                    "recordedById": "test_user_b",
                    "title": "test blood panel",
                    "category": "blood",
                    "date": "2026-09-11",
                    "hospital": "test hospital",
                    "doctorNotes": "test diagnosis",
                    "aiSummary": "test summary",
                    "itemsJson": json.dumps([{
                        "id": "test_item_a",
                        "name": "test_marker",
                        "value": 4.2,
                        "unit": "mg/L",
                        "referenceRange": "1-5",
                        "status": "normal",
                        "interpretation": "test interpretation",
                    }], ensure_ascii=False),
                    "imageUrl": None,
                    "createdAt": stamp,
                    "updatedAt": stamp,
                },
                {
                    "id": "test_medical_fallback",
                    "babyId": "test_baby_a",
                    "title": "test checkup",
                    "category": "checkup",
                    "date": "2026-09-11",
                    "hospital": None,
                    "doctorNotes": None,
                    "aiSummary": None,
                    "itemsJson": json.dumps([{"name": "test_weight", "value": "7.2", "status": "normal", "legacyUnit": "kg"}], ensure_ascii=False),
                    "imageUrl": "https://legacy.test/uploads/test-medical.png",
                    "createdAt": stamp,
                    "updatedAt": stamp,
                },
            ],
        },
    }


def expect_value_error(fn, fragment: str):
    try:
        fn()
    except ValueError as error:
        assert fragment in str(error), str(error)
    else:
        raise AssertionError(f"expected ValueError containing {fragment!r}")


def main() -> None:
    data = archive()
    checksum = "b" * 64
    reports = m.prepare_reports(data, checksum)
    assert [row["id"] for row in reports] == ["test_medical_a", "test_medical_fallback"]
    assert reports[0]["caregiver_id"] == "test_user_b"
    assert reports[0]["caregiver_fallback"] is None
    assert reports[0]["items"][0]["value"] == 4.2
    assert reports[1]["caregiver_id"] == "test_user_a"
    assert reports[1]["caregiver_fallback"] == "family_admin_lowest_user_id"
    assert reports[1]["unresolved_references"][0]["field"] == "imageUrl"
    assert reports[1]["mapping_status"] == "mapped_with_unresolved_attachment"
    assert reports[1]["metadata"]["normalizations"] == ["items[0].id generated deterministically"]
    assert reports[1]["items"][0]["legacyUnit"] == "kg"

    sql = m.render_materialization(data, checksum)
    for required in (
        "BEGIN;", "COMMIT;", "pg_advisory_xact_lock(724019235)",
        "source_table='MedicalReport'", "Legacy medical source count mismatch",
        "medical_reports", "timeline_entries", "legacy_idempotency_mappings",
        "mapped_with_unresolved_attachment", "targetHashSha256", "medical-v1",
        "MedicalReport/",
    ):
        assert required in sql, required
    assert "INSERT INTO public.medical_report_attachments" not in sql

    malformed = copy.deepcopy(data)
    malformed["tables"]["MedicalReport"][0]["itemsJson"] = "not-json"
    expect_value_error(lambda: m.prepare_reports(malformed, checksum), "invalid JSON")

    cross_family = copy.deepcopy(data)
    cross_family["tables"]["MedicalReport"][0]["familyId"] = "test_family_b"
    expect_value_error(lambda: m.prepare_reports(cross_family, checksum), "crosses baby family")

    outsider = copy.deepcopy(data)
    outsider["tables"]["MedicalReport"][0]["recordedById"] = "test_user_other"
    expect_value_error(lambda: m.prepare_reports(outsider, checksum), "outside the baby family")

    invalid_status = copy.deepcopy(data)
    invalid_status["tables"]["MedicalReport"][0]["itemsJson"] = json.dumps([{"name": "test_marker", "value": 1, "status": "test_unknown"}])
    expect_value_error(lambda: m.prepare_reports(invalid_status, checksum), "status is invalid")

    non_finite = copy.deepcopy(data)
    non_finite["tables"]["MedicalReport"][0]["itemsJson"] = '[{"name":"test_marker","value":NaN,"status":"normal"}]'
    expect_value_error(lambda: m.prepare_reports(non_finite, checksum), "value is invalid")

    invalid_checksum = "B" * 64
    expect_value_error(lambda: m.render_materialization(data, invalid_checksum), "lowercase SHA-256")
    print("Medical materializer pure tests PASS")


if __name__ == "__main__":
    main()
