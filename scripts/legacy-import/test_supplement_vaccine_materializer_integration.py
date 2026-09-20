"""Owned PostgreSQL verification for supplement/vaccine archive promotion."""

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


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


def load(name: str):
    path = HERE / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"{name}_sv_integration", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


identity = load("import_sql")
materializer = load("materialize_supplement_vaccine")
pure = load("test_supplement_vaccine_materializer")


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _sql(value):
    return identity.literal(value)


def _payload(row: dict) -> tuple[str, str]:
    encoded = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return encoded, hashlib.sha256(encoded.encode()).hexdigest()


def seed_sql(data: dict, batch_id: str, *, tamper_source_id: str | None = None) -> str:
    tables = data["tables"]
    counts = {table: len(rows) for table, rows in tables.items()}
    all_rows = [row for rows in tables.values() for row in rows]
    stamp = _sql("2026-09-12T00:00:00Z")
    statements: list[str] = []
    for row in tables["User"]:
        statements.append(
            "INSERT INTO public.users(id,username,password_hash,password_hash_algorithm,password_hash_needs_rehash,display_name,timezone,created_at,updated_at) VALUES ("
            + ",".join([_sql(row["id"]), _sql(row["username"]), _sql(row["passwordHash"]), _sql("bcrypt"), "TRUE", _sql(row["displayName"]), _sql("Asia/Shanghai"), stamp, stamp]) + ");"
        )
    for row in tables["Family"]:
        statements.append(f"INSERT INTO public.families(id,name,timezone,created_at,updated_at) VALUES ({_sql(row['id'])},{_sql(row['name'])},'Asia/Shanghai',{stamp},{stamp});")
    for row in tables["Baby"]:
        statements.append(f"INSERT INTO public.babies(id,family_id,nickname,birth_date,gender,created_at,updated_at) VALUES ({_sql(row['id'])},{_sql(row['familyId'])},{_sql(row['nickname'])},{_sql(row['birthDate'])},{_sql(row['gender'])},{stamp},{stamp});")
    for row in tables["FamilyMember"]:
        statements.append(
            f"INSERT INTO public.family_members(id,family_id,user_id,role,relation,status,created_at,updated_at) VALUES ({_sql(row['id'])},{_sql(row['familyId'])},{_sql(row['userId'])},{_sql(row.get('role','member'))},'parent','active',{stamp},{stamp});"
        )
    for baby in tables["Baby"]:
        members = [row for row in tables["FamilyMember"] if row["familyId"] == baby["familyId"]]
        for member in members:
            statements.append(
                f"INSERT INTO public.baby_members(id,family_id,baby_id,user_id,role,status,created_at,updated_at) VALUES ({_sql(member['id'] + '_' + baby['id'])},{_sql(baby['familyId'])},{_sql(baby['id'])},{_sql(member['userId'])},{_sql(member.get('role','member'))},'active',{stamp},{stamp});"
            )
    for row in tables["User"]:
        statements.append(f"INSERT INTO public.user_sync_states(user_id,epoch,created_at,updated_at) VALUES ({_sql(row['id'])},{_sql(row['id'] + '_epoch')},{stamp},{stamp});")
    for row in tables["Family"]:
        statements.append(f"INSERT INTO public.family_sync_states(family_id,epoch,created_at,updated_at) VALUES ({_sql(row['id'])},{_sql(row['id'] + '_epoch')},{stamp},{stamp});")
    statements.append(
        "INSERT INTO legacy_import.import_batches(batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) VALUES ("
        + ",".join([_sql(batch_id), _sql("test_supplement_vaccine"), _sql("b" * 64), _sql(batch_id), _sql("identity-v1"), str(len(all_rows)), _sql(json.dumps(counts, sort_keys=True, separators=(",", ":"))) + "::jsonb", _sql(json.dumps({"historyState": "preserved_not_business_tables"}))])
        + ");"
    )
    for table, rows in tables.items():
        for row in rows:
            payload, payload_hash = _payload(row)
            if row["id"] == tamper_source_id:
                payload_hash = "f" * 64
            statements.append(
                "INSERT INTO legacy_import.import_rows(batch_id,source_table,source_id,user_id,family_id,baby_id,payload,payload_hash,captured_at) VALUES ("
                + ",".join([_sql(batch_id), _sql(table), _sql(row["id"]), _sql(row.get("userId")), _sql(row.get("familyId")), _sql(row.get("babyId", row.get("id") if table == "Baby" else None)), _sql(payload) + "::jsonb", _sql(payload_hash), stamp])
                + ");"
            )
    return "\n".join(statements)


