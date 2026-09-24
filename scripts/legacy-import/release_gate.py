"""Validate release evidence separately from successful database import.

This function never stops services, switches routing, or grants deployment
permission. It accepts only matching, explicitly supplied acceptance receipts.
"""
from __future__ import annotations

import hashlib
import json
import re
import stat
from pathlib import Path
from typing import Any


REQUIRED_CHECKS = ("pairedAcceptance", "attachments", "finalWriterFence", "incrementalReconciliation", "rollbackRehearsal")
REVISION = re.compile(r"^[0-9a-f]{40}$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
MAX_RECEIPT_BYTES = 1_048_576


def _private_bytes(path: Path) -> bytes:
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > MAX_RECEIPT_BYTES:
        raise ValueError("receipt must be a bounded private regular file")
    return path.read_bytes()


def release_readiness(path: Path | None, archive_hash: str, import_ready: bool) -> dict[str, Any]:
    failures: list[str] = [] if import_ready is True else ["IMPORT_INTEGRITY_FAILED"]
    if path is None:
        return {"ready": False, "failures": failures + ["RELEASE_EVIDENCE_REQUIRED"]}
    try:
        if not DIGEST.fullmatch(archive_hash):
            raise ValueError("invalid archive hash")
        manifest = json.loads(_private_bytes(path))
        if not isinstance(manifest, dict) or manifest.get("schemaVersion") != 1 or manifest.get("archiveSha256") != archive_hash:
            raise ValueError("release source mismatch")
        pair = {key: manifest.get(key) for key in ("webCommit", "serverCommit")}
        if any(not isinstance(value, str) or REVISION.fullmatch(value) is None for value in pair.values()):
            raise ValueError("clean immutable revision pair required")
        descriptors = manifest.get("checks")
        if not isinstance(descriptors, dict):
            raise ValueError("release checks required")
        root = path.parent.resolve()
        for name in REQUIRED_CHECKS:
            descriptor = descriptors.get(name)
            if not isinstance(descriptor, dict):
                failures.append(name + ":MISSING")
                continue
            filename, expected = descriptor.get("path"), descriptor.get("sha256")
            if not isinstance(filename, str) or not isinstance(expected, str) or not DIGEST.fullmatch(expected):
                raise ValueError("invalid receipt descriptor")
            relative = Path(filename)
            if relative.is_absolute() or not relative.parts or any(part in (".", "..") for part in relative.parts):
                raise ValueError("receipt path escapes evidence directory")
            candidate = root
            for part in relative.parts:
                candidate = candidate / part
                if candidate.is_symlink():
                    raise ValueError("receipt symlinks are forbidden")
            if not candidate.resolve().is_relative_to(root):
                raise ValueError("receipt outside evidence directory")
            raw = _private_bytes(candidate)
            if hashlib.sha256(raw).hexdigest() != expected:
                failures.append(name + ":HASH_MISMATCH")
                continue
            receipt = json.loads(raw)
            valid = (isinstance(receipt, dict) and receipt.get("passed") is True
                     and receipt.get("sourceDirty") is False and receipt.get("archiveSha256") == archive_hash
                     and all(receipt.get(key) == value for key, value in pair.items()))
            if valid and name == "pairedAcceptance":
                valid = receipt.get("goldenPassed") is True and receipt.get("browserPassed") is True
            elif valid and name == "attachments":
                valid = type(receipt.get("unresolved")) is int and receipt["unresolved"] == 0 and type(receipt.get("quarantined")) is int and receipt["quarantined"] == 0
            elif valid and name == "finalWriterFence":
                valid = receipt.get("writersStopped") is True and receipt.get("finalSnapshot") is True
            elif valid and name == "incrementalReconciliation":
                valid = type(receipt.get("pendingChanges")) is int and receipt["pendingChanges"] == 0
            elif valid and name == "rollbackRehearsal":
                valid = receipt.get("restored") is True and receipt.get("freshTarget") is True
            if not valid:
                failures.append(name + ":NOT_ACCEPTED")
        return {"ready": not failures, "failures": failures, **pair}
    except (OSError, ValueError, TypeError, KeyError):
        return {"ready": False, "failures": failures + ["INVALID_RELEASE_EVIDENCE"]}
