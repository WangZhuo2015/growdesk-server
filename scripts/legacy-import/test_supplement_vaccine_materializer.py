"""Pure checks for the legacy supplement/vaccine promotion boundary."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "materialize_supplement_vaccine_test",
    Path(__file__).with_name("materialize_supplement_vaccine.py"),
)
assert SPEC is not None and SPEC.loader is not None
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)

STAMP = "2026-09-12T08:00:00+08:00"


def archive() -> dict:
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "capturedAt": STAMP,
        "sourceId": "test_supplement_vaccine_archive",
        "sourceSha256": "a" * 64,
        "excluded": {},
        "tables": {
            "User": [
                {"id": "test_sv_user_a", "username": "test_sv_user_a", "passwordHash": "$2b$10$" + "a" * 53, "displayName": "test_sv_a", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_sv_user_b", "username": "test_sv_user_b", "passwordHash": "$2b$10$" + "b" * 53, "displayName": "test_sv_b", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_sv_other", "username": "test_sv_other", "passwordHash": "$2b$10$" + "c" * 53, "displayName": "test_sv_other", "createdAt": STAMP, "updatedAt": STAMP},
            ],
            "Family": [
                {"id": "test_sv_family_a", "name": "test_sv_family_a", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_sv_family_b", "name": "test_sv_family_b", "createdAt": STAMP, "updatedAt": STAMP},
            ],
            "FamilyMember": [
                {"id": "test_sv_member_a", "familyId": "test_sv_family_a", "userId": "test_sv_user_a", "role": "admin", "status": "active", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_sv_member_b", "familyId": "test_sv_family_a", "userId": "test_sv_user_b", "role": "member", "status": "active", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_sv_member_other", "familyId": "test_sv_family_b", "userId": "test_sv_other", "role": "admin", "status": "active", "createdAt": STAMP, "updatedAt": STAMP},
            ],
            "Baby": [
                {"id": "test_sv_baby_a", "familyId": "test_sv_family_a", "nickname": "test_sv_baby_a", "gender": "female", "birthDate": "2026-01-01", "createdAt": STAMP, "updatedAt": STAMP},
                {"id": "test_sv_baby_b", "familyId": "test_sv_family_b", "nickname": "test_sv_baby_b", "gender": "male", "birthDate": "2026-01-01", "createdAt": STAMP, "updatedAt": STAMP},
            ],
            "SupplementProduct": [{
                "id": "test_sv_product_d3", "familyId": "test_sv_family_a", "name": "test vitamin d3", "brand": "test brand",
                "dosageForm": "drops", "unitName": "滴", "defaultDose": 1.5, "nutrientsJson": {"vitaminD": {"amount": 400, "unit": "IU"}},
                "isActive": True, "isArchived": False, "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "SupplementSchedule": [{
                "id": "test_sv_schedule_d3", "babyId": "test_sv_baby_a", "productId": "test_sv_product_d3", "frequency": "daily",
                "customDaysJson": [], "targetDose": 1.5, "reminderTime": "09:30", "isActive": True, "startDate": "2026-01-02",
                "notes": "test schedule", "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "SupplementRecord": [{
                "id": "test_sv_record_d3", "babyId": "test_sv_baby_a", "recordedById": "test_sv_user_b", "productId": "test_sv_product_d3",
                "date": "2026-09-11", "time": "09:30", "dose": 1.5, "unitName": "滴", "clientId": "test_sv_client_d3",
                "source": "ui_manual", "sourceAgent": "test_agent", "notes": "test record", "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "Vaccine": [{
                "id": "test_sv_vaccine_hepb", "vaccineId": "test_sv_hepb", "name": "test hepatitis b", "shortName": "test hepB",
                "englishName": "test HepB", "programType": "national_immunization_program", "legacyLabel": "test national", "sexRestriction": "all",
                "chinaNational": True, "diseases": ["test disease"], "targetPopulation": "test infants", "policyEffectiveDate": "2025-01-01",
                "policyVersion": "test-policy-v1", "routineHealthyChildOption": True, "manualReviewRequired": False, "marketStatus": "marketed",
                "catchUpSupported": True, "catchUpRules": ["test rule"], "substitutionRules": [], "contraindications": ["test contraindication"],
                "precautions": [], "specialPopulations": [], "regionalOverrides": [], "regimenOptions": [], "sourceRefsJson": ["test_source_ref"],
                "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "VaccineDose": [{
                "id": "test_sv_dose_hepb_1", "vaccineId": "test_sv_hepb", "doseNumber": 1, "doseLabel": "test dose 1",
                "recommendedAgeMonths": 0, "minimumAgeDays": 0, "maximumAgeDays": 30, "route": "test route", "site": "test site",
                "doseVolumeMl": 0.5, "sourceRefsJson": ["test_source_ref"], "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "VaccineScheduleEntry": [{
                "id": "test_sv_entry_hepb_1", "vaccineId": "test_sv_hepb", "ageMonths": 0, "ageDays": 0, "ageLabel": "test birth",
                "doseNumber": 1, "priority": "routine", "isOptional": False, "action": "test action", "selectionGroup": "test group",
                "sourceRefsJson": ["test_source_ref"], "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "VaccineStrategyGroup": [{
                "id": "test_sv_strategy_group", "strategyId": "test_sv_strategy", "name": "test strategy", "scope": "test scope",
                "baseProgram": "test base", "optionsJson": [{"id": "test_option"}], "sourceRefsJson": ["test_source_ref"],
                "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "VaccineSelection": [{
                "id": "test_sv_selection", "babyId": "test_sv_baby_a", "vaccineId": "test_sv_hepb", "doseNumber": 1,
                "selected": True, "completed": False, "createdAt": STAMP, "updatedAt": STAMP,
            }],
            "VaccineRecord": [{
                "id": "test_sv_vaccine_record", "babyId": "test_sv_baby_a", "recordedById": "test_sv_user_b", "vaccineId": "test_sv_hepb",
                "name": "test hepatitis b", "dose": "test dose 1", "scheduledDate": "2026-09-11", "completedDate": "2026-09-11",
                "isCompleted": True, "clinic": "test clinic", "batchNumber": "test batch", "notes": "test vaccine record",
                "createdAt": STAMP, "updatedAt": STAMP,
            }],
        },
    }


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def static_archive() -> dict:
    data = copy.deepcopy(archive())
    for table in list(data["tables"]):
        if table not in M.STATIC_REFERENCE_TABLES:
            data["tables"][table] = []
    data["sourceId"] = "test_sv_static_reference_archive"
    return data


class SupplementVaccineMaterializerTests(unittest.TestCase):
    def test_maps_full_graph_with_exact_target_snapshots(self) -> None:
        data = archive()
        items = M.prepare_materialization(data, checksum(data))
        self.assertEqual(len(items), 9)
        self.assertEqual(
            [item["kind"] for item in items],
            ["vaccine", "vaccine_dose", "vaccine_schedule_entry", "vaccine_strategy_group", "supplement_product", "supplement_schedule", "supplement", "vaccine_selection", "vaccine_record"],
        )
        supplement = next(item for item in items if item["kind"] == "supplement")
        self.assertEqual(supplement["family_id"], "test_sv_family_a")
        self.assertEqual(supplement["columns"]["recorded_by_user_id"], "test_sv_user_b")
        self.assertEqual(supplement["columns"]["occurred_at"], "2026-09-11T01:30:00.000Z")
        self.assertEqual(len(supplement["target_hash"]), 64)
        vaccine = next(item for item in items if item["kind"] == "vaccine")
        self.assertEqual(vaccine["columns"]["vaccine_code"], "test_sv_hepb")
        record = next(item for item in items if item["kind"] == "vaccine_record")
        self.assertEqual(record["columns"]["vaccine_id"], "test_sv_vaccine_hepb")

        by_name = copy.deepcopy(data)
        by_name["tables"]["VaccineRecord"][0].pop("vaccineId")
        by_name_items = M.prepare_materialization(by_name, checksum(by_name))
        by_name_record = next(item for item in by_name_items if item["kind"] == "vaccine_record")
        self.assertEqual(by_name_record["columns"]["vaccine_id"], "test_sv_vaccine_hepb")

    def test_render_is_deterministic_atomic_and_hash_guarded(self) -> None:
        data = archive()
        digest = checksum(data)
        first = M.render_materialization(data, digest)
        second = M.render_materialization(copy.deepcopy(data), digest)
        self.assertEqual(first, second)
        for required in (
            "BEGIN;", "COMMIT;", "pg_advisory_xact_lock(724019236)", "supplement_products", "supplement_schedules",
            "vaccines", "vaccine_doses", "vaccine_schedule_entries", "vaccine_strategy_groups", "vaccine_selections",
            "source hash mismatch", "targetHashSha256", "targetSnapshot", "supplement-vaccine-v1", "timeline_entries",
            "source ID mismatch",
        ):
            self.assertIn(required, first)

    def test_static_reference_archive_registers_raw_rows_without_identity_batch(self) -> None:
        data = static_archive()
        digest = checksum(data)
        rendered = M.render_materialization(data, digest)
        self.assertIn("static_vaccine_reference_only", rendered)
        self.assertIn("INSERT INTO legacy_import.import_batches", rendered)
        self.assertIn("INSERT INTO legacy_import.import_rows", rendered)
        self.assertIn("metadata='", rendered)
        self.assertIn("mapping_version='identity-v1'", rendered)
        self.assertNotIn("INSERT INTO public.users", rendered)
        self.assertNotIn("INSERT INTO public.families", rendered)
        self.assertNotIn("INSERT INTO public.supplement_products", rendered)
        self.assertNotIn("INSERT INTO public.vaccine_selections", rendered)
        self.assertNotIn("INSERT INTO public.vaccine_records", rendered)
        self.assertNotIn("INSERT INTO public.timeline_entries", rendered)

        items = M.prepare_materialization(data, digest)
        self.assertEqual(
            [item["kind"] for item in items],
            ["vaccine", "vaccine_dose", "vaccine_schedule_entry", "vaccine_strategy_group"],
        )

    def test_static_reference_archive_rejects_any_non_static_source_rows(self) -> None:
        source = archive()
        for table in ("User", "Family", "FamilyMember", "Baby", "SupplementProduct", "SupplementSchedule", "SupplementRecord", "VaccineSelection", "VaccineRecord"):
            data = static_archive()
            data["tables"][table] = copy.deepcopy(source["tables"][table])
            with self.subTest(table=table):
                self.assertFalse(M._static_reference_archive(data))

        unknown = static_archive()
        unknown["tables"]["UnexpectedTenantTable"] = [{"id": "test_sv_forbidden_unknown"}]
        self.assertFalse(M._static_reference_archive(unknown))
        self.assertNotIn("static_vaccine_reference_only", M.render_materialization(unknown, checksum(unknown)))

    def test_static_reference_rows_cannot_carry_tenant_scope(self) -> None:
        data = static_archive()
        data["tables"]["Vaccine"][0]["familyId"] = "test_sv_forbidden_family"
        with self.assertRaisesRegex(ValueError, "cannot carry familyId"):
            M.render_materialization(data, checksum(data))

    def test_cross_tenant_actor_and_reference_are_rejected(self) -> None:
        data = archive()
        cross = copy.deepcopy(data)
        cross["tables"]["SupplementRecord"][0]["babyId"] = "test_sv_baby_b"
        with self.assertRaisesRegex(ValueError, "outside the baby family"):
            M.prepare_materialization(cross, checksum(cross))

        outsider = copy.deepcopy(data)
        outsider["tables"]["SupplementRecord"][0]["recordedById"] = "test_sv_other"
        with self.assertRaisesRegex(ValueError, "outside the baby family"):
            M.prepare_materialization(outsider, checksum(outsider))

        unresolved = copy.deepcopy(data)
        unresolved["tables"]["VaccineSelection"][0]["vaccineId"] = "test_sv_other_vaccine"
        with self.assertRaisesRegex(ValueError, "unresolved"):
            M.prepare_materialization(unresolved, checksum(unresolved))

        missing_product = copy.deepcopy(data)
        missing_product["tables"]["SupplementRecord"][0].pop("productId")
        with self.assertRaisesRegex(ValueError, "productId"):
            M.prepare_materialization(missing_product, checksum(missing_product))

        unsupported_source_ref = copy.deepcopy(data)
        unsupported_source_ref["tables"]["VaccineSourceRef"] = [{"id": "test_sv_source_ref"}]
        with self.assertRaisesRegex(ValueError, "canonical source-reference"):
            M.prepare_materialization(unsupported_source_ref, checksum(unsupported_source_ref))

        unsupported_rule = copy.deepcopy(data)
        unsupported_rule["tables"]["ScheduleEngineRule"] = [{"id": "test_sv_schedule_rule"}]
        with self.assertRaisesRegex(ValueError, "pinned canonical vaccine rules"):
            M.prepare_materialization(unsupported_rule, checksum(unsupported_rule))

    def test_malformed_numeric_json_and_tampered_source_never_render(self) -> None:
        bad_number = copy.deepcopy(archive())
        bad_number["tables"]["SupplementRecord"][0]["dose"] = float("nan")
        with self.assertRaisesRegex(ValueError, "finite number"):
            M.prepare_materialization(bad_number, checksum(bad_number))

        bad_json = copy.deepcopy(archive())
        bad_json["tables"]["Vaccine"][0]["diseases"] = "not-json"
        with self.assertRaisesRegex(ValueError, "not valid JSON"):
            M.prepare_materialization(bad_json, checksum(bad_json))

        changed = copy.deepcopy(archive())
        changed["tables"]["VaccineRecord"][0]["notes"] = "test tampered"
        self.assertNotEqual(checksum(archive()), checksum(changed))
        self.assertIn(checksum(changed), M.render_materialization(changed, checksum(changed)))

    def test_legacy_defaults_and_scheduled_only_vaccine_preserve_completion_state(self) -> None:
        data = archive()
        data["tables"]["SupplementRecord"][0].pop("source")
        data["tables"]["VaccineRecord"][0]["completedDate"] = None
        data["tables"]["VaccineRecord"][0]["isCompleted"] = False
        items = M.prepare_materialization(data, checksum(data))
        supplement = next(item for item in items if item["kind"] == "supplement")
        self.assertEqual(supplement["columns"]["source"], "ui_manual")
        vaccine = next(item for item in items if item["kind"] == "vaccine_record")
        self.assertEqual(vaccine["columns"]["administered_date"], "2026-09-11")
        self.assertIsNone(vaccine["columns"]["completed_date"])
        self.assertFalse(vaccine["columns"]["is_completed"])
        self.assertIsNone(vaccine["timeline_summary"])
        rendered = M.render_materialization(data, checksum(data))
        # Only the supplement and completed vaccine produce historical
        # timeline entries.  The pending row must remain visible through the
        # record graph without becoming a completed event.
        self.assertEqual(rendered.count("INSERT INTO public.timeline_entries"), 1)
        self.assertIn(
            'AND NOT EXISTS (SELECT 1 FROM public.timeline_entries e WHERE e."entity_id"',
            rendered,
        )

        contradictory = copy.deepcopy(data)
        contradictory["tables"]["VaccineRecord"][0]["isCompleted"] = True
        with self.assertRaisesRegex(ValueError, "requires completedDate"):
            M.prepare_materialization(contradictory, checksum(contradictory))

        reversed_dates = copy.deepcopy(archive())
        reversed_dates["tables"]["VaccineRecord"][0]["scheduledDate"] = "2026-09-12"
        reversed_dates["tables"]["VaccineRecord"][0]["completedDate"] = "2026-09-11"
        with self.assertRaisesRegex(ValueError, "precedes scheduledDate"):
            M.prepare_materialization(reversed_dates, checksum(reversed_dates))

    def test_target_decimal_precision_and_legacy_required_fields_fail_closed(self) -> None:
        too_precise = copy.deepcopy(archive())
        too_precise["tables"]["SupplementProduct"][0]["defaultDose"] = "1.234567"
        with self.assertRaisesRegex(ValueError, "numeric\(12,5\)"):
            M.prepare_materialization(too_precise, checksum(too_precise))

        missing_product_field = copy.deepcopy(archive())
        missing_product_field["tables"]["SupplementProduct"][0].pop("brand")
        with self.assertRaisesRegex(ValueError, "brand"):
            M.prepare_materialization(missing_product_field, checksum(missing_product_field))

        missing_vaccine_field = copy.deepcopy(archive())
        missing_vaccine_field["tables"]["Vaccine"][0].pop("shortName")
        with self.assertRaisesRegex(ValueError, "shortName"):
            M.prepare_materialization(missing_vaccine_field, checksum(missing_vaccine_field))

        missing_vaccine_id = copy.deepcopy(archive())
        missing_vaccine_id["tables"]["Vaccine"][0].pop("vaccineId")
        with self.assertRaisesRegex(ValueError, "vaccineId"):
            M.prepare_materialization(missing_vaccine_id, checksum(missing_vaccine_id))


if __name__ == "__main__":
    unittest.main()
