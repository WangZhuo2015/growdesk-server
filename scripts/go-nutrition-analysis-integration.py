#!/usr/bin/env python3
"""Nutrition analysis/trends real HTTP checks on an owned local test stack."""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import hashlib
import importlib.util
import json
import re
import secrets
import subprocess
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence/tasks/IOS_WEB_PARITY_20261002/nutrition-profile-fields"
RESERVED_PORTS = {3088, 3089, 49762, 57006, 58572, 60756}

_spec = importlib.util.spec_from_file_location(
    "nutrition_analysis_owned_stack", ROOT / "scripts/go-vaccine-edit-integration.py"
)
assert _spec and _spec.loader
_stack_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_stack_module)
_stack_module.RESERVED_PORTS.update(RESERVED_PORTS)
OwnedStack = _stack_module.OwnedStack


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def request(base: str, method: str, path: str, *, body=None, token=None, key=None):
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    if key:
        headers["Idempotency-Key"] = key
    encoded = None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    req = urllib.request.Request(base + path, data=encoded, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        try:
            return error.code, json.loads(error.read())
        finally:
            error.close()


def call(observations, base, method, path, expected, *, body=None, token=None, key=None, name):
    status, payload = request(base, method, path, body=body, token=token, key=key)
    error = payload.get("error", {}) if isinstance(payload, dict) else {}
    observations.append({
        "case": name,
        "method": method,
        "path": re.sub(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", "{test-id}", path.split("?", 1)[0]),
        "status": status,
        "errorCode": error.get("code"),
    })
    if status != expected:
        raise AssertionError(f"{name}: expected HTTP {expected}, got {status} ({error.get('code', 'no-code')})")
    return payload


def expect_non_success(observations, base, method, path, *, token, name):
    status, payload = request(base, method, path, token=token)
    error = payload.get("error", {}) if isinstance(payload, dict) else {}
    observations.append({"case": name, "method": method,
                         "path": re.sub(r"[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}", "{test-id}", path.split("?", 1)[0]),
                         "status": status, "errorCode": error.get("code")})
    if 200 <= status < 300:
        raise AssertionError(f"{name}: a foreign principal unexpectedly received HTTP {status}")
    return status, payload


def data(response):
    if set(response) != {"data"}:
        raise AssertionError("expected the standard {data} response envelope")
    return response["data"]


def nutrient(day, nutrient_id):
    for item in day["nutrients"]:
        if item["nutrientId"] == nutrient_id:
            return item
    raise AssertionError(f"missing nutrient {nutrient_id}")


def decimal(value, expected, context):
    if value != expected:
        raise AssertionError(f"{context}: expected {expected}, got {value}")


def food_sync_command(
    family_id: str,
    baby_id: str,
    payload: dict[str, object],
    *,
    operation: str = "create",
    entity_id: str | None = None,
    base_version: str | None = None,
) -> dict[str, object]:
    return {
        "commandId": str(uuid.uuid4()),
        "familyId": family_id,
        "babyId": baby_id,
        "entityType": "foodLog",
        "entityId": entity_id or str(uuid.uuid4()),
        "operation": operation,
        "baseVersion": base_version,
        "clientCreatedAt": "2026-10-04T16:00:00Z",
        "payload": payload,
    }


def exercise(stack: OwnedStack) -> dict[str, object]:
    observations: list[dict[str, object]] = []
    suffix = stack.owner
    password = "test_nutrition_analysis_pw_" + secrets.token_hex(12)
    owner_name = "test_nutrition_analysis_owner_" + suffix
    outsider_name = "test_nutrition_analysis_outsider_" + suffix
    owner = data(call(observations, stack.base, "POST", "/api/v1/auth/register", 201,
                      body={"username": owner_name, "password": password,
                            "displayName": "Test Nutrition Analysis", "deviceLabel": "test_nutrition_analysis"},
                      name="register isolated owner"))
    outsider = data(call(observations, stack.base, "POST", "/api/v1/auth/register", 201,
                         body={"username": outsider_name, "password": password,
                               "displayName": "Test Nutrition Outsider", "deviceLabel": "test_nutrition_analysis"},
                         name="register foreign tenant"))
    owner_token, outsider_token = owner["accessToken"], outsider["accessToken"]

    family = data(call(observations, stack.base, "POST", "/api/v1/families", 201, token=owner_token,
                       body={"name": "test_family_nutrition_analysis_" + suffix, "timeZone": "Asia/Shanghai"},
                       name="create test family with family timezone"))
    family_id = family["id"]
    baby = data(call(observations, stack.base, "POST", f"/api/v1/families/{family_id}/babies", 201,
                     token=owner_token,
                     body={"name": "test_baby_nutrition_analysis_" + suffix,
                           "birthDate": "2026-04-02", "gender": "girl"},
                     name="create test baby"))
    baby_id = baby["id"]
    if not (owner_name.startswith("test_") and outsider_name.startswith("test_") and
            baby["name"].startswith("test_baby_")):
        raise AssertionError("test tenant naming guard failed")

    base_path = f"/api/v1/babies/{baby_id}/nutrition"
    analysis_path = base_path + "/analysis"
    trends_path = base_path + "/trends"
    prebirth_baby = data(call(observations, stack.base, "POST", f"/api/v1/families/{family_id}/babies", 201,
                             token=owner_token,
                             body={"name": "test_baby_prebirth_nutrition_" + suffix,
                                   "birthDate": "2027-04-02", "gender": "girl"},
                             name="create test baby with a valid future birth date"))
    prebirth_path = f"/api/v1/babies/{prebirth_baby['id']}/nutrition/analysis?date=2027-04-01"
    prebirth = data(call(observations, stack.base, "GET", prebirth_path, 200, token=owner_token,
                         name="read a valid day before baby birth date"))
    if prebirth["ageMonths"] is not None or prebirth["ageGroup"] != "unknown_age":
        raise AssertionError("a day before birth must report unknown age, not the 0-6m age band")
    if any(item["targetAmount"] is not None or item["targetType"] is not None or item["ulAmount"] is not None
           or item["knownSubtotalAchievementRate"] is not None or item["knownProductAmountExceedsUL"] is not None
           for item in prebirth["nutrients"]):
        raise AssertionError("unknown age must not receive age-dependent DRI targets, ULs, or comparisons")

    boundary_baby = data(call(observations, stack.base, "POST", f"/api/v1/families/{family_id}/babies", 201,
                              token=owner_token,
                              body={"name": "test_baby_age_boundary_" + suffix,
                                    "birthDate": "2024-10-01", "gender": "girl"},
                              name="create test baby for unsupported-age target boundary"))
    boundary_query = urllib.parse.urlencode({"from": "2027-10-31", "to": "2027-11-01"})
    boundary_trends = data(call(observations, stack.base, "GET",
                                f"/api/v1/babies/{boundary_baby['id']}/nutrition/trends?{boundary_query}", 200,
                                token=owner_token, name="read trend across supported-age boundary"))
    boundary_protein = next(item for item in boundary_trends["averages"] if item["nutrientId"] == "protein")
    if [item["ageMonths"] for item in boundary_trends["daily"]] != [36, 37]:
        raise AssertionError("boundary trend must use each local day's age")
    if boundary_protein["targetDaysCount"] != 1 or boundary_protein["targetCoverageRatio"] != "0.5":
        raise AssertionError("trend must expose partial day-specific target coverage")
    if boundary_protein["averageKnownSubtotalAchievementRate"] is not None:
        raise AssertionError("trend must not compare all-day intake average to targets covering only some days")

    call(observations, stack.base, "GET", analysis_path + "?date=2026-10-02", 401,
         name="analysis requires an authenticated session")

    formula_profile = {
        "protein": {"amount": "1.25", "unit": "g"},
        "vitamin_d": {"amount": "0.5", "unit": "mcg"},
        "future_nutrient": {"amount": "3", "unit": "mg"},
    }
    formula = data(call(observations, stack.base, "POST",
                        f"/api/v1/families/{family_id}/nutrition/products", 201, token=owner_token,
                        body={"brand": "test brand", "name": "test formula", "scoopGrams": "4.3",
                              "waterMlPerScoop": "30", "servingSizeUnit": "per_100ml",
                              "nutrientsJson": formula_profile}, name="create family formula profile through typed API"))
    if formula["version"] != 1 or formula["nutrientsJson"]["protein"]["amount"] != "1.25":
        raise AssertionError("formula create must persist a versioned typed nutrient profile")

    call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/feeding", 201,
         token=owner_token, key="test_nutrition_formula_" + suffix,
         body={"feedingType": "formula", "occurredAt": "2026-10-01T16:30:00Z",
               "amountMl": "90", "formulaProductId": formula["id"]}, name="record formula across local midnight")
    formula_path = f"/api/v1/families/{family_id}/nutrition/products/{formula['id']}"
    formula_day_path = analysis_path + "?date=2026-10-02"
    formula_initial = data(call(observations, stack.base, "GET", formula_day_path, 200,
                                token=owner_token, name="calculate exact formula profile created by API"))
    decimal(nutrient(formula_initial, "protein")["formulaCalculatedAmount"], "1.125", "formula protein from per-100ml profile")
    decimal(nutrient(formula_initial, "vitamin_d")["formulaCalculatedAmount"], "18", "formula vitamin D mcg-to-IU conversion")

    changed_formula_profile = {
        "protein": {"amount": "2", "unit": "g"},
        "vitamin_d": {"amount": "0.25", "unit": "mcg"},
    }
    formula_updated = data(call(observations, stack.base, "PATCH", formula_path, 200, token=owner_token,
                                body={"baseVersion": 1, "nutrientsJson": changed_formula_profile},
                                name="update formula profile with compare-and-swap"))
    if formula_updated["version"] != 2:
        raise AssertionError("formula profile update must advance version")
    formula_changed = data(call(observations, stack.base, "GET", formula_day_path, 200,
                                token=owner_token, name="calculate updated formula profile"))
    decimal(nutrient(formula_changed, "protein")["formulaCalculatedAmount"], "1.8", "updated formula protein")
    stale_formula = call(observations, stack.base, "PATCH", formula_path, 409, token=owner_token,
                         body={"baseVersion": 1, "nutrientsJson": changed_formula_profile},
                         name="reject stale formula profile version")
    if stale_formula["error"]["code"] != "CONCURRENCY_CONFLICT":
        raise AssertionError("stale formula profile must return a typed concurrency conflict")
    bad_formula_unit = call(observations, stack.base, "PATCH", formula_path, 400, token=owner_token,
                            body={"baseVersion": 2, "nutrientsJson": {"protein": {"amount": "2", "unit": "bananas"}}},
                            name="reject unsupported formula nutrient unit")
    if bad_formula_unit["error"]["code"] != "BAD_REQUEST":
        raise AssertionError("unsupported formula nutrient unit must be a typed 400")
    call(observations, stack.base, "PATCH", formula_path, 400, token=owner_token,
         body={"baseVersion": 2, "nutrientsJson": {"protein": {"amount": "-2", "unit": "g"}}},
         name="reject negative formula nutrient amount")
    formula_cleared = data(call(observations, stack.base, "PATCH", formula_path, 200, token=owner_token,
                                body={"baseVersion": 2, "nutrientsJson": None},
                                name="clear formula nutrient profile"))
    if formula_cleared["version"] != 3 or formula_cleared["nutrientsJson"] is not None:
        raise AssertionError("explicit null must clear the formula profile and advance version")

    legacy_formula = data(call(observations, stack.base, "POST",
                               f"/api/v1/families/{family_id}/nutrition/products", 201,
                               token=owner_token,
                               body={"brand": "test brand", "name": "test legacy formula",
                                     "scoopGrams": "4", "waterMlPerScoop": "30"},
                               name="create formula without a nutrient profile for legacy edit compatibility"))
    legacy_formula_updated = data(call(observations, stack.base, "PATCH",
                                       f"/api/v1/families/{family_id}/nutrition/products/{legacy_formula['id']}",
                                       200, token=owner_token, body={"waterMlPerScoop": "25"},
                                       name="preserve no-profile legacy formula edits without a version token"))
    if legacy_formula_updated["waterMlPerScoop"] != "25" or legacy_formula_updated["version"] != 2:
        raise AssertionError("legacy no-profile formula edits must remain available while advancing version")

    ratio_formula = data(call(observations, stack.base, "POST",
                              f"/api/v1/families/{family_id}/nutrition/products", 201,
                              token=owner_token,
                              body={"brand": "test brand", "name": "test reconstitution formula",
                                    "scoopGrams": "4", "waterMlPerScoop": "30",
                                    "servingSizeUnit": "per_100g",
                                    "nutrientsJson": {"protein": {"amount": "10", "unit": "g"}}},
                              name="create formula profile with ratio-based serving"))
    ratio_formula_path = f"/api/v1/families/{family_id}/nutrition/products/{ratio_formula['id']}"
    call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/feeding", 201,
         token=owner_token, key="test_nutrition_ratio_formula_" + suffix,
         body={"feedingType": "formula", "occurredAt": "2026-10-03T16:00:00Z",
               "amountMl": "90", "formulaProductId": ratio_formula["id"]},
         name="record formula for ratio profile calculation")
    ratio_analysis_path = analysis_path + "?date=2026-10-04"
    ratio_before = data(call(observations, stack.base, "GET", ratio_analysis_path, 200,
                             token=owner_token, name="calculate formula from scoop and water ratio"))
    decimal(nutrient(ratio_before, "protein")["formulaCalculatedAmount"], "1.2",
            "formula protein from initial scoop-water ratio")
    missing_ratio_version = call(observations, stack.base, "PATCH", ratio_formula_path, 400,
                                 token=owner_token, body={"waterMlPerScoop": "15"},
                                 name="require base version for profiled water reconstitution change")
    if missing_ratio_version["error"]["code"] != "BASE_VERSION_REQUIRED":
        raise AssertionError("changing profiled reconstitution inputs without baseVersion must fail explicitly")
    stale_ratio = call(observations, stack.base, "PATCH", ratio_formula_path, 409, token=owner_token,
                       body={"baseVersion": 2, "waterMlPerScoop": "15"},
                       name="reject stale reconstitution profile version")
    if stale_ratio["error"]["code"] != "CONCURRENCY_CONFLICT":
        raise AssertionError("stale reconstitution update must return a typed conflict")
    ratio_updated = data(call(observations, stack.base, "PATCH", ratio_formula_path, 200,
                              token=owner_token,
                              body={"baseVersion": 1, "waterMlPerScoop": "15"},
                              name="update profiled reconstitution ratio with compare-and-swap"))
    if ratio_updated["version"] != 2:
        raise AssertionError("reconstitution update must advance formula profile version")
    ratio_after = data(call(observations, stack.base, "GET", ratio_analysis_path, 200,
                            token=owner_token, name="recalculate formula after versioned reconstitution change"))
    decimal(nutrient(ratio_after, "protein")["formulaCalculatedAmount"], "2.4",
            "formula protein after versioned scoop-water ratio change")
    missing_scoop_version = call(observations, stack.base, "PATCH", ratio_formula_path, 400,
                                 token=owner_token, body={"scoopGrams": "8"},
                                 name="require base version for profiled scoop weight change")
    if missing_scoop_version["error"]["code"] != "BASE_VERSION_REQUIRED":
        raise AssertionError("changing profiled scoop weight without baseVersion must fail explicitly")
    stale_scoop = call(observations, stack.base, "PATCH", ratio_formula_path, 409, token=owner_token,
                       body={"baseVersion": 1, "scoopGrams": "8"},
                       name="reject stale scoop weight version")
    if stale_scoop["error"]["code"] != "CONCURRENCY_CONFLICT":
        raise AssertionError("stale scoop weight update must return a typed conflict")
    scoop_updated = data(call(observations, stack.base, "PATCH", ratio_formula_path, 200,
                              token=owner_token, body={"baseVersion": 2, "scoopGrams": "8"},
                              name="update profiled scoop weight with compare-and-swap"))
    if scoop_updated["version"] != 3:
        raise AssertionError("scoop weight update must advance formula profile version")
    scoop_analysis = data(call(observations, stack.base, "GET", ratio_analysis_path, 200,
                               token=owner_token, name="recalculate formula after versioned scoop weight change"))
    decimal(nutrient(scoop_analysis, "protein")["formulaCalculatedAmount"], "4.8",
            "formula protein after versioned scoop weight change")
    missing_clear_version = call(observations, stack.base, "PATCH", ratio_formula_path, 400,
                                 token=owner_token, body={"nutrientsJson": None},
                                 name="require base version when clearing formula nutrient input")
    if missing_clear_version["error"]["code"] != "BASE_VERSION_REQUIRED":
        raise AssertionError("clearing a formula nutrient input without baseVersion must fail")
    stale_clear = call(observations, stack.base, "PATCH", ratio_formula_path, 409, token=owner_token,
                       body={"baseVersion": 2, "nutrientsJson": None},
                       name="reject stale formula nutrient profile clear")
    if stale_clear["error"]["code"] != "CONCURRENCY_CONFLICT":
        raise AssertionError("stale formula profile clear must return a typed conflict")
    ratio_cleared = data(call(observations, stack.base, "PATCH", ratio_formula_path, 200,
                              token=owner_token, body={"baseVersion": 3, "nutrientsJson": None},
                              name="clear formula nutrient input with matching version"))
    if ratio_cleared["version"] != 4 or ratio_cleared["nutrientsJson"] is not None:
        raise AssertionError("versioned profile clear must advance the formula version")
    ratio_after_clear = data(call(observations, stack.base, "GET", ratio_analysis_path, 200,
                                  token=owner_token, name="report unknown after CAS-protected formula profile clear"))
    if (nutrient(ratio_after_clear, "protein")["coverage"]["status"] != "unknown" or
            nutrient(ratio_after_clear, "protein")["formulaCalculatedAmount"] != "0"):
        raise AssertionError("cleared formula profile must not provide stale calculated nutrients")

    energy_basis_baby = data(call(observations, stack.base, "POST", f"/api/v1/families/{family_id}/babies", 201,
                                  token=owner_token,
                                  body={"name": "test_baby_formula_energy_basis_" + suffix,
                                        "birthDate": "2026-04-02", "gender": "girl"},
                                  name="create test baby for Web per-100kJ formula basis"))
    energy_basis_formula = data(call(observations, stack.base, "POST",
                                     f"/api/v1/families/{family_id}/nutrition/products", 201,
                                     token=owner_token,
                                     body={"brand": "test brand", "name": "test energy-basis formula",
                                           "servingSizeUnit": "per_100kJ",
                                           "nutrientsJson": {"protein": {"amount": "10", "unit": "g"}}},
                                     name="accept Web per-100kJ formula label basis"))
    call(observations, stack.base, "POST",
         f"/api/v1/babies/{energy_basis_baby['id']}/records/feeding", 201, token=owner_token,
         key="test_nutrition_energy_basis_" + suffix,
         body={"feedingType": "formula", "occurredAt": "2026-10-02T12:00:00Z",
               "amountMl": "120", "formulaProductId": energy_basis_formula["id"]},
         name="record formula without consumed-kilojoule measurement")
    energy_basis_analysis = data(call(observations, stack.base, "GET",
                                      f"/api/v1/babies/{energy_basis_baby['id']}/nutrition/analysis?date=2026-10-02",
                                      200, token=owner_token,
                                      name="report unsupported formula calculation basis as unknown"))
    energy_protein = nutrient(energy_basis_analysis, "protein")
    decimal(energy_protein["formulaCalculatedAmount"], "0", "per-100kJ formula must not be scaled by millilitres")
    if energy_protein["coverage"]["status"] != "unknown":
        raise AssertionError("per-100kJ formula without logged consumed energy must remain unknown")

    call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/feeding", 201,
         token=owner_token, key="test_nutrition_breast_" + suffix,
         body={"feedingType": "breast", "occurredAt": "2026-10-01T13:00:00Z",
               "leftMinutes": 8, "rightMinutes": 0}, name="record direct breastfeeding estimate")

    before_products = data(call(observations, stack.base, "GET", analysis_path + "?date=2026-10-02", 200,
                                token=owner_token, name="refresh after feeding write"))
    if before_products["summary"]["formulaMl"] != "90" or before_products["coverage"]["unknownSourceCount"] == 0:
        raise AssertionError("missing formula profile must remain unknown while logged milk volume is retained")

    supplement = data(call(observations, stack.base, "POST",
                           f"/api/v1/families/{family_id}/nutrition/supplement-products", 201,
                           token=owner_token,
                           body={"name": "test D3", "dosageForm": "drops", "unitName": "drops",
                                 "defaultDose": "1", "nutrientsJson": {
                                     "vitamin_d": {"amount": "10", "unit": "mcg"},
                                     "iron": {"amount": "1", "unit": "mg"},
                                 }}, name="create supplement nutrient profile through API"))
    call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/supplement", 201,
         token=owner_token, key="test_nutrition_supplement_" + suffix,
         body={"supplementName": "test D3", "productId": supplement["id"],
               "occurredAt": "2026-10-02T03:00:00Z", "amount": "0.5 drops",
               "dose": "0.5", "unitName": "drops"}, name="record exact supplement dose")
    call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/food", 201,
         token=owner_token, key="test_nutrition_food_" + suffix,
         body={"recordDate": "2026-10-02", "mealType": "lunch", "foodItemIds": ["food_egg"],
               "portionDescription": "half"}, name="record reference food item")

    custom_food = call(observations, stack.base, "POST", "/api/v1/food/items", 201, token=owner_token,
                       body={"familyId": family_id, "name": "test custom food", "category": "fruit",
                             "allergenRisk": "low", "recommendedAgeMonths": 6,
                             "nutritionBasis": "per_100g",
                             "nutrientsJson": {"protein": {"amount": "4.25", "unit": "g"},
                                               "energy_kcal": {"amount": "50", "unit": "kcal"}}},
                       name="create custom food nutrient profile through API")
    if (custom_food["version"] != 1 or custom_food["nutritionBasis"] != "per_100g" or
            custom_food["nutrientsJson"]["protein"]["amount"] != "4.25"):
        raise AssertionError("custom food create must persist the profile without a data envelope")
    listed_foods = data(call(observations, stack.base, "GET", f"/api/v1/food/items?familyId={family_id}", 200,
                             token=owner_token, name="read custom food profile through family catalog"))
    if not any(row["id"] == custom_food["id"] and row["version"] == 1 for row in listed_foods):
        raise AssertionError("family food catalog did not return the stored custom profile")
    valid_sync_command = food_sync_command(family_id, baby_id, {
        "recordDate": "2026-10-05", "mealType": "lunch", "foodItemIds": [custom_food["id"]],
        "foodAmountGrams": "25", "portionDescription": "test measured serving",
    })
    valid_sync = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                           token=owner_token, body={"commands": [valid_sync_command]},
                           name="create measured food through native sync command"))
    valid_sync_result = valid_sync["results"][0]
    if valid_sync_result["status"] != "applied" or valid_sync_result["version"] != "1":
        raise AssertionError("family-profile measured food sync command must apply at version one")
    valid_sync_record = data(call(observations, stack.base, "GET",
                                  f"/api/v1/babies/{baby_id}/records/food/{valid_sync_command['entityId']}", 200,
                                  token=owner_token, name="read back measured food written through sync"))
    if valid_sync_record["foodAmountGrams"] != "25" or valid_sync_record["familyId"] != family_id:
        raise AssertionError("sync-created record lost its measured amount or family scope")
    sync_analysis_path = analysis_path + "?date=2026-10-05"
    sync_analysis = data(call(observations, stack.base, "GET", sync_analysis_path, 200,
                              token=owner_token, name="calculate measured food written through sync"))
    decimal(nutrient(sync_analysis, "protein")["foodCalculatedAmount"], "1.063",
            "sync-created custom food calculation rounded to the API precision")

    builtin_update_command = food_sync_command(
        family_id, baby_id, {"foodItemIds": ["food_egg"]}, operation="update",
        entity_id=valid_sync_command["entityId"], base_version="1")
    builtin_update = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                               token=owner_token, body={"commands": [builtin_update_command]},
                               name="reject sync update moving measured mass to non-profile food"))
    builtin_update_result = builtin_update["results"][0]
    if builtin_update_result["status"] != "error" or builtin_update_result.get("error", {}).get("code") != "BAD_REQUEST":
        raise AssertionError("sync update must validate the retained gram amount against the new food profile")
    retained_after_builtin = data(call(observations, stack.base, "GET",
                                       f"/api/v1/babies/{baby_id}/records/food/{valid_sync_command['entityId']}", 200,
                                       token=owner_token, name="verify rejected sync food reassignment preserves record"))
    if retained_after_builtin["foodItemIds"] != [custom_food["id"]] or retained_after_builtin["foodAmountGrams"] != "25":
        raise AssertionError("rejected sync reassignment changed the existing measured food record")

    multi_update_command = food_sync_command(
        family_id, baby_id, {"foodItemIds": [custom_food["id"], "food_egg"]}, operation="update",
        entity_id=valid_sync_command["entityId"], base_version="1")
    multi_update = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                             token=owner_token, body={"commands": [multi_update_command]},
                             name="reject sync update assigning measured mass to multiple foods"))
    multi_update_result = multi_update["results"][0]
    if multi_update_result["status"] != "error" or multi_update_result.get("error", {}).get("code") != "BAD_REQUEST":
        raise AssertionError("sync update must reject multiple foods when retaining measured grams")

    valid_update_command = food_sync_command(
        family_id, baby_id, {"foodAmountGrams": "30"}, operation="update",
        entity_id=valid_sync_command["entityId"], base_version="1")
    valid_update = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                             token=owner_token, body={"commands": [valid_update_command]},
                             name="update measured food through native sync command"))
    valid_update_result = valid_update["results"][0]
    if valid_update_result["status"] != "applied" or valid_update_result["version"] != "2":
        raise AssertionError("valid measured food sync update must advance the record version")
    valid_sync_updated = data(call(observations, stack.base, "GET",
                                   f"/api/v1/babies/{baby_id}/records/food/{valid_sync_command['entityId']}", 200,
                                   token=owner_token, name="read back updated sync food record"))
    if valid_sync_updated["foodAmountGrams"] != "30":
        raise AssertionError("sync update did not persist the new measured mass")
    sync_updated_analysis = data(call(observations, stack.base, "GET", sync_analysis_path, 200,
                                      token=owner_token, name="recalculate updated sync food record"))
    decimal(nutrient(sync_updated_analysis, "protein")["foodCalculatedAmount"], "1.275",
            "updated sync-created custom food calculation")

    builtin_sync_command = food_sync_command(family_id, baby_id, {
        "recordDate": "2026-10-06", "mealType": "lunch", "foodItemIds": ["food_egg"],
        "foodAmountGrams": "10",
    })
    builtin_sync = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                             token=owner_token, body={"commands": [builtin_sync_command]},
                             name="reject measured food sync without family profile"))
    builtin_result = builtin_sync["results"][0]
    if builtin_result["status"] != "error" or builtin_result.get("error", {}).get("code") != "BAD_REQUEST":
        raise AssertionError("sync must reject grams for a non-profile food item")
    call(observations, stack.base, "GET",
         f"/api/v1/babies/{baby_id}/records/food/{builtin_sync_command['entityId']}", 404,
         token=owner_token, name="verify rejected profile-less sync did not persist a record")

    multi_sync_command = food_sync_command(family_id, baby_id, {
        "recordDate": "2026-10-06", "mealType": "lunch",
        "foodItemIds": [custom_food["id"], "food_egg"], "foodAmountGrams": "10",
    })
    multi_sync = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                           token=owner_token, body={"commands": [multi_sync_command]},
                           name="reject measured multi-food sync command"))
    multi_result = multi_sync["results"][0]
    if multi_result["status"] != "error" or multi_result.get("error", {}).get("code") != "BAD_REQUEST":
        raise AssertionError("sync must reject measured mass for multiple food items")
    call(observations, stack.base, "GET",
         f"/api/v1/babies/{baby_id}/records/food/{multi_sync_command['entityId']}", 404,
         token=owner_token, name="verify rejected multi-food sync did not persist a record")

    foreign_sync_command = food_sync_command(family_id, baby_id, {
        "recordDate": "2026-10-06", "mealType": "lunch", "foodItemIds": [custom_food["id"]],
        "foodAmountGrams": "20",
    })
    foreign_sync = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                             token=outsider_token, body={"commands": [foreign_sync_command]},
                             name="deny foreign tenant measured-food sync command"))
    foreign_result = foreign_sync["results"][0]
    if foreign_result["status"] != "error" or foreign_result.get("error", {}).get("code") not in {
            "FAMILY_ACCESS_DENIED", "BABY_ACCESS_DENIED"}:
        raise AssertionError("foreign sync principal must not create a measured food record")
    call(observations, stack.base, "GET",
         f"/api/v1/babies/{baby_id}/records/food/{foreign_sync_command['entityId']}", 404,
         token=owner_token, name="verify foreign sync denial did not persist a record")
    custom_food_record_date = "2026-10-03"
    invalid_grams = call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/food", 400,
                         token=owner_token,
                         body={"recordDate": custom_food_record_date, "mealType": "lunch",
                               "foodItemIds": [custom_food["id"]], "foodAmountGrams": "-2"},
                         name="reject negative measured food mass")
    if invalid_grams["error"]["code"] != "BAD_REQUEST":
        raise AssertionError("negative grams must return a typed bad request")
    call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/food", 400,
         token=owner_token,
         body={"recordDate": custom_food_record_date, "mealType": "lunch",
               "foodItemIds": [custom_food["id"], "food_egg"], "foodAmountGrams": "10"},
         name="reject measured grams for multiple food items")
    food_record = data(call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/food", 201,
         token=owner_token, key="test_nutrition_custom_food_" + suffix,
         body={"recordDate": custom_food_record_date, "mealType": "lunch", "foodItemIds": [custom_food["id"]],
               "foodAmountGrams": "50", "portionDescription": "all"}, name="record custom food measured grams"))
    if food_record["foodAmountGrams"] != "50":
        raise AssertionError("food record response did not retain the measured gram amount")
    custom_food_analysis_path = analysis_path + "?date=" + custom_food_record_date
    custom_food_initial = data(call(observations, stack.base, "GET", custom_food_analysis_path, 200,
                                    token=owner_token, name="calculate initial per-100g food profile"))
    decimal(nutrient(custom_food_initial, "protein")["foodCalculatedAmount"], "2.125", "initial custom food grams calculation")
    decimal(nutrient(custom_food_initial, "protein")["foodEstimatedAmount"], "0", "measured food is not classified as estimate")
    custom_food_path = f"/api/v1/families/{family_id}/food/items/{custom_food['id']}"
    custom_food_updated = call(observations, stack.base, "PATCH", custom_food_path, 200, token=owner_token,
                               body={"baseVersion": 1, "nutrientsJson": {"protein": {"amount": "6.5", "unit": "g"}}},
                               name="update custom food profile with compare-and-swap")
    if custom_food_updated["version"] != 2:
        raise AssertionError("food profile update must advance version")
    custom_food_changed = data(call(observations, stack.base, "GET", custom_food_analysis_path, 200,
                                    token=owner_token, name="calculate updated custom food profile"))
    decimal(nutrient(custom_food_changed, "protein")["foodCalculatedAmount"], "3.25", "updated custom food calculation at 50 g")
    no_grams = data(call(observations, stack.base, "PATCH", f"/api/v1/babies/{baby_id}/records/food/{food_record['id']}",
                         200, token=owner_token,
                         body={"baseVersion": "1", "foodAmountGrams": None},
                         name="explicitly clear measured food amount"))
    if no_grams["foodAmountGrams"] is not None or no_grams["version"] != "2":
        raise AssertionError("measured food clear must persist and advance the care-record version")
    no_grams_analysis = data(call(observations, stack.base, "GET", custom_food_analysis_path, 200,
                                  token=owner_token, name="do not estimate per-100g profile without measured mass"))
    no_grams_protein = nutrient(no_grams_analysis, "protein")
    decimal(no_grams_protein["foodCalculatedAmount"], "0", "missing measured grams must not use per-100g profile as a serving")
    decimal(no_grams_protein["foodEstimatedAmount"], "0", "missing measured grams must not create a serving estimate")
    if no_grams_protein["coverage"]["unknownSourceCount"] == 0:
        raise AssertionError("missing measured mass must be visible as unknown coverage")
    measured_again = data(call(observations, stack.base, "PATCH", f"/api/v1/babies/{baby_id}/records/food/{food_record['id']}",
                               200, token=owner_token,
                               body={"baseVersion": "2", "foodAmountGrams": "60"},
                               name="restore measured grams with CAS"))
    if measured_again["foodAmountGrams"] != "60" or measured_again["version"] != "3":
        raise AssertionError("updated measured grams must persist at the next version")
    measured_again_analysis = data(call(observations, stack.base, "GET", custom_food_analysis_path, 200,
                                        token=owner_token, name="calculate restored measured grams"))
    decimal(nutrient(measured_again_analysis, "protein")["foodCalculatedAmount"], "3.9", "custom food calculation at 60 g")
    stale_food_record = call(observations, stack.base, "PATCH", f"/api/v1/babies/{baby_id}/records/food/{food_record['id']}",
                             409, token=owner_token,
                             body={"baseVersion": "2", "foodAmountGrams": "70"},
                             name="reject stale measured food record version")
    if stale_food_record["error"]["code"] != "CONCURRENCY_CONFLICT":
        raise AssertionError("stale measured food write must return a concurrency conflict")
    stale_food = call(observations, stack.base, "PATCH", custom_food_path, 409, token=owner_token,
                      body={"baseVersion": 1, "nutrientsJson": {"protein": {"amount": "9", "unit": "g"}}},
                      name="reject stale custom food profile version")
    if stale_food["error"]["code"] != "CONCURRENCY_CONFLICT":
        raise AssertionError("stale food profile must return a typed concurrency conflict")
    foreign_food = call(observations, stack.base, "PATCH", custom_food_path, 403, token=outsider_token,
                        body={"baseVersion": 2, "nutrientsJson": None},
                        name="deny foreign principal custom food profile write")
    if foreign_food["error"]["code"] != "FAMILY_ACCESS_DENIED":
        raise AssertionError("foreign food profile write must return family access denial")
    call(observations, stack.base, "PATCH", custom_food_path, 400, token=owner_token,
         body={"baseVersion": 2, "nutrientsJson": {"protein": {"amount": "1", "unit": "bananas"}}},
         name="reject unsupported custom food nutrient unit")
    call(observations, stack.base, "PATCH", custom_food_path, 400, token=owner_token,
         body={"baseVersion": 2, "nutrientsJson": {"protein": {"amount": -1, "unit": "g"}}},
         name="reject negative custom food nutrient amount")
    custom_food_cleared = call(observations, stack.base, "PATCH", custom_food_path, 200, token=owner_token,
                               body={"baseVersion": 2, "nutrientsJson": None},
                               name="clear custom food nutrient profile")
    if custom_food_cleared["version"] != 3 or custom_food_cleared["nutrientsJson"] is not None:
        raise AssertionError("explicit null must clear the food profile and advance version")
    custom_food_unknown = data(call(observations, stack.base, "GET", custom_food_analysis_path, 200,
                                    token=owner_token, name="report unknown custom food after profile clear"))
    if custom_food_unknown["coverage"]["unknownSourceCount"] == 0:
        raise AssertionError("clearing a custom food profile must not keep stale calculated nutrients")

    delete_sync_command = food_sync_command(
        family_id, baby_id, {}, operation="delete", entity_id=valid_sync_command["entityId"],
        base_version="2")
    delete_sync = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                            token=owner_token, body={"commands": [delete_sync_command]},
                            name="soft-delete measured food through native sync"))
    delete_sync_result = delete_sync["results"][0]
    if delete_sync_result["status"] != "applied" or delete_sync_result["version"] != "3":
        raise AssertionError("sync delete must advance the food record version")
    restore_sync_command = food_sync_command(
        family_id, baby_id, {}, operation="restore", entity_id=valid_sync_command["entityId"],
        base_version="3")
    restore_sync = data(call(observations, stack.base, "POST", "/api/v1/sync/commands", 200,
                             token=owner_token, body={"commands": [restore_sync_command]},
                             name="restore measured historical food after current profile clear"))
    restore_sync_result = restore_sync["results"][0]
    if restore_sync_result["status"] != "applied" or restore_sync_result["version"] != "4":
        raise AssertionError("sync restore must preserve an accepted historical food record")
    restored_sync_record = data(call(observations, stack.base, "GET",
                                     f"/api/v1/babies/{baby_id}/records/food/{valid_sync_command['entityId']}", 200,
                                     token=owner_token, name="read restored measured food record"))
    if restored_sync_record["foodAmountGrams"] != "30":
        raise AssertionError("sync restore lost the historical measured mass")
    restored_sync_analysis = data(call(observations, stack.base, "GET", sync_analysis_path, 200,
                                       token=owner_token,
                                       name="keep restored historical record visibly unknown after profile clear"))
    restored_sync_protein = nutrient(restored_sync_analysis, "protein")
    if restored_sync_protein["foodCalculatedAmount"] != "0" or restored_sync_protein["coverage"]["status"] != "unknown":
        raise AssertionError("restored record must not reuse a cleared family profile")

    day_empty = data(call(observations, stack.base, "GET", analysis_path + "?date=2026-09-30", 200,
                          token=owner_token, name="read empty local calendar day"))
    day_breast = data(call(observations, stack.base, "GET", analysis_path + "?date=2026-10-01", 200,
                           token=owner_token, name="read breast milk day"))
    day_mixed_sources = data(call(observations, stack.base, "GET", analysis_path + "?date=2026-10-02", 200,
                                  token=owner_token, name="refresh after food and supplement writes"))

    if day_empty["ageMonths"] != 5 or day_empty["coverage"]["logCompleteness"] != "unverified":
        raise AssertionError("empty-day age or completeness metadata is incorrect")
    if day_breast["ageMonths"] != 5 or day_breast["timeZone"] != "Asia/Shanghai":
        raise AssertionError("local day age/timezone metadata is incorrect")
    decimal(day_breast["summary"]["breastmilkEstimatedMl"], "40", "estimated nursing volume")
    decimal(nutrient(day_breast, "protein")["breastmilkEstimatedAmount"], "0.44", "breast milk protein estimate")
    if day_mixed_sources["ageMonths"] != 6:
        raise AssertionError("age must be recalculated for the next local calendar day")
    decimal(day_mixed_sources["summary"]["formulaMl"], "90", "formula logged volume")
    decimal(nutrient(day_mixed_sources, "vitamin_d")["supplementCalculatedAmount"], "200", "supplement mcg-to-IU conversion")
    decimal(nutrient(day_mixed_sources, "vitamin_d")["foodEstimatedAmount"], "20", "legacy food estimate")
    decimal(nutrient(day_mixed_sources, "protein")["foodEstimatedAmount"], "3.15", "food portion estimate")
    if nutrient(day_mixed_sources, "protein")["coverage"]["status"] != "partial":
        raise AssertionError("missing formula/product nutrients must not be presented as a complete total")
    if day_mixed_sources["referenceDataset"]["validationStatus"] != "legacy_values_not_independently_cross_checked":
        raise AssertionError("reference metadata falsely claims clinical validation")
    if day_mixed_sources["coverage"]["unknownSourceCount"] == 0:
        raise AssertionError("cleared formula profile must remain unknown instead of reusing stale values")

    query = urllib.parse.urlencode({"from": "2026-09-30", "to": "2026-10-02"})
    trends = data(call(observations, stack.base, "GET", trends_path + "?" + query, 200,
                       token=owner_token, name="read three-day local trend"))
    if trends["daysCount"] != 3 or len(trends["daily"]) != 3:
        raise AssertionError("trend must contain all requested calendar days")
    if [item["ageMonths"] for item in trends["daily"]] != [5, 5, 6]:
        raise AssertionError("trend must calculate age for each local date")
    decimal(nutrient(trends["daily"][0], "protein")["knownSubtotalAmount"], "0", "empty-day subtotal")
    protein_average = next(item for item in trends["averages"] if item["nutrientId"] == "protein")
    decimal(protein_average["estimatedAmountPerDay"], "1.197", "average includes the empty day")
    if protein_average["targetDaysCount"] != 3 or protein_average["targetCoverageRatio"] != "1":
        raise AssertionError("trend target coverage should count all three day-specific targets")
    if trends["coverage"]["logCompleteness"] != "unverified":
        raise AssertionError("trend completeness must remain unverified")

    # Inclusive local-day guard: exactly 90 dates pass, 91 dates fail.
    end = date(2026, 10, 2)
    accepted_from = end - timedelta(days=89)
    rejected_from = end - timedelta(days=90)
    ninety = urllib.parse.urlencode({"from": accepted_from.isoformat(), "to": end.isoformat()})
    ninety_data = data(call(observations, stack.base, "GET", trends_path + "?" + ninety, 200,
                            token=owner_token, name="accept 90 local calendar days"))
    if ninety_data["daysCount"] != 90:
        raise AssertionError("90-day response has the wrong number of local dates")
    ninety_one = urllib.parse.urlencode({"from": rejected_from.isoformat(), "to": end.isoformat()})
    error = call(observations, stack.base, "GET", trends_path + "?" + ninety_one, 400,
                 token=owner_token, name="reject 91 local calendar days")
    if error["error"]["code"] != "BAD_REQUEST":
        raise AssertionError("91-day limit must be a normal 400 request error")
    invalid_version = urllib.parse.urlencode({"date": "2026-10-02", "datasetVersion": "test_unknown"})
    error = call(observations, stack.base, "GET", analysis_path + "?" + invalid_version, 409,
                 token=owner_token, name="reject unavailable reference dataset")
    if error["error"]["code"] != "NUTRITION_DATASET_VERSION_UNSUPPORTED":
        raise AssertionError("unknown reference version must be a typed conflict")
    bad_date = urllib.parse.urlencode({"date": "2026-02-30"})
    call(observations, stack.base, "GET", analysis_path + "?" + bad_date, 400,
         token=owner_token, name="reject invalid calendar date")
    foreign_status, _ = expect_non_success(observations, stack.base, "GET",
                                           analysis_path + "?date=2026-10-02", token=outsider_token,
                                           name="deny foreign tenant nutrition read")

    # Simulate one explicitly test-owned historical row. The row is first
    # created through the public typed API; the direct SQL update is only a
    # fixture injection for legacy-read compatibility and is not an API write
    # path or a substitute for the CAS/authorization checks above.
    legacy_baby = data(call(observations, stack.base, "POST", f"/api/v1/families/{family_id}/babies", 201,
                            token=owner_token,
                            body={"name": "test_baby_legacy_profile_" + suffix,
                                  "birthDate": "2026-01-01", "gender": "girl"},
                            name="create isolated baby for historical profile read compatibility"))
    legacy_formula = data(call(
        observations, stack.base, "POST", f"/api/v1/families/{family_id}/nutrition/products", 201,
        token=owner_token,
        body={"brand": "test legacy brand", "name": "test legacy formula", "scoopGrams": "4.3",
              "waterMlPerScoop": "30", "servingSizeUnit": "per_100ml",
              "nutrientsJson": {"protein": {"amount": 2, "unit": "g"},
                                "vitamin_d": {"amount": 0.5, "unit": "mcg"}}},
        name="create valid product before historical fixture injection"))
    call(observations, stack.base, "POST", f"/api/v1/babies/{legacy_baby['id']}/records/feeding", 201,
         token=owner_token, key="test_legacy_profile_feeding_" + suffix,
         body={"feedingType": "formula", "occurredAt": "2026-10-02T08:00:00Z",
               "amountMl": "100", "formulaProductId": legacy_formula["id"]},
         name="create formula feeding for historical profile analysis")
    legacy_profile = {
        "protein": {"amount": 2, "unit": "g", "source": "legacy_label"},
        "iron": 18,
        "vitamin_d": {"amount": 0.5, "unit": "mcg"},
        "future_label_nutrient": {"amount": 4, "unit": "mg", "source": "old_web"},
    }
    encoded_legacy_profile = json.dumps(legacy_profile, ensure_ascii=False, separators=(",", ":"))
    encoded_legacy_profile = encoded_legacy_profile.replace("'", "''")
    fixture_id = stack.sql(
        f"UPDATE formula_products SET nutrients_json='{encoded_legacy_profile}'::jsonb "
        f"WHERE id='{legacy_formula['id']}' AND family_id='{family_id}' RETURNING id;"
    )
    if fixture_id != legacy_formula["id"]:
        raise AssertionError("owned historical fixture did not update exactly its API-created test product")

    products_path = f"/api/v1/families/{family_id}/nutrition/products?limit=200&includeArchived=true"
    legacy_list = call(observations, stack.base, "GET", products_path, 200, token=owner_token,
                       name="read test-owned historical profile through real formula product list")
    legacy_list_rows = legacy_list.get("data")
    if not isinstance(legacy_list_rows, list):
        raise AssertionError("formula product list did not return a data array")
    legacy_readback = next((row for row in legacy_list_rows if row.get("id") == legacy_formula["id"]), None)
    if legacy_readback is None or legacy_readback.get("nutrientsJson") != legacy_profile:
        raise AssertionError("formula product list did not preserve raw historical JSON exactly")

    bad_create = call(
        observations, stack.base, "POST", f"/api/v1/families/{family_id}/nutrition/products", 400,
        token=owner_token,
        body={"brand": "test invalid brand", "name": "test rejected legacy-shaped formula",
              "servingSizeUnit": "per_100ml", "nutrientsJson": legacy_profile},
        name="reject malformed legacy-shaped profile on typed formula create",
    )
    bad_update = call(
        observations, stack.base, "PATCH",
        f"/api/v1/families/{family_id}/nutrition/products/{legacy_formula['id']}", 400,
        token=owner_token, body={"baseVersion": 1, "nutrientsJson": legacy_profile},
        name="reject malformed legacy-shaped profile on typed formula update",
    )
    if not bad_create.get("error") or not bad_update.get("error"):
        raise AssertionError("malformed typed write must retain a standard validation error")

    legacy_analysis = data(call(
        observations, stack.base, "GET",
        f"/api/v1/babies/{legacy_baby['id']}/nutrition/analysis?date=2026-10-02", 200,
        token=owner_token, name="analyze mixed valid and malformed historical formula profile",
    ))
    malformed_protein = nutrient(legacy_analysis, "protein")
    malformed_iron = nutrient(legacy_analysis, "iron")
    valid_vitamin_d = nutrient(legacy_analysis, "vitamin_d")
    if malformed_protein["coverage"]["status"] != "unknown" or malformed_protein["sources"]:
        raise AssertionError("extra measurement metadata must remain unknown and not be calculated")
    if malformed_iron["coverage"]["status"] != "unknown":
        raise AssertionError("a scalar historical nutrient value must be reported as unknown")
    if valid_vitamin_d["coverage"]["status"] != "calculated" or valid_vitamin_d["formulaCalculatedAmount"] != "20":
        raise AssertionError("one malformed historical entry must not prevent valid entries from being calculated")

    return {
        "checkCount": len(observations),
        "httpChecks": observations,
        "owner": "test_…",
        "family": "test_family_…",
        "baby": "test_baby_…",
        "timeZone": "Asia/Shanghai",
        "foreignTenantStatus": foreign_status,
        "legacyProfileReadCompatibility": {
            "fixtureSource": "direct UPDATE of an API-created row in this run's owned test PostgreSQL only; not a public write path",
            "rawListReadbackPreserved": True,
            "invalidCreateStatus": bad_create["error"]["code"],
            "invalidUpdateStatus": bad_update["error"]["code"],
            "analysisHTTPStatus": 200,
            "malformedProteinCoverage": malformed_protein["coverage"]["status"],
            "scalarIronCoverage": malformed_iron["coverage"]["status"],
            "validVitaminDCalculatedIU": valid_vitamin_d["formulaCalculatedAmount"],
        },
        "golden": {
            "dayCount": trends["daysCount"],
            "ageMonthsByLocalDay": [item["ageMonths"] for item in trends["daily"]],
            "breastmilkEstimatedMl": day_breast["summary"]["breastmilkEstimatedMl"],
            "vitaminDCalculatedIU": nutrient(day_mixed_sources, "vitamin_d")["supplementCalculatedAmount"],
            "proteinFoodEstimateG": nutrient(day_mixed_sources, "protein")["foodEstimatedAmount"],
            "proteinEstimatedAverageGPerDay": protein_average["estimatedAmountPerDay"],
            "proteinTrendTargetDaysCount": protein_average["targetDaysCount"],
            "proteinTrendTargetCoverageRatio": protein_average["targetCoverageRatio"],
            "partialBoundaryTargetDaysCount": boundary_protein["targetDaysCount"],
            "partialBoundaryTargetCoverageRatio": boundary_protein["targetCoverageRatio"],
            "referenceValidationStatus": trends["referenceDataset"]["validationStatus"],
        },
        "profileFlow": "formula and custom food profiles created, updated by CAS, explicitly cleared, and analyzed through real HTTP; custom food profiles use per-100g basis and exact calculations require measured grams, while legacy portion multipliers remain estimates",
        "formulaProfileVersionAfterClear": formula_cleared["version"],
        "formulaProteinBeforeUpdateG": nutrient(formula_initial, "protein")["formulaCalculatedAmount"],
        "formulaProteinAfterUpdateG": nutrient(formula_changed, "protein")["formulaCalculatedAmount"],
        "profileCASFlow": {
            "legacyNoProfileEditVersion": legacy_formula_updated["version"],
            "versionAfterWaterRatioUpdate": ratio_updated["version"],
            "proteinBeforeReconstitutionChangeG": nutrient(ratio_before, "protein")["formulaCalculatedAmount"],
            "proteinAfterWaterChangeG": nutrient(ratio_after, "protein")["formulaCalculatedAmount"],
            "versionAfterScoopWeightUpdate": scoop_updated["version"],
            "proteinAfterScoopWeightChangeG": nutrient(scoop_analysis, "protein")["formulaCalculatedAmount"],
            "versionAfterProfileClear": ratio_cleared["version"],
            "coverageAfterProfileClear": nutrient(ratio_after_clear, "protein")["coverage"]["status"],
            "missingVersionError": missing_ratio_version["error"]["code"],
            "staleVersionError": stale_ratio["error"]["code"],
            "missingClearVersionError": missing_clear_version["error"]["code"],
            "staleClearVersionError": stale_clear["error"]["code"],
        },
        "foodSyncFlow": {
            "createStatus": valid_sync_result["status"],
            "createVersion": valid_sync_result["version"],
            "createReadbackGrams": valid_sync_record["foodAmountGrams"],
            "createProteinG": nutrient(sync_analysis, "protein")["foodCalculatedAmount"],
            "updateStatus": valid_update_result["status"],
            "updateVersion": valid_update_result["version"],
            "updateReadbackGrams": valid_sync_updated["foodAmountGrams"],
            "updatedProteinG": nutrient(sync_updated_analysis, "protein")["foodCalculatedAmount"],
            "profilelessCreateError": builtin_result["error"]["code"],
            "multiFoodCreateError": multi_result["error"]["code"],
            "profilelessUpdateError": builtin_update_result["error"]["code"],
            "multiFoodUpdateError": multi_update_result["error"]["code"],
            "foreignPrincipalError": foreign_result["error"]["code"],
            "deleteStatus": delete_sync_result["status"],
            "restoreStatus": restore_sync_result["status"],
            "restoredGrams": restored_sync_record["foodAmountGrams"],
            "coverageAfterProfileClearAndRestore": restored_sync_protein["coverage"]["status"],
        },
        "customFoodProfileVersionAfterClear": custom_food_cleared["version"],
        "customFoodProteinAt50gG": nutrient(custom_food_changed, "protein")["foodCalculatedAmount"],
        "customFoodProteinAt60gG": nutrient(measured_again_analysis, "protein")["foodCalculatedAmount"],
        "customFoodUnknownSourceCountAfterClear": custom_food_unknown["coverage"]["unknownSourceCount"],
    }


