"""Owned PostgreSQL checks for the legacy AI history promotion.

The script is intentionally a child of the existing owned integration
runner: it only accepts the private ``BOOT02_RUN_FILE`` manifest for
``test_growdesk_integration``/``test_runner`` and never discovers or adopts a
running database.  It does not change the shared runner; invoke it while the
runner's owned manifest is live, or from an equivalent private owned setup.
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


materializer = load_module("materialize_ai_history_integration", "materialize_ai_history.py")
fixtures = load_module("test_ai_history_fixture", "test_ai_history_materializer.py")
identity = load_module("legacy_identity_sql", "import_sql.py")


def _sql(value):
    return identity.literal(value)


def _checksum(data: dict) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def source_sql(data: dict, checksum: str) -> str:
    tables = data["tables"]
    counts = {table: len(rows) for table, rows in tables.items()}
    now = _sql("2026-09-12T00:00:00Z")
    parts = [
        "INSERT INTO legacy_import.import_batches (batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) "
        f"VALUES ({_sql(checksum)},{_sql(data['sourceId'])},{_sql(data['sourceSha256'])},{_sql(checksum)},'identity-v1',{sum(counts.values())},{_sql(json.dumps(counts, sort_keys=True))}::jsonb,{_sql({})});"
    ]
    for row in tables["User"]:
        parts.append(
            "INSERT INTO public.users (id,username,password_hash,password_hash_algorithm,password_hash_needs_rehash,display_name,timezone,created_at,updated_at) "
            f"VALUES ({_sql(row['id'])},{_sql(row['username'])},{_sql(row['passwordHash'])},'bcrypt',true,{_sql(row['displayName'])},'Asia/Shanghai',{now},{now});"
        )
    for row in tables["Family"]:
        parts.append(
            "INSERT INTO public.families (id,name,timezone,created_at,updated_at) "
            f"VALUES ({_sql(row['id'])},{_sql(row['name'])},'Asia/Shanghai',{now},{now});"
        )
    for row in tables["FamilyMember"]:
        parts.append(
            "INSERT INTO public.family_members (id,family_id,user_id,role,relation,status,created_at,updated_at) "
            f"VALUES ({_sql(row['id'])},{_sql(row['familyId'])},{_sql(row['userId'])},{_sql(row['role'])},'parent','active',{now},{now});"
        )
    for row in tables["Baby"]:
        parts.append(
            "INSERT INTO public.babies (id,family_id,nickname,birth_date,gender,created_at,updated_at) "
            f"VALUES ({_sql(row['id'])},{_sql(row['familyId'])},{_sql(row['nickname'])},{_sql(row['birthDate'])},{_sql(row['gender'])},{now},{now});"
        )
    for member in tables["FamilyMember"]:
        for baby in tables["Baby"]:
            if baby["familyId"] == member["familyId"]:
                baby_member_id = f"{member['id']}_{baby['id']}"
                parts.append(
                    "INSERT INTO public.baby_members (id,family_id,baby_id,user_id,role,status,created_at,updated_at) "
                    f"VALUES ({_sql(baby_member_id)},{_sql(member['familyId'])},{_sql(baby['id'])},{_sql(member['userId'])},{_sql(member['role'])},'active',{now},{now});"
                )
    for table, rows in tables.items():
        if table in {"User", "Family", "FamilyMember", "Baby"}:
            continue
        for row in rows:
            payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            row_hash = hashlib.sha256(payload.encode()).hexdigest()
            parts.append(
                "INSERT INTO legacy_import.import_rows (batch_id,source_table,source_id,user_id,family_id,baby_id,payload,payload_hash) "
                f"VALUES ({_sql(checksum)},{_sql(table)},{_sql(row['id'])},{_sql(row.get('userId'))},{_sql(row.get('familyId'))},{_sql(row.get('babyId'))},{_sql(payload)}::jsonb,{_sql(row_hash)});"
            )
    return "\n".join(parts)


def followup_source_sql(data: dict, checksum: str, tables: set[str]) -> str:
    """Insert only raw follow-up rows; identity rows already exist."""

    selected = {table: [row for row in data["tables"].get(table, []) if table in tables] for table in tables}
    counts = {table: len(rows) for table, rows in selected.items()}
    parts = [
        "INSERT INTO legacy_import.import_batches (batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) "
        f"VALUES ({_sql(checksum)},{_sql(data['sourceId'])},{_sql(data['sourceSha256'])},{_sql(checksum)},'identity-v1',{sum(counts.values())},{_sql(json.dumps(counts, sort_keys=True))}::jsonb,{_sql({})});"
    ]
    for table, rows in selected.items():
        for row in rows:
            payload = json.dumps(row, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
            row_hash = hashlib.sha256(payload.encode()).hexdigest()
            parts.append(
                "INSERT INTO legacy_import.import_rows (batch_id,source_table,source_id,user_id,family_id,baby_id,payload,payload_hash) "
                f"VALUES ({_sql(checksum)},{_sql(table)},{_sql(row['id'])},{_sql(row.get('userId'))},{_sql(row.get('familyId'))},{_sql(row.get('babyId'))},{_sql(payload)}::jsonb,{_sql(row_hash)});"
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

    def execute(sql: str, *, success: bool = True) -> str:
        result = subprocess.run(cmd, input=sql, capture_output=True, text=True, env=env, cwd=ROOT)
        if (result.returncode == 0) != success:
            stderr = result.stderr.replace(run["password"], "[redacted]")
            raise AssertionError(stderr)
        return result.stdout.strip()

    data = fixtures.archive()
    checksum = _checksum(data)
    cleanup = """
