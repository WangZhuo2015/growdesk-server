"""Owned PostgreSQL replay/tamper checks for RecordSnapshot promotion."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[2]


def load_module(name: str, filename: str):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


materializer = load_module("materialize_record_snapshots_integration", "materialize_record_snapshots.py")
fixtures = load_module("record_snapshot_fixture", "test_record_snapshot_materializer.py")
identity = load_module("legacy_identity_sql_record_snapshots", "import_sql.py")


def sql(value):
    return identity.literal(value)


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def source_sql(data: dict, batch_id: str) -> str:
    tables = data["tables"]
    now = sql("2026-09-12T00:00:00Z")
    counts = {table: len(rows) for table, rows in tables.items()}
    parts = [
        "INSERT INTO legacy_import.import_batches (batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) "
        f"VALUES ({sql(batch_id)},{sql(data['sourceId'])},{sql(data['sourceSha256'])},{sql(batch_id)},'identity-v1',{sum(counts.values())},{sql(json.dumps(counts, sort_keys=True))}::jsonb,{sql(json.dumps({}))}::jsonb);"
    ]
    for row in tables["User"]:
        parts.append(
            "INSERT INTO public.users (id,username,password_hash,password_hash_algorithm,password_hash_needs_rehash,display_name,timezone,created_at,updated_at) "
            f"VALUES ({sql(row['id'])},{sql(row['username'])},{sql('$2b$12$' + 'a' * 53)},'bcrypt',true,{sql('test snapshot')},'Asia/Shanghai',{now},{now});"
        )
    for row in tables["Family"]:
        parts.append(f"INSERT INTO public.families (id,name,timezone,created_at,updated_at) VALUES ({sql(row['id'])},{sql(row['name'])},'Asia/Shanghai',{now},{now});")
    for row in tables["FamilyMember"]:
        parts.append(f"INSERT INTO public.family_members (id,family_id,user_id,role,relation,status,created_at,updated_at) VALUES ({sql(row['id'])},{sql(row['familyId'])},{sql(row['userId'])},'admin','parent','active',{now},{now});")
    for row in tables["Baby"]:
        parts.append(f"INSERT INTO public.babies (id,family_id,nickname,birth_date,gender,created_at,updated_at) VALUES ({sql(row['id'])},{sql(row['familyId'])},{sql(row['nickname'])},'2025-01-01','unknown',{now},{now});")
    for member in tables["FamilyMember"]:
        for baby in tables["Baby"]:
            if baby["familyId"] == member["familyId"]:
                parts.append(f"INSERT INTO public.baby_members (id,family_id,baby_id,user_id,role,status,created_at,updated_at) VALUES ({sql(member['id'] + '_' + baby['id'])},{sql(member['familyId'])},{sql(baby['id'])},{sql(member['userId'])},'admin','active',{now},{now});")
    for table, rows in tables.items():
        if table in {"User", "Family", "FamilyMember", "Baby"}:
            continue
        for row in rows:
            payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            parts.append(
                "INSERT INTO legacy_import.import_rows (batch_id,source_table,source_id,user_id,family_id,baby_id,payload,payload_hash) "
                f"VALUES ({sql(batch_id)},{sql(table)},{sql(row['id'])},{sql(row.get('userId'))},{sql(row['familyId'])},{sql(row['babyId'])},{sql(payload)}::jsonb,{sql(hashlib.sha256(payload.encode()).hexdigest())});"
            )
    return "\n".join(parts)


def main() -> None:
    manifest_path = Path(os.environ.get("BOOT02_RUN_FILE", "")).resolve()
    temp_root = Path(tempfile.gettempdir()).resolve()
    if not manifest_path.is_file() or manifest_path.parent.parent != temp_root:
        raise RuntimeError("refuses a non-managed BOOT02_RUN_FILE")
    if not manifest_path.parent.name.startswith("growdesk-integration-") or manifest_path.stat().st_mode & 0o077:
        raise RuntimeError("managed manifest must be private")
    run = json.loads(manifest_path.read_text())
    if run.get("database") != "test_growdesk_integration" or run.get("user") != "test_runner":
        raise RuntimeError("refuses a non-test database")
    pg_bin = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@18/bin"))
    cmd = [str(pg_bin / "psql"), "-X", "-h", "127.0.0.1", "-p", str(run["pgPort"]), "-U", run["user"], "-d", run["database"], "-v", "ON_ERROR_STOP=1", "-At"]
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env["PGPASSWORD"] = run["password"]

    def execute(statement: str, *, success: bool = True) -> str:
        result = subprocess.run(cmd, input=statement, capture_output=True, text=True, env=env, cwd=ROOT)
        if (result.returncode == 0) != success:
            raise AssertionError(result.stderr.replace(run["password"], "[redacted]"))
        return result.stdout.strip()

    data = fixtures.archive()
    batch_id = checksum(data)
    snapshot_id = "test_snapshot_1"
    cleanup = f"""
DELETE FROM public.legacy_idempotency_mappings WHERE source_batch_id={sql(batch_id)};
DELETE FROM public.record_snapshots WHERE id={sql(snapshot_id)};
DELETE FROM legacy_import.import_rows WHERE batch_id={sql(batch_id)};
DELETE FROM legacy_import.import_batches WHERE batch_id={sql(batch_id)};
DELETE FROM public.baby_members WHERE id='test_snapshot_member_test_snapshot_baby';
DELETE FROM public.family_members WHERE id='test_snapshot_member';
DELETE FROM public.babies WHERE id='test_snapshot_baby';
DELETE FROM public.families WHERE id='test_snapshot_family';
DELETE FROM public.users WHERE id='test_snapshot_user';
"""
    execute(cleanup)
    try:
        execute(source_sql(data, batch_id))
        rendered = materializer.render_materialization(data, batch_id)
        execute(rendered)
        execute(rendered)
        assert execute(f"SELECT count(*) FROM public.record_snapshots WHERE id={sql(snapshot_id)}") == "1"
        assert execute(f"SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id={sql(batch_id)} AND target_entity_type='record_snapshot'") == "1"

        execute(f"UPDATE public.record_snapshots SET payload_json='{{\"tampered\":true}}'::jsonb WHERE id={sql(snapshot_id)}")
        execute(rendered, success=False)
        assert execute(f"SELECT payload_json->>'tampered' FROM public.record_snapshots WHERE id={sql(snapshot_id)}") == "true"
        execute(f"UPDATE public.record_snapshots SET payload_json={sql(json.dumps(data['tables']['RecordSnapshot'][0]['payload'], sort_keys=True, ensure_ascii=False, separators=(',', ':')))}::jsonb WHERE id={sql(snapshot_id)}")

        execute(f"UPDATE legacy_import.import_rows SET payload_hash={sql('0' * 64)} WHERE batch_id={sql(batch_id)} AND source_table='RecordSnapshot'")
        execute(rendered, success=False)
        assert execute(f"SELECT count(*) FROM public.record_snapshots WHERE id={sql(snapshot_id)}") == "1"
    finally:
        execute(cleanup)
    print("Record snapshot materializer owned PostgreSQL integration PASS")


if __name__ == "__main__":
    main()
