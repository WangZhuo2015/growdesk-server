"""Synthetic pure mapping tests; PostgreSQL receipts are tested separately."""
import copy
import json
import unittest
from formula_mapper import map_formula_product


class FormulaMappingTests(unittest.TestCase):
    def setUp(self):
        self.row = dict(id="test_formula", familyId="test_family", brand="test_brand", name="test_formula",
                        stage=1, scoopWeightG=4.3, waterPerScoopMl=30, reconstitutionRatio=0.1433,
                        servingSizeUnit="per_100g", nutrientsJson='{"protein":{"amount":1.4,"unit":"g","source":"test_label"}}',
                        notes="test_'\\;", isActive=0, isDefault=1,
                        createdAt="2026-09-19T08:00:00+08:00", updatedAt=1789776000000)

    def test_preserves_identity_inactive_metadata_and_exact_decimals(self):
        mapped = map_formula_product(self.row, {"test_family"})
        self.assertEqual(mapped["id"], self.row["id"])
        self.assertEqual(mapped["family_id"], self.row["familyId"])
        self.assertEqual(mapped["reconstitution_ratio"], "0.1433")
        self.assertEqual(mapped["notes"], self.row["notes"])
        self.assertEqual(json.loads(mapped["nutrients_json"])["protein"]["source"], "test_label")
        self.assertEqual(mapped["created_at"], "2026-09-19T00:00:00.000+00:00")
        self.assertFalse(mapped["is_active"])
        self.assertFalse(mapped["is_archived"])
        self.assertTrue(mapped["is_default"])

    def test_rejects_orphan_family(self):
        with self.assertRaisesRegex(ValueError, "family"):
            map_formula_product(self.row, {"test_other_family"})

    def test_retains_high_precision_json_tokens_and_empty_labels(self):
        self.row.update(brand="", name=" ", nutrientsJson='{"x":{"amount":0.12345678901234567890,"unit":"g"}}')
        mapped = map_formula_product(self.row, {"test_family"})
        self.assertEqual(mapped["nutrients_json"], self.row["nutrientsJson"])
        self.assertEqual(mapped["brand"], "")
        self.assertEqual(mapped["name"], " ")

    def test_rejects_lossy_or_invalid_source_without_defaults(self):
        for key, value in (("scoopWeightG", 4.123456), ("waterPerScoopMl", float("inf")),
                           ("reconstitutionRatio", 0), ("isActive", "false"), ("stage", True),
                           ("createdAt", "2026-09-19T00:00:00"), ("nutrientsJson", '{"x":{"amount":NaN,"unit":"g"}}'),
                           ("nutrientsJson", "[]"), ("nutrientsJson", "null"),
                           ("nutrientsJson", '{"x":{"amount":"1.4","unit":"g"}}'),
                           ("nutrientsJson", '{"x":{"amount":1.4,"unit":""}}'),
                           ("servingSizeUnit", "unknown")):
            with self.subTest(key=key, value=value):
                row = copy.deepcopy(self.row)
                row[key] = value
                with self.assertRaises(ValueError):
                    map_formula_product(row, {"test_family"})


if __name__ == "__main__":
    unittest.main()
