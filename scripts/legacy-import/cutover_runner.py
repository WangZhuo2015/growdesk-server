"""Run the ordered, fail-closed legacy import on an owned GrowDesk target.

This module is intentionally a small orchestration boundary.  The individual
materializers stay pure and render private SQL; this runner supplies the
immutable archive proof, executes one materializer at a time, and records only
aggregate phase receipts.  It refuses to guess a snapshot, a target
container, or an object-store configuration.

The runner is for the final cutover rehearsal/import command only.  It is not a
test harness and it never changes the legacy SQLite database.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
from typing import Any, Callable, Mapping, Sequence


ROOT = Path(__file__).resolve().parents[2]
SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
PHASES = (
    "migrations",
    "identity",
    "care",
    "food",
    "medical",
    "supplement_vaccine",
    "ai_history",
    "voice",
    "record_snapshot",
    # The private object store must be populated before binary AiArchive rows
    # can be promoted.  The report still presents the archive phase after the
    # promotion phase and calls out this dependency explicitly.
    "attachment_promotion",
    "ai_archive",
    "attachment_reference_backfill",
    "target_verification",
)
MATERIALIZERS = {
    "care": ("materialize_care.py", ()),
    "food": ("materialize_food.py", ()),
    "medical": ("materialize_medical.py", ()),
    "supplement_vaccine": ("materialize_supplement_vaccine.py", ()),
    "ai_history": ("materialize_ai_history.py", ("--quarantine-output",)),
    "voice": ("materialize_voice_logs.py", ()),
    "record_snapshot": ("materialize_record_snapshots.py", ()),
}


class CutoverError(RuntimeError):
    """A safe, source-free error suitable for a phase receipt."""


def _canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _private_regular_file(path: Path, label: str) -> Path:
    if path.is_symlink() or not path.is_file():
        raise CutoverError(f"{label} must be a regular file")
    mode = stat.S_IMODE(path.stat().st_mode)
    if mode & 0o077:
        raise CutoverError(f"{label} must not be group/world accessible")
    return path


def _regular_file(path: Path, label: str) -> Path:
    if path.is_symlink() or not path.is_file():
        raise CutoverError(f"{label} must be a regular file")
    return path


def _private_directory(path: Path, label: str, *, create: bool = False) -> Path:
    if path.exists():
        if path.is_symlink() or not path.is_dir():
            raise CutoverError(f"{label} must be a real directory")
    elif create:
        path.mkdir(mode=0o700, parents=True)
    else:
        raise CutoverError(f"{label} does not exist")
    path.chmod(0o700)
    if stat.S_IMODE(path.stat().st_mode) & 0o077:
        raise CutoverError(f"{label} must not be group/world accessible")
    return path


def _required_hash(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA256.fullmatch(value) is None:
        raise CutoverError(f"{label} must be a lowercase SHA-256")
    return value


def validate_snapshot(snapshot: str | os.PathLike[str], manifest: str | os.PathLike[str]) -> dict[str, Any]:
    """Validate the immutable source proof without printing source content."""

    root = Path(snapshot).expanduser().resolve()
    _private_directory(root, "snapshot")
    manifest_path = Path(manifest).expanduser().resolve()
    # The manifest contains only aggregate provenance and is produced by the
    # existing snapshot tool with ordinary metadata permissions.  The raw
    # archive and source.sqlite remain private below.
    _regular_file(manifest_path, "snapshot manifest")
    if manifest_path.parent != root:
        raise CutoverError("manifest must be inside the explicit snapshot directory")
    try:
        manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(manifest_data, dict):
            raise ValueError
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise CutoverError("snapshot manifest is invalid") from error

    source_id = manifest_data.get("sourceId")
    if not isinstance(source_id, str) or not source_id:
        raise CutoverError("manifest sourceId is required")
    archive_hash = _required_hash(manifest_data.get("archiveSha256"), "manifest archiveSha256")
    source_hash = _required_hash(manifest_data.get("sourceSha256"), "manifest sourceSha256")

    archive_path = _private_regular_file(root / "legacy.json", "legacy archive")
    actual_archive_hash = sha256_file(archive_path)
    if actual_archive_hash != archive_hash:
        raise CutoverError("legacy archive hash does not match manifest")
    source_path = _private_regular_file(root / "source.sqlite", "source snapshot")
    if sha256_file(source_path) != source_hash:
        raise CutoverError("source snapshot hash does not match manifest")
    try:
        archive = json.loads(archive_path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise CutoverError("legacy archive is invalid") from error
    if not isinstance(archive, dict) or archive.get("formatVersion") != 1:
        raise CutoverError("unsupported legacy archive format")
    if archive.get("sourceId") != source_id or archive.get("sourceSha256") != source_hash:
        raise CutoverError("archive source identity does not match manifest")
    tables = archive.get("tables")
    if not isinstance(tables, dict):
        raise CutoverError("legacy archive tables must be an object")
    manifest_counts = manifest_data.get("counts")
    if manifest_counts is not None:
        if not isinstance(manifest_counts, dict):
            raise CutoverError("manifest counts must be an object")
        actual_counts = {str(name): len(rows) for name, rows in tables.items() if isinstance(rows, list)}
        if {str(k): int(v) for k, v in manifest_counts.items()} != actual_counts:
            raise CutoverError("manifest table counts do not match immutable archive")
    return {
        "root": str(root),
        "manifest": str(manifest_path),
        "archive": str(archive_path),
        "sourceSnapshot": str(source_path),
        "sourceId": source_id,
        "sourceSha256": source_hash,
        "archiveSha256": archive_hash,
        "manifestSha256": sha256_file(manifest_path),
        "tableCounts": {str(name): len(rows) for name, rows in tables.items() if isinstance(rows, list)},
    }


def read_private_env(path: str | os.PathLike[str]) -> dict[str, str]:
    """Read a deployment env file without ever echoing its values."""

    env_path = _private_regular_file(Path(path).expanduser().resolve(), "runtime env")
    values: dict[str, str] = {}
    for line in env_path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "=" not in stripped:
            raise CutoverError("runtime env contains an invalid line")
        key, value = stripped.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or "\n" in value or "\r" in value:
            raise CutoverError("runtime env contains an invalid key/value")
        values[key] = value
    return values


def validate_attachment_config(values: Mapping[str, str]) -> None:
    """Fail before any attachment phase if the private store is not configured."""

    required = ("S3_BUCKET", "S3_REGION", "S3_ENDPOINT", "MINIO_ROOT_USER", "MINIO_ROOT_PASSWORD")
    missing = [name for name in required if not values.get(name)]
    if missing:
        raise CutoverError("attachment storage configuration is incomplete")
    if values.get("S3_ENDPOINT") != "http://storage:9000":
        raise CutoverError("attachment storage endpoint must use the private GrowDesk service")
    password = values.get("POSTGRES_SUPERUSER_PASSWORD")
    if not password or re.fullmatch(r"[0-9a-f]{64}", password) is None:
        raise CutoverError("target database superuser configuration is incomplete")


def _safe_summary(value: Any) -> Any:
    """Keep only bounded aggregate values in receipts."""

    if isinstance(value, dict):
        return {str(key): _safe_summary(item) for key, item in value.items() if str(key).lower() not in {"payload", "content", "body", "token", "secret"}}
    if isinstance(value, list):
        return [_safe_summary(item) for item in value[:100]]
    if isinstance(value, (str, int, float, bool)) or value is None:
        if isinstance(value, str) and len(value) > 256:
            return value[:256]
        return value
    return None


def _write_json_private(path: Path, value: Mapping[str, Any], *, replace: bool = False) -> None:
    if path.exists() and not replace:
        raise CutoverError("receipt path already exists")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    flags = os.O_WRONLY | os.O_CREAT | (os.O_TRUNC if replace else os.O_EXCL)
    fd = os.open(path, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")
    finally:
        if os.path.exists(path):
            path.chmod(0o600)


class CommandExecutor:
    """Subprocess boundary which deliberately discards command output."""

    def __init__(self, *, docker: str = "docker", python: str = "python3") -> None:
        self.docker = docker
        self.python = python

    def run(self, args: Sequence[str], *, input_path: Path | None = None, env: Mapping[str, str] | None = None) -> str:
        input_stream = input_path.open("rb") if input_path is not None else None
        try:
            result = subprocess.run(
                list(args),
                stdin=input_stream,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=dict(env) if env is not None else None,
                check=False,
            )
        finally:
            if input_stream is not None:
                input_stream.close()
        if result.returncode != 0:
            raise CutoverError("phase command failed")
        # Commands may return a final aggregate JSON row.  Parse only that row
        # and discard all other output; source rows and SQL errors never enter a
        # receipt.
        lines = [line.strip() for line in result.stdout.decode("utf-8", "replace").splitlines() if line.strip()]
        if not lines:
            return ""
        try:
            return json.dumps(_safe_summary(json.loads(lines[-1])), ensure_ascii=False, sort_keys=True)
        except (ValueError, json.JSONDecodeError):
            return ""


def validate_target_container(executor: CommandExecutor, container: str) -> None:
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+", container):
        raise CutoverError("target container name is invalid")
    try:
        raw = subprocess.check_output([executor.docker, "inspect", container], stderr=subprocess.DEVNULL, text=True)
        value = json.loads(raw)[0]
    except (OSError, subprocess.SubprocessError, ValueError, IndexError, KeyError) as error:
        raise CutoverError("target PostgreSQL container cannot be inspected") from error
    labels = value.get("Config", {}).get("Labels", {})
    if labels.get("com.docker.compose.project") != "growdesk" or labels.get("com.docker.compose.service") != "postgres":
        raise CutoverError("target must be the growdesk Compose PostgreSQL service")
    image = value.get("Config", {}).get("Image", "")
    if not isinstance(image, str) or not image.startswith("postgres:18.6-bookworm@sha256:"):
        raise CutoverError("target PostgreSQL image is not the pinned GrowDesk image")
    if value.get("HostConfig", {}).get("PortBindings"):
        raise CutoverError("target PostgreSQL must not expose host ports")
    networks = value.get("NetworkSettings", {}).get("Networks", {})
    if "growdesk-db" not in networks:
        raise CutoverError("target PostgreSQL is not on the private GrowDesk database network")


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class CutoverRunner:
    def __init__(
        self,
        *,
        snapshot: Mapping[str, Any],
        receipt_dir: Path,
        target_container: str,
        migration_image: str,
        runtime_env: Mapping[str, str],
        executor: CommandExecutor | None = None,
    ) -> None:
        self.snapshot = snapshot
        self.receipt_dir = _private_directory(receipt_dir, "receipt directory", create=True)
        self.target_container = target_container
        self.migration_image = migration_image
        self.runtime_env = dict(runtime_env)
        self.executor = executor or CommandExecutor()
        self.results: list[dict[str, Any]] = []

    def receipt_path(self, phase: str) -> Path:
        return self.receipt_dir / f"phase-{PHASES.index(phase):02d}-{phase}.json"

    def phase(self, name: str, action: Callable[[], Mapping[str, Any] | None]) -> Mapping[str, Any]:
        if name not in PHASES:
            raise CutoverError("unknown cutover phase")
        started = _now()
        receipt: dict[str, Any] = {
            "phase": name,
            "status": "running",
            "startedAt": started,
            "sourceId": self.snapshot["sourceId"],
            "archiveSha256": self.snapshot["archiveSha256"],
        }
        _write_json_private(self.receipt_path(name), receipt)
        try:
            detail = action() or {}
            receipt.update({"status": "completed", "finishedAt": _now(), "detail": _safe_summary(detail)})
            _write_json_private(self.receipt_path(name), receipt, replace=True)
            self.results.append(receipt)
            return receipt
        except Exception as error:
            receipt.update({"status": "failed", "finishedAt": _now(), "error": type(error).__name__})
            _write_json_private(self.receipt_path(name), receipt, replace=True)
            self.results.append(receipt)
            raise

    def _psql(self, sql_path: Path) -> str:
        return self.executor.run(
            [self.executor.docker, "exec", "-i", self.target_container, "psql", "-X", "-U", "postgres", "-d", "growdesk", "-v", "ON_ERROR_STOP=1", "-At"],
            input_path=sql_path,
        )

    def run_materializer(self, phase: str, script: str, extra: Sequence[str] = ()) -> Mapping[str, Any]:
        output = self.receipt_dir / f"{phase}.sql"
        args = [
            self.executor.python,
            str(ROOT / "scripts/legacy-import" / script),
            "--archive", self.snapshot["archive"],
            "--sha256", self.snapshot["archiveSha256"],
            "--output", str(output),
        ]
        if "--quarantine-output" in extra:
            args.extend(["--quarantine-output", str(self.receipt_dir / f"{phase}-quarantine.json")])
        if phase == "ai_archive":
            args.extend(["--attachment-report", str(self.receipt_dir / "attachment-promotion.json"), "--quarantine-output", str(self.receipt_dir / "ai_archive-quarantine.json")])
        self.executor.run(args)
        summary = self._psql(output)
        output.unlink(missing_ok=True)
        return {"mappingScript": script, "databaseSummary": summary}

    def _run_attachment_container(self, args: Sequence[str], env_file: Path) -> str:
        return self.executor.run([
            self.executor.docker, "run", "--rm",
            "--network", "growdesk-db", "--network", "growdesk-storage",
            "--env-file", str(env_file),
            "-v", f"{self.snapshot['root']}:/migration/input:ro",
            "-v", f"{self.receipt_dir}:/migration/work:rw",
            "--entrypoint", "node",
            self.migration_image,
            *args,
        ])

    def run(self) -> Mapping[str, Any]:
        validate_target_container(self.executor, self.target_container)
        validate_attachment_config(self.runtime_env)
        env_path = self.receipt_dir / "target.env"
        db_password = self.runtime_env["POSTGRES_SUPERUSER_PASSWORD"]
        if any(char in db_password for char in "\r\n"):
            raise CutoverError("target database credential is invalid")
        _write_private_env = f"DATABASE_URL=postgresql://postgres:{db_password}@postgres:5432/growdesk\n"
        fd = os.open(env_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(_write_private_env)
                for key in ("S3_BUCKET", "S3_REGION", "S3_ENDPOINT"):
                    stream.write(f"{key}={self.runtime_env[key]}\n")
                stream.write(f"AWS_ACCESS_KEY_ID={self.runtime_env['MINIO_ROOT_USER']}\n")
                stream.write(f"AWS_SECRET_ACCESS_KEY={self.runtime_env['MINIO_ROOT_PASSWORD']}\n")
        finally:
            env_path.chmod(0o600)

        try:
            self.phase("migrations", lambda: {"migrationImage": self.migration_image, "summary": self.executor.run([
                self.executor.docker, "run", "--rm", "--network", "growdesk-db", "--env-file", str(env_path), self.migration_image,
            ])})
            identity_sql = self.receipt_dir / "identity.sql"
            self.executor.run([
                self.executor.python, str(ROOT / "scripts/legacy-import/import_sql.py"),
                "--archive", self.snapshot["archive"], "--sha256", self.snapshot["archiveSha256"], "--output", str(identity_sql),
            ])
            self.phase("identity", lambda: {"databaseSummary": self._psql(identity_sql)})
            identity_sql.unlink(missing_ok=True)

            for phase in ("care", "food", "medical", "supplement_vaccine", "ai_history", "voice", "record_snapshot"):
                script, extra = MATERIALIZERS[phase]
                self.phase(phase, lambda phase=phase, script=script, extra=extra: self.run_materializer(phase, script, extra))

            # Planner output is a prerequisite for both the object-store write
            # and the AiArchive renderer.  A quarantine is a hard stop.
            plan_path = self.receipt_dir / "attachment-promotion.json"
            self.phase("attachment_promotion", lambda: self._attachment_promotion(env_path, plan_path))
            self.phase("ai_archive", lambda: self.run_materializer("ai_archive", "materialize_ai_archive.py"))
            self.phase("attachment_reference_backfill", lambda: self._attachment_reference_backfill(env_path, plan_path))
            verification = self.phase("target_verification", self._verification)
            report = {
                "status": "cutover-ready" if verification.get("detail", {}).get("cutoverReady") else "not-cutover-ready",
                "cutoverReady": bool(verification.get("detail", {}).get("cutoverReady")),
                "source": {
                    "sourceId": self.snapshot["sourceId"],
                    "archiveSha256": self.snapshot["archiveSha256"],
                    "manifestSha256": self.snapshot["manifestSha256"],
                    "tableCounts": self.snapshot["tableCounts"],
                },
                "phases": self.results,
                "requiredFollowUp": [
                    "take a final stopped-writer SQLite snapshot and rerun this import",
                    "complete a fresh-target rehearsal with rollback evidence",
                    "switch routing only after the verification report is cutover-ready",
                ],
            }
            _write_json_private(self.receipt_dir / "cutover-report.json", report)
            if not report["cutoverReady"]:
                raise CutoverError("target verification is not cutover-ready")
            return report
        finally:
            env_path.unlink(missing_ok=True)

    def _attachment_promotion(self, env_path: Path, plan_path: Path) -> Mapping[str, Any]:
        self.executor.run([
            self.executor.python, str(ROOT / "scripts/legacy-import/attachment_promotion.py"),
            "--archive", self.snapshot["root"], "--output", str(plan_path),
        ])
        report = json.loads(plan_path.read_text(encoding="utf-8"))
        if report.get("status") != "planned" or report.get("counts", {}).get("quarantined", 0) != 0:
            raise CutoverError("attachment plan contains quarantine entries")
        summary = self._run_attachment_container([
            "--import", "tsx", "scripts/legacy-import/attachment-promotion-cli.ts",
            "--archive", "/migration/input", "--plan", "/migration/work/attachment-promotion.json",
            "--report", "/migration/work/attachment-runtime.json", "--bucket", self.runtime_env["S3_BUCKET"], "--execute",
        ], env_path)
        runtime_report = json.loads((self.receipt_dir / "attachment-runtime.json").read_text(encoding="utf-8"))
        if runtime_report.get("status") != "completed" or runtime_report.get("counts", {}).get("quarantined", 0) != 0:
            raise CutoverError("attachment promotion did not complete cleanly")
        return {"runtimeSummary": summary, "counts": runtime_report.get("counts", {})}

    def _attachment_reference_backfill(self, env_path: Path, promotion_path: Path) -> Mapping[str, Any]:
        # The runtime report contains the verified receipts required by the
        # pure reference planner; retain it only for this phase.
        runtime_path = self.receipt_dir / "attachment-runtime.json"
        if not runtime_path.is_file():
            raise CutoverError("attachment promotion receipt is missing")
        summary = self._run_attachment_container([
            "--import", "tsx", "scripts/legacy-import/attachment-reference-backfill-cli.ts",
            "--promotion-report", "/migration/work/attachment-promotion.json",
            "--report", "/migration/work/attachment-reference.json", "--execute",
        ], env_path)
        result = json.loads((self.receipt_dir / "attachment-reference.json").read_text(encoding="utf-8"))
        if result.get("status") != "completed" or result.get("counts", {}).get("quarantined", 0) != 0:
            raise CutoverError("attachment reference backfill did not complete cleanly")
        return {"runtimeSummary": summary, "counts": result.get("counts", {})}

    def _verification(self) -> Mapping[str, Any]:
        output = self.receipt_dir / "target-verification.json"
        self.executor.run([
            self.executor.python, str(ROOT / "scripts/legacy-import/verify_target.py"),
            "--archive", self.snapshot["archive"], "--manifest", self.snapshot["manifest"],
            "--target-container", self.target_container, "--receipt-dir", str(self.receipt_dir), "--output", str(output),
        ])
        value = json.loads(output.read_text(encoding="utf-8"))
        if not isinstance(value, dict):
            raise CutoverError("target verifier returned an invalid report")
        return value


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--receipt-dir", required=True)
    parser.add_argument("--target-container", default="growdesk-postgres-1")
    parser.add_argument("--migration-image", required=True)
    parser.add_argument("--runtime-env-file", required=True)
    args = parser.parse_args(argv)
    try:
        snapshot = validate_snapshot(args.snapshot, args.manifest)
        runtime_env = read_private_env(args.runtime_env_file)
        runner = CutoverRunner(
            snapshot=snapshot,
            receipt_dir=Path(args.receipt_dir).expanduser().resolve(),
            target_container=args.target_container,
            migration_image=args.migration_image,
            runtime_env=runtime_env,
        )
        report = runner.run()
        print(json.dumps({"status": report["status"], "cutoverReady": report["cutoverReady"]}, ensure_ascii=False))
        return 0
    except Exception as error:
        print(json.dumps({"error": type(error).__name__}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
