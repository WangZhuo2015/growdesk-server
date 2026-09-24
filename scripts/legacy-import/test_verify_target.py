"""Pure verifier gate tests; no Docker or production data."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


SPEC = importlib.util.spec_from_file_location("verify_target", Path(__file__).with_name("verify_target.py"))
assert SPEC is not None and SPEC.loader is not None
verify_target = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify_target)


class VerifyTargetTests(unittest.TestCase):
    def test_missing_required_phase_fails_closed(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="test_verify_receipts_"))
        root.chmod(0o700)
        archive_hash = "a" * 64
        receipt = {
            "phase": "identity",
            "status": "completed",
            "archiveSha256": archive_hash,
        }
        path = root / "phase-01-identity.json"
        path.write_text(json.dumps(receipt), encoding="utf-8")
        path.chmod(0o600)
        summary = verify_target._receipt_summary(root, archive_hash)
        self.assertIn("migrations", summary["phaseFailures"])
        self.assertNotIn("identity", summary["phaseFailures"])

    def test_static_reference_hashes_are_exact_legacy_rows(self) -> None:
        empty_hash = hashlib.sha256(b"[]").hexdigest()
        self.assertEqual(verify_target.STATIC_REFERENCE_GOLDEN["MilestoneSourceRef"], (0, empty_hash))
        self.assertEqual(verify_target.STATIC_REFERENCE_GOLDEN["DevelopmentMilestone"][0], 119)


if __name__ == "__main__":
    unittest.main()
