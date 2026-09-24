import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("release_gate", Path(__file__).with_name("release_gate.py"))
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

ARCHIVE = "a" * 64
PAIR = {"webCommit": "b" * 40, "serverCommit": "c" * 40}


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="test_release_gate_")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.manifest = {"schemaVersion": 1, "archiveSha256": ARCHIVE, **PAIR, "checks": {}}
        for name in module.REQUIRED_CHECKS:
            value = {"passed": True, "sourceDirty": False, "archiveSha256": ARCHIVE, **PAIR,
                     "goldenPassed": True, "browserPassed": True, "unresolved": 0, "quarantined": 0,
                     "writersStopped": True, "finalSnapshot": True, "pendingChanges": 0,
                     "restored": True, "freshTarget": True}
            self.write_receipt(name, value)
        self.save_manifest()

    def write_receipt(self, name, value):
        raw = json.dumps(value).encode()
        path = self.root / (name + ".json")
        path.write_bytes(raw)
        path.chmod(0o600)
        self.manifest["checks"][name] = {"path": path.name, "sha256": hashlib.sha256(raw).hexdigest()}

    def save_manifest(self):
        self.path = self.root / "release.json"
        self.path.write_text(json.dumps(self.manifest))
        self.path.chmod(0o600)

    def result(self):
        return module.release_readiness(self.path, ARCHIVE, True)

    def test_exact_complete_pair(self):
        self.assertTrue(self.result()["ready"])

    def test_import_success_is_not_release_success(self):
        self.assertFalse(module.release_readiness(None, ARCHIVE, True)["ready"])
        self.assertFalse(module.release_readiness(self.path, ARCHIVE, False)["ready"])

    def test_every_required_receipt_is_mandatory(self):
        for name in module.REQUIRED_CHECKS:
            with self.subTest(name=name):
                saved = self.manifest["checks"].pop(name)
                self.save_manifest()
                self.assertFalse(self.result()["ready"])
                self.manifest["checks"][name] = saved
        self.save_manifest()

    def test_dirty_wrong_pair_false_and_wrong_source_fail(self):
        original = json.loads((self.root / "pairedAcceptance.json").read_text())
        for field, value in (("sourceDirty", True), ("webCommit", "d" * 40), ("serverCommit", "e" * 40),
                             ("passed", False), ("archiveSha256", "f" * 64), ("goldenPassed", False), ("browserPassed", False)):
            with self.subTest(field=field):
                self.write_receipt("pairedAcceptance", {**original, field: value})
                self.save_manifest()
                self.assertFalse(self.result()["ready"])
        self.write_receipt("pairedAcceptance", original)

    def test_generic_pass_does_not_prove_writer_fence_or_restore(self):
        for name, field, value in (("finalWriterFence", "writersStopped", False),
                                   ("finalWriterFence", "finalSnapshot", False),
                                   ("rollbackRehearsal", "restored", False),
                                   ("rollbackRehearsal", "freshTarget", False),
                                   ("incrementalReconciliation", "pendingChanges", 1),
                                   ("attachments", "quarantined", 1), ("attachments", "unresolved", 1)):
            with self.subTest(name=name, field=field):
                original = json.loads((self.root / (name + ".json")).read_text())
                self.write_receipt(name, {**original, field: value})
                self.save_manifest()
                self.assertFalse(self.result()["ready"])
                self.write_receipt(name, original)

    def test_receipt_hash_must_match(self):
        (self.root / "attachments.json").write_text("{}")
        self.assertFalse(self.result()["ready"])

    def test_unsafe_paths_and_symlinks_fail(self):
        for path in ("../outside.json", "/tmp/outside.json"):
            self.manifest["checks"]["attachments"]["path"] = path
            self.save_manifest()
            self.assertFalse(self.result()["ready"])
        link = self.root / "link.json"
        link.symlink_to(self.root / "attachments.json")
        self.manifest["checks"]["attachments"]["path"] = link.name
        self.save_manifest()
        self.assertFalse(self.result()["ready"])

    def test_public_or_oversized_evidence_fails(self):
        self.path.chmod(0o644)
        self.assertFalse(self.result()["ready"])
        self.path.chmod(0o600)
        self.path.write_text(" " * (module.MAX_RECEIPT_BYTES + 1))
        self.assertFalse(self.result()["ready"])


if __name__ == "__main__":
    unittest.main()
