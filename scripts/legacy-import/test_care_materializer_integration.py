"""Owned PostgreSQL checks for the identity-v1 formula/care promotion slice.

This is intentionally a separate opt-in script.  It requires the managed
BOOT02 manifest, uses a unique test_ tenant, and cleans that tenant in a
finally block.  It does not adopt an existing PostgreSQL instance.
"""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import uuid
from decimal import Decimal
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


def load(name: str):
    path = Path(__file__).with_name(f"{name}.py")
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


identity = load("import_sql")
materializer = load("materialize_care")


def archive(prefix: str) -> dict:
    stamp = "2026-09-12T08:00:00+08:00"
    other_stamp = "2026-09-12T08:05:00+08:00"
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "capturedAt": stamp,
        "sourceId": "legacy_web",
        "sourceSha256": "source-snapshot",
        "excluded": [],
        "tables": {
            "User": [
                {"id": f"{prefix}_user", "username": f"{prefix}_user", "passwordHash": "$2b$10$" + "a" * 53, "displayName": f"{prefix}_user", "createdAt": stamp, "updatedAt": stamp},
                {"id": f"{prefix}_other_user", "username": f"{prefix}_other_user", "passwordHash": "$2b$10$" + "b" * 53, "displayName": f"{prefix}_other_user", "createdAt": other_stamp, "updatedAt": other_stamp},
            ],
            "Family": [
                {"id": f"{prefix}_family", "name": f"{prefix}_family", "createdAt": stamp, "updatedAt": stamp},
                {"id": f"{prefix}_other_family", "name": f"{prefix}_other_family", "createdAt": other_stamp, "updatedAt": other_stamp},
            ],
            "FamilyMember": [
                {"id": f"{prefix}_member", "familyId": f"{prefix}_family", "userId": f"{prefix}_user", "role": "admin", "createdAt": stamp, "updatedAt": stamp},
                {"id": f"{prefix}_other_member", "familyId": f"{prefix}_other_family", "userId": f"{prefix}_other_user", "role": "admin", "createdAt": other_stamp, "updatedAt": other_stamp},
            ],
            "Baby": [
                {"id": f"{prefix}_baby", "familyId": f"{prefix}_family", "nickname": f"{prefix}_baby", "gender": "female", "birthDate": "2026-01-01", "createdAt": stamp, "updatedAt": stamp},
                {"id": f"{prefix}_other_baby", "familyId": f"{prefix}_other_family", "nickname": f"{prefix}_other_baby", "gender": "male", "birthDate": "2026-01-02", "createdAt": other_stamp, "updatedAt": other_stamp},
            ],
            "FormulaProduct": [
                {
                    "id": f"{prefix}_formula", "familyId": f"{prefix}_family", "brand": "", "name": f"{prefix}_formula",
                    "stage": 1, "scoopWeightG": 4.3, "waterPerScoopMl": 30, "reconstitutionRatio": 0.1433,
                    "servingSizeUnit": "per_100g",
                    "nutrientsJson": "{\"protein\":{\"amount\":0.12345678901234567890,\"unit\":\"g\",\"source\":\"test_label\"}}",
                    "notes": "test_formula_notes", "isActive": 0, "isDefault": 1,
                    "createdAt": stamp, "updatedAt": stamp,
                },
                {
                    "id": f"{prefix}_other_formula", "familyId": f"{prefix}_other_family", "brand": "test_brand", "name": f"{prefix}_other_formula",
                    "stage": 2, "scoopWeightG": 4.1, "waterPerScoopMl": 29, "reconstitutionRatio": 0.1414,
                    "servingSizeUnit": "per_100ml",
                    "nutrientsJson": "{\"protein\":{\"amount\":1.25,\"unit\":\"g\"}}",
                    "notes": "other_formula_notes", "isActive": 1, "isDefault": 0,
                    "createdAt": other_stamp, "updatedAt": other_stamp,
                },
            ],
            "FeedingRecord": [{
                "id": f"{prefix}_feeding", "babyId": f"{prefix}_baby", "clientId": f"{prefix}_feed_client", "recordedById": f"{prefix}_user",
                "source": "ui_manual", "sourceAgent": "legacy-agent", "timestamp": "2026-09-12T08:30:00",
                "type": "formula", "amountMl": 90, "leftMinutes": None, "rightMinutes": None,
                # SQLite BOOLEAN columns are exported by sqlite3 as INTEGER 0/1.
                "spitUp": 0, "formulaProductId": f"{prefix}_formula", "notes": "test_feeding", "createdAt": stamp, "updatedAt": stamp,
            }],
            "SleepRecord": [{
                "id": f"{prefix}_sleep", "babyId": f"{prefix}_baby", "clientId": f"{prefix}_sleep_client", "recordedById": f"{prefix}_user",
                "source": "ui_manual", "sourceAgent": None, "startTime": "2026-09-12T10:00:00", "endTime": "2026-09-12T11:00:00",
                "type": "day", "nightWakingCount": 0, "notes": "test_sleep", "createdAt": stamp, "updatedAt": stamp,
            }],
            "DiaperRecord": [{
                "id": f"{prefix}_diaper", "babyId": f"{prefix}_baby", "clientId": f"{prefix}_diaper_client", "recordedById": f"{prefix}_user",
                "source": "ui_manual", "sourceAgent": None, "timestamp": "2026-09-12T12:00:00", "type": "both",
                "poopColor": "yellow", "poopConsistency": "paste", "notes": "test_diaper", "createdAt": stamp, "updatedAt": stamp,
            }],
        },
    }