DELETE FROM public.legacy_idempotency_mappings WHERE source_batch_id IN ({checksums});
DELETE FROM public.ai_run_events WHERE run_id LIKE 'test_ai_job_%';
DELETE FROM public.ai_runs WHERE id LIKE 'test_ai_job_%';
DELETE FROM public.task_executions WHERE id LIKE 'test_ai_job_%';
DELETE FROM public.ai_messages WHERE id LIKE 'test_ai_message_%';
DELETE FROM public.ai_sessions WHERE id LIKE 'test_ai_session%' OR id LIKE 'legacy_ai_job_session_%';
DELETE FROM legacy_import.import_rows WHERE batch_id IN ({checksums});
DELETE FROM legacy_import.import_batches WHERE batch_id IN ({checksums});
DELETE FROM public.baby_members WHERE id LIKE 'test_ai_member_%' OR id='test_ai_member_test_ai_baby' OR id='test_ai_other_member_test_ai_other_baby';
DELETE FROM public.family_members WHERE id IN ('test_ai_member','test_ai_other_member');
DELETE FROM public.babies WHERE id IN ('test_ai_baby','test_ai_other_baby');
DELETE FROM public.families WHERE id IN ('test_ai_family','test_ai_other_family');
DELETE FROM public.users WHERE id IN ('test_ai_user','test_ai_other_user');
""".format(checksums=_sql(checksum))
    execute(cleanup)
    atomic_checksum: str | None = None
    try:
        execute(source_sql(data, checksum))
        rendered = materializer.render_materialization(data, checksum)
        execute(rendered)
        execute(rendered)
        counts = execute(
            "SELECT (SELECT count(*) FROM public.ai_sessions WHERE id LIKE 'test_ai_session%' OR id LIKE 'legacy_ai_job_session_%') || '|' || "
            "(SELECT count(*) FROM public.ai_messages WHERE id LIKE 'test_ai_message_%') || '|' || "
            "(SELECT count(*) FROM public.task_executions WHERE id LIKE 'test_ai_job_%') || '|' || "
            "(SELECT count(*) FROM public.ai_runs WHERE id LIKE 'test_ai_job_%') || '|' || "
            "(SELECT count(*) FROM public.ai_run_events WHERE run_id LIKE 'test_ai_job_%') || '|' || "
            "(SELECT count(*) FROM public.task_outbox WHERE aggregate_id LIKE 'test_ai_job_%') || '|' || "
            "(SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id=" + _sql(checksum) + ")"
        )
        assert counts == "3|2|2|2|2|0|11", counts
        assert execute("SELECT status || '|' || error_code FROM public.task_executions t JOIN public.ai_runs r ON r.id=t.id WHERE t.id='test_ai_job_processing'") == "failed|LEGACY_INCOMPLETE_NOT_RESUMED"
        assert execute("SELECT count(*) FROM public.ai_messages WHERE tools_json LIKE '%test_secret%' OR tools_json LIKE '%evidence%'") == "0"
        assert execute("SELECT count(*) FROM public.task_executions WHERE result_ref::text LIKE '%providerSecret%' OR error_details::text LIKE '%do-not-copy%'") == "0"

        # An existing target row must match the immutable target snapshot.
        execute("UPDATE public.ai_sessions SET title='test_ai_tampered' WHERE id='test_ai_session'")
        execute(rendered, success=False)
        assert execute("SELECT title FROM public.ai_sessions WHERE id='test_ai_session'") == "test_ai_tampered"
        execute("UPDATE public.ai_sessions SET title='test chat' WHERE id='test_ai_session'")
        execute(rendered)

        # A source hash mismatch after one target statement has run rolls the
        # whole new batch back; no first row may survive.
        atomic = copy.deepcopy(data)
        atomic["tables"]["AiJob"] = [
            {"id": "test_ai_job_atomic_a", "userId": "test_ai_user", "babyId": "test_ai_baby", "type": "growth_ocr", "status": "done", "inputArchiveId": None, "resultJson": None, "imageUrl": None, "errorMessage": None, "claimed": False, "createdAt": fixtures.STAMP, "finishedAt": fixtures.STAMP},
            {"id": "test_ai_job_atomic_b", "userId": "test_ai_user", "babyId": "test_ai_baby", "type": "medical_ocr", "status": "done", "inputArchiveId": None, "resultJson": None, "imageUrl": None, "errorMessage": None, "claimed": False, "createdAt": fixtures.STAMP, "finishedAt": fixtures.STAMP},
        ]
        atomic_checksum = _checksum(atomic)
        atomic_raw = {**atomic, "tables": {**atomic["tables"], "AiChatSession": [], "AiChatMessage": [], "AiArchive": [], "AgentVoiceLog": [], "RecordSnapshot": []}}
        execute(followup_source_sql(atomic_raw, atomic_checksum, {"AiJob"}))
        execute(
            "UPDATE legacy_import.import_rows SET payload_hash='" + "0" * 64 + "' WHERE batch_id=" + _sql(atomic_checksum) + " AND source_table='AiJob' AND source_id='test_ai_job_atomic_b'"
        )
        atomic_sql = materializer.render_materialization(atomic_raw, atomic_checksum)
        execute(atomic_sql, success=False)
        assert execute("SELECT count(*) FROM public.task_executions WHERE id IN ('test_ai_job_atomic_a','test_ai_job_atomic_b')") == "0"
        atomic_session_ids = [
            "legacy_ai_job_session_" + hashlib.sha256(value.encode()).hexdigest()[:32]
            for value in ("test_ai_job_atomic_a", "test_ai_job_atomic_b")
        ]
        assert execute("SELECT count(*) FROM public.ai_sessions WHERE id IN (" + ",".join(_sql(value) for value in atomic_session_ids) + ")") == "0"
        print("AI history materializer owned PostgreSQL integration PASS")
    finally:
        batches = _sql(checksum) if atomic_checksum is None else _sql(checksum) + "," + _sql(atomic_checksum)
        execute(cleanup.format(checksums=batches), success=True)


if __name__ == "__main__":
    main()
