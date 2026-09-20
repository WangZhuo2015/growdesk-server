"""Pure semantic checks for the bounded legacy food promotion."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path


PATH = Path(__file__).with_name("materialize_food.py")
SPEC = importlib.util.spec_from_file_location("materialize_food_test", PATH)
assert SPEC is not None and SPEC.loader is not None
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


STAMP = "2026-09-12T08:00:00+08:00"


def archive(prefix: str = "test_food_materializer") -> dict:
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "capturedAt": STAMP,
        "sourceId": "legacy_web",
        "sourceSha256": "source-snapshot",
        "excluded": [],
        "tables": {
            "User": [{
                "id": f"{prefix}_user", "username": f"{prefix}_user",
                "passwordHash": "$2b$10$" + "a" * 53, "displayName": f"{prefix}_user",
                "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "Family": [{"id": f"{prefix}_family", "name": f"{prefix}_family", "createdAt": STAMP, "updatedAt": STAMP}],
            "FamilyMember": [{"id": f"{prefix}_member", "familyId": f"{prefix}_family", "userId": f"{prefix}_user", "role": "admin", "createdAt": STAMP, "updatedAt": STAMP}],
            "Baby": [{"id": f"{prefix}_baby", "familyId": f"{prefix}_family", "nickname": f"{prefix}_baby", "gender": "female", "birthDate": "2026-01-01", "createdAt": STAMP, "updatedAt": STAMP}],
            "FoodItem": [
                {
                    "id": f"{prefix}_reference_pk", "foodId": "food_egg", "name": "鸡蛋", "icon": "🥚", "category": "protein",
                    "recommendedFromMonth": 6, "isCommonAllergen": 1, "highRiskInfantNeedsMedicalAdvice": 0,
                    "preparationJson": "[\"蒸熟\"]", "nutritionJson": "[]", "textureByAgeJson": "[]", "sourceRefsJson": "[]",
                    "createdAt": STAMP, "updatedAt": STAMP,
                },
                {
                    "id": f"{prefix}_custom_pk", "foodId": f"{prefix}_custom_food", "name": "测试南瓜", "icon": "🎃", "category": "other",
                    "recommendedFromMonth": 6, "isCommonAllergen": 0, "highRiskInfantNeedsMedicalAdvice": 0,
                    "preparationJson": "[]", "nutritionJson": "[]", "textureByAgeJson": "[]", "sourceRefsJson": "[]",
                    "createdAt": STAMP, "updatedAt": STAMP,
                },
            ],
            "FoodLogRecord": [{
                "id": f"{prefix}_log", "babyId": f"{prefix}_baby", "clientId": f"{prefix}_log_client", "recordedById": f"{prefix}_user",
                "date": "2026-09-12", "time": "08:30", "foods": json.dumps(["鸡蛋", {"id": f"{prefix}_custom_food", "name": "测试南瓜"}], ensure_ascii=False),
                "portion": "most", "acceptance": 4, "babyState": "happy", "hasAbnormal": 0, "abnormalNotes": None,
                "source": "ui_manual", "sourceAgent": "legacy-test", "createdAt": STAMP,
            }],
            "FamilyFoodStatus": [{
                "id": f"{prefix}_status", "familyId": f"{prefix}_family", "foodId": f"{prefix}_custom_food", "status": "tried",
                "firstAddedDate": "2026-09-10", "acceptance": 4, "updatedAt": STAMP,
            }],
        },
    }


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


class FoodMaterializerTests(unittest.TestCase):
    def test_maps_ownership_ids_observations_and_metadata(self) -> None:
        data = archive()
        actual = checksum(data)
        items, by_food_id, by_name = M.prepare_food_items(data, actual)
        logs = M.prepare_food_logs(data, actual, by_food_id, by_name)
        statuses = M.prepare_food_statuses(data, actual, by_food_id)

        reference = next(item for item in items if item["food_id"] == "food_egg")
        custom = next(item for item in items if item["is_custom"])
        self.assertEqual(reference["id"], "food_egg")
        self.assertEqual(custom["id"], "test_food_materializer_custom_pk")
        self.assertEqual(custom["family_id"], "test_food_materializer_family")
        self.assertEqual(reference["allergen_risk"], "high")
        self.assertEqual(statuses[0]["food_item_id"], custom["id"])
        self.assertEqual(statuses[0]["legacy_acceptance"], 4)
        self.assertEqual(logs[0]["food_item_ids"], ["鸡蛋", custom["id"]])
        self.assertEqual(logs[0]["occurred_at"], "2026-09-12T00:30:00.000Z")
        self.assertEqual(logs[0]["meal_type"], "breakfast")
        self.assertEqual(logs[0]["reaction"], "like")
        self.assertTrue(logs[0]["notes"].startswith(M.NOTES_PREFIX))
        decoded = json.loads(logs[0]["notes"][len(M.NOTES_PREFIX):])
        self.assertEqual(decoded["observations"]["acceptance"], 4)
        self.assertEqual(decoded["observations"]["babyState"], "happy")
        self.assertEqual(logs[0]["metadata"]["targetSnapshot"]["legacyClientId"], "test_food_materializer_log_client")
        self.assertEqual(len(logs[0]["metadata"]["targetHashSha256"]), 64)

    def test_render_is_one_transaction_with_receipts_and_timeline(self) -> None:
        data = archive()
        sql = M.render_materialization(data, checksum(data))
        self.assertTrue(sql.startswith("BEGIN;"))
        self.assertIn("COMMIT;", sql)
        self.assertIn("legacy_idempotency_mappings", sql)
        self.assertIn("timeline_entries", sql)
        self.assertIn("food_library_items", sql)
        self.assertIn("family_food_statuses", sql)
        self.assertIn("legacy_client_id", sql)
        self.assertIn("food-v1", sql)
        self.assertIn("Legacy FoodItem source count mismatch", sql)
        self.assertIn("UPDATE public.food_library_items", sql)

    def test_custom_item_without_single_family_owner_fails_before_render(self) -> None:
        data = archive()
        data["tables"]["FamilyFoodStatus"] = []
        with self.assertRaisesRegex(ValueError, "no provable family owner"):
            M.render_materialization(data, checksum(data))

    def test_cross_family_actor_and_duplicate_client_are_rejected(self) -> None:
        data = archive()
        other_family = {"id": "test_food_other_family", "name": "test_food_other_family", "createdAt": STAMP, "updatedAt": STAMP}
        other_user = {"id": "test_food_other_user", "username": "test_food_other_user", "passwordHash": "$2b$10$" + "b" * 53, "displayName": "test_food_other_user", "createdAt": STAMP, "updatedAt": STAMP}
        data["tables"]["Family"].append(other_family)
        data["tables"]["User"].append(other_user)
        data["tables"]["FamilyMember"].append({"id": "test_food_other_member", "familyId": other_family["id"], "userId": other_user["id"], "role": "admin", "createdAt": STAMP, "updatedAt": STAMP})
        bad = copy.deepcopy(data["tables"]["FoodLogRecord"][0])
        bad["id"] = "test_food_cross_family"
        bad["babyId"] = "test_food_other_baby"
        data["tables"]["Baby"].append({"id": bad["babyId"], "familyId": other_family["id"], "nickname": "test_food_other_baby", "gender": "male", "birthDate": "2026-01-01", "createdAt": STAMP, "updatedAt": STAMP})
        bad["clientId"] = "test_food_other_client"
        data["tables"]["FoodLogRecord"].append(bad)
        with self.assertRaisesRegex(ValueError, "recordedById is outside"):
            M.render_materialization(data, checksum(data))

        duplicate = copy.deepcopy(data)
        duplicate["tables"]["FoodLogRecord"] = [
            copy.deepcopy(archive()["tables"]["FoodLogRecord"][0]),
            {**copy.deepcopy(archive()["tables"]["FoodLogRecord"][0]), "id": "test_food_duplicate_client"},
        ]
        with self.assertRaisesRegex(ValueError, "Duplicate FoodLogRecord clientId"):
            M.render_materialization(duplicate, checksum(duplicate))

    def test_source_hash_changes_checksum_and_never_reuses_old_receipt(self) -> None:
        data = archive()
        first = checksum(data)
        changed = copy.deepcopy(data)
        changed["tables"]["FoodLogRecord"][0]["acceptance"] = 2
        second = checksum(changed)
        self.assertNotEqual(first, second)
        sql = M.render_materialization(changed, second)
        self.assertIn(second, sql)
        self.assertNotIn(first, sql)

    def test_foods_requires_strict_json_array(self) -> None:
        data = archive()
        data["tables"]["FoodLogRecord"][0]["foods"] = "not-json"
        with self.assertRaisesRegex(ValueError, "foods is not valid JSON"):
            M.render_materialization(data, checksum(data))

        data = archive()
        data["tables"]["FoodLogRecord"][0]["foods"] = json.dumps({"name": "test_food"})
        with self.assertRaisesRegex(ValueError, "foods must be a JSON array"):
            M.render_materialization(data, checksum(data))


if __name__ == "__main__":
    unittest.main()
