"""Owner-only aggregate verification for a legacy import target.

The verifier reads source rows only into memory for hash/ID comparison and
never prints their values. ``cutoverReady`` is deliberately false whenever a
phase receipt, mapping receipt, quarantine, unresolved attachment, or target
count is incomplete.
"""

from __future__ import annotations

import argparse
import importlib.util
import hashlib
import json
from pathlib import Path
import re
import stat
import subprocess
from typing import Any


SHA256 = re.compile(r"^[0-9a-f]{64}$")
CORE_TABLES = {"User", "Family", "FamilyMember", "Baby"}
REQUIRED_RECEIPT_PHASES = {
    "migrations", "identity", "care", "food", "medical", "supplement_vaccine",
    "ai_history", "voice", "record_snapshot", "attachment_promotion", "ai_archive",
    "attachment_reference_backfill",
}
# These public knowledge rows are served from reviewed, versioned code rather
# than copied into the new transactional database. Their exact legacy hashes
# are pinned here so a changed source snapshot fails closed.
STATIC_REFERENCE_GOLDEN = {
    "ActivityRecommendation": (25, "3f0dcc5893799eec3c292dbebc6ed9af8c55beaf6f9083a1f7566b6c1d4ea7e7"),
    "Book": (5, "792955d8c6795dcdaf7bc49f82c607c50d4e56bf474c737345b0f6358d820632"),
    "DataRelease": (1, "a670d44a40e5b8be97067a55331071ce2cabaf81d4a628b950322e0a67e9ee1d"),
    "DevelopmentMilestone": (119, "b9f7ff1fddc152d6cd7886ebc1ecc58c030b437ba9ef07a2c77799b7d4aee991"),
    "DevelopmentWarningSign": (32, "52914143057812b4926972127ff9b7fde65631889a798282f4f4dfe6a9bd6a2a"),
    "FeedingGuideline": (4, "8743460ff5284d8c74ed8b2a84fad37f37c327dbff33fc22a3b921d4e5b15ad8"),
    "MilestoneSourceRef": (0, "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"),
    "SourceRef": (59, "888e67a80d714fbec090b69ad9486a3c3e22401f18e1bac9d28c55a8953be4cf"),
    "ScheduleEngineRule": (8, "554317540fd69c7c735053ae156e131cae6d21979295df9d254ea4821a888bd3"),
}
PROMOTED_TABLES = {
    "FormulaProduct", "FeedingRecord", "SleepRecord", "DiaperRecord", "GrowthMeasurement",
    "FoodItem", "FoodLogRecord", "FamilyFoodStatus", "MedicalReport",
    "SupplementProduct", "SupplementSchedule", "SupplementRecord", "Vaccine", "VaccineDose",
    "VaccineScheduleEntry", "VaccineStrategyGroup", "VaccineSelection", "VaccineRecord",
    "VaccineSourceRef", "AiChatSession", "AiChatMessage", "AiJob",
    "AgentVoiceLog", "RecordSnapshot", "AiArchive",
}


def _hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _load_archive(archive: str | Path) -> tuple[dict[str, Any], str]:
    path = Path(archive).resolve()
    if path.is_symlink() or not path.is_file() or stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise RuntimeError("archive must be a private regular file")
    raw = path.read_bytes()
    value = json.loads(raw)
    if not isinstance(value, dict) or not isinstance(value.get("tables"), dict):
        raise RuntimeError("archive is invalid")
    return value, hashlib.sha256(raw).hexdigest()


def _query(container: str, sql: str) -> Any:
    if re.fullmatch(r"[A-Za-z0-9_.-]+", container) is None:
        raise RuntimeError("target container name is invalid")
    process = subprocess.run(
        ["docker", "exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", "growdesk", "-At", "-v", "ON_ERROR_STOP=1"],
        input=sql,
        text=True,
        capture_output=True,
    )
    if process.returncode:
        raise RuntimeError("target verification query failed")
    return json.loads(process.stdout)


