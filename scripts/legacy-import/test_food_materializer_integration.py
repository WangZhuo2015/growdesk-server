"""Owned PostgreSQL checks for the legacy food promotion slice."""

from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
import subprocess
import tempfile
import uuid
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
materializer = load("materialize_food")
pure = load("test_food_materializer")


def sql_literal(value):
    return identity.literal(value)


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def source_rows_sql(data: dict, batch_id: str, *, identity_rows: bool = False) -> str:
    tables = data["tables"]
    counts = {table: len(rows) for table, rows in tables.items()}
    parts = [
        "INSERT INTO legacy_import.import_batches (batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) "
        f"VALUES ({sql_literal(batch_id)},'legacy_web','source-snapshot',{sql_literal(batch_id)},'identity-v1',{sum(counts.values())},{sql_literal(json.dumps(counts, sort_keys=True))}::jsonb,'{{}}'::jsonb);"
    ]
    now = sql_literal("2026-09-12T00:00:00Z")
    if identity_rows:
        for row in tables["User"]:
            parts.append(
                "INSERT INTO public.users (id,username,password_hash,password_hash_algorithm,password_hash_needs_rehash,display_name,timezone,created_at,updated_at) "
                f"VALUES ({sql_literal(row['id'])},{sql_literal(row['username'])},{sql_literal(row['passwordHash'])},'bcrypt',true,{sql_literal(row['displayName'])},'Asia/Shanghai',{now},{now});"
            )
        for row in tables["Family"]:
            parts.append(
                f"INSERT INTO public.families (id,name,timezone,created_at,updated_at) VALUES ({sql_literal(row['id'])},{sql_literal(row['name'])},'Asia/Shanghai',{now},{now});"
            )
        for row in tables["FamilyMember"]:
            parts.append(
                f"INSERT INTO public.family_members (id,family_id,user_id,role,relation,status,created_at,updated_at) VALUES ({sql_literal(row['id'])},{sql_literal(row['familyId'])},{sql_literal(row['userId'])},'admin','parent','active',{now},{now});"
            )
        for row in tables["Baby"]:
            parts.append(
                f"INSERT INTO public.babies (id,family_id,nickname,birth_date,gender,created_at,updated_at) VALUES ({sql_literal(row['id'])},{sql_literal(row['familyId'])},{sql_literal(row['nickname'])},{sql_literal(row['birthDate'])},{sql_literal(row['gender'])},{now},{now});"
            )
            member = next(item for item in tables["FamilyMember"] if item["familyId"] == row["familyId"])
            parts.append(
                f"INSERT INTO public.baby_members (id,family_id,baby_id,user_id,role,status,created_at,updated_at) VALUES ({sql_literal(member['id'] + '_' + row['id'])},{sql_literal(row['familyId'])},{sql_literal(row['id'])},{sql_literal(member['userId'])},'admin','active',{now},{now});"
            )
    for table, rows in tables.items():
        if table in {"User", "Family", "FamilyMember", "Baby"}:
            continue
        for row in rows:
            payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            payload_hash = hashlib.sha256(payload.encode()).hexdigest()
            parts.append(
                "INSERT INTO legacy_import.import_rows (batch_id,source_table,source_id,family_id,baby_id,payload,payload_hash) "
                f"VALUES ({sql_literal(batch_id)},{sql_literal(table)},{sql_literal(row['id'])},{sql_literal(row.get('familyId'))},{sql_literal(row.get('babyId'))},{sql_literal(payload)}::jsonb,{sql_literal(payload_hash)});"
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
    command = [str(psql), "-X", "-h", "127.0.0.1", "-p", str(run["pgPort"]), "-U", run["user"], "-d", run["database"], "-v", "ON_ERROR_STOP=1", "-At"]

    def execute(sql: str, success: bool = True) -> str:
        result = subprocess.run(command, input=sql, capture_output=True, text=True, env=env, cwd=ROOT)
        if (result.returncode == 0) != success:
            raise AssertionError(result.stderr.replace(run["password"], "[redacted]"))
        return result.stdout.strip()

    execute("SELECT current_user || '|' || current_setting('cluster_name')")
    prefix = "test_food_materializer_" + uuid.uuid4().hex[:10]
    data = pure.archive(prefix)
    batch_id = checksum(data)
    cleanup = []
    try:
        execute(source_rows_sql(data, batch_id, identity_rows=True))
        execute(materializer.render_materialization(data, batch_id))
        counts = execute(
            f"SELECT (SELECT count(*) FROM public.food_library_items WHERE id IN ('food_egg',{sql_literal(prefix + '_custom_pk')})) || '|' || "
            f"(SELECT count(*) FROM public.food_records WHERE id={sql_literal(prefix + '_log')}) || '|' || "
            f"(SELECT count(*) FROM public.family_food_statuses WHERE id={sql_literal(prefix + '_status')}) || '|' || "
            f"(SELECT count(*) FROM public.timeline_entries WHERE entity_id={sql_literal(prefix + '_log')}) || '|' || "
            f"(SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={sql_literal(batch_id)})"
        )
        assert counts == "2|1|1|1|4", counts
        assert execute(f"SELECT source,source_agent,recorded_by_user_id,legacy_client_id FROM public.food_records WHERE id={sql_literal(prefix + '_log')}") == "ui_manual|legacy-test|" + prefix + "_user|" + prefix + "_log_client"
        # The static food catalogue already exists in a fresh target. Replaying
        # the same source hash must reconcile it without a duplicate row.
        execute(materializer.render_materialization(data, batch_id))
        assert execute(f"SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={sql_literal(batch_id)}") == "4"

        follow_up = copy.deepcopy(data)
        follow_up["tables"]["FoodItem"] = []
        follow_up["tables"]["FamilyFoodStatus"] = []
        valid = copy.deepcopy(data["tables"]["FoodLogRecord"][0])
        valid["id"] = prefix + "_valid_follow_up"
        valid["clientId"] = prefix + "_valid_follow_up_client"
        invalid = copy.deepcopy(valid)
        invalid["id"] = prefix + "_invalid_follow_up"
        invalid["clientId"] = prefix + "_invalid_follow_up_client"
        follow_up["tables"]["FoodLogRecord"] = [valid, invalid]
        follow_up_id = checksum(follow_up)
        execute(source_rows_sql(follow_up, follow_up_id))
        execute(
            f"UPDATE legacy_import.import_rows SET payload_hash={sql_literal('0' * 64)} WHERE batch_id={sql_literal(follow_up_id)} AND source_table='FoodLogRecord' AND source_id={sql_literal(invalid['id'])}"
        )
        execute(materializer.render_materialization(follow_up, follow_up_id), success=False)
        # The first follow-up row was rendered before the tampered second row;
        # its absence proves the promotion transaction rolled back atomically.
        assert execute(f"SELECT count(*) FROM public.food_records WHERE id={sql_literal(valid['id'])}") == "0"
        cleanup.extend([batch_id, follow_up_id])
    finally:
        batch_ids = ",".join(sql_literal(value) for value in cleanup or [batch_id])
        execute(
            f"DELETE FROM public.timeline_entries WHERE entity_id LIKE {sql_literal(prefix + '%')};\n"
            f"DELETE FROM public.legacy_idempotency_mappings WHERE source_batch_id IN ({batch_ids});\n"
            f"DELETE FROM public.food_records WHERE id LIKE {sql_literal(prefix + '%')};\n"
            f"DELETE FROM public.family_food_statuses WHERE id LIKE {sql_literal(prefix + '%')};\n"
            f"DELETE FROM public.food_library_items WHERE id LIKE {sql_literal(prefix + '%')};\n"
            f"DELETE FROM legacy_import.import_rows WHERE batch_id IN ({batch_ids});\n"
            f"DELETE FROM legacy_import.import_batches WHERE batch_id IN ({batch_ids});\n"
            f"DELETE FROM public.families WHERE id={sql_literal(prefix + '_family')};\n"
            f"DELETE FROM public.users WHERE id={sql_literal(prefix + '_user')};"
        )
    print("Owned PostgreSQL legacy food materializer PASS: mapping, static reconciliation, replay, metadata, timeline, and atomic rollback")


if __name__ == "__main__":
    main()
