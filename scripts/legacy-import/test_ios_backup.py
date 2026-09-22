import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("ios_backup", Path(__file__).with_name("ios_backup.py"))
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


def _base_snapshot():
    return {
        "formatVersion": 1,
        "sourceId": "test_source",
        "timeZone": "Asia/Shanghai",
        "capturedAt": "2026-09-12T00:00:00Z",
        "tables": {
            "Family": [{"id": "test_family", "name": "test_family_name"}],
            "Baby": [{
                "id": "test_baby",
                "familyId": "test_family",
                "nickname": "test_baby_name",
                "gender": "female",
                "birthDate": "2026-01-02",
                "gestationalAge": 39,
                "avatarUrl": "https://example.test/test_baby.png",
                "createdAt": "2026-01-02T00:00:00+08:00",
                "updatedAt": "2026-09-11T10:00:00+08:00",
            }],
            "FormulaProduct": [{
                "id": "test_formula",
                "familyId": "test_family",
                "name": "test_formula_name",
            }],
            "SupplementProduct": [{
                "id": "test_supplement",
                "familyId": "test_family",
                "name": "test_supplement_name",
                "unitName": "mg",
                "defaultDose": 1.5,
            }],
            "FeedingRecord": [{
                "id": "test_record_feeding",
                "babyId": "test_baby",
                "timestamp": "2026-09-11T08:00:00+08:00",
                "type": "formula",
                "amountMl": 120,
                "formulaProductId": "test_formula",
                "spitUp": False,
                "notes": "test_feeding_note",
                "createdAt": "2026-09-11T08:00:00+08:00",
                "updatedAt": "2026-09-11T08:00:00+08:00",
            }],
            "SleepRecord": [{
                "id": "test_record_sleep",
                "babyId": "test_baby",
                "startTime": "2026-09-11T21:00:00+08:00",
                "endTime": "2026-09-12T06:00:00+08:00",
                "type": "night",
                "nightWakingCount": 1,
                "fallingAsleepMethod": "test_method",
                "wakeUpMood": "test_mood",
            }],
            "DiaperRecord": [{
                "id": "test_record_diaper",
                "babyId": "test_baby",
                "timestamp": "2026-09-11T09:00:00+08:00",
                "type": "poop",
                "poopColor": "yellow",
                "poopConsistency": "paste",
            }],
            "FoodLogRecord": [{
                "id": "test_record_food",
                "babyId": "test_baby",
                "date": "2026-09-11",
                "time": "12:00",
                "foods": json.dumps([{"id": "test_food_item", "name": "test_food", "grams": 20, "foodId": "test_reference_food"}], ensure_ascii=False),
                "portion": "most",
                "acceptance": 4,
                "babyState": "happy",
                "hasAbnormal": False,
                "abnormalNotes": "",
            }],
            "SupplementRecord": [{
                "id": "test_record_supplement",
                "babyId": "test_baby",
                "productId": "test_supplement",
                "date": "2026-09-11",
                "time": "09:30",
                "dose": 1.5,
                "unitName": "mg",
            }],
            "GrowthMeasurement": [{
                "id": "test_record_growth",
                "babyId": "test_baby",
                "date": "2026-09-11",
                "ageInMonths": 8,
                "ageLabel": "test_age",
                "weightKg": 8.25,
                "heightCm": 70.5,
                "headCircumferenceCm": 44.1,
                "percentile": 60,
                "imageUrl": "https://example.test/test_growth.jpg",
            }],
            "VaccineRecord": [{
                "id": "test_record_vaccine",
                "babyId": "test_baby",
                "name": "test_vaccine",
                "dose": "test_dose",
                "scheduledDate": "2026-09-11",
                "completedDate": "2026-09-11",
                "isCompleted": True,
            }],
            "MedicalReport": [{
                "id": "test_record_medical",
                "babyId": "test_baby",
                "title": "test_checkup",
                "category": "blood",
                "date": "2026-09-11",
                "hospital": "test_hospital",
                "doctorNotes": "test_doctor_notes",
                "aiSummary": "test_ai_summary",
                "itemsJson": json.dumps([{
                    "id": "test_medical_item",
                    "name": "test_marker",
                    "value": 4.2,
                    "unit": "mg/L",
                    "referenceRange": "test_range",
                    "status": "normal",
                    "interpretation": "test_interpretation",
                }]),
                "imageUrl": "https://example.test/test_medical.pdf",
            }],
            "FoodPlan": [{"id": "test_food_plan", "babyId": "test_baby"}],
            "User": [{"id": "test_user", "username": "test_user", "passwordHash": "test_secret"}],
        },
        "excluded": {"OAuthRefreshToken": 1},
    }


