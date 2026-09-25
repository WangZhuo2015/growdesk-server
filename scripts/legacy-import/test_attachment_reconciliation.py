"""Pure receipt-boundary tests; no production archive or database is accessed."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest


def load(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


canonical = load("canonical_verification")
fixture = load("test_care_materializer_integration")


class AttachmentReconciliationTests(unittest.TestCase):
    def setUp(self):
        self.data = fixture.archive("test_attachment_reconciliation")

    def checksum(self):
        return hashlib.sha256(json.dumps(self.data, sort_keys=True).encode()).hexdigest()

    def image(self, table, field):
        row = self.data["tables"][table][0]
        row[field] = "/uploads/test_unmapped_private_image.png"
        return row["id"]

    def report(self, table, row_id, field):
        return {
            "mappingVersion": "attachment-promotion-v1",
            "receipts": [{
                "sourceBatchId": self.checksum(), "sourceTable": table,
                "sourceId": row_id, "sourceField": field,
                "sourcePath": "public/uploads/test_unmapped_private_image.png",
                "targetAttachmentId": "00000000-0000-4000-8000-000000000007",
                "attachment": {
                    "id": "00000000-0000-4000-8000-000000000007",
                    "familyId": "00000000-0000-4000-8000-000000000001",
                    "uploaderId": "00000000-0000-4000-8000-000000000002",
                    "babyId": "00000000-0000-4000-8000-000000000003",
                    "purpose": "avatar" if table == "Baby" else "medical_report",
                    "mimeType": "image/png", "byteSize": 42,
                    "sha256": "a" * 64, "objectKey": "test-reconciliation/image.png",
                },
            }],
        }

    def no_query(self, _sql):
        self.fail("unmapped source image must not reach the database query")

    def assert_missing_mapping(self, report=None):
        with self.assertRaisesRegex(ValueError, "missing canonical attachment mapping") as raised:
            canonical.verify_canonical(self.data, self.checksum(), self.no_query, report)
        # Refuse without printing an original private image path.
        self.assertNotIn("test_unmapped_private_image", str(raised.exception))

    def test_growth_image_requires_mapping_before_query(self):
        self.image("GrowthMeasurement", "imageUrl")
        self.assert_missing_mapping()
        self.assert_missing_mapping({"mappingVersion": "attachment-promotion-v1", "receipts": []})

    def test_baby_avatar_requires_mapping_before_query(self):
        self.image("Baby", "avatarUrl")
        self.assert_missing_mapping()
        self.assert_missing_mapping({"mappingVersion": "attachment-promotion-v1", "receipts": []})

    def test_absent_and_empty_images_still_need_no_mapping(self):
        for value in (None, ""):
            with self.subTest(value=value):
                self.data["tables"]["GrowthMeasurement"][0]["imageUrl"] = value
                self.data["tables"]["Baby"][0]["avatarUrl"] = value
                checks = canonical.build_checks(self.data, self.checksum())
                self.assertGreater(len(checks), 0)
                result = canonical.verify_canonical(self.data, self.checksum(),
                    lambda _: {"checked": len(checks), "mismatched": 0, "tables": []})
                self.assertTrue(result["passed"])

    def test_valid_growth_mapping_retains_canonical_attachment_predicate(self):
        row_id = self.image("GrowthMeasurement", "imageUrl")
        report = self.report("GrowthMeasurement", row_id, "imageUrl")
        checks = canonical.build_checks(self.data, self.checksum(), report)
        predicates = " ".join(sql for name, sql in checks if name == "GrowthMeasurement")
        self.assertIn("t.attachment_id IS NOT DISTINCT FROM '00000000-0000-4000-8000-000000000007'", predicates)
        self.assertTrue(any(name == "Attachment" for name, _ in checks))

    def test_valid_avatar_mapping_retains_protected_url_predicate(self):
        row_id = self.image("Baby", "avatarUrl")
        report = self.report("Baby", row_id, "avatarUrl")
        checks = canonical.build_checks(self.data, self.checksum(), report)
        self.assertTrue(any(name == "Baby" and "/api/attachments/00000000-0000-4000-8000-000000000007" in sql
                            for name, sql in checks))

    def test_receipt_for_another_field_does_not_hide_missing_image(self):
        row_id = self.image("GrowthMeasurement", "imageUrl")
        self.assert_missing_mapping(self.report("GrowthMeasurement", row_id, "differentField"))

    def test_receipt_from_another_batch_is_rejected(self):
        row_id = self.image("GrowthMeasurement", "imageUrl")
        report = self.report("GrowthMeasurement", row_id, "imageUrl")
        report["receipts"][0]["sourceBatchId"] = "b" * 64
        with self.assertRaisesRegex(ValueError, "another source batch"):
            canonical.verify_canonical(self.data, self.checksum(), self.no_query, report)

    def test_ambiguous_receipts_are_still_rejected(self):
        row_id = self.image("GrowthMeasurement", "imageUrl")
        report = self.report("GrowthMeasurement", row_id, "imageUrl")
        other = copy.deepcopy(report["receipts"][0])
        other["attachment"]["id"] = "00000000-0000-4000-8000-000000000008"
        report["receipts"].append(other)
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            canonical.verify_canonical(self.data, self.checksum(), self.no_query, report)


if __name__ == "__main__":
    unittest.main()
