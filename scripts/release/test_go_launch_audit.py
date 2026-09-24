from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("go_launch_audit", Path(__file__).with_name("go_launch_audit.py"))
assert SPEC and SPEC.loader
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def fixture(count=2):
    contract = {"paths": {f"/api/test/{i}": {"get": {"operationId": f"testOperation{i}"}} for i in range(count)}}
    inventory = {"reference": AUDIT.REFERENCE, "operations": [
        {"method": "GET", "path": f"/api/test/{i}", "operationId": f"testOperation{i}", "implemented": True}
        for i in range(count)]}
    return contract, inventory


class InventoryTests(unittest.TestCase):
    def test_missing_is_reported_not_counted_as_implemented(self):
        contract, inventory = fixture()
        inventory["operations"][1]["implemented"] = False
        report = AUDIT.inventory_summary(contract, inventory)
        self.assertEqual(report["implemented"], 1)
        self.assertEqual(report["missing"][0]["operationId"], "testOperation1")

    def test_all_operations_still_are_only_registrations(self):
        contract, inventory = fixture()
        inventory["acceptance"] = "ACCEPTED"
        report = AUDIT.inventory_summary(contract, inventory)
        self.assertEqual(report, {"declared": 2, "implemented": 2, "missing": []})
        self.assertNotIn("productionApproved", report)

    def test_truthy_non_boolean_flags_are_rejected(self):
        for value in (1, 0, "true", "false", None, [], {}):
            with self.subTest(value=value):
                contract, inventory = fixture()
                inventory["operations"][0]["implemented"] = value
                with self.assertRaises(ValueError):
                    AUDIT.inventory_summary(contract, inventory)

    def test_duplicate_and_missing_and_unknown_routes_are_rejected(self):
        contract, inventory = fixture()
        for rows in (inventory["operations"] * 2, inventory["operations"][:1],
                     [{**inventory["operations"][0], "path": "/unknown"}, inventory["operations"][1]]):
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                AUDIT.inventory_summary(contract, {**inventory, "operations": rows})

    def test_reference_drift_is_rejected(self):
        contract, inventory = fixture()
        inventory["reference"] = "a" * 40
        with self.assertRaises(ValueError):
            AUDIT.inventory_summary(contract, inventory)

    def test_operation_name_and_case_must_match(self):
        contract, inventory = fixture()
        for change in ({"operationId": "wrong"}, {"method": "get"}, {"method": None}):
            edited = copy.deepcopy(inventory)
            edited["operations"][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                AUDIT.inventory_summary(contract, edited)

    def test_duplicate_json_properties_are_rejected(self):
        with self.assertRaises(ValueError):
            AUDIT.decode_json(b'{"implemented":false,"implemented":true}')

    def test_oversized_metadata_is_rejected(self):
        with self.assertRaises(ValueError):
            AUDIT.decode_json(b" " * (AUDIT.MAX_JSON_BYTES + 1))


class SourceAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.server, self.web = self.root / "server", self.root / "web"
        self.server.mkdir()
        self.web.mkdir()
        self.identity = {"commit": "a" * 40, "tree": "b" * 40, "dirty": False}
        self.binary = self.root / "test-api"
        self.binary.write_bytes(b"test binary, never executed")
        self.contract, self.inventory = fixture(151)
        self.write(self.server, "contracts/openapi.json", json.dumps(self.contract))
        self.write(self.server, "internal/backend/config.go", "// production configuration placeholder for unit test")
        self.write(self.server, "Dockerfile", 'ENTRYPOINT ["node", "apps/api/dist/server.js"]')
        self.write(self.web, "lib/growdesk/bridge-policy.ts", 'const GO_PENDING_WEB_ROUTES = new Set(["/api/ai/chat"]);')
        self.write(self.web, "scripts/review/go-api-baseline.json", json.dumps({"commit": "a" * 40}))

    def write(self, root, name, value):
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(value)

    def run_audit(self, revision=None):
        version = {"revision": revision or self.identity["commit"], "reference": AUDIT.REFERENCE}
        with mock.patch.object(AUDIT, "git_identity", return_value=self.identity), mock.patch.object(
            AUDIT, "metadata_command", side_effect=[json.dumps(version).encode(), json.dumps(self.inventory).encode()]):
            return AUDIT.audit(self.server, self.web, self.binary)

    def test_current_preview_blockers_are_not_hidden(self):
        self.write(self.server, "internal/backend/config.go", 'native Go preview refuses production\nValidateDatabaseURL(c.DatabaseURL, true)')
        report = self.run_audit()
        codes = {item["code"] for item in report["blockers"]}
        self.assertTrue({"PRODUCTION_GUARD_ACTIVE", "PREVIEW_DATABASE_ENFORCED", "RUNTIME_ENTRYPOINTS_MISSING",
                         "NO_DEDICATED_GO_DEPLOYMENT", "WEB_GO_ROUTES_BLOCKED"}.issubset(codes))
        self.assertEqual(report["status"], "NO_GO")
        self.assertFalse(report["productionApproved"])

    def test_clean_markers_and_complete_inventory_never_approve_production(self):
        for name in ("worker", "scheduler", "migrate"):
            self.write(self.server, f"cmd/growdesk-{name}/main.go", "package main")
        self.write(self.server, "deploy/Go.Dockerfile", "# deliberately not runtime acceptance")
        self.write(self.web, "lib/growdesk/bridge-policy.ts", "// no known pending literals")
        report = self.run_audit()
        self.assertEqual(report["status"], "SOURCE_AUDIT_PASS_REQUIRES_ACCEPTANCE")
        self.assertFalse(report["productionApproved"])
        self.assertIn("production startup", report["notVerified"])

    def test_binary_revision_mismatch_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_audit("c" * 40)

    def test_dirty_source_and_other_backend_pin_are_blockers(self):
        self.identity["dirty"] = True
        self.write(self.web, "scripts/review/go-api-baseline.json", json.dumps({"commit": "c" * 40}))
        codes = [item["code"] for item in self.run_audit()["blockers"]]
        self.assertEqual(codes.count("DIRTY_SOURCE"), 2)
        self.assertIn("WEB_ACCEPTANCE_PIN_DIFFERS", codes)

    def test_source_symlink_cannot_escape_worktree(self):
        outside = self.root / "outside"
        outside.write_text("not allowed")
        (self.server / "link").symlink_to(outside)
        with self.assertRaises(ValueError):
            AUDIT.source(self.server, "link")

    def test_git_and_binary_metadata_do_not_inherit_runtime_secrets(self):
        completed = mock.Mock(returncode=0, stdout=b"{}")
        with mock.patch.dict(AUDIT.os.environ, {"JWT_SECRET": "test_secret", "DATABASE_URL": "test_private", "HTTPS_PROXY": "test_proxy"}), mock.patch.object(
            AUDIT.subprocess, "run", return_value=completed) as run:
            self.assertEqual(AUDIT.metadata_command(["test-command"], self.server), b"{}")
            env = run.call_args.kwargs["env"]
            self.assertNotIn("JWT_SECRET", env)
            self.assertNotIn("DATABASE_URL", env)
            self.assertNotIn("HTTPS_PROXY", env)
            self.assertFalse(run.call_args.kwargs["check"])


if __name__ == "__main__":
    unittest.main()
