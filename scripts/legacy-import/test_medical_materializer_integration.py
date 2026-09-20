"""Exercise the MedicalReport promotion SQL against the owned PostgreSQL run."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile


HERE = Path(__file__).resolve().parent


def load(name: str):
    path = HERE / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"{name}_integration", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


identity = load("import_sql")
medical = load("materialize_medical")


def fixture() -> dict:
    stamp = "2026-09-12T08:00:00+08:00"
    return {
        "formatVersion": 1,
        "timeZone": "Asia/Shanghai",
        "capturedAt": stamp,
        "sourceId": "test_medical_integration",
        "sourceSha256": "d" * 64,
        "excluded": {},
        "tables": {
            "User": [{"id": "test_medical_user", "username": "test_medical_user", "passwordHash": "$2b$10$" + "a" * 53, "displayName": "test_medical_user", "createdAt": stamp, "updatedAt": stamp}],
            "Family": [{"id": "test_medical_family", "name": "test_medical_family", "createdAt": stamp, "updatedAt": stamp}],
            "FamilyMember": [{"id": "test_medical_member", "familyId": "test_medical_family", "userId": "test_medical_user", "role": "admin", "createdAt": stamp, "updatedAt": stamp}],
            "Baby": [{"id": "test_medical_baby", "familyId": "test_medical_family", "nickname": "test_medical_baby", "gender": "female", "birthDate": "2026-01-01", "createdAt": stamp, "updatedAt": stamp}],
            "MedicalReport": [
                {
                    "id": "test_medical_report_1", "babyId": "test_medical_baby", "recordedById": "test_medical_user",
                    "title": "test medical report", "category": "blood", "date": "2026-09-11", "hospital": "test hospital",
                    "doctorNotes": "test diagnosis", "aiSummary": "test summary",
                    "itemsJson": json.dumps([{"id": "test_medical_item", "name": "test marker", "value": 4.2, "status": "normal"}], separators=(",", ":")),
                    "imageUrl": None, "createdAt": stamp, "updatedAt": stamp,
                },
                {
                    "id": "test_medical_report_2", "babyId": "test_medical_baby",
                    "title": "test follow up", "category": "checkup", "date": "2026-09-12", "hospital": None,
                    "doctorNotes": None, "aiSummary": None, "itemsJson": "[]", "imageUrl": "https://legacy.test/test.png",
                    "createdAt": stamp, "updatedAt": stamp,
                },
            ],
        },
    }


def main() -> None:
    manifest_path = os.environ.get("BOOT02_RUN_FILE")
    if not manifest_path:
        raise RuntimeError("Medical integration requires the managed owned PostgreSQL runner")
    manifest = Path(manifest_path).resolve()
    if manifest.parent.parent != Path(tempfile.gettempdir()).resolve() or not manifest.parent.name.startswith("growdesk-integration-"):
        raise RuntimeError("Manifest is outside the private integration run")
    if manifest.stat().st_mode & 0o077:
        raise RuntimeError("Manifest permissions are too broad")
    run = json.loads(manifest.read_text())
    if run.get("database") != "test_growdesk_integration" or run.get("user") != "test_runner":
        raise RuntimeError("Refusing a non-test database manifest")
    binary = Path(os.environ.get("PG_BIN", "/opt/homebrew/opt/postgresql@18/bin")) / "psql"
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    env["PGPASSWORD"] = run["password"]
    command = [str(binary), "-X", "-h", "127.0.0.1", "-p", str(run["pgPort"]), "-U", run["user"], "-d", run["database"], "-v", "ON_ERROR_STOP=1", "-At"]

    def execute(sql: str, *, success: bool = True) -> str:
        result = subprocess.run(command, input=sql, capture_output=True, text=True, env=env)
        if (result.returncode == 0) != success:
            stderr = result.stderr.replace(run["password"], "[redacted]")
            raise AssertionError(f"unexpected psql status {result.returncode}: {stderr}")
        return result.stdout.strip()

    data = fixture()
    archive_bytes = json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    checksum = hashlib.sha256(archive_bytes).hexdigest()
    # The general owned runner already executes the identity-import regression
    # before this opt-in suite.  Seed this suite's own synthetic tenant with
    # explicit inserts so it never relies on an empty database or attempts to
    # overwrite another test's identity rows.
    stamp = "2026-09-12T00:00:00Z"
    seed = [
        "INSERT INTO public.users(id,username,password_hash,password_hash_algorithm,password_hash_needs_rehash,display_name,timezone,created_at,updated_at) VALUES ("
        + ",".join([identity.literal("test_medical_user"), identity.literal("test_medical_user"), identity.literal("$2b$10$" + "a" * 53), identity.literal("bcrypt"), "TRUE", identity.literal("test_medical_user"), identity.literal("Asia/Shanghai"), identity.literal(stamp), identity.literal(stamp)]) + ");",
        "INSERT INTO public.families(id,name,timezone,created_at,updated_at) VALUES ("
        + ",".join([identity.literal("test_medical_family"), identity.literal("test_medical_family"), identity.literal("Asia/Shanghai"), identity.literal(stamp), identity.literal(stamp)]) + ");",
        "INSERT INTO public.family_members(id,family_id,user_id,role,relation,status,created_at,updated_at) VALUES ("
        + ",".join([identity.literal("test_medical_member"), identity.literal("test_medical_family"), identity.literal("test_medical_user"), identity.literal("admin"), identity.literal("parent"), identity.literal("active"), identity.literal(stamp), identity.literal(stamp)]) + ");",
        "INSERT INTO public.babies(id,family_id,nickname,birth_date,gender,created_at,updated_at) VALUES ("
        + ",".join([identity.literal("test_medical_baby"), identity.literal("test_medical_family"), identity.literal("test_medical_baby"), identity.literal("2026-01-01"), identity.literal("female"), identity.literal(stamp), identity.literal(stamp)]) + ");",
        "INSERT INTO public.baby_members(id,family_id,baby_id,user_id,role,status,created_at,updated_at) VALUES ("
        + ",".join([identity.literal("test_medical_baby_member"), identity.literal("test_medical_family"), identity.literal("test_medical_baby"), identity.literal("test_medical_user"), identity.literal("admin"), identity.literal("active"), identity.literal(stamp), identity.literal(stamp)]) + ");",
        "INSERT INTO public.user_sync_states(user_id,epoch,created_at,updated_at) VALUES ("
        + ",".join([identity.literal("test_medical_user"), identity.literal("test_medical_user_epoch"), identity.literal(stamp), identity.literal(stamp)]) + ");",
        "INSERT INTO public.family_sync_states(family_id,epoch,created_at,updated_at) VALUES ("
        + ",".join([identity.literal("test_medical_family"), identity.literal("test_medical_family_epoch"), identity.literal(stamp), identity.literal(stamp)]) + ");",
    ]
    payload_rows = data["tables"]["MedicalReport"]
    seed.append(
        "INSERT INTO legacy_import.import_batches(batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) VALUES ("
        + ",".join([
            identity.literal(checksum), identity.literal("test_medical_integration"), identity.literal("d" * 64), identity.literal(checksum), identity.literal("identity-v1"), str(len(payload_rows)), identity.literal(json.dumps({"MedicalReport": len(payload_rows)}, separators=(",", ":"))), identity.literal(json.dumps({"historyState": "preserved_not_business_tables"})),
        ]) + ");"
    )
    for row in payload_rows:
        payload = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        seed.append(
            "INSERT INTO legacy_import.import_rows(batch_id,source_table,source_id,family_id,baby_id,payload,payload_hash,captured_at) VALUES ("
            + ",".join([
                identity.literal(checksum), identity.literal("MedicalReport"), identity.literal(row["id"]), identity.literal("test_medical_family"), identity.literal("test_medical_baby"), identity.literal(payload) + "::jsonb", identity.literal(hashlib.sha256(payload.encode()).hexdigest()), identity.literal(stamp),
            ]) + ");"
        )
    execute("BEGIN;\n" + "\n".join(seed) + "\nCOMMIT;")
    promotion = medical.render_materialization(data, checksum)
    output = execute(promotion)
    receipt = json.loads(output.splitlines()[-1])
    assert receipt["sourceCount"] == 2, receipt
    assert receipt["targetCount"] == 2, receipt
    assert receipt["timelineCount"] == 2, receipt
    assert receipt["unresolvedAttachmentCount"] == 1, receipt

    assert execute("SELECT count(*) FROM public.medical_reports WHERE id LIKE 'test_medical_report_%'") == "2"
    assert execute("SELECT count(*) FROM public.timeline_entries WHERE entity_type='medical' AND entity_id LIKE 'test_medical_report_%'") == "2"
    assert execute("SELECT department || '|' || diagnosis || '|' || notes FROM public.medical_reports WHERE id='test_medical_report_1'") == "blood|test diagnosis|test summary"
    assert execute("SELECT status FROM public.legacy_idempotency_mappings WHERE source_batch_id='" + checksum + "' AND source_id='test_medical_report_2'") == "mapped_with_unresolved_attachment"
    assert execute("SELECT jsonb_array_length(items) FROM public.medical_reports WHERE id='test_medical_report_1'") == "1"
    assert execute("SELECT length(metadata->>'targetHashSha256') FROM public.legacy_idempotency_mappings WHERE source_batch_id='" + checksum + "' AND source_id='test_medical_report_1'") == "64"
    assert execute("SELECT source_hash = payload_hash FROM public.legacy_idempotency_mappings m JOIN legacy_import.import_rows r ON r.batch_id=m.source_batch_id AND r.source_table=m.source_table AND r.source_id=m.source_id WHERE m.source_batch_id='" + checksum + "' AND m.source_id='test_medical_report_1'") == "t"

    # Replaying the exact archive is a no-op and preserves one target per source.
    execute(promotion)
    assert execute("SELECT count(*) FROM public.medical_reports WHERE id LIKE 'test_medical_report_%'") == "2"
    assert execute("SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id='" + checksum + "'") == "2"

    # A later source-row hash failure must roll back the first row of a new
    # batch as well.  Insert only synthetic raw rows; no production tables are
    # touched and no identity re-import is attempted.
    atomic_data = json.loads(json.dumps(data))
    atomic_data["tables"]["MedicalReport"] = [
        dict(data["tables"]["MedicalReport"][0], id="test_medical_atomic_1"),
        dict(data["tables"]["MedicalReport"][1], id="test_medical_atomic_2"),
    ]
    atomic_bytes = json.dumps(atomic_data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    atomic_checksum = hashlib.sha256(atomic_bytes).hexdigest()
    atomic_rows = atomic_data["tables"]["MedicalReport"]
    table_counts = {"MedicalReport": 2}
    raw_inserts = [
        "INSERT INTO legacy_import.import_batches(batch_id,source_system,source_snapshot,checksum,mapping_version,row_count,table_counts,metadata) VALUES ("
        + ",".join([
            identity.literal(atomic_checksum), identity.literal("test_medical_integration"), identity.literal("d" * 64), identity.literal(atomic_checksum), identity.literal("identity-v1"), "2", identity.literal(json.dumps(table_counts, separators=(",", ":"))), identity.literal(json.dumps({"historyState": "preserved_not_business_tables"})),
        ]) + ");"
    ]
    for index, row in enumerate(atomic_rows):
        payload = json.dumps(row, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        payload_hash = hashlib.sha256(payload.encode()).hexdigest()
        if index == 1:
            payload_hash = "f" * 64
        raw_inserts.append(
            "INSERT INTO legacy_import.import_rows(batch_id,source_table,source_id,family_id,baby_id,payload,payload_hash,captured_at) VALUES ("
            + ",".join([
                identity.literal(atomic_checksum), identity.literal("MedicalReport"), identity.literal(row["id"]), identity.literal("test_medical_family"), identity.literal("test_medical_baby"), identity.literal(payload) + "::jsonb", identity.literal(payload_hash), identity.literal("2026-09-12T00:00:00Z"),
            ]) + ");"
        )
    execute("\n".join(raw_inserts))
    execute(medical.render_materialization(atomic_data, atomic_checksum), success=False)
    assert execute("SELECT count(*) FROM public.medical_reports WHERE id LIKE 'test_medical_atomic_%'") == "0"
    assert execute("SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id='" + atomic_checksum + "'") == "0"
    print("Medical materializer integration PASS: owned PG, exact source hash guard, atomic rollback, replay, family scope, unresolved attachment receipt")


if __name__ == "__main__":
    main()
