"""Pure GrowthMeasurement mapper tests; no database or attachment access."""

from __future__ import annotations

import copy
import hashlib
import json
import unittest

from growth_mapper import map_growth_measurement


class GrowthMappingTests(unittest.TestCase):
    def setUp(self) -> None:
        stamp = "2026-09-19T08:00:00+08:00"
        self.data = {
            "formatVersion": 1,
            "timeZone": "Asia/Shanghai",
            "capturedAt": stamp,
            "sourceId": "test_legacy_source",
            "sourceSha256": "a" * 64,
            "tables": {
                "User": [{"id": "test_growth_user", "username": "test_growth_user"}],
                "Family": [{"id": "test_growth_family", "name": "test_growth_family"}],
                "FamilyMember": [{
                    "id": "test_growth_member", "familyId": "test_growth_family",
                    "userId": "test_growth_user", "role": "admin", "status": "active",
                }],
                "Baby": [{
                    "id": "test_growth_baby", "familyId": "test_growth_family",
                    "birthDate": "2026-01-01",
                }],
            },
        }
        self.row = {
            "id": "test_growth_row",
            "babyId": "test_growth_baby",
            "clientId": "test_growth_client",
            "recordedById": "test_growth_user",
            "source": "ui_manual",
            "sourceAgent": "test_growth_agent",
            "date": "2026-09-18",
            "ageInMonths": 8,
            "ageLabel": "8月18天",
            "weightKg": "7.250",
            "heightCm": "66.50",
            "headCircumferenceCm": "42.50",
            "percentile": 75,
            "imageUrl": None,
            "notes": "test human notes",
            "createdAt": "2026-09-19T08:00:00+08:00",
            "updatedAt": "2026-09-19T08:00:00+08:00",
            "sessionToken": "test_sensitive_value",
        }
        self.checksum = "b" * 64

    def test_maps_date_decimal_and_metadata_without_notes_pollution(self) -> None:
        mapped = map_growth_measurement(self.data, self.row, self.checksum)
        self.assertEqual(mapped["id"], "test_growth_row")
        self.assertEqual(mapped["family_id"], "test_growth_family")
        self.assertEqual(mapped["baby_id"], "test_growth_baby")
        self.assertEqual(mapped["measurement_date"], "2026-09-18")
        self.assertEqual(mapped["occurred_at"], "2026-09-18T00:00:00.000Z")
        self.assertEqual(mapped["weight_kg"], "7.25")
        self.assertEqual(mapped["height_cm"], "66.5")
        self.assertEqual(mapped["head_circumference_cm"], "42.5")
        self.assertEqual(mapped["notes"], "test human notes")
        self.assertEqual(mapped["metadata"]["legacyGrowth"], {
            "ageInMonths": 8, "ageLabel": "8月18天", "percentile": 75,
        })
        self.assertEqual(mapped["metadata"]["legacySource"], "ui_manual")
        self.assertEqual(mapped["metadata"]["legacySourceAgent"], "test_growth_agent")
        self.assertEqual(mapped["metadata"]["extra"]["sessionToken"], "[redacted]")
        self.assertEqual(mapped["metadata"]["sourceBatchId"], self.checksum)
        expected_hash = hashlib.sha256(
            json.dumps(self.row, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        ).hexdigest()
        self.assertEqual(mapped["source_hash"], expected_hash)

    def test_empty_client_key_means_no_idempotency_key(self) -> None:
        row = {**self.row, "clientId": ""}
        self.assertIsNone(map_growth_measurement(self.data, row, self.checksum)["client_id"])
        # Whitespace is a real non-empty old key; do not trim stored identities.
        row["clientId"] = " "
        self.assertEqual(map_growth_measurement(self.data, row, self.checksum)["client_id"], " ")

    def test_allows_recorded_date_alias_only_when_consistent(self) -> None:
        row = copy.deepcopy(self.row)
        del row["date"]
        row["recordedDate"] = "2026-09-18"
        self.assertEqual(map_growth_measurement(self.data, row, self.checksum)["measurement_date"], "2026-09-18")
        row["date"] = "2026-09-17"
        with self.assertRaisesRegex(ValueError, "disagree"):
            map_growth_measurement(self.data, row, self.checksum)

    def test_rejects_image_rows_and_lossy_measurements(self) -> None:
        image_row = copy.deepcopy(self.row)
        image_row["imageUrl"] = "/uploads/growth/test.jpg"
        with self.assertRaisesRegex(ValueError, "attachment"):
            map_growth_measurement(self.data, image_row, self.checksum)

        for key, value in (
            ("weightKg", "7.256"),  # target DECIMAL(5,2) cannot represent this without rounding
            ("heightCm", 0),
            ("headCircumferenceCm", -1),
            ("weightKg", "1000.00"),
            ("percentile", 101),
            ("ageInMonths", True),
        ):
            row = copy.deepcopy(self.row)
            row[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                map_growth_measurement(self.data, row, self.checksum)

        no_values = copy.deepcopy(self.row)
        no_values.update(weightKg=None, heightCm=None, headCircumferenceCm=None)
        with self.assertRaisesRegex(ValueError, "no measurement"):
            map_growth_measurement(self.data, no_values, self.checksum)

    def test_rejects_cross_family_and_inactive_actor(self) -> None:
        row = copy.deepcopy(self.row)
        row["familyId"] = "test_other_family"
        with self.assertRaisesRegex(ValueError, "crosses baby family"):
            map_growth_measurement(self.data, row, self.checksum)

        inactive_data = copy.deepcopy(self.data)
        inactive_data["tables"]["FamilyMember"][0]["status"] = "revoked"
        with self.assertRaisesRegex(ValueError, "outside the baby family"):
            map_growth_measurement(inactive_data, self.row, self.checksum)


if __name__ == "__main__":
    unittest.main()
