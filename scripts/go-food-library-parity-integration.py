#!/usr/bin/env python3
"""Real HTTP food-library parity checks on a private PostgreSQL 18/Redis 8 stack.

Only generated test_ principals are used. The suite reads the legacy 45-item
Web JSON as a golden source, mutates only the private stack through HTTP, and
starts a one-shot worker only after proving its sole active task is this
family's snapshot. No production URL, caller-supplied database, external
provider key, push service, or storage object is used.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("food_snapshot_support", ROOT / "scripts/go-sync-snapshot-integration.py")
assert SPEC and SPEC.loader
SNAPSHOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SNAPSHOT)
TOOLS = SNAPSHOT.TOOLS

WEB_FOOD = Path("/Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia/data/04_foods.json")
WEB_FOOD_SHA256 = "89d96cdb829f552982ddb1da76d51b85eb8d2d02a70194386e3b200cff8453d2"


class Scenario:
    def __init__(self, owned, base: str, worker: Path, reference: dict):
        self.owned = owned
        self.base = base
        self.worker = worker.resolve()
        self.reference = reference
        self.calls = 0
        self.observations: list[dict[str, object]] = []
        self.cleanup_notes: dict[str, object] = {}

    def call(self, method, path, status, body=None, token=None, headers=None, label=None):
        self.calls += 1
        actual, value = TOOLS.http(self.base, method, path, body, token, headers)
        if actual != status:
            code = value.get("error", {}).get("code", "unexpected_success") if isinstance(value, dict) else type(value).__name__
            raise AssertionError(f"{method} {path}: expected {status}, got {actual}; {code}")
        if label:
            record = {"case": label, "status": actual}
            if actual >= 400:
                record["errorCode"] = value.get("error", {}).get("code")
            self.observations.append(record)
        return value

    def error(self, method, path, status, code, body=None, token=None, headers=None, label=None):
        result = self.call(method, path, status, body, token, headers, label)
        actual = result.get("error", {}).get("code")
        if actual != code:
            raise AssertionError(f"{method} {path}: expected error {code}, got {actual}")
        return result

    def register(self, label: str):
        username = f"test_food_{label}_{self.owned.owner}"
        password = "test_food_password_" + secrets.token_hex(12)
        data = self.call("POST", "/api/v1/auth/register", 201, {
            "username": username,
            "password": password,
            "displayName": f"Test Food {label}",
            "deviceLabel": "test_food_parity",
        })["data"]
        if data["user"]["username"] != username:
            raise AssertionError("registration did not preserve the test_ username")
        self.observations.append({"case": f"register {label}", "status": 201, "usernamePrefix": "test_"})
        return data

    def state(self, family_id: str) -> dict[str, object]:
        if not re.fullmatch(r"[0-9a-f-]{36}", family_id):
            raise AssertionError("diagnostic family ID is not a UUID")
        raw = self.owned.sql(f"""SELECT jsonb_build_object(
          'cursor',(SELECT cursor::text FROM family_sync_states WHERE family_id='{family_id}'),
          'itemCount',(SELECT COUNT(*) FROM food_library_items WHERE family_id='{family_id}' AND is_custom=true),
          'statusCount',(SELECT COUNT(*) FROM family_food_statuses WHERE family_id='{family_id}'),
          'foodChanges',(SELECT COUNT(*) FROM family_changes WHERE family_id='{family_id}' AND entity_type IN ('food_item','food_status')),
          'foodReceipts',(SELECT COUNT(*) FROM idempotency_receipts WHERE scope_id='{family_id}' AND command_id LIKE 'food_item:create:%')
        );""")
        return json.loads(raw)

    def install_feed_rejector(self, family_id: str, entity_type: str):
        if not re.fullmatch(r"[0-9a-f-]{36}", family_id) or entity_type not in {"food_item", "food_status"}:
            raise AssertionError("unsafe test-only feed rejector scope")
        self.owned.sql(f"""CREATE FUNCTION test_food_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            IF NEW.family_id='{family_id}' AND NEW.entity_type='{entity_type}' THEN
              RAISE EXCEPTION 'test food feed append failure';
            END IF;
            RETURN NEW;
          END; $$;
          CREATE TRIGGER test_food_reject_change BEFORE INSERT ON family_changes
          FOR EACH ROW EXECUTE FUNCTION test_food_reject_change();""")

    def remove_feed_rejector(self):
        self.owned.sql("DROP TRIGGER test_food_reject_change ON family_changes; DROP FUNCTION test_food_reject_change();")

    def family_changes(self, family_id: str, token: str, cursor: str | None = None):
        path = f"/api/v1/sync/families/{family_id}/changes"
        if cursor:
            path += "?cursor=" + quote(cursor, safe="")
        return self.call("GET", path, 200, token=token)

    def assert_reference_catalog(self, items):
        source_items = self.reference["foodItems"]
        meta = self.reference["datasetMeta"]
        if len(source_items) != 45 or len(items) != 45:
            raise AssertionError(f"expected 45 source/catalog foods, got {len(source_items)}/{len(items)}")
        by_id = {item["id"]: item for item in items}
        if set(by_id) != {item["id"] for item in source_items}:
            raise AssertionError("food catalog IDs differ from the original Web reference set")
        for source in source_items:
            actual = by_id[source["id"]]
            intro = source["introduction"]
            allergen = source["allergen"]
            expected = {
                "name": source["name"], "icon": source["icon"], "category": source["category"],
                "foodGroup": source.get("foodGroup"),
                "recommendedFromMonth": intro.get("recommendedFromMonth"),
                "recommendedToMonth": intro.get("recommendedToMonth"),
                "exactMonthEvidence": intro["exactMonthEvidence"], "guidance": intro.get("guidance"),
                "isCommonAllergen": allergen.get("isCommonAllergen"),
                "allergenIntroductionGuidance": allergen.get("introductionGuidance"),
                "highRiskInfantNeedsMedicalAdvice": allergen.get("highRiskInfantNeedsMedicalAdvice"),
                "chokingRisk": source["chokingRisk"], "chokingNotes": source.get("chokingNotes"),
                "avoidBeforeMonths": source.get("avoidBeforeMonths"), "preparation": source["preparation"],
                "nutrition": source["nutrition"], "textureByAge": source["textureByAge"],
                "notes": source.get("notes"), "sourceRefs": source["sourceRefs"],
                "dataSource": {"asOf": meta["asOf"], "scope": meta["scope"], "evidenceConflict": meta["evidenceConflict"]},
            }
            for field, value in expected.items():
                if actual.get(field) != value:
                    raise AssertionError(f"Web food reference mismatch at {source['id']}.{field}")
            if actual.get("status") != "to_try" or actual.get("firstAddedDate") is not None or actual.get("acceptance") != 0:
                raise AssertionError(f"new-family status leaked into reference item {source['id']}")
            if "familyStatus" in actual:
                raise AssertionError(f"empty family unexpectedly has private state for {source['id']}")
        self.observations.append({"case": "45 reference food rows match legacy Web source fields", "status": 200, "itemCount": 45, "sourceAsOf": meta["asOf"], "sourceSha256": WEB_FOOD_SHA256})

    def run(self):
        owner = self.register("owner")
        owner_token = owner["accessToken"]
        owner_user_id = owner["user"]["id"]
        family = self.call("GET", "/api/v1/families", 200, token=owner_token)["data"][0]
        family_id = family["id"]
        family_name = f"test_food_family_{self.owned.owner}"
        self.call("PATCH", f"/api/v1/families/{family_id}", 200, {"name": family_name}, owner_token, label="rename to test family")
        babies = []
        for suffix in ("a", "b"):
            baby = self.call("POST", f"/api/v1/families/{family_id}/babies", 201, {
                "name": f"test_food_baby_{suffix}_{self.owned.owner}",
                "birthDate": "2026-01-02", "gender": "girl", "gestationalWeeks": 39, "gestationalDays": 0,
            }, owner_token)["data"]
            babies.append(baby["id"])
        if len(set(babies)) != 2:
            raise AssertionError("test family did not receive two independent test babies")
        self.observations.append({"case": "owner test family has two test babies", "status": 201, "babyCount": 2})

        viewer = self.register("viewer")
        viewer_token = viewer["accessToken"]
        viewer_family = self.call("GET", "/api/v1/families", 200, token=viewer_token)["data"][0]
        self.call("PATCH", f"/api/v1/families/{viewer_family['id']}", 200,
                  {"name": f"test_food_viewer_family_{self.owned.owner}"}, viewer_token)
        invite = self.call("POST", f"/api/v1/families/{family_id}/invites", 201, {"expiresInDays": 1}, owner_token)["data"]
        self.call("POST", "/api/v1/families/join", 200, {"inviteCode": invite["inviteCode"]}, viewer_token, label="second test account joins as viewer candidate")
        viewer_user_id = viewer["user"]["id"]
        if not re.fullmatch(r"[0-9a-f-]{36}", viewer_user_id):
            raise AssertionError("viewer fixture user ID is not a UUID")
        # The public family-management API intentionally only promotes between
        # admin/member. Set the already-joined test membership to viewer in this
        # private database fixture so all authorization assertions still cross
        # the real food HTTP handlers.
        self.owned.sql(f"UPDATE family_members SET role='viewer' WHERE family_id='{family_id}' AND user_id='{viewer_user_id}' AND status='active' AND deleted_at IS NULL;")
        if self.owned.sql(f"SELECT role FROM family_members WHERE family_id='{family_id}' AND user_id='{viewer_user_id}';") != "viewer":
            raise AssertionError("owned viewer-role fixture was not applied")
        self.observations.append({"case": "viewer membership fixture in private test database", "status": 200, "writePath": "SQL setup only; all food operations remain HTTP"})
        outsider = self.register("outsider")
        outsider_token = outsider["accessToken"]
        outsider_family = self.call("GET", "/api/v1/families", 200, token=outsider_token)["data"][0]
        self.call("PATCH", f"/api/v1/families/{outsider_family['id']}", 200,
                  {"name": f"test_food_outsider_family_{self.owned.owner}"}, outsider_token)

        list_path = f"/api/v1/food/items?familyId={family_id}"
        self.error("GET", "/api/v1/food/items", 401, "UNAUTHORIZED", label="catalog requires authentication")
        listing = self.call("GET", list_path, 200, token=owner_token, label="owner loads food library")
        self.assert_reference_catalog(listing["data"])
        viewer_listing = self.call("GET", list_path, 200, token=viewer_token, label="viewer can read family food statuses")
        if viewer_listing != listing:
            raise AssertionError("viewer read differs from owner for an unchanged family food catalog")

        # A custom create carries both a visible textual Web profile and the
        # independent numeric profile used by the Go nutrient calculator.
        custom_body = {
            "familyId": family_id,
            "name": f"test_custom_food_{self.owned.owner}",
            "icon": "🍐",
            "category": "fruit",
            "allergenRisk": "low",
            "recommendedAgeMonths": 6,
            "status": "tried",
            "tried": True,
            "firstAddedDate": "2026-10-03",
            "acceptance": 4,
            "nutritionBasis": "per_100g",
            "nutrientsJson": {"protein": {"amount": "2.5", "unit": "g"}},
        }
        key = "test_food_create_" + secrets.token_hex(12)
        before_create = self.state(family_id)
        feed_before = self.family_changes(family_id, owner_token)
        create = self.call("POST", "/api/v1/food/items", 201, custom_body, owner_token,
                           {"Idempotency-Key": key}, label="idempotent custom food create")
        item = create
        if item["icon"] != "🍐" or item["firstAddedDate"] != "2026-10-03" or item["familyStatus"]["version"] != 1:
            raise AssertionError("custom icon/first-added/status data did not round-trip")
        if item["nutrition"] != [] or item["nutrientsJson"] != custom_body["nutrientsJson"] or item["nutritionBasis"] != "per_100g":
            raise AssertionError("numeric nutrient profile was merged with or lost beside descriptive nutrition")
        item_id = item["id"]
        after_create = self.state(family_id)
        if int(after_create["cursor"]) != int(before_create["cursor"]) + 2:
            raise AssertionError("custom item plus its initial status did not advance the family cursor twice")
        if after_create["itemCount"] != before_create["itemCount"] + 1 or after_create["statusCount"] != before_create["statusCount"] + 1:
            raise AssertionError("custom food creation did not atomically persist both projections")
        if after_create["foodChanges"] != before_create["foodChanges"] + 2 or after_create["foodReceipts"] != before_create["foodReceipts"] + 1:
            raise AssertionError("custom food creation did not append exactly two feed rows and one receipt")
        replay = self.call("POST", "/api/v1/food/items", 201, custom_body, owner_token,
                           {"Idempotency-Key": key}, label="same-key lost-response replay")
        if replay != item or self.state(family_id) != after_create:
            raise AssertionError("same-key create replay changed the saved row, cursor, feed, or receipt")
        self.error("POST", "/api/v1/food/items", 409, "IDEMPOTENCY_KEY_REUSED",
                   {**custom_body, "name": custom_body["name"] + " changed"}, owner_token,
                   {"Idempotency-Key": key}, label="same key with changed body rejected")
        if self.state(family_id) != after_create:
            raise AssertionError("changed-body replay modified family food state")
        feed_after_create = self.family_changes(family_id, owner_token)
        if feed_after_create["highWater"] != feed_before["highWater"]:
            if int(feed_after_create["highWater"]) != int(feed_before["highWater"]) + 2:
                raise AssertionError("food item/status feed cursors are not contiguous")
        replay_delta = self.family_changes(family_id, owner_token, feed_after_create["nextCursor"])
        if replay_delta["changes"] or replay_delta["highWater"] != feed_after_create["highWater"]:
            raise AssertionError("idempotent replay appended a family change")
        create_changes = [row for row in feed_after_create["changes"] if row["entityType"] in ("food_item", "food_status")]
        item_change = next((row for row in create_changes if row["entityType"] == "food_item" and row["entityId"] == item_id), None)
        if item_change is None:
            raise AssertionError("create feed omitted the custom food item projection")
        status_change = next((row for row in create_changes if row["entityType"] == "food_status" and row["payload"].get("foodItemId") == item_id), None)
        if status_change is None:
            raise AssertionError("create feed omitted the initial family status projection")
        if item_change["payload"].get("nutritionBasis") != "per_100g" or item_change["payload"].get("nutrientsJson") != custom_body["nutrientsJson"]:
            raise AssertionError("food_item feed lost the numeric profile or its separate basis")
        if item_change["payload"].get("version") != "1" or not item_change["payload"].get("createdAt") or not item_change["payload"].get("updatedAt"):
            raise AssertionError("food_item feed version/timestamps differ from the snapshot projection shape")
        if status_change["payload"].get("status") != "tried" or status_change["payload"].get("version") != "1" or not status_change["payload"].get("updatedAt"):
            raise AssertionError("food_status feed omitted its versioned family projection")

        before_failed_create = self.state(family_id)
        self.install_feed_rejector(family_id, "food_item")
        try:
            self.call("POST", "/api/v1/food/items", 500, {
                **custom_body, "name": f"test_rollback_create_{self.owned.owner}",
            }, owner_token, {"Idempotency-Key": "test_food_atomic_create_rollback"}, label="failed feed append returns error")
            if self.state(family_id) != before_failed_create:
                raise AssertionError("failed create feed append leaked item/status/cursor/change/receipt state")
        finally:
            self.remove_feed_rejector()
        self.observations.append({"case": "create/feed failure rolls back all projections and receipt", "status": 500})

        # Numeric-profile PATCH stays independent and participates in CAS/feed.
        before_failed_patch = self.state(family_id)
        self.install_feed_rejector(family_id, "food_item")
        try:
            self.call("PATCH", f"/api/v1/families/{family_id}/food/items/{item_id}", 500,
                      {"baseVersion": 1, "nutrientsJson": None}, owner_token,
                      label="failed update feed append returns error")
            if self.state(family_id) != before_failed_patch:
                raise AssertionError("failed profile feed append leaked profile/version/cursor/change state")
        finally:
            self.remove_feed_rejector()
        self.observations.append({"case": "profile/feed failure rolls back the row and family cursor", "status": 500})
        cleared = self.call("PATCH", f"/api/v1/families/{family_id}/food/items/{item_id}", 200,
                            {"baseVersion": 1, "nutrientsJson": None}, owner_token,
                            label="clear numeric profile without erasing Web metadata")
        if cleared["version"] != 2 or cleared["nutrientsJson"] is not None or cleared["nutrition"] != [] or cleared["icon"] != "🍐":
            raise AssertionError("numeric profile clear changed unrelated descriptive/custom-food fields")
        self.error("PATCH", f"/api/v1/families/{family_id}/food/items/{item_id}", 409, "CONCURRENCY_CONFLICT",
                   {"baseVersion": 1, "nutrientsJson": custom_body["nutrientsJson"]}, owner_token,
                   label="stale numeric profile update rejected")

        # Family-shared status is optimistic-locked. Two separate child rows in
        # this family prove the status is not partitioned by baby navigation.
        eggs_path = f"/api/v1/families/{family_id}/food-status/food_egg"
        before_failed_status = self.state(family_id)
        self.install_feed_rejector(family_id, "food_status")
        try:
            self.call("PUT", eggs_path, 500, {
                "status": "tried", "firstAddedDate": "2026-10-03", "acceptance": 2, "baseVersion": 0,
            }, owner_token, label="failed status feed append returns error")
            if self.state(family_id) != before_failed_status:
                raise AssertionError("failed status feed append leaked status/cursor/change state")
        finally:
            self.remove_feed_rejector()
        self.observations.append({"case": "status/feed failure rolls back the row and family cursor", "status": 500})
        attempts = [
            {"status": "tried", "firstAddedDate": "2026-10-02", "acceptance": 2, "reaction": "test_tolerated", "baseVersion": 0},
            {"status": "to_try", "firstAddedDate": None, "acceptance": 0, "reaction": "test_observed", "baseVersion": 0},
        ]
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda body: TOOLS.http(self.base, "PUT", eggs_path, body, owner_token), attempts))
        self.calls += len(responses)
        codes = sorted(code for code, _ in responses)
        if codes != [200, 409]:
            raise AssertionError(f"family status CAS expected one winner and one conflict, got {codes}")
        winner_code, winner = next(result for result in responses if result[0] == 200)
        if winner_code != 200 or winner.get("data", {}).get("version") != 1:
            raise AssertionError("winning initial status write did not return version one")
        self.observations.append({"case": "parallel baseVersion 0 has one status winner", "status": 200, "conflicts": 1})
        second_status = self.call("PUT", eggs_path, 200, {
            "status": "tried", "firstAddedDate": "2026-10-03", "acceptance": 4,
            "reaction": "test_observed", "baseVersion": 1,
        }, owner_token, label="update existing family status")
        cleared_status = self.call("PUT", eggs_path, 200, {
            "status": "to_try", "firstAddedDate": None, "acceptance": 0,
            "reaction": None, "baseVersion": 2,
        }, owner_token, label="clear tried date and reaction")
        if second_status["data"]["version"] != 2 or cleared_status["data"]["version"] != 3:
            raise AssertionError("family status version did not advance by compare-and-swap")
        self.error("PUT", eggs_path, 409, "CONCURRENCY_CONFLICT", {
            "status": "tried", "firstAddedDate": "2026-10-03", "acceptance": 1, "baseVersion": 2,
        }, owner_token, label="stale status version rejected")
        final_list = self.call("GET", list_path, 200, token=owner_token)
        egg = next(value for value in final_list["data"] if value["id"] == "food_egg")
        if egg["status"] != "to_try" or egg["firstAddedDate"] is not None or egg["acceptance"] != 0:
            raise AssertionError("status clears were not reflected in the family food-list read")
        if egg["familyStatus"]["version"] != 3 or egg["familyStatus"]["reaction"] is not None:
            raise AssertionError("family status read did not preserve its final version or explicit reaction clear")
        viewer_list = self.call("GET", list_path, 200, token=viewer_token)
        viewer_egg = next(value for value in viewer_list["data"] if value["id"] == "food_egg")
        if viewer_egg["familyStatus"] != egg["familyStatus"]:
            raise AssertionError("same-family viewer did not read the shared status")

        self.error("GET", f"/api/v1/food/items?familyId={family_id}", 403, "FAMILY_ACCESS_DENIED", token=outsider_token,
                   label="outsider cannot read another family")
        self.error("POST", "/api/v1/food/items", 403, "FAMILY_ACCESS_DENIED", {
            "familyId": family_id, "name": "test_foreign_food", "icon": "🥝", "category": "fruit",
            "allergenRisk": "low", "recommendedAgeMonths": 6,
        }, outsider_token, label="outsider cannot create in another family")
        self.error("PUT", eggs_path, 403, "FAMILY_ACCESS_DENIED", {
            "status": "tried", "firstAddedDate": None, "acceptance": 0, "baseVersion": 3,
        }, outsider_token, label="outsider cannot update another family's status")
        self.error("POST", "/api/v1/food/items", 403, "FAMILY_ACCESS_DENIED", {
            "familyId": family_id, "name": "test_viewer_food", "icon": "🥝", "category": "fruit",
            "allergenRisk": "low", "recommendedAgeMonths": 6,
        }, viewer_token, label="family viewer cannot create custom food")
        self.error("PUT", eggs_path, 403, "FAMILY_ACCESS_DENIED", {
            "status": "tried", "firstAddedDate": None, "acceptance": 0, "baseVersion": 3,
        }, viewer_token, label="family viewer cannot change shared status")

        refreshed = self.call("GET", list_path, 200, token=owner_token, label="relaunch-style catalog read")
        persisted = next(value for value in refreshed["data"] if value["id"] == item_id)
        if persisted["version"] != 2 or persisted["nutrientsJson"] is not None or persisted["icon"] != "🍐":
            raise AssertionError("custom food/profile state did not persist after independent HTTP reads")

        # The test database must contain only the exact worker task created here.
        queued = self.call("POST", f"/api/v1/sync/families/{family_id}/snapshots", 202, token=owner_token)["data"]
        snapshot_id = queued["snapshotId"]
        active = self.owned.sql("SELECT COALESCE(string_agg(type||':'||aggregate_id, E'\\n' ORDER BY created_at),'') FROM task_outbox WHERE dispatch_state='active';")
        if active != f"sync_snapshot_family:{snapshot_id}":
            raise AssertionError("refusing one-shot worker: private stack has an unexpected active task")
        process = subprocess.run([str(self.worker), "--once"], cwd=ROOT, env=self.owned.env,
                                 capture_output=True, text=True, timeout=220, check=False)
        if process.returncode != 0:
            raise AssertionError(f"owned one-shot snapshot worker failed with status {process.returncode}")
        self.observations.append({"case": "bounded worker processed only this family's snapshot", "status": 200, "activeTaskBeforeWorker": "sync_snapshot_family"})
        manifest = None
        for _ in range(80):
            metadata = self.call("GET", f"/api/v1/sync/families/{family_id}/snapshots/{snapshot_id}", 200, token=owner_token)["data"]
            if metadata["status"] == "ready":
                manifest = metadata
                break
            if metadata["status"] == "failed":
                raise AssertionError("family snapshot worker stored failed status")
            time.sleep(0.1)
        if manifest is None:
            raise AssertionError("one-shot worker did not make the family snapshot ready")
        pages = []
        for page_index in range(manifest["pageCount"]):
            result = self.call("GET", f"/api/v1/sync/families/{family_id}/snapshots/{snapshot_id}/pages/{page_index}", 200, token=owner_token)["data"]
            encoded = result["contentJSON"].encode("utf-8")
            if hashlib.sha256(encoded).hexdigest() != result["sha256"] or json.loads(result["contentJSON"]) != result["content"]:
                raise AssertionError("snapshot page SHA/contentJSON does not match the actual content")
            pages.append(result["content"])
        item_rows = [row for page in pages if page["entityType"] == "food_item" for row in page["data"]]
        status_rows = [row for page in pages if page["entityType"] == "food_status" for row in page["data"]]
        snap_item = next((row for row in item_rows if row["id"] == item_id), None)
        snap_egg = next((row for row in status_rows if row["foodItemId"] == "food_egg"), None)
        if snap_item is None or snap_egg is None:
            raise AssertionError("native snapshot pages omitted custom food or family-shared food status")
        if snap_item.get("icon") != "🍐" or snap_item.get("nutrition") != [] or snap_item.get("nutrientsJson") is not None:
            raise AssertionError("snapshot custom-food DTO lost typed or numeric nutrition fields")
        if snap_egg.get("tried") is not False or snap_egg.get("firstAddedDate") is not None or snap_egg.get("acceptance") != 0:
            raise AssertionError("snapshot family status DTO lost current clear-state values")
        self.observations.append({"case": "real snapshot food_item and food_status DTOs with content digest", "status": 200, "snapshotPageCount": manifest["pageCount"], "highWater": manifest["highWater"]})

        state = self.state(family_id)
        self.observations.append({"case": "durable test-family food state", "status": 200, "state": state})
        return {
            "assertions": self.calls,
            "testUsernames": [owner["user"]["username"], viewer["user"]["username"], outsider["user"]["username"]],
            "familyName": family_name,
            "babyCount": len(babies),
            "catalogItems": 45,
            "foodItemIdPrefix": item_id.split("_")[0] + "_",
            "observations": self.observations,
        }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api-binary", type=Path, required=True)
    parser.add_argument("--worker-binary", type=Path, required=True)
    parser.add_argument("--web-food-json", type=Path, default=WEB_FOOD)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    if not __debug__:
        raise RuntimeError("assertions must remain enabled")
    for binary in (args.api_binary, args.worker_binary):
        if not binary.is_file():
            raise RuntimeError("build the Go API and worker before running this isolated HTTP suite")
    raw = args.web_food_json.read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    if digest != WEB_FOOD_SHA256:
        raise RuntimeError("legacy Web food source changed; re-audit before using it as a parity golden")
    reference = json.loads(raw)
    if not isinstance(reference, dict) or len(reference.get("foodItems", [])) != 45:
        raise RuntimeError("legacy Web food source has an unexpected structure")

    report = {
        "suite": "Go food-library family/shared-state HTTP parity",
        "status": "RUNNING",
        "serverHead": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "sourceSha256": {"legacyFoodJson": digest},
        "runtime": {"apiHost": "127.0.0.1", "database": "owned test_ PostgreSQL 18", "redis": "owned test_ Redis 8", "externalProviders": "not configured", "push": "not configured", "objectStorage": "not used by this scope"},
        "cleanup": {},
    }
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    owned = SNAPSHOT.LocalOwnedEnvironment()
    try:
        owned.start()
        api = owned.serve(args.api_binary)
        report["runtime"]["apiUrl"] = api
        report["result"] = Scenario(owned, api, args.worker_binary, reference).run()
        report["status"] = "PASS"
    except BaseException as error:
        report["status"] = "FAIL"
        report["failureType"] = type(error).__name__
        report["failure"] = str(error)[:500]
        raise
    finally:
        report["cleanup"] = owned.close()
        report["cleanupVerified"] = all(report["cleanup"].get(name) for name in (
            "apiProcessesStopped", "redisProcessStopped", "postgresStopped", "temporaryDirectoryRemoved"
        ))
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps({"status": report["status"], "report": str(args.report), "cleanupVerified": report["cleanupVerified"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda signum, _frame: (_ for _ in ()).throw(KeyboardInterrupt(f"signal {signum}")))
    main()
