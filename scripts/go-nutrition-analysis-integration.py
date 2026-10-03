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
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EVIDENCE = ROOT / "evidence/tasks/IOS_WEB_PARITY_20261002/nutrition-analysis"
RESERVED_PORTS = {3088, 3089, 49762, 57006, 60756}

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

    formula = data(call(observations, stack.base, "POST",
                        f"/api/v1/families/{family_id}/nutrition/products", 201, token=owner_token,
                        body={"brand": "test brand", "name": "test formula", "scoopGrams": "4.3",
                              "waterMlPerScoop": "30"}, name="create family formula through API"))
    # The frozen contract exposes no formula nutrientsJson write. The response
    # therefore remains explicitly unknown instead of receiving a fabricated profile.
    if formula.get("nutrientsJson") is not None:
        raise AssertionError("formula nutrientsJson changed without an exposed create field")

    call(observations, stack.base, "POST", f"/api/v1/babies/{baby_id}/records/feeding", 201,
         token=owner_token, key="test_nutrition_formula_" + suffix,
         body={"feedingType": "formula", "occurredAt": "2026-10-01T16:30:00Z",
               "amountMl": "90", "formulaProductId": formula["id"]}, name="record formula across local midnight")
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

    return {
        "checkCount": len(observations),
        "httpChecks": observations,
        "owner": "test_…",
        "family": "test_family_…",
        "baby": "test_baby_…",
        "timeZone": "Asia/Shanghai",
        "foreignTenantStatus": foreign_status,
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
        "formulaProfileBoundary": "formula product nutrientsJson is not writable through the pinned create/update contract; HTTP result remains unknown, no SQL seeding",
    }


def main() -> int:
    if not __debug__:
        raise RuntimeError("Refusing optimized Python: assertions must remain enabled")
    source_files = [
        "packages/contracts/src/nutrition.ts", "packages/contracts/src/routes.ts", "contracts/openapi.json",
        "internal/backend/register.go", "internal/backend/nutrition_analysis.go",
        "internal/backend/nutrition_analysis_calc.go", "internal/backend/nutrition_analysis_test.go",
        "internal/backend/nutrition_reference_legacy_v1.json", "scripts/go-nutrition-analysis-integration.py",
    ]
    evidence: dict[str, object] = {
        "scope": "server-authoritative nutrition analysis and trends",
        "status": "RUNNING",
        "sourceRevision": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
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