def sql_literal(value):
    return identity.literal(value)


def source_rows_sql(data: dict, checksum: str) -> str:
    tables = data["tables"]
    now = sql_literal("2026-09-12T00:00:00Z")
    counts = {table: len(rows) for table, rows in tables.items()}
    parts = [
        f"INSERT INTO legacy_import.import_batches (batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) VALUES ({sql_literal(checksum)},'legacy_web','source-snapshot',{sql_literal(checksum)},'identity-v1',{sum(counts.values())},{sql_literal(json.dumps(counts, sort_keys=True))}::jsonb,'{{}}'::jsonb);",
    ]
    for user in tables["User"]:
        parts.append(
            f"INSERT INTO public.users (id,username,password_hash,password_hash_algorithm,password_hash_needs_rehash,display_name,timezone,created_at,updated_at) VALUES ({sql_literal(user['id'])},{sql_literal(user['username'])},{sql_literal(user['passwordHash'])},'bcrypt',true,{sql_literal(user['displayName'])},'Asia/Shanghai',{now},{now});"
        )
    for family in tables["Family"]:
        parts.append(
            f"INSERT INTO public.families (id,name,timezone,created_at,updated_at) VALUES ({sql_literal(family['id'])},{sql_literal(family['name'])},'Asia/Shanghai',{now},{now});"
        )
    for member in tables["FamilyMember"]:
        parts.append(
            f"INSERT INTO public.family_members (id,family_id,user_id,role,relation,status,created_at,updated_at) VALUES ({sql_literal(member['id'])},{sql_literal(member['familyId'])},{sql_literal(member['userId'])},'admin','parent','active',{now},{now});"
        )
    for baby in tables["Baby"]:
        parts.append(
            f"INSERT INTO public.babies (id,family_id,nickname,birth_date,gender,created_at,updated_at) VALUES ({sql_literal(baby['id'])},{sql_literal(baby['familyId'])},{sql_literal(baby['nickname'])},{sql_literal(baby['birthDate'])},{sql_literal(baby['gender'])},{now},{now});"
        )
        member = next(item for item in tables["FamilyMember"] if item["familyId"] == baby["familyId"])
        parts.append(
            f"INSERT INTO public.baby_members (id,family_id,baby_id,user_id,role,status,created_at,updated_at) VALUES ({sql_literal(member['id'] + '_' + baby['id'])},{sql_literal(member['familyId'])},{sql_literal(baby['id'])},{sql_literal(member['userId'])},'admin','active',{now},{now});"
        )
    for table, rows in tables.items():
        if table in ("User", "Family", "FamilyMember", "Baby"):
            continue
        for row in tables[table]:
            payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            payload_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
            parts.append(
                "INSERT INTO legacy_import.import_rows (batch_id,source_table,source_id,family_id,baby_id,payload,payload_hash) "
                f"VALUES ({sql_literal(checksum)},{sql_literal(table)},{sql_literal(row['id'])},{sql_literal(row.get('familyId'))},{sql_literal(row.get('babyId'))},{sql_literal(payload)}::jsonb,{sql_literal(payload_hash)});"
            )
    return "\n".join(parts)


