"""Pure safety tests for the cutover orchestrator; no Docker or PostgreSQL."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("cutover_runner", Path(__file__).with_name("cutover_runner.py"))
assert SPEC is not None and SPEC.loader is not None
cutover = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cutover)


class RecordingExecutor:
    def __init__(self) -> None:
        self.docker = "docker"
        self.python = "python3"
        self.commands: list[list[str]] = []

    def run(self, args, **_kwargs) -> str:
        self.commands.append(list(args))
        return ""


class CutoverRunnerTests(unittest.TestCase):
    def snapshot(self) -> tuple[Path, Path, dict]:
        root = Path(tempfile.mkdtemp(prefix="test_cutover_snapshot_"))
        root.chmod(0o700)
        source = root / "source.sqlite"
        source.write_bytes(b"test immutable sqlite bytes")
        source.chmod(0o600)
        archive = {
            "formatVersion": 1,
            "sourceId": "test_cutover_source",
            "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "timeZone": "Asia/Shanghai",
            "tables": {"User": [], "Family": [], "FamilyMember": [], "Baby": []},
        }
        archive_path = root / "legacy.json"
        archive_path.write_text(json.dumps(archive, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        archive_path.chmod(0o600)
        manifest = {
            "sourceId": archive["sourceId"],
            "sourceSha256": archive["sourceSha256"],
            "archiveSha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
            "counts": {"User": 0, "Family": 0, "FamilyMember": 0, "Baby": 0},
        }
        manifest_path = root / "manifest.json"
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
        manifest_path.chmod(0o600)
        return root, manifest_path, manifest

    def test_snapshot_requires_matching_archive_and_source_hashes(self) -> None:
        root, manifest, expected = self.snapshot()
        result = cutover.validate_snapshot(root, manifest)
        self.assertEqual(result["sourceId"], "test_cutover_source")
        self.assertEqual(result["archiveSha256"], expected["archiveSha256"])
        raw = json.loads((root / "manifest.json").read_text())
        raw["sourceId"] = "test_other_source"
        (root / "manifest.json").write_text(json.dumps(raw))
        (root / "manifest.json").chmod(0o600)
        with self.assertRaises(cutover.CutoverError):
            cutover.validate_snapshot(root, manifest)

    def test_snapshot_rejects_public_archive(self) -> None:
        root, manifest, _ = self.snapshot()
        (root / "legacy.json").chmod(0o644)
        with self.assertRaises(cutover.CutoverError):
            cutover.validate_snapshot(root, manifest)

    def test_attachment_configuration_is_required(self) -> None:
        with self.assertRaisesRegex(cutover.CutoverError, "attachment storage"):
            cutover.validate_attachment_config({"POSTGRES_SUPERUSER_PASSWORD": "test"})

    def test_attachment_configuration_rejects_non_private_endpoint(self) -> None:
        values = {
            "POSTGRES_SUPERUSER_PASSWORD": "a" * 64,
            "S3_BUCKET": "test-bucket",
            "S3_REGION": "us-east-1",
            "S3_ENDPOINT": "https://external.invalid",
            "MINIO_ROOT_USER": "test",
            "MINIO_ROOT_PASSWORD": "test",
        }
        with self.assertRaisesRegex(cutover.CutoverError, "private GrowDesk"):
            cutover.validate_attachment_config(values)

    def test_phase_order_keeps_attachment_before_binary_archive_mapping(self) -> None:
        self.assertLess(cutover.PHASES.index("attachment_promotion"), cutover.PHASES.index("ai_history"))
        self.assertLess(cutover.PHASES.index("attachment_promotion"), cutover.PHASES.index("ai_archive"))
        self.assertLess(cutover.PHASES.index("ai_archive"), cutover.PHASES.index("attachment_reference_backfill"))
        self.assertEqual(cutover.PHASES[-1], "target_verification")

    def test_attachment_container_uses_node_entrypoint_once(self) -> None:
        root, manifest, _ = self.snapshot()
        snapshot = cutover.validate_snapshot(root, manifest)
        receipt_dir = root / "receipts"
        executor = RecordingExecutor()
        runner = cutover.CutoverRunner(
            snapshot=snapshot,
            receipt_dir=receipt_dir,
            target_container="test_target",
            migration_image="test_image",
            runtime_env={},
            executor=executor,
        )
        runner._run_attachment_container(["--import", "tsx", "worker.ts"], root / "env")
        command = executor.commands[0]
        self.assertEqual(command[command.index("--entrypoint") + 1], "node")
        self.assertEqual(command[-3:], ["--import", "tsx", "worker.ts"])
        self.assertEqual(command.count("node"), 1)
        self.assertEqual(command.count("--network"), 2)
        self.assertIn("growdesk-db", command)
        self.assertIn("growdesk-storage", command)

    def test_phase_failure_is_recorded_and_raised(self) -> None:
        root, manifest, _ = self.snapshot()
        snapshot = cutover.validate_snapshot(root, manifest)
        receipt_dir = root / "receipts"
        runner = cutover.CutoverRunner(
            snapshot=snapshot,
            receipt_dir=receipt_dir,
            target_container="test_target",
            migration_image="test_image",
            runtime_env={},
        )
        with self.assertRaisesRegex(RuntimeError, "boom"):
            runner.phase("identity", lambda: (_ for _ in ()).throw(RuntimeError("boom")))
        receipt = json.loads((receipt_dir / "phase-01-identity.json").read_text())
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["error"], "RuntimeError")

    def test_receipts_are_private(self) -> None:
        root, manifest, _ = self.snapshot()
        snapshot = cutover.validate_snapshot(root, manifest)
        receipt_dir = root / "receipts"
        runner = cutover.CutoverRunner(
            snapshot=snapshot,
            receipt_dir=receipt_dir,
            target_container="test_target",
            migration_image="test_image",
            runtime_env={},
        )
        runner.phase("identity", lambda: {"count": 0})
        self.assertEqual(stat.S_IMODE(receipt_dir.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((receipt_dir / "phase-01-identity.json").stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
