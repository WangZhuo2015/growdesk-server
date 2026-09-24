from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from embedded_attachment_audit import MAPPING_VERSION, audit_embedded_references, main
from attachment_promotion import plan_attachment_promotion


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


class EmbeddedAttachmentAuditTests(unittest.TestCase):
    def test_scans_all_registered_fields_and_deduplicates_paths(self) -> None:
        snapshot = {
            "tables": {
                "RecordSnapshot": [{
                    "id": "test_embedded_snapshot",
                    "payloadJson": {
                        "imageUrl": "/uploads/test/shared.png",
                        "nested": {"path": "public/uploads/test/shared.png"},
                        "path": "../secret.png",
                    },
                }],
                "AiJob": [{
                    "id": "test_embedded_job",
                    "resultJson": json.dumps({"filePath": "data/archive/test-job.m4a", "attachmentUrl": "https://example.test/object.png"}),
                }],
                "AiArchive": [{
                    "id": "test_embedded_archive",
                    "content": "test text /uploads/test/archive.png and /uploads/test/archive.png",
                }],
            },
        }

        report = audit_embedded_references(snapshot)

        self.assertEqual(report["mappingVersion"], MAPPING_VERSION)
        self.assertEqual(report["status"], "quarantined")
        self.assertEqual(report["counts"]["fieldsScanned"], 3)
        self.assertEqual(report["counts"]["rowsScanned"], 3)
        self.assertEqual(report["counts"]["uniquePaths"], 3)
        self.assertEqual(report["counts"]["references"], 5)
        shared = next(item for item in report["references"] if item.get("normalizedPath") == "public/uploads/test/shared.png")
        self.assertEqual(shared["jsonPointers"], ["/imageUrl", "/nested/path"])
        self.assertIn("EMBEDDED_PATH_TRAVERSAL", {item["code"] for item in report["references"]})
        self.assertIn("EMBEDDED_EXTERNAL_REFERENCE", {item["code"] for item in report["references"]})

    def test_planner_turns_embedded_references_into_a_cutover_stop(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="test_embedded_attachment_archive_"))
        snapshot = {
            "formatVersion": 1,
            "sourceId": "test_embedded_source",
            "sourceSha256": "a" * 64,
            "timeZone": "Asia/Shanghai",
            "capturedAt": "2026-09-19T08:00:00+00:00",
            "tables": {
                "User": [{"id": "test_embedded_user", "username": "test_embedded_user"}],
                "Family": [{"id": "test_embedded_family", "name": "test_embedded_family"}],
                "FamilyMember": [{"id": "test_embedded_member", "familyId": "test_embedded_family", "userId": "test_embedded_user", "status": "active"}],
                "Baby": [{"id": "test_embedded_baby", "familyId": "test_embedded_family"}],
                "RecordSnapshot": [{"id": "test_embedded_snapshot", "payloadJson": {"imageUrl": "/uploads/test/embedded.png"}}],
                "AiJob": [{"id": "test_embedded_job", "resultJson": {"imageUrl": "/uploads/test/job.png"}}],
                "AiArchive": [{"id": "test_embedded_archive", "content": "data/archive/test-archive.m4a"}],
            },
        }
        archive_bytes = canonical(snapshot)
        (root / "legacy.json").write_bytes(archive_bytes)
        (root / "files.json").write_text("[]", encoding="utf-8")
        (root / "manifest.json").write_text(json.dumps({
            "sourceId": snapshot["sourceId"],
            "sourceSha256": snapshot["sourceSha256"],
            "archiveSha256": hashlib.sha256(archive_bytes).hexdigest(),
            "attachmentFiles": 0,
            "attachmentBytes": 0,
        }), encoding="utf-8")

        report = plan_attachment_promotion(root)

        self.assertEqual(report["status"], "quarantined")
        self.assertEqual(report["embeddedReferenceAudit"]["counts"]["references"], 3)
        self.assertGreaterEqual(report["counts"]["quarantined"], 3)
        self.assertTrue(all("content" not in item and "payload" not in item for item in report["embeddedReferenceAudit"]["quarantine"]))
        self.assertIn("EMBEDDED_FILE_MISSING", {item["code"] for item in report["quarantine"]})

        embedded_path = "public/uploads/test/embedded.png"
        embedded_bytes = b"\x89PNG\r\n\x1a\n" + b"test-embedded"
        embedded_file = root / "files" / embedded_path
        embedded_file.parent.mkdir(parents=True, exist_ok=True)
        embedded_file.write_bytes(embedded_bytes)
        duplicate_entries = [{
            "path": embedded_path,
            "size": len(embedded_bytes),
            "sha256": hashlib.sha256(embedded_bytes).hexdigest(),
        }] * 2
        (root / "files.json").write_text(json.dumps(duplicate_entries), encoding="utf-8")
        manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
        manifest["attachmentFiles"] = 2
        manifest["attachmentBytes"] = len(embedded_bytes) * 2
        (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        ambiguous = plan_attachment_promotion(root)

        self.assertIn("EMBEDDED_FILE_AMBIGUOUS", {item["code"] for item in ambiguous["quarantine"]})

    def test_cli_writes_a_new_source_free_report_and_fails_on_unresolved_paths(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="test_embedded_attachment_cli_"))
        archive = {
            "tables": {
                "RecordSnapshot": [{"id": "test_cli_snapshot", "payloadJson": {"path": "/uploads/test/cli.png"}}],
                "AiJob": [],
                "AiArchive": [],
            },
        }
        (root / "legacy.json").write_bytes(canonical(archive))
        output = root / "embedded-audit.json"
        self.assertEqual(main(["--archive", str(root), "--output", str(output)]), 1)
        saved = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(saved["mappingVersion"], MAPPING_VERSION)
        self.assertEqual(saved["status"], "quarantined")
        self.assertEqual(saved["counts"]["references"], 1)
        self.assertNotIn("cli.png bytes", output.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