def care_batch_sql(data: dict, checksum: str) -> str:
    """Seed only a follow-up care batch against already imported identities."""

    rows = [(table, row) for table in materializer.CARE_TABLES for row in data["tables"].get(table, [])]
    parts = [
        f"INSERT INTO legacy_import.import_batches (batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) VALUES ({sql_literal(checksum)},'legacy_web','source-snapshot',{sql_literal(checksum)},'identity-v1',{len(rows)},'{{}}'::jsonb,'{{}}'::jsonb);"
    ]
    for table, row in rows:
        payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        payload_hash = hashlib.sha256(payload.encode("utf-8")).hexdigest()
        parts.append(
            "INSERT INTO legacy_import.import_rows (batch_id,source_table,source_id,family_id,baby_id,payload,payload_hash) "
            f"VALUES ({sql_literal(checksum)},{sql_literal(table)},{sql_literal(row['id'])},{sql_literal(row.get('familyId'))},{sql_literal(row.get('babyId'))},{sql_literal(payload)}::jsonb,{sql_literal(payload_hash)});"
        )
    return "\n".join(parts)


def main() -> None:
    manifest_path = Path(os.environ["BOOT02_RUN_FILE"]).resolve()
    if manifest_path.parent.parent != Path(tempfile.gettempdir()).resolve():
        raise RuntimeError("refuses a non-managed manifest")
    if not manifest_path.parent.name.startswith("growdesk-integration-") or manifest_path.stat().st_mode & 0o077:
        raise RuntimeError("managed manifest must be private")
    run = json.loads(manifest_path.read_text())
    if run.get("database") != "test_growdesk_integration" or run.get("user") != "test_runner":
        raise RuntimeError("refuses a non-test database")
    psql = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@18/bin")) / "psql"
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env["PGPASSWORD"] = run["password"]
    cmd = [str(psql), "-X", "-h", "127.0.0.1", "-p", str(run["pgPort"]), "-U", run["user"], "-d", run["database"], "-v", "ON_ERROR_STOP=1", "-At"]

    def execute(sql: str, success: bool = True) -> str:
        result = subprocess.run(cmd, input=sql, capture_output=True, text=True, env=env, cwd=ROOT)
        expected = result.returncode == 0
        if expected != success:
            raise AssertionError(result.stderr.replace(run["password"], "[redacted]"))
        return result.stdout.strip()

    execute("SELECT current_user || '|' || current_setting('cluster_name')")
    prefix = "test_care_materializer_" + uuid.uuid4().hex[:10]
    data = archive(prefix)
    checksum = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    ids = {table: data["tables"][table][0]["id"] for table in materializer.CARE_TABLES}
    formula_ids = {row["id"] for row in data["tables"]["FormulaProduct"]}
    formula_id = f"{prefix}_formula"

    # This follow-up batch has one valid row followed by a row referencing the
    # other family's product.  The first insert must be rolled back with the
    # second row's family-boundary failure.
    bad = copy.deepcopy(data)
    bad["tables"]["FormulaProduct"] = []
    bad["tables"]["SleepRecord"] = []
    bad["tables"]["DiaperRecord"] = []
    valid_follow_up = copy.deepcopy(data["tables"]["FeedingRecord"][0])
    valid_follow_up.update({"id": f"{prefix}_follow_up", "clientId": f"{prefix}_follow_up_client"})
    invalid_cross_family = copy.deepcopy(valid_follow_up)
    invalid_cross_family.update({"id": f"{prefix}_cross_family", "clientId": f"{prefix}_cross_family_client", "formulaProductId": f"{prefix}_other_formula"})
    bad["tables"]["FeedingRecord"] = [valid_follow_up, invalid_cross_family]
    bad_checksum = hashlib.sha256(json.dumps(bad, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
    bad_ids = [valid_follow_up["id"], invalid_cross_family["id"]]
    all_care_ids = [*ids.values(), *bad_ids]
    identity_ids = {
        "users": [row["id"] for row in data["tables"]["User"]],
        "families": [row["id"] for row in data["tables"]["Family"]],
        "babies": [row["id"] for row in data["tables"]["Baby"]],
    }
    cleanup = f"""
DELETE FROM public.timeline_entries WHERE entity_id IN ({','.join(sql_literal(value) for value in all_care_ids)});
DELETE FROM public.legacy_idempotency_mappings WHERE source_batch_id IN ({sql_literal(checksum)},{sql_literal(bad_checksum)});
DELETE FROM public.feeding_records WHERE id={sql_literal(ids['FeedingRecord'])};
DELETE FROM public.feeding_records WHERE id IN ({','.join(sql_literal(value) for value in bad_ids)});
DELETE FROM public.sleep_records WHERE id={sql_literal(ids['SleepRecord'])};
DELETE FROM public.diaper_records WHERE id={sql_literal(ids['DiaperRecord'])};
DELETE FROM public.formula_products WHERE id IN ({','.join(sql_literal(value) for value in formula_ids)});
DELETE FROM legacy_import.import_rows WHERE batch_id IN ({sql_literal(checksum)},{sql_literal(bad_checksum)});
DELETE FROM legacy_import.import_batches WHERE batch_id IN ({sql_literal(checksum)},{sql_literal(bad_checksum)});
DELETE FROM public.baby_members WHERE baby_id IN ({','.join(sql_literal(value) for value in identity_ids['babies'])});
DELETE FROM public.family_members WHERE family_id IN ({','.join(sql_literal(value) for value in identity_ids['families'])});
DELETE FROM public.babies WHERE id IN ({','.join(sql_literal(value) for value in identity_ids['babies'])});
DELETE FROM public.families WHERE id IN ({','.join(sql_literal(value) for value in identity_ids['families'])});
DELETE FROM public.users WHERE id IN ({','.join(sql_literal(value) for value in identity_ids['users'])});
"""
    try:
        execute(source_rows_sql(data, checksum))
        promotion_sql = materializer.render_materialization(data, checksum)
        execute(promotion_sql)
        execute(promotion_sql)
        assert execute("SELECT count(*) FROM public.feeding_records WHERE id=" + sql_literal(ids["FeedingRecord"])) == "1"
        assert execute("SELECT count(*) FROM public.sleep_records WHERE id=" + sql_literal(ids["SleepRecord"])) == "1"
        assert execute("SELECT count(*) FROM public.diaper_records WHERE id=" + sql_literal(ids["DiaperRecord"])) == "1"
        assert execute("SELECT count(*) FROM public.formula_products WHERE id IN (" + ",".join(sql_literal(value) for value in formula_ids) + ")") == "2"
        assert execute("SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id=" + sql_literal(checksum)) == "5"
        row = execute("SELECT family_id || '|' || baby_id || '|' || feeding_type || '|' || (occurred_at AT TIME ZONE 'UTC')::text || '|' || recorded_by_user_id || '|' || legacy_client_id || '|' || formula_product_id || '|' || (legacy_metadata->>'sourceId') FROM public.feeding_records WHERE id=" + sql_literal(ids["FeedingRecord"]))
        assert row.startswith(f"{prefix}_family|{prefix}_baby|formula|2026-09-12 00:30:00|{prefix}_user|{prefix}_feed_client|{formula_id}|{ids['FeedingRecord']}"), row
        amount = execute("SELECT nutrients_json->'protein'->>'amount' FROM public.formula_products WHERE id=" + sql_literal(formula_id))
        assert Decimal(amount) == Decimal("0.12345678901234567890"), amount
        assert execute("SELECT jsonb_typeof(nutrients_json->'protein') FROM public.formula_products WHERE id=" + sql_literal(formula_id)) == "object"

        execute("UPDATE public.formula_products SET notes='test_formula_tampered' WHERE id=" + sql_literal(formula_id) + ";")
        execute(promotion_sql, success=False)
        assert execute("SELECT notes FROM public.formula_products WHERE id=" + sql_literal(formula_id)) == "test_formula_tampered"
        execute("UPDATE public.formula_products SET notes='test_formula_notes' WHERE id=" + sql_literal(formula_id) + ";")

        formula_row = data["tables"]["FormulaProduct"][0]
        formula_hash = hashlib.sha256(json.dumps(formula_row, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()
        execute("UPDATE legacy_import.import_rows SET payload_hash=" + sql_literal("0" * 64) + " WHERE batch_id=" + sql_literal(checksum) + " AND source_table='FormulaProduct' AND source_id=" + sql_literal(formula_id) + ";")
        execute(promotion_sql, success=False)
        assert execute("SELECT count(*) FROM public.formula_products WHERE id=" + sql_literal(formula_id)) == "1"
        execute("UPDATE legacy_import.import_rows SET payload_hash=" + sql_literal(formula_hash) + " WHERE batch_id=" + sql_literal(checksum) + " AND source_table='FormulaProduct' AND source_id=" + sql_literal(formula_id) + ";")
        execute(promotion_sql)

        execute(care_batch_sql(bad, bad_checksum))
        bad_sql = materializer.render_materialization(bad, bad_checksum)
        execute(bad_sql, success=False)
        assert execute("SELECT count(*) FROM public.feeding_records WHERE id=" + sql_literal(valid_follow_up["id"])) == "0"
        assert execute("SELECT count(*) FROM public.feeding_records WHERE id=" + sql_literal(ids["FeedingRecord"])) == "1"
        assert execute("SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id=" + sql_literal(checksum)) == "5"
        print("Care materializer owned PG PASS: formula JSON precision, same-family reference, replay no-op, source/target tamper detection, cross-family rollback")
    finally:
        execute(cleanup)


if __name__ == "__main__":
    main()