def main() -> int:
    if not __debug__:
        raise RuntimeError("Refusing optimized Python: assertions must remain enabled")
    source_files = [
        "packages/contracts/src/nutrition.ts", "packages/contracts/src/routes.ts", "contracts/openapi.json",
        "packages/contracts/src/records.ts", "packages/contracts/tests/nutrition-profile.test.ts",
        "apps/api/src/services/formula-product-service.ts", "packages/database/src/food-repository.ts",
        "internal/backend/register.go", "internal/backend/formula_products.go", "internal/backend/formula_products_test.go",
        "internal/backend/food_library.go", "internal/backend/sync_commands.go",
        "internal/backend/food_library_test.go", "internal/backend/companion_test.go", "internal/backend/foundation_test.go",
        "internal/backend/nutrition_profile.go", "internal/backend/nutrition_profile_test.go",
        "internal/backend/nutrition_analysis.go", "internal/backend/nutrition_analysis_calc.go",
        "internal/backend/nutrition_analysis_test.go", "internal/backend/nutrition_records.go",
        "internal/backend/nutrition_records_test.go", "prisma/schema.prisma",
        "prisma/migrations/202610030026_food_nutrition_profiles/migration.sql",
        "prisma/migrations/202610030027_food_record_measured_grams/migration.sql",
        "internal/backend/nutrition_reference_legacy_v1.json", "scripts/go-nutrition-analysis-integration.py",
    ]
    evidence: dict[str, object] = {
        "scope": "formula reconstitution CAS, measured food sync guards, and historical formula profile read compatibility",
        "status": "RUNNING",
        "sourceFileHashes": {name: sha256_file(ROOT / name) for name in source_files},
        "result": None,
        "cleanup": {},
    }
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + secrets.token_hex(3)
    result_path = EVIDENCE / f"http-result-{run_id}.json"
    stack: OwnedStack | None = None
    return_code = 0
    try:
        stack = OwnedStack()
        if {stack.api_port, stack.pg_port, stack.redis_port, stack.s3_port, stack.s3_console_port} & RESERVED_PORTS:
            raise RuntimeError("owned test stack selected a reserved shared-service port")
        stack.start()
        evidence["ownedEnvironment"] = {
            "postgresHost": "127.0.0.1", "redisHost": "127.0.0.1", "objectStorageHost": "127.0.0.1",
            "database": "test_…", "role": "test_…", "prismaMigrationCount": len(stack.migrated),
            "aiProvider": "fixture", "workerStarted": False, "pushCredentialsPresent": False,
            "usedProductionSecretsOrLegacyDatabase": False,
        }
        evidence["result"] = exercise(stack)
        evidence["status"] = "PASS"
    except BaseException as error:
        evidence["status"] = "FAIL"
        evidence["failureType"] = type(error).__name__
        evidence["failure"] = str(error) if isinstance(error, (AssertionError, RuntimeError)) else type(error).__name__
        return_code = 130 if isinstance(error, KeyboardInterrupt) else 1
    finally:
        if stack is not None:
            stack.close()
            evidence["cleanup"] = stack.cleanup
            evidence["databaseDiagnostics"] = stack.database_diagnostics
            if not all(value is True for value in stack.cleanup.values()):
                evidence["status"] = "FAIL"
                return_code = 1
        result_path.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
        result_path.chmod(0o600)
        if evidence["status"] == "PASS":
            print(f"PASS isolated nutrition HTTP E2E ({evidence['result']['checkCount']} checks)")
            print(f"Evidence: {result_path}")
            print("PASS owned PostgreSQL, Redis, MinIO, and API stopped; tenant data removed")
        else:
            print(f"FAIL isolated nutrition HTTP E2E ({evidence.get('failure', 'cleanup failure')})")
            print(f"Evidence: {result_path}")
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
