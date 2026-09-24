import contextlib
import hashlib
import importlib.util
import io
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
verifier = load("verify_target")


class CanonicalVerifierTests(unittest.TestCase):
    def setUp(self):
        self.data = fixture.archive("test_canonical_reconciliation")
        self.checksum = hashlib.sha256(json.dumps(self.data, sort_keys=True).encode()).hexdigest()

    def test_predicates_read_runtime_fields_not_only_receipts(self):
        checks = canonical.build_checks(self.data, self.checksum)
        sql = " ".join(predicate for _, predicate in checks)
        for field in ("amount_ml", "occurred_at", "family_id", "baby_id", "notes", "weight_kg", "head_circumference_cm", "formula_product_id", "night_waking_count", "nutrients_json"):
            with self.subTest(field=field):
                self.assertIn(field, sql)
        self.assertNotIn("legacy_idempotency_mappings", sql)
        self.assertTrue(all(predicate.startswith("EXISTS (SELECT 1 FROM public.") for _, predicate in checks))

    def test_mismatch_is_failure_even_when_all_checks_are_present(self):
        checks = canonical.build_checks(self.data, self.checksum)
        queries = []
        def query(sql):
            queries.append(sql)
            return {"checked": len(checks), "mismatched": 1, "tables": ["FeedingRecord"]}
        result = canonical.verify_canonical(self.data, self.checksum, query)
        self.assertFalse(result["passed"])
        self.assertEqual(len(queries), 1)
        self.assertTrue(queries[0].startswith("SELECT json_build_object"))
        self.assertNotIn("INSERT INTO", queries[0])
        self.assertNotIn("UPDATE public.", queries[0])

    def test_complete_aggregate_passes(self):
        count = len(canonical.build_checks(self.data, self.checksum))
        result = canonical.verify_canonical(self.data, self.checksum, lambda _: {"checked": count, "mismatched": 0, "tables": []})
        self.assertTrue(result["passed"])

    def test_invalid_or_partial_aggregate_is_not_success(self):
        for result in ({}, {"checked": 0, "mismatched": 0, "tables": []}, {"checked": True, "mismatched": 0, "tables": []}):
            with self.subTest(result=result), self.assertRaises(RuntimeError):
                canonical.verify_canonical(self.data, self.checksum, lambda _: result)

    def test_missing_attachment_mapping_fails_before_query(self):
        self.data["tables"]["GrowthMeasurement"][0]["imageUrl"] = "/uploads/test_missing.png"
        with self.assertRaises(ValueError):
            canonical.verify_canonical(self.data, self.checksum, lambda _: self.fail("no query after missing attachment"))


class VerifierCliTests(unittest.TestCase):
    def invoke(self, result, *arguments):
        with contextlib.redirect_stdout(io.StringIO()):
            return verifier.main(["--archive", "test_archive.json", *arguments], verifier=lambda *a, **kw: result)

    def test_nonready_default_exits_one(self):
        self.assertEqual(self.invoke({"importIntegrityReady": True, "releaseCutoverReady": False}), 1)

    def test_explicit_import_gate_does_not_assert_release(self):
        self.assertEqual(self.invoke({"importIntegrityReady": True, "releaseCutoverReady": False}, "--require", "import"), 0)
        self.assertEqual(self.invoke({"importIntegrityReady": False, "releaseCutoverReady": False}, "--require", "import"), 1)

    def test_verified_release_exits_zero(self):
        self.assertEqual(self.invoke({"importIntegrityReady": True, "releaseCutoverReady": True}), 0)

    def test_missing_boolean_is_not_a_pass(self):
        self.assertEqual(self.invoke({}), 1)
        self.assertEqual(self.invoke({"releaseCutoverReady": "true"}), 1)


if __name__ == "__main__":
    unittest.main()