def _validate_target_container(container: str) -> None:
    if re.fullmatch(r"[A-Za-z0-9_.-]+", container) is None:
        raise RuntimeError("target container name is invalid")
    try:
        raw = subprocess.check_output(["docker", "inspect", container], stderr=subprocess.DEVNULL, text=True)
        value = json.loads(raw)[0]
        labels = value["Config"]["Labels"]
        image = value["Config"]["Image"]
        ports = value["HostConfig"].get("PortBindings")
        networks = value["NetworkSettings"]["Networks"]
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, KeyError, TypeError) as error:
        raise RuntimeError("target PostgreSQL container cannot be inspected") from error
    if labels.get("com.docker.compose.project") != "growdesk" or labels.get("com.docker.compose.service") != "postgres":
        raise RuntimeError("target must be the growdesk Compose PostgreSQL service")
    if not isinstance(image, str) or not image.startswith("postgres:18.6-bookworm@sha256:"):
        raise RuntimeError("target PostgreSQL image is not the pinned GrowDesk image")
    if ports or "growdesk-db" not in networks:
        raise RuntimeError("target PostgreSQL is not private to the GrowDesk database network")


def _validate_manifest(archive: dict[str, Any], checksum: str, manifest_path: Path) -> dict[str, Any]:
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise RuntimeError("manifest must be a private regular file")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("archiveSha256") != checksum:
        raise RuntimeError("manifest archive hash does not match")
    source_id = manifest.get("sourceId")
    source_hash = manifest.get("sourceSha256")
    if not isinstance(source_id, str) or not source_id or not isinstance(source_hash, str) or SHA256.fullmatch(source_hash) is None:
        raise RuntimeError("manifest source proof is invalid")
    if archive.get("sourceId") != source_id or archive.get("sourceSha256") != source_hash:
        raise RuntimeError("archive source proof does not match manifest")
    source_path = manifest_path.parent / "source.sqlite"
    if source_path.is_symlink() or not source_path.is_file() or stat.S_IMODE(source_path.stat().st_mode) & 0o077 or _hash(source_path) != source_hash:
        raise RuntimeError("source snapshot hash does not match manifest")
    return manifest


def _receipt_summary(receipt_dir: str | Path | None, archive_hash: str) -> dict[str, Any]:
    if receipt_dir is None:
        return {"phaseFailures": ["receipt directory not supplied"], "quarantined": 0, "unresolvedAttachments": 0}
    root = Path(receipt_dir).resolve()
    if root.is_symlink() or not root.is_dir() or stat.S_IMODE(root.stat().st_mode) & 0o077:
        raise RuntimeError("receipt directory must be private")
    phase_failures: list[str] = []
    phase_names: set[str] = set()
    quarantined = 0
    unresolved = 0
    for path in root.glob("phase-*.json"):
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError) as error:
            raise RuntimeError("phase receipt is invalid") from error
        if not isinstance(value, dict) or value.get("archiveSha256") != archive_hash:
            raise RuntimeError("phase receipt archive proof does not match")
        phase = value.get("phase")
        if isinstance(phase, str):
            phase_names.add(phase)
        if value.get("status") != "completed" and phase != "target_verification":
            phase_failures.append(str(phase))
    for path in root.glob("*.json"):
        if path.name.startswith("phase-") or path.name in {"cutover-report.json", "target-verification.json"}:
            continue
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        if not isinstance(value, dict):
            continue
        entry_count = 0
        for entry_key in ("quarantine", "entries"):
            entries = value.get(entry_key)
            if isinstance(entries, list):
                entry_count += sum(
                    int(item.get("count", 1))
                    for item in entries
                    if isinstance(item, dict) and isinstance(item.get("count", 1), int)
                )
        if entry_count:
            quarantined += entry_count
        counts = value.get("counts")
        if isinstance(counts, dict):
            if entry_count == 0:
                raw = counts.get("quarantined")
                if isinstance(raw, int) and raw > 0:
                    quarantined += raw
            raw_unresolved = counts.get("unresolvedAttachmentCount")
            if isinstance(raw_unresolved, int) and raw_unresolved > 0:
                unresolved += raw_unresolved
        if entry_count == 0:
            raw_quarantined = value.get("quarantined")
            if isinstance(raw_quarantined, int) and raw_quarantined > 0:
                quarantined += raw_quarantined
    return {
        "phaseFailures": sorted(set(phase_failures) | (REQUIRED_RECEIPT_PHASES - phase_names)),
        "receiptPhases": sorted(phase_names),
        "quarantined": quarantined,
        "unresolvedAttachments": unresolved,
    }


