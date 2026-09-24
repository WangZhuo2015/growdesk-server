#!/usr/bin/env python3
"""Read-only source/build audit. A source PASS is never production permission.

Only executes the reviewed API binary's metadata flags and read-only Git commands.
Does not load .env, contact a service, migrate data, change refs, or deploy anything.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from typing import Any

REFERENCE = "f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4"
METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
REVISION = re.compile(r"[0-9a-f]{40}\Z")
MAX_JSON_BYTES = 8 * 1024 * 1024


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON property")
        result[key] = value
    return result


def decode_json(raw: bytes) -> Any:
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("Metadata exceeds audit size budget")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)


def metadata_command(command: list[str], cwd: Path) -> bytes:
    # No inherited DATABASE_URL, JWT, cloud credentials, proxies or .env loading.
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LANG": "C.UTF-8", "GIT_TERMINAL_PROMPT": "0"}
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, timeout=30, check=False)
    if result.returncode:
        # Stderr is intentionally not copied: metadata failures must not leak secrets.
        raise ValueError(f"Metadata command failed with exit code {result.returncode}")
    if len(result.stdout) > MAX_JSON_BYTES:
        raise ValueError("Metadata exceeds audit size budget")
    return result.stdout


def git_identity(root: Path) -> dict[str, Any]:
    top = Path(metadata_command(["git", "rev-parse", "--show-toplevel"], root).decode().strip()).resolve()
    if top != root:
        raise ValueError("Each source root must be a Git worktree root")
    sha = metadata_command(["git", "rev-parse", "HEAD"], root).decode().strip()
    tree = metadata_command(["git", "rev-parse", "HEAD^{tree}"], root).decode().strip()
    if not REVISION.fullmatch(sha) or not REVISION.fullmatch(tree):
        raise ValueError("Immutable Git identity is required")
    dirty = bool(metadata_command(["git", "status", "--porcelain", "--untracked-files=normal"], root).strip())
    return {"commit": sha, "tree": tree, "dirty": dirty}


def source(root: Path, relative: str) -> str:
    target = root / relative
    if not target.resolve().is_relative_to(root):
        raise ValueError("Source file escapes the worktree")
    raw = target.read_bytes()
    if len(raw) > MAX_JSON_BYTES:
        raise ValueError("Source file exceeds audit size budget")
    return raw.decode("utf-8")


def inventory_summary(contract: Any, inventory: Any) -> dict[str, Any]:
    if not isinstance(contract, dict) or not isinstance(contract.get("paths"), dict):
        raise ValueError("Invalid OpenAPI paths")
    if not isinstance(inventory, dict) or inventory.get("reference") != REFERENCE:
        raise ValueError("Native reference changed without an audited rebaseline")
    expected: dict[tuple[str, str], str] = {}
    operation_ids: set[str] = set()
    for path, item in contract["paths"].items():
        if not isinstance(path, str) or not isinstance(item, dict):
            raise ValueError("Invalid OpenAPI path item")
        for method, operation in item.items():
            if method not in METHODS:
                continue
            if not isinstance(operation, dict) or not isinstance(operation.get("operationId"), str):
                raise ValueError("Missing OpenAPI operationId")
            operation_id = operation["operationId"]
            if not operation_id or operation_id in operation_ids:
                raise ValueError("Duplicate or empty OpenAPI operationId")
            operation_ids.add(operation_id)
            expected[(method.upper(), path)] = operation_id
    rows = inventory.get("operations")
    if not isinstance(rows, list):
        raise ValueError("Native operations must be an array")
    seen: set[tuple[str, str]] = set()
    missing: list[dict[str, str]] = []
    for row in rows:
        if not isinstance(row, dict) or any(not isinstance(row.get(field), str) for field in ("method", "path", "operationId")):
            raise ValueError("Invalid native operation")
        key = (row["method"], row["path"])
        if key in seen or expected.get(key) != row["operationId"]:
            raise ValueError("Duplicate, unknown or mismatched native operation")
        if type(row.get("implemented")) is not bool:
            raise ValueError("Implemented must be a JSON boolean, not truthy data")
        seen.add(key)
        if not row["implemented"]:
            missing.append({field: row[field] for field in ("method", "path", "operationId")})
    if seen != set(expected):
        raise ValueError("Inventory does not enumerate the complete contract")
    return {"declared": len(expected), "implemented": len(expected) - len(missing),
            "missing": sorted(missing, key=lambda row: row["operationId"])}


def known_source_blockers(server: Path, web: Path) -> list[dict[str, Any]]:
    blockers: list[dict[str, Any]] = []
    config = source(server, "internal/backend/config.go")
    if "native Go preview refuses production" in config:
        blockers.append({"code": "PRODUCTION_GUARD_ACTIVE", "path": "internal/backend/config.go"})
    if "ValidateDatabaseURL(c.DatabaseURL, true)" in config:
        blockers.append({"code": "PREVIEW_DATABASE_ENFORCED", "path": "internal/backend/config.go"})
    absent = [f"cmd/growdesk-{name}/main.go" for name in ("worker", "scheduler", "migrate")
              if not (server / f"cmd/growdesk-{name}/main.go").is_file()]
    if absent:
        blockers.append({"code": "RUNTIME_ENTRYPOINTS_MISSING", "paths": absent})
    dockerfile = source(server, "Dockerfile")
    if 'ENTRYPOINT ["node"' in dockerfile and not any((server / name).is_file() for name in (
        "deploy/Go.Dockerfile", "deploy/systemd/growdesk-api.service")):
        blockers.append({"code": "NO_DEDICATED_GO_DEPLOYMENT", "path": "Dockerfile"})
    policy = source(web, "lib/growdesk/bridge-policy.ts")
    match = re.search(r"GO_PENDING_WEB_ROUTES\s*=\s*new Set\(\s*\[(.*?)\]\s*\)", policy, re.S)
    if match:
        routes = sorted(set(re.findall(r'["\'](/api/[^"\']+)["\']', match.group(1))))
        if routes:
            blockers.append({"code": "WEB_GO_ROUTES_BLOCKED", "routes": routes,
                             "note": "Includes known literals only; dynamic routes and other fences need review"})
    elif "GO_PENDING_WEB_ROUTES" in policy:
        blockers.append({"code": "WEB_CAPABILITY_POLICY_NEEDS_REVIEW"})
    return blockers


def audit(server: Path, web: Path, binary: Path) -> dict[str, Any]:
    if server == web:
        raise ValueError("Web and backend must be separate worktrees")
    server_identity, web_identity = git_identity(server), git_identity(web)
    raw_binary = binary.read_bytes()
    binary_hash = hashlib.sha256(raw_binary).hexdigest()
    del raw_binary
    version = decode_json(metadata_command([str(binary), "--version"], server))
    if not isinstance(version, dict) or version.get("revision") != server_identity["commit"] or version.get("reference") != REFERENCE:
        raise ValueError("Binary revision/reference does not match the audited source")
    inventory = decode_json(metadata_command([str(binary), "--contract-inventory"], server))
    if hashlib.sha256(binary.read_bytes()).hexdigest() != binary_hash:
        raise ValueError("Binary changed during metadata inspection")
    summary = inventory_summary(json.loads(source(server, "contracts/openapi.json")), inventory)
    if summary["declared"] != 151:
        raise ValueError("Frozen 151-operation contract changed; review the rebaseline")
    blockers = known_source_blockers(server, web)
    for name, identity in (("server", server_identity), ("web", web_identity)):
        if identity["dirty"]:
            blockers.append({"code": "DIRTY_SOURCE", "repository": name})
    if summary["missing"]:
        blockers.append({"code": "NATIVE_OPERATIONS_MISSING", "count": len(summary["missing"])})
    baseline = json.loads(source(web, "scripts/review/go-api-baseline.json"))
    if not isinstance(baseline, dict) or baseline.get("commit") != server_identity["commit"]:
        blockers.append({"code": "WEB_ACCEPTANCE_PIN_DIFFERS", "note": "Rerun cross-repository acceptance on the final release pair"})
    # A concurrent checkout/edit cannot silently change the source under this audit.
    if git_identity(server) != server_identity or git_identity(web) != web_identity:
        raise ValueError("Source changed during audit")
    return {"schemaVersion": 1, "scope": "offline source and compiled API inventory only",
            "status": "NO_GO" if blockers else "SOURCE_AUDIT_PASS_REQUIRES_ACCEPTANCE",
            "productionApproved": False, "server": {**server_identity, "binarySha256": binary_hash, "reference": REFERENCE},
            "web": web_identity, "operations": summary, "blockers": blockers,
            "notVerified": ["production startup", "worker execution", "full HTTP parity", "all-page browser/offline behavior",
                            "private S3 bytes", "provider delivery", "source/target reconciliation", "writer fence", "restore rehearsal"],
            "warning": "Static markers are diagnostic, not proofs. Deleting a guard or an unimplemented route never establishes readiness."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-root", type=Path, required=True)
    parser.add_argument("--web-root", type=Path, required=True)
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    server, web, binary = args.server_root.resolve(), args.web_root.resolve(), args.binary.resolve()
    output = args.output.absolute()
    if output.exists() or output.is_symlink():
        parser.error("Refusing to overwrite an existing audit output")
    if any(output.resolve().is_relative_to(root) for root in (server, web)):
        parser.error("Write evidence outside source worktrees")
    try:
        report = audit(server, web, binary)
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        report = {"schemaVersion": 1, "status": "NO_GO", "productionApproved": False,
                  "blockers": [{"code": "AUDIT_INCOMPLETE", "errorType": type(error).__name__}],
                  "note": "No readiness inference is allowed from an incomplete audit; no services were contacted."}
    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if report["status"] == "NO_GO" else 0


if __name__ == "__main__":
    sys.exit(main())