def rename_archive(data: dict, prefix: str) -> dict:
    output = copy.deepcopy(data)
    mapping: dict[str, str] = {}
    for rows in output["tables"].values():
        for row in rows:
            if isinstance(row, dict) and isinstance(row.get("id"), str):
                mapping[row["id"]] = prefix + row["id"]
    mapping["test_sv_hepb"] = prefix + "test_sv_hepb"
    mapping["test_sv_strategy"] = prefix + "test_sv_strategy"

    def replace(value):
        if isinstance(value, dict):
            return {key: replace(item) for key, item in value.items()}
        if isinstance(value, list):
            return [replace(item) for item in value]
        return mapping.get(value, value)

    output["tables"] = replace(output["tables"])
    output["sourceId"] = prefix + "archive"
    return output


def main() -> None:
    manifest_path = os.environ.get("BOOT02_RUN_FILE")
    if not manifest_path:
        raise RuntimeError("Supplement/vaccine integration requires the managed owned PostgreSQL runner")
    manifest = Path(manifest_path).resolve()
    if manifest.parent.parent != Path(tempfile.gettempdir()).resolve() or not manifest.parent.name.startswith("growdesk-integration-") or manifest.stat().st_mode & 0o077:
        raise RuntimeError("Manifest is outside the private integration run")
    run = json.loads(manifest.read_text())
    if run.get("database") != "test_growdesk_integration" or run.get("user") != "test_runner":
        raise RuntimeError("Refusing a non-test database manifest")
    binary = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@18/bin")) / "psql"
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env["PGPASSWORD"] = run["password"]
    command = [str(binary), "-X", "-h", "127.0.0.1", "-p", str(run["pgPort"]), "-U", run["user"], "-d", run["database"], "-v", "ON_ERROR_STOP=1", "-At"]

    def execute(sql: str, *, success: bool = True) -> str:
        result = subprocess.run(command, input=sql, capture_output=True, text=True, env=env, cwd=ROOT)
        if (result.returncode == 0) != success:
            raise AssertionError(result.stderr.replace(run["password"], "[redacted]"))
        return result.stdout.strip()

    prefix = "test_sv_integration_" + uuid.uuid4().hex[:8]
    data = pure.archive()
    data = rename_archive(data, prefix)
    batch_id = checksum(data)
    scheduled = rename_archive(pure.archive(), prefix + "scheduled_")
    scheduled["tables"]["VaccineRecord"][0]["completedDate"] = None
    scheduled["tables"]["VaccineRecord"][0]["isCompleted"] = False
    scheduled_batch = checksum(scheduled)
    atomic = rename_archive(pure.archive(), prefix + "atomic_")
    second = copy.deepcopy(atomic["tables"]["SupplementRecord"][0])
    second["id"] = prefix + "atomic_record_2"
    second["clientId"] = prefix + "atomic_client_2"
    atomic["tables"]["SupplementRecord"].append(second)
    atomic_batch = checksum(atomic)
    cleanup_batches = [batch_id, scheduled_batch, atomic_batch]
    try:
        execute("BEGIN;\n" + seed_sql(data, batch_id) + "\nCOMMIT;")
        output = execute(materializer.render_materialization(data, batch_id))
        receipt = json.loads(output.splitlines()[-1])
        assert receipt["targetCount"] == 9, receipt
        assert execute(f"SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={_sql(batch_id)}") == "9"
        assert execute(f"SELECT count(*) FROM public.supplement_products WHERE id={_sql(prefix + 'test_sv_product_d3')}") == "1"
        assert execute(f"SELECT count(*) FROM public.supplement_schedules WHERE id={_sql(prefix + 'test_sv_schedule_d3')}") == "1"
        assert execute(f"SELECT count(*) FROM public.supplement_records WHERE id={_sql(prefix + 'test_sv_record_d3')}") == "1"
        assert execute(f"SELECT count(*) FROM public.vaccines WHERE id={_sql(prefix + 'test_sv_vaccine_hepb')}") == "1"
        assert execute(f"SELECT count(*) FROM public.vaccine_doses WHERE id={_sql(prefix + 'test_sv_dose_hepb_1')}") == "1"
        assert execute(f"SELECT count(*) FROM public.vaccine_schedule_entries WHERE id={_sql(prefix + 'test_sv_entry_hepb_1')}") == "1"
        assert execute(f"SELECT count(*) FROM public.vaccine_strategy_groups WHERE id={_sql(prefix + 'test_sv_strategy_group')}") == "1"
        assert execute(f"SELECT count(*) FROM public.vaccine_selections WHERE id={_sql(prefix + 'test_sv_selection')}") == "1"
        assert execute(f"SELECT count(*) FROM public.vaccine_records WHERE id={_sql(prefix + 'test_sv_vaccine_record')}") == "1"
        assert execute(f"SELECT count(*) FROM public.timeline_entries WHERE entity_id IN ({_sql(prefix + 'test_sv_record_d3')},{_sql(prefix + 'test_sv_vaccine_record')})") == "2"
        assert execute(f"SELECT length(metadata->>'targetHashSha256') || '|' || (metadata->'targetSnapshot'->>'legacy_dose') FROM public.legacy_idempotency_mappings WHERE source_batch_id={_sql(batch_id)} AND target_entity_type='vaccine_record'") == "64|test dose 1"

        # A scheduled-only legacy row remains pending: the required target
        # ordering date is retained, but completion is never fabricated.
        execute("BEGIN;\n" + seed_sql(scheduled, scheduled_batch) + "\nCOMMIT;")
        execute(materializer.render_materialization(scheduled, scheduled_batch))
        scheduled_record_id = prefix + "scheduled_test_sv_vaccine_record"
        assert execute(f"SELECT administered_date::text || '|' || COALESCE(completed_date::text, '') || '|' || is_completed::text FROM public.vaccine_records WHERE id={_sql(scheduled_record_id)}") == "2026-09-11||false"
        assert execute(f"SELECT count(*) FROM public.timeline_entries WHERE entity_id={_sql(scheduled_record_id)}") == "0"
        execute(materializer.render_materialization(scheduled, scheduled_batch))

        # Existing canonical rows predate the source column. An insert that
        # omits it must use the neutral care-record default, not legacy_web.
        default_source_id = prefix + "default_source"
        execute(
            f"INSERT INTO public.supplement_records(id,family_id,baby_id,supplement_name,occurred_at) VALUES ({_sql(default_source_id)},{_sql(prefix + 'test_sv_family_a')},{_sql(prefix + 'test_sv_baby_a')},'test_default_source','2026-09-11T01:30:00Z');"
        )
        assert execute(f"SELECT source FROM public.supplement_records WHERE id={_sql(default_source_id)}") == "manual"

        # Exact replay is a no-op and still checks the target snapshot and
        # source hash.  A changed target must fail closed.
        execute(materializer.render_materialization(data, batch_id))
        assert execute(f"SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={_sql(batch_id)}") == "9"
        execute(f"UPDATE public.supplement_records SET notes='test_tampered_target' WHERE id={_sql(prefix + 'test_sv_record_d3')}")
        execute(materializer.render_materialization(data, batch_id), success=False)
        execute(f"UPDATE public.supplement_records SET notes='test record' WHERE id={_sql(prefix + 'test_sv_record_d3')}")

        # A later bad source row is rejected before any row from that batch is
        # committed; this proves the all-or-nothing transaction boundary.
        execute("BEGIN;\n" + seed_sql(atomic, atomic_batch, tamper_source_id=prefix + "atomic_record_2") + "\nCOMMIT;")
        execute(materializer.render_materialization(atomic, atomic_batch), success=False)
        assert execute(f"SELECT count(*) FROM public.supplement_records WHERE id LIKE {_sql(prefix + 'atomic%')}") == "0"
        assert execute(f"SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={_sql(atomic_batch)}") == "0"
        print("Owned PostgreSQL supplement/vaccine materializer PASS: full graph, source/target hashes, scope, replay, tamper rejection, and atomic rollback")
    finally:
        batch_literals = ",".join(_sql(value) for value in cleanup_batches)
        like = _sql(prefix + "%")
        execute(
            f"DELETE FROM public.timeline_entries WHERE entity_id LIKE {like};\n"
            f"DELETE FROM public.legacy_idempotency_mappings WHERE source_batch_id IN ({batch_literals});\n"
            f"DELETE FROM public.vaccine_records WHERE id LIKE {like};\n"
            f"DELETE FROM public.supplement_records WHERE id LIKE {like};\n"
            f"DELETE FROM public.vaccine_selections WHERE id LIKE {like};\n"
            f"DELETE FROM public.supplement_schedules WHERE id LIKE {like};\n"
            f"DELETE FROM public.vaccine_doses WHERE id LIKE {like};\n"
            f"DELETE FROM public.vaccine_schedule_entries WHERE id LIKE {like};\n"
            f"DELETE FROM public.vaccine_strategy_groups WHERE id LIKE {like};\n"
            f"DELETE FROM public.vaccines WHERE id LIKE {like};\n"
            f"DELETE FROM public.supplement_products WHERE id LIKE {like};\n"
            f"DELETE FROM legacy_import.import_rows WHERE batch_id IN ({batch_literals});\n"
            f"DELETE FROM legacy_import.import_batches WHERE batch_id IN ({batch_literals});\n"
            f"DELETE FROM public.families WHERE id LIKE {like};\n"
            f"DELETE FROM public.users WHERE id LIKE {like};"
        )


if __name__ == "__main__":
    main()
