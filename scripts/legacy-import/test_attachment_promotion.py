"""Synthetic attachment promotion tests; no PostgreSQL/S3/MinIO access."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from attachment_promotion import MAPPING_VERSION, plan_attachment_promotion


def _canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


class AttachmentPromotionTests(unittest.TestCase):
    def _archive(self, *, mutate_files: dict[str, bytes] | None = None, files_override: list[dict] | None = None) -> Path:
        root = Path(tempfile.mkdtemp(prefix="test_attachment_archive_"))
        source_rows = {
            "User": [{"id": "test_attachment_user", "username": "test_attachment_user"}],
            "Family": [{"id": "test_attachment_family", "name": "test_attachment_family"}],
            "FamilyMember": [{
                "id": "test_attachment_member",
                "familyId": "test_attachment_family",
                "userId": "test_attachment_user",
                "role": "admin",
                "status": "active",
            }],
            "Baby": [{
                "id": "test_attachment_baby",
                "familyId": "test_attachment_family",
                "nickname": "test_attachment_baby",
            }],
            "GrowthMeasurement": [{
                "id": "test_growth_attachment_row",
                "babyId": "test_attachment_baby",
                "recordedById": "test_attachment_user",
                "date": "2026-09-18",
                "imageUrl": "/uploads/growth/test-growth.jpg",
            }],
            "MedicalReport": [{
                "id": "test_medical_attachment_row",
                "babyId": "test_attachment_baby",
                "recordedById": "test_attachment_user",
                "title": "test report",
                "imageUrl": "/uploads/medical/test-report.pdf",
            }],
            "AiJob": [{
                "id": "test_voice_job",
                "userId": "test_attachment_user",
                "babyId": "test_attachment_baby",
                "type": "voice_transcription",
                "inputArchiveId": "test_voice_archive",
            }],
            "AiArchive": [{
                "id": "test_voice_archive",
                "kind": "input_audio",
                "filePath": "data/archive/test-voice.m4a",
                "contentHash": "0" * 64,
                "byteSize": 0,
            }],
        }
        files = {
            "public/uploads/growth/test-growth.jpg": b"\xff\xd8\xfftest-growth",
            "public/uploads/medical/test-report.pdf": b"%PDF-1.4 test-report",
            "data/archive/test-voice.m4a": b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A ",
        }
        if mutate_files:
            files.update(mutate_files)
        for relative, payload in files.items():
            destination = root / "files" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(payload)
        voice = source_rows["AiArchive"][0]
        voice_payload = files["data/archive/test-voice.m4a"]
        voice["contentHash"] = hashlib.sha256(voice_payload).hexdigest()
        voice["byteSize"] = len(voice_payload)
        file_manifest = files_override or [
            {"path": path, "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}
            for path, payload in files.items()
        ]
        snapshot = {
            "formatVersion": 1,
            "sourceId": "test_attachment_source",
            "sourceSha256": "a" * 64,
            "timeZone": "Asia/Shanghai",
            "capturedAt": "2026-09-19T08:00:00+00:00",
            "tables": source_rows,
        }
        legacy_bytes = _canonical(snapshot)
        # snapshot.py writes compact JSON without a trailing newline.
        (root / "legacy.json").write_bytes(legacy_bytes)
        (root / "files.json").write_text(json.dumps(file_manifest), encoding="utf-8")
        (root / "manifest.json").write_text(json.dumps({
            "sourceId": "test_attachment_source",
            "sourceSha256": "a" * 64,
            "archiveSha256": hashlib.sha256(legacy_bytes).hexdigest(),
            "attachmentFiles": len(file_manifest),
        }), encoding="utf-8")
        growth = source_rows["GrowthMeasurement"][0]
        (root / "import_rows.json").write_text(json.dumps([{
            "sourceTable": "GrowthMeasurement",
            "sourceId": growth["id"],
            "payload": growth,
            "payloadHash": hashlib.sha256(_canonical(growth)).hexdigest(),
        }]), encoding="utf-8")
        return root

    def test_maps_owner_mime_hash_and_stable_key_without_writes(self) -> None:
        root = self._archive()
        first = plan_attachment_promotion(root)
        second = plan_attachment_promotion(root)

        self.assertEqual(first["status"], "planned")
        self.assertEqual(first["mappingVersion"], MAPPING_VERSION)
        self.assertEqual(first["counts"]["mapped"], 3)
        self.assertEqual(first["counts"]["quarantined"], 0)
        self.assertEqual(first["storage"], {"database": "not_written", "objectStore": "not_written"})
        self.assertEqual(first["receipts"], second["receipts"])
        by_source = {(item["sourceTable"], item["sourceField"]): item for item in first["receipts"]}
        growth = by_source[("GrowthMeasurement", "imageUrl")]
        self.assertEqual(growth["attachment"]["familyId"], "test_attachment_family")
        self.assertEqual(growth["attachment"]["babyId"], "test_attachment_baby")
        self.assertEqual(growth["attachment"]["uploaderId"], "test_attachment_user")
        self.assertEqual(growth["attachment"]["mimeType"], "image/jpeg")
        self.assertTrue(growth["targetObjectKey"].startswith("families/test_attachment_family/attachments/"))
        self.assertEqual(by_source[("AiArchive", "filePath")]["attachment"]["purpose"], "voice_note")

    def test_missing_uploader_is_quarantined_and_never_planned(self) -> None:
        root = self._archive()
        snapshot = json.loads((root / "legacy.json").read_text())
        del snapshot["tables"]["GrowthMeasurement"][0]["recordedById"]
        payload = _canonical(snapshot)
        (root / "legacy.json").write_bytes(payload)
        (root / "import_rows.json").unlink()
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["archiveSha256"] = hashlib.sha256(payload).hexdigest()
        (root / "manifest.json").write_text(json.dumps(manifest))

        report = plan_attachment_promotion(root)
        self.assertNotIn("test_growth_attachment_row", {r["sourceId"] for r in report["receipts"]})
        self.assertIn("MISSING_UPLOADER", {q["code"] for q in report["quarantine"]})

    def test_linked_ai_user_with_one_family_proves_attachment_scope(self) -> None:
        root = self._archive()
        snapshot = json.loads((root / "legacy.json").read_text())
        snapshot["tables"]["AiJob"][0]["babyId"] = None
        payload = _canonical(snapshot)
        (root / "legacy.json").write_bytes(payload)
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["archiveSha256"] = hashlib.sha256(payload).hexdigest()
        (root / "manifest.json").write_text(json.dumps(manifest))

        report = plan_attachment_promotion(root)
        voice = next(item for item in report["receipts"] if item["sourceId"] == "test_voice_archive")
        self.assertEqual(voice["attachment"]["familyId"], "test_attachment_family")
        self.assertEqual(voice["attachment"]["uploaderId"], "test_attachment_user")

    def test_baby_avatar_uses_unique_family_administrator_as_historical_uploader(self) -> None:
        root = self._archive()
        avatar_path = "public/uploads/avatars/test-avatar.png"
        avatar = b"\x89PNG\r\n\x1a\n" + b"test-avatar"
        destination = root / "files" / avatar_path
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(avatar)
        files = json.loads((root / "files.json").read_text())
        files.append({"path": avatar_path, "size": len(avatar), "sha256": hashlib.sha256(avatar).hexdigest()})
        (root / "files.json").write_text(json.dumps(files))
        snapshot = json.loads((root / "legacy.json").read_text())
        snapshot["tables"]["Baby"][0]["avatarUrl"] = "/uploads/avatars/test-avatar.png"
        payload = _canonical(snapshot)
        (root / "legacy.json").write_bytes(payload)
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["archiveSha256"] = hashlib.sha256(payload).hexdigest()
        (root / "manifest.json").write_text(json.dumps(manifest))

        report = plan_attachment_promotion(root)
        receipt = next(item for item in report["receipts"] if item["sourceTable"] == "Baby")
        self.assertEqual(receipt["attachment"]["uploaderId"], "test_attachment_user")
        self.assertEqual(receipt["attachment"]["purpose"], "avatar")

    def test_missing_file_and_hash_mismatch_fail_closed(self) -> None:
        root = self._archive()
        original = (root / "files" / "public/uploads/medical/test-report.pdf").read_bytes()
        (root / "files" / "public/uploads/medical/test-report.pdf").write_bytes(b"X" * len(original))
        report = plan_attachment_promotion(root)
        codes = {q["code"] for q in report["quarantine"]}
        self.assertIn("HASH_MISMATCH", codes)
        self.assertNotIn("test_medical_attachment_row", {r["sourceId"] for r in report["receipts"]})

        missing_root = self._archive()
        (missing_root / "files" / "public/uploads/medical/test-report.pdf").unlink()
        missing_report = plan_attachment_promotion(missing_root)
        self.assertIn("MISSING_FILE", {q["code"] for q in missing_report["quarantine"]})

    def test_allowed_extension_without_matching_magic_is_quarantined(self) -> None:
        root = self._archive()
        growth_path = root / "files/public/uploads/growth/test-growth.jpg"
        payload = b"not-a-real-jpeg-payload"
        growth_path.write_bytes(payload)
        files = json.loads((root / "files.json").read_text())
        growth = next(item for item in files if item["path"].endswith("test-growth.jpg"))
        growth["size"] = len(payload)
        growth["sha256"] = hashlib.sha256(payload).hexdigest()
        (root / "files.json").write_text(json.dumps(files))

        report = plan_attachment_promotion(root)
        self.assertIn("UNSUPPORTED_MIME", {q["code"] for q in report["quarantine"]})
        self.assertNotIn("test_growth_attachment_row", {r["sourceId"] for r in report["receipts"]})

    def test_path_traversal_is_rejected_before_filesystem_resolution(self) -> None:
        root = self._archive()
        snapshot = json.loads((root / "legacy.json").read_text())
        snapshot["tables"]["GrowthMeasurement"][0]["imageUrl"] = "/uploads/growth/../secret.jpg"
        payload = _canonical(snapshot)
        (root / "legacy.json").write_bytes(payload)
        manifest = json.loads((root / "manifest.json").read_text())
        manifest["archiveSha256"] = hashlib.sha256(payload).hexdigest()
        (root / "manifest.json").write_text(json.dumps(manifest))
        report = plan_attachment_promotion(root)
        self.assertIn("PATH_TRAVERSAL", {q["code"] for q in report["quarantine"]})
        self.assertNotIn("test_growth_attachment_row", {r["sourceId"] for r in report["receipts"]})

    def test_symlinked_archive_file_is_rejected(self) -> None:
        root = self._archive()
        growth_path = root / "files/public/uploads/growth/test-growth.jpg"
        outside = root.parent / "test_attachment_outside.bin"
        outside.write_bytes(growth_path.read_bytes())
        growth_path.unlink()
        growth_path.symlink_to(outside)
        report = plan_attachment_promotion(root)
        self.assertIn("SYMLINK_REJECTED", {q["code"] for q in report["quarantine"]})
        self.assertNotIn("test_growth_attachment_row", {r["sourceId"] for r in report["receipts"]})
        outside.unlink()

    def test_symlinked_archive_root_is_rejected(self) -> None:
        root = self._archive()
        link = root.parent / f"{root.name}_link"
        link.symlink_to(root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "archive_root must be a regular directory"):
            plan_attachment_promotion(link)
        link.unlink()

    def test_manifest_orphan_and_declared_mime_mismatch_are_visible(self) -> None:
        root = self._archive()
        files = json.loads((root / "files.json").read_text())
        files[0]["mimeType"] = "image/png"
        files[0]["sha256"] = hashlib.sha256((root / "files" / files[0]["path"]).read_bytes()).hexdigest()
        files.append({"path": "public/uploads/growth/test-orphan.jpg", "size": 8, "sha256": hashlib.sha256(b"orphan!!").hexdigest()})
        orphan = root / "files/public/uploads/growth/test-orphan.jpg"
        orphan.write_bytes(b"orphan!!")
        (root / "files.json").write_text(json.dumps(files))
        report = plan_attachment_promotion(root)
        codes = {q["code"] for q in report["quarantine"]}
        self.assertIn("MIME_MISMATCH", codes)
        self.assertIn("ORPHAN_FILE", codes)

    def test_import_rows_hash_mismatch_is_not_ignored(self) -> None:
        root = self._archive()
        rows = json.loads((root / "import_rows.json").read_text())
        rows[0]["payloadHash"] = "f" * 64
        (root / "import_rows.json").write_text(json.dumps(rows))
        report = plan_attachment_promotion(root)
        self.assertIn("SOURCE_ROW_HASH_MISMATCH", {q["code"] for q in report["quarantine"]})
        self.assertNotIn("test_growth_attachment_row", {r["sourceId"] for r in report["receipts"]})


if __name__ == "__main__":
    unittest.main()