class IOSBackupTests(unittest.TestCase):
    def test_all_eight_native_record_kinds_and_swift_wire_shape(self):
        backup, report = MODULE.convert_snapshot(
            _base_snapshot(), family_id="test_family", baby_id="test_baby"
        )

        self.assertEqual(backup["schemaVersion"], 3)
        self.assertEqual(backup["vaultID"], "legacy:test_source")
        self.assertEqual(backup["babies"][0]["id"], "test_baby")
        self.assertEqual(len(backup["records"]), 8)
        self.assertEqual(
            [record["id"] for record in backup["records"]],
            sorted(record["id"] for record in backup["records"]),
        )
        self.assertEqual(set(report["mappedRecords"]), {
            "feeding", "sleep", "diaper", "food", "supplement", "growth", "vaccine", "medical"
        })
        self.assertTrue(all(count == 1 for count in report["mappedRecords"].values()))

        feeding = next(record for record in backup["records"] if record["id"] == "test_record_feeding")
        self.assertEqual(feeding["payload"]["feeding"]["_0"]["formulaName"], "test_formula_name")
        self.assertIsInstance(feeding["occurredAt"], (int, float))
        self.assertAlmostEqual(
            feeding["occurredAt"],
            datetime(2026, 9, 11, 0, 0, tzinfo=timezone.utc).timestamp(),
        )
        self.assertEqual(
            next(record for record in backup["records"] if record["id"] == "test_record_sleep")["payload"]["sleep"]["_0"]["startAt"],
            next(record for record in backup["records"] if record["id"] == "test_record_sleep")["occurredAt"],
        )
        food = next(record for record in backup["records"] if record["id"] == "test_record_food")
        self.assertEqual(food["payload"]["food"]["_0"]["foods"][0]["id"], "test_food_item")
        medical = next(record for record in backup["records"] if record["id"] == "test_record_medical")
        self.assertIn("test_interpretation", medical["notes"])
        self.assertEqual(medical["payload"]["medical"]["_0"]["items"][0]["value"], "4.2")

        serialized = json.dumps(backup, ensure_ascii=False)
        self.assertNotIn("passwordHash", serialized)
        self.assertNotIn("test_secret", serialized)
        self.assertEqual(len(report["attachmentLinks"]), 3)
        self.assertFalse(report["complete"])
        self.assertEqual(report["unsupportedTables"]["FoodPlan"]["selectedCount"], 1)
        self.assertIn("attachment links", backup["babies"][0]["notes"])

    def test_explicit_family_and_baby_scope_excludes_other_baby(self):
        snapshot = _base_snapshot()
        snapshot["tables"]["Baby"].append({
            "id": "test_other_baby",
            "familyId": "test_family",
            "nickname": "test_other_baby_name",
            "gender": "male",
            "birthDate": "2025-01-01",
        })
        snapshot["tables"]["FeedingRecord"].append({
            "id": "test_other_record",
            "babyId": "test_other_baby",
            "timestamp": "2026-09-11T08:00:00+08:00",
            "type": "breast",
        })

        backup, report = MODULE.convert_snapshot(
            snapshot, family_id="test_family", baby_id="test_baby"
        )
        self.assertEqual([baby["id"] for baby in backup["babies"]], ["test_baby"])
        self.assertNotIn("test_other_record", {record["id"] for record in backup["records"]})
        self.assertEqual(report["mappedRecords"]["feeding"], 1)

    def test_selected_unrepresentable_row_fails_or_is_explicitly_quarantined(self):
        snapshot = _base_snapshot()
        snapshot["tables"]["FeedingRecord"].append({
            "id": "test_record_bad_feeding",
            "babyId": "test_baby",
            "timestamp": "2026-09-11T08:00:00+08:00",
            "type": "solid",
            "foodName": "test_solid_food",
        })

        with self.assertRaises(MODULE.ConversionError) as context:
            MODULE.convert_snapshot(snapshot, family_id="test_family", baby_id="test_baby")
        self.assertEqual(len(context.exception.report["quarantinedRecords"]), 1)
        self.assertEqual(context.exception.report["quarantinedRecords"][0]["id"], "test_record_bad_feeding")

        backup, report = MODULE.convert_snapshot(
            snapshot,
            family_id="test_family",
            baby_id="test_baby",
            allow_quarantine=True,
        )
        self.assertEqual(len(backup["records"]), 8)
        self.assertEqual(len(report["quarantinedRecords"]), 1)

    def test_cli_writes_backup_and_report_without_source_access(self):
        snapshot = _base_snapshot()
        with tempfile.TemporaryDirectory(prefix="test_ios_backup_") as folder:
            folder_path = Path(folder)
            input_path = folder_path / "test_legacy.json"
            output_path = folder_path / "test_backup.json"
            report_path = folder_path / "test_report.json"
            input_path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
            result = MODULE.main([
                "--input", str(input_path),
                "--output", str(output_path),
                "--report", str(report_path),
                "--family-id", "test_family",
                "--baby-id", "test_baby",
            ])
            self.assertEqual(result, 0)
            self.assertEqual(json.loads(output_path.read_text())["schemaVersion"], 3)
            self.assertEqual(json.loads(report_path.read_text())["output"]["recordCount"], 8)


if __name__ == "__main__":
    unittest.main()
