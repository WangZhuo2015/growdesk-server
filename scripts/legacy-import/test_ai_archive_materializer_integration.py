"""Owned PostgreSQL checks for canonical legacy AiArchive promotion.

The test accepts only the managed BOOT02 manifest created by
``scripts/test-integration.py``. It inserts a test_ tenant and a ready private
attachment, then proves mapping, replay, target tamper detection, source hash
failure and cleanup without touching an existing database.
"""

from __future__ import annotations

import copy
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


materializer = load_module("materialize_ai_archive_integration", "materialize_ai_archive.py")
fixtures = load_module("test_ai_archive_fixture_integration", "test_ai_archive_materializer.py")
identity = load_module("legacy_identity_sql_ai_archive", "import_sql.py")


def sql(value):
    return identity.literal(value)


def checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def source_sql(data: dict, batch: str) -> str:
    tables = data["tables"]
    counts = {table: len(rows) for table, rows in tables.items()}
    now = sql("2026-09-12T00:00:00Z")
    parts = [
        "INSERT INTO legacy_import.import_batches (batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) "
        f"VALUES ({sql(batch)},{sql(data['sourceId'])},{sql(data['sourceSha256'])},{sql(batch)},'ai-archive-v1',{sum(counts.values())},{sql(json.dumps(counts, sort_keys=True))}::jsonb,{sql({})});"
    ]
    for row in tables["User"]:
        parts.append(
            "INSERT INTO public.users (id,username,password_hash,password_hash_algorithm,password_hash_needs_rehash,display_name,timezone,created_at,updated_at) "
            f"VALUES ({sql(row['id'])},{sql(row['username'])},{sql('test_password_hash')},'bcrypt',true,{sql(row['username'])},'Asia/Shanghai',{now},{now});"
        )
    for row in tables["Family"]:
        parts.append(
            "INSERT INTO public.families (id,name,timezone,created_at,updated_at) "
            f"VALUES ({sql(row['id'])},{sql(row['name'])},'Asia/Shanghai',{now},{now});"
        )
    for row in tables["FamilyMember"]:
        parts.append(
            "INSERT INTO public.family_members (id,family_id,user_id,role,relation,status,created_at,updated_at) "
            f"VALUES ({sql(row['id'])},{sql(row['familyId'])}, {sql(row['userId'])}, 'admin','parent','active',{now},{now});"
        )
    for row in tables["Baby"]:
        parts.append(
            "INSERT INTO public.babies (id,family_id,nickname,birth_date,gender,created_at,updated_at) "
            f"VALUES ({sql(row['id'])},{sql(row['familyId'])},{sql(row['nickname'])},'2024-01-01','unknown',{now},{now});"
        )
    for member in tables["FamilyMember"]:
        for baby in tables["Baby"]:
            if baby["familyId"] == member["familyId"]:
                parts.append(
                    "INSERT INTO public.baby_members (id,family_id,baby_id,user_id,role,status,created_at,updated_at) "
                    f"VALUES ({sql(member['id'] + '_' + baby['id'])},{sql(member['familyId'])},{sql(baby['id'])},{sql(member['userId'])},'member','active',{now},{now});"
                )
    for table in ("AiJob", "AiArchive"):
        for row in tables[table]:
            payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            payload_hash = hashlib.sha256(payload.encode()).hexdigest()
            parts.append(
                "INSERT INTO legacy_import.import_rows (batch_id,source_table,source_id,user_id,family_id,baby_id,payload,payload_hash) "
                f"VALUES ({sql(batch)},{sql(table)},{sql(row['id'])},{sql(row.get('userId'))},{sql(row.get('familyId'))},{sql(row.get('babyId'))},{sql(payload)}::jsonb,{sql(payload_hash)});"
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
    command = [str(pg_bin / "psql"), "-X", "-h", "127.0.0.1", "-p", str(run["pgPort"]), "-U", run["user"], "-d", run["database"], "-v", "ON_ERROR_STOP=1", "-At"]
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env["PGPASSWORD"] = run["password"]

    def execute(statement: str, *, success: bool = True) -> str:
        result = subprocess.run(command, input=statement, capture_output=True, text=True, env=env, cwd=ROOT)
        if (result.returncode == 0) != success:
            raise AssertionError(result.stderr.replace(run["password"], "[redacted]"))
        return result.stdout.strip()

    data = fixtures.archive()
    batch = checksum(data)
    report = fixtures.attachment_report(data, batch)
    attachment_id = "test_archive_audio_attachment"
    cleanup = f"""
DELETE FROM public.legacy_idempotency_mappings WHERE source_batch_id={sql(batch)};
DELETE FROM public.ai_archive_entries WHERE source_batch_id={sql(batch)};
DELETE FROM public.attachments WHERE id={sql(attachment_id)};
DELETE FROM legacy_import.import_rows WHERE batch_id={sql(batch)};
DELETE FROM legacy_import.import_batches WHERE batch_id={sql(batch)};
DELETE FROM public.baby_members WHERE id LIKE 'test_archive_%';
DELETE FROM public.family_members WHERE id LIKE 'test_archive_%';
DELETE FROM public.babies WHERE id LIKE 'test_archive_%';
DELETE FROM public.families WHERE id LIKE 'test_archive_%';
DELETE FROM public.users WHERE id LIKE 'test_archive_%';
"""
    execute(cleanup)
    try:
        execute(source_sql(data, batch))
        execute(
            "INSERT INTO public.attachments (id,family_id,baby_id,uploader_id,purpose,mime_type,byte_size,sha256,object_key,status,expires_at) "
            f"VALUES ({sql(attachment_id)},'test_archive_family','test_archive_baby','test_archive_user','voice_note','audio/m4a',{data['tables']['AiArchive'][1]['byteSize']},{sql(data['tables']['AiArchive'][1]['contentHash'])},'families/test_archive_family/attachments/voice_note/legacy/test_archive_audio.m4a','ready','9999-12-31T23:59:59.999Z')"
        )
        rendered = materializer.render_materialization(data, batch, report)
        execute(rendered)
        execute(rendered)
        counts = execute(
            "SELECT (SELECT count(*) FROM public.ai_archive_entries WHERE source_batch_id=" + sql(batch) + " AND status='mapped') || '|' || "
            "(SELECT count(*) FROM public.ai_archive_entries WHERE source_batch_id=" + sql(batch) + " AND status='quarantined') || '|' || "
            "(SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id=" + sql(batch) + " AND target_entity_type='ai_archive_entry')"
        )
        assert counts == "2|2|4", counts
        assert execute("SELECT attachment_id FROM public.ai_archive_entries WHERE id='test_archive_audio'") == attachment_id
        assert execute("SELECT quarantine_code FROM public.ai_archive_entries WHERE id='test_archive_orphan'") == "OWNER_UNPROVEN"

        execute("UPDATE public.ai_archive_entries SET content='tampered' WHERE id='test_archive_text'")
        execute(rendered, success=False)
        execute("UPDATE public.ai_archive_entries SET content='{" + '"summary":"private test"' + "}' WHERE id='test_archive_text'")
        execute(rendered)

        execute("UPDATE legacy_import.import_rows SET payload_hash='" + "0" * 64 + "' WHERE batch_id=" + sql(batch) + " AND source_table='AiArchive' AND source_id='test_archive_audio'")
        execute(rendered, success=False)
        assert execute("SELECT count(*) FROM public.ai_archive_entries WHERE source_batch_id=" + sql(batch)) == "4"
        print("AI archive materializer owned PostgreSQL integration PASS")
    finally:
        execute(cleanup)


if __name__ == "__main__":
    main()