def _verification_module(name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    if spec is None or spec.loader is None:
        raise RuntimeError("verification module unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def verify(
    archive: str | Path,
    *,
    manifest: str | Path | None = None,
    target_container: str = "growdesk-postgres-1",
    receipt_dir: str | Path | None = None,
    release_evidence: str | Path | None = None,
) -> dict[str, Any]:
    archive_path = Path(archive).resolve()
    data, checksum = _load_archive(archive_path)
    _validate_target_container(target_container)
    manifest_data = _validate_manifest(data, checksum, Path(manifest).resolve()) if manifest is not None else None
    tables = data["tables"]
    expected = {(table, row["id"]): row for table, rows in tables.items() for row in rows}
    imported = _query(target_container, "SELECT coalesce(json_agg(r),'[]'::json) FROM (SELECT source_table,source_id,payload,payload_hash FROM legacy_import.import_rows) r;")
    if len(imported) != len(expected):
        raise RuntimeError("legacy archive row count does not match target")
    for row in imported:
        source = expected.get((row["source_table"], row["source_id"]))
        if source is None or row["payload"] != source:
            raise RuntimeError("legacy archive row content does not match target")
        payload = json.dumps(source, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        if row["payload_hash"] != hashlib.sha256(payload).hexdigest():
            raise RuntimeError("legacy archive row hash does not match target")
    users = _query(target_container, "SELECT coalesce(json_agg(r),'[]'::json) FROM (SELECT id,username,password_hash,display_name FROM public.users) r;")
    source_users = {row["id"]: row for row in tables["User"]}
    if len(users) != len(source_users):
        raise RuntimeError("identity user count does not match source")
    for row in users:
        source = source_users.get(row["id"])
        if source is None or row["username"] != source["username"] or row["password_hash"] != source["passwordHash"] or row["display_name"] != source["displayName"]:
            raise RuntimeError("identity user content does not match source")
    members = _query(target_container, "SELECT coalesce(json_agg(r),'[]'::json) FROM (SELECT user_id,baby_id,family_id,role,status FROM public.baby_members) r;")
    wanted = {(member["userId"], baby["id"], baby["familyId"], member["role"], "active") for member in tables["FamilyMember"] for baby in tables["Baby"] if baby["familyId"] == member["familyId"]}
    actual = {tuple(row[key] for key in ("user_id", "baby_id", "family_id", "role", "status")) for row in members}
    if actual != wanted:
        raise RuntimeError("baby membership backfill does not match source")
    counts = _query(target_container, "SELECT json_build_object('users',(SELECT count(*) FROM public.users),'families',(SELECT count(*) FROM public.families),'babies',(SELECT count(*) FROM public.babies),'familyMembers',(SELECT count(*) FROM public.family_members),'babyMembers',(SELECT count(*) FROM public.baby_members),'archiveRows',(SELECT count(*) FROM legacy_import.import_rows),'apiCanReadUsers',has_table_privilege('growdesk','public.users','SELECT'),'apiCanReadArchive',has_table_privilege('growdesk','legacy_import.import_rows','SELECT'),'appliedMigrations',(SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NOT NULL));")
    if counts["families"] != len(tables["Family"]) or counts["babies"] != len(tables["Baby"]) or counts["familyMembers"] != len(tables["FamilyMember"]):
        raise RuntimeError("identity aggregate counts do not match source")
    if counts["apiCanReadUsers"] or counts["apiCanReadArchive"]:
        raise RuntimeError("runtime role can read protected migration tables")

    receipt_counts = _query(target_container, "SELECT coalesce(json_object_agg(source_table, row_count),'{}'::json) FROM (SELECT source_table,count(*)::int AS row_count FROM public.legacy_idempotency_mappings WHERE source_batch_id='" + checksum + "' GROUP BY source_table) r;")
    unresolved_db = _query(target_container, "SELECT json_build_object('unresolvedAttachmentMappings',(SELECT count(*)::int FROM public.legacy_idempotency_mappings WHERE source_batch_id='" + checksum + "' AND status LIKE '%unresolved%'),'quarantinedMappings',(SELECT count(*)::int FROM public.legacy_idempotency_mappings WHERE source_batch_id='" + checksum + "' AND status='quarantined'));")
    source_counts = {str(table): len(rows) for table, rows in tables.items()}
    static_reference_failures = []
    for table, (expected_count, expected_hash) in STATIC_REFERENCE_GOLDEN.items():
        rows = tables.get(table, [])
        actual_hash = hashlib.sha256(
            json.dumps(rows, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()
        if len(rows) != expected_count or actual_hash != expected_hash:
            static_reference_failures.append(table)
    # Every non-identity source table needs either a promotion receipt or an
    # explicit zero-row proof. Unknown tables are reported as gaps instead of
    # being silently treated as harmless legacy history.
    unmapped = sorted(
        table for table, count in source_counts.items()
        if count and table not in CORE_TABLES and table not in STATIC_REFERENCE_GOLDEN
        and (table not in PROMOTED_TABLES or int(receipt_counts.get(table, 0)) < count)
    )
    receipt = _receipt_summary(receipt_dir, checksum)
    unresolved = receipt["unresolvedAttachments"] + int(unresolved_db.get("unresolvedAttachmentMappings", 0))
    quarantined = receipt["quarantined"] + int(unresolved_db.get("quarantinedMappings", 0))
    attachment_report = None
    if receipt_dir is not None:
        attachment_path = Path(receipt_dir) / "attachment-promotion.json"
        if attachment_path.exists():
            if attachment_path.is_symlink() or not attachment_path.is_file() or attachment_path.stat().st_mode & 0o077:
                raise RuntimeError("attachment report must be private")
            attachment_report = json.loads(attachment_path.read_text())
    canonical = _verification_module("canonical_verification").verify_canonical(
        data, checksum, lambda sql: _query(target_container, sql), attachment_report,
    )
    import_ready = (not unmapped and not static_reference_failures and not receipt["phaseFailures"]
                    and quarantined == 0 and unresolved == 0 and canonical["passed"])
    release = _verification_module("release_gate").release_readiness(
        Path(release_evidence) if release_evidence is not None else None, checksum, import_ready,
    )
    cutover_ready = release["ready"]
    return {
        "batchId": checksum,
        "source": {"sourceId": manifest_data.get("sourceId") if manifest_data else data.get("sourceId"), "archiveSha256": checksum, "tableCounts": source_counts},
        "target": {"counts": counts, "legacyImportRows": len(imported), "receiptCounts": receipt_counts},
        "quarantine": {"count": quarantined, "unresolvedAttachments": unresolved},
        "unmappedSourceTables": unmapped,
        "staticReferenceFailures": static_reference_failures,
        "receipts": receipt,
        "allArchivedRowsMatch": True,
        "passwordHashesPreserved": True,
        "babyMembershipBackfillMatches": True,
        "canonicalReconciliation": canonical,
        "importIntegrityReady": import_ready,
        "releaseCutoverReady": cutover_ready,
        "releaseGate": release,
        "businessHistoryReady": import_ready,
        "loginDataReady": True,
        "cutoverReady": cutover_ready,
        "requiredFollowUp": [] if cutover_ready else ["complete every materializer and resolve all quarantine/unresolved attachment entries", "rerun from a final stopped-writer immutable source snapshot", "perform a fresh-target rehearsal with rollback evidence"],
    }


def main(argv=None, *, verifier=verify) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--manifest")
    parser.add_argument("--target-container", default="growdesk-postgres-1")
    parser.add_argument("--receipt-dir")
    parser.add_argument("--output")
    parser.add_argument("--release-evidence", type=Path)
    parser.add_argument("--require", choices=("import", "release"), default="release")
    args = parser.parse_args(argv)
    try:
        result = verifier(args.archive, manifest=args.manifest, target_container=args.target_container,
                          receipt_dir=args.receipt_dir, release_evidence=args.release_evidence)
        if args.output:
            output = Path(args.output).resolve()
            output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            import os
            descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        key = "importIntegrityReady" if args.require == "import" else "releaseCutoverReady"
        passed = result.get(key) is True
        print(json.dumps({"status": "passed" if passed else "not-ready", "requiredGate": args.require,
                          "importIntegrityReady": result.get("importIntegrityReady") is True,
                          "cutoverReady": result.get("releaseCutoverReady") is True}))
        return 0 if passed else 1
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
