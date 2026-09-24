"""Audit attachment-like references embedded in legacy JSON/text fields.

The ordinary attachment planner can only prove references represented by an
explicit source column (for example ``GrowthMeasurement.imageUrl``).  Some
legacy payloads contain paths inside JSON/text instead.  This module is a
read-only inventory boundary for those values.  It intentionally does not
guess a target business field: every discovered embedded reference is emitted
with a deterministic pointer and an explicit quarantine code so the caller
cannot silently complete an incomplete attachment migration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
from typing import Any, Mapping, Sequence
from urllib.parse import unquote, urlsplit


MAPPING_VERSION = "embedded-attachment-reference-audit-v1"

# Keep this registry deliberately explicit.  Adding a raw JSON/text field to
# the migration source must be accompanied by an audit test and a reviewed
# mapping decision; otherwise the planner will not appear to succeed merely
# because the new field was forgotten.
EMBEDDED_FIELDS: tuple[tuple[str, str], ...] = (
    ("RecordSnapshot", "payloadJson"),
    ("AiJob", "resultJson"),
    ("AiArchive", "content"),
)

_EMBEDDED_PATH = re.compile(
    r"(?<![A-Za-z0-9_])(?:https?://[^\s\"'<>]+|//[^\s\"'<>]+|/?(?:public/)?uploads/[^\s\"'<>]+|/?data/archive/[^\s\"'<>]+|/api/attachments/[A-Za-z0-9._~:-]+)",
    re.IGNORECASE,
)
_TRAILING_PUNCTUATION = ".,;:!?)]}>\"'"
_MEDIA_FIELD_NAMES = {
    "url",
    "uri",
    "path",
    "src",
    "imageurl",
    "imageuri",
    "imagepath",
    "photourl",
    "photouri",
    "photopath",
    "pictureurl",
    "pictureuri",
    "picturepath",
    "audiourl",
    "audiouri",
    "audiopath",
    "voiceurl",
    "voiceuri",
    "voicepath",
    "videourl",
    "videouri",
    "videopath",
    "mediaurl",
    "mediauri",
    "mediapath",
    "fileurl",
    "fileuri",
    "filepath",
    "attachmenturl",
    "attachmenturi",
    "attachmentpath",
    "sourceurl",
    "sourceuri",
    "sourcepath",
}


class EmbeddedAuditError(ValueError):
    """The immutable source envelope cannot be audited safely."""


def _value_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _pointer(parts: Sequence[str | int]) -> str:
    result = ""
    for part in parts:
        value = str(part).replace("~", "~0").replace("/", "~1")
        result += f"/{value}"
    return result or "/"


def _trim_candidate(value: str) -> str:
    return value.strip().rstrip(_TRAILING_PUNCTUATION)


def _normalise_path(value: str) -> tuple[str | None, str | None]:
    """Return a safe archive-relative path or a stable quarantine code."""

    raw = _trim_candidate(value)
    if not raw:
        return None, "EMBEDDED_EMPTY_REFERENCE"
    parts = urlsplit(raw)
    if parts.scheme or parts.netloc or parts.query or parts.fragment:
        return None, "EMBEDDED_EXTERNAL_REFERENCE"
    if "\\" in raw or "\x00" in raw:
        return None, "EMBEDDED_UNSAFE_REFERENCE"
    if "%" in raw:
        decoded = unquote(raw)
        if decoded != raw or ".." in PurePosixPath(decoded).parts:
            return None, "EMBEDDED_PATH_TRAVERSAL"
        return None, "EMBEDDED_ENCODED_REFERENCE"
    if raw.startswith("/api/attachments/"):
        # A protected target URL is still a reference that needs a source
        # mapping.  It must not be mistaken for a legacy file path.
        return None, "EMBEDDED_CANONICAL_REFERENCE"
    normalized = raw.lstrip("/")
    if normalized.startswith("uploads/"):
        normalized = "public/" + normalized
    path = PurePosixPath(normalized)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        return None, "EMBEDDED_PATH_TRAVERSAL"
    normalized = path.as_posix()
    if not (normalized.startswith("public/uploads/") or normalized.startswith("data/archive/")):
        return None, "EMBEDDED_PATH_OUTSIDE_ALLOWED_ROOT"
    return normalized, None


def _looks_like_media_key(key: str) -> bool:
    lowered = key.strip().lower()
    return lowered in _MEDIA_FIELD_NAMES


def _candidate_values(value: str, key_hint: str | None) -> list[str]:
    candidates: list[str] = []
    if key_hint is not None and _looks_like_media_key(key_hint):
        candidates.append(value)
    candidates.extend(match.group(0) for match in _EMBEDDED_PATH.finditer(value))
    # Preserve order while removing repeated matches in one scalar.  The
    # caller performs source-row/path deduplication across JSON pointers.
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))


def _walk(value: Any, pointer: tuple[str | int, ...], *, key_hint: str | None = None) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, Mapping):
        for key, child in value.items():
            if not isinstance(key, str):
                continue
            found.extend(_walk(child, (*pointer, key), key_hint=key))
        return found
    if isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(_walk(child, (*pointer, index), key_hint=key_hint))
        return found
    if not isinstance(value, str):
        return found

    for candidate in _candidate_values(value, key_hint):
        normalized, code = _normalise_path(candidate)
        found.append({
            "jsonPointer": _pointer(pointer),
            "rawHash": _value_hash(candidate),
            "normalizedPath": normalized,
            "code": code or "EMBEDDED_REFERENCE_UNMAPPED",
        })

    # Legacy JSON columns were exported both as parsed objects and as raw JSON
    # strings.  Parse a bounded JSON scalar once so nested media keys are
    # inventoried with a useful pointer.  Invalid JSON remains ordinary text;
    # root paths in it were already scanned above.
    stripped = value.lstrip()
    if stripped.startswith(("{", "[")):
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError, json.JSONDecodeError):
            parsed = None
        if isinstance(parsed, (Mapping, list)):
            found.extend(_walk(parsed, (*pointer, "$json")))
    return found


def _rows(snapshot: Mapping[str, Any], table: str) -> list[Mapping[str, Any]]:
    tables = snapshot.get("tables")
    if not isinstance(tables, Mapping):
        raise EmbeddedAuditError("legacy.json tables must be an object")
    raw = tables.get(table, [])
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise EmbeddedAuditError(f"legacy.json tables.{table} must be an array")
    rows: list[Mapping[str, Any]] = []
    for index, row in enumerate(raw):
        if not isinstance(row, Mapping):
            raise EmbeddedAuditError(f"legacy.json tables.{table}[{index}] must be an object")
        rows.append(row)
    return rows


def audit_embedded_references(snapshot: Mapping[str, Any]) -> dict[str, Any]:
    """Return a deterministic, source-content-free embedded reference report."""

    fields: list[dict[str, Any]] = []
    references: dict[tuple[str, str, str, str, str], dict[str, Any]] = {}
    quarantine: list[dict[str, Any]] = []
    rows_scanned = 0

    for table, field in EMBEDDED_FIELDS:
        rows = _rows(snapshot, table)
        rows_with_references = 0
        for row in rows:
            rows_scanned += 1
            source_id = row.get("id")
            if not isinstance(source_id, str) or not source_id:
                quarantine.append({
                    "code": "EMBEDDED_INVALID_SOURCE_ID",
                    "message": "embedded reference source row has no stable id",
                    "sourceTable": table,
                    "sourceField": field,
                })
                continue
            raw = row.get(field)
            if raw in (None, ""):
                continue
            found = _walk(raw, ())
            if not found:
                continue
            rows_with_references += 1
            for item in found:
                normalized = item.get("normalizedPath")
                code = str(item["code"])
                # Same source row/path can be present under multiple JSON keys;
                # report it once with all pointers, while retaining every row
                # as a migration stop condition.
                dedup_path = normalized if isinstance(normalized, str) else f"{code}:{item['rawHash']}"
                key = (table, source_id, field, dedup_path, code)
                current = references.get(key)
                if current is None:
                    current = {
                        "sourceTable": table,
                        "sourceId": source_id,
                        "sourceField": field,
                        "jsonPointers": [item["jsonPointer"]],
                        "rawHash": item["rawHash"],
                        "normalizedPath": normalized,
                        "code": code,
                    }
                    references[key] = current
                elif item["jsonPointer"] not in current["jsonPointers"]:
                    current["jsonPointers"].append(item["jsonPointer"])

        fields.append({
            "sourceTable": table,
            "sourceField": field,
            "rowsScanned": len(rows),
            "rowsWithReferences": rows_with_references,
        })

    ordered = sorted(
        references.values(),
        key=lambda item: (
            item["sourceTable"],
            item["sourceId"],
            item["sourceField"],
            item.get("normalizedPath") or "",
            item["code"],
        ),
    )
    for item in ordered:
        item["jsonPointers"] = sorted(item["jsonPointers"])
        quarantine.append({
            "code": item["code"],
            "message": "embedded attachment reference has no approved canonical mapping",
            "sourceTable": item["sourceTable"],
            "sourceId": item["sourceId"],
            "sourceField": item["sourceField"],
            "jsonPointers": item["jsonPointers"],
            "sourcePath": item.get("normalizedPath"),
        })

    unique_paths = {item["normalizedPath"] for item in ordered if isinstance(item.get("normalizedPath"), str)}
    return {
        "mappingVersion": MAPPING_VERSION,
        "status": "quarantined" if quarantine else "ready",
        "fields": fields,
        "references": ordered,
        "quarantine": quarantine,
        "counts": {
            "fieldsScanned": len(EMBEDDED_FIELDS),
            "rowsScanned": rows_scanned,
            "rowsWithReferences": sum(int(item["rowsWithReferences"]) for item in fields),
            "references": len(ordered),
            "uniquePaths": len(unique_paths),
            "quarantined": len(quarantine),
        },
    }


def _load_snapshot(path: str | os.PathLike[str]) -> Mapping[str, Any]:
    candidate = Path(path).expanduser()
    if candidate.is_dir():
        candidate = candidate / "legacy.json"
    if candidate.is_symlink() or not candidate.is_file():
        raise EmbeddedAuditError("legacy archive must be a regular non-symlink file")
    try:
        value = json.loads(candidate.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError, json.JSONDecodeError) as error:
        raise EmbeddedAuditError("legacy archive is not valid UTF-8 JSON") from error
    if not isinstance(value, Mapping):
        raise EmbeddedAuditError("legacy archive must be an object")
    return value


def _write_new(path: Path, value: Mapping[str, Any]) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite audit report: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
    except BaseException:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, help="private legacy.json or immutable snapshot directory")
    parser.add_argument("--output", required=True, help="new 0600 JSON audit report")
    parser.add_argument("--allow-quarantine", action="store_true", help="return success for inspection with unresolved references")
    args = parser.parse_args(argv)
    output = Path(args.output).expanduser()
    try:
        report = audit_embedded_references(_load_snapshot(args.archive))
    except (EmbeddedAuditError, OSError, ValueError) as error:
        report = {
            "mappingVersion": MAPPING_VERSION,
            "status": "invalid_archive",
            "fields": [],
            "references": [],
            "quarantine": [{"code": "INVALID_ARCHIVE", "message": str(error)}],
            "counts": {"fieldsScanned": 0, "rowsScanned": 0, "rowsWithReferences": 0, "references": 0, "uniquePaths": 0, "quarantined": 1},
        }
        _write_new(output, report)
        print(json.dumps({"status": report["status"], "quarantined": 1}))
        return 0 if args.allow_quarantine else 1
    _write_new(output, report)
    print(json.dumps({"status": report["status"], "references": report["counts"]["references"], "quarantined": report["counts"]["quarantined"]}))
    return 0 if args.allow_quarantine or report["status"] == "ready" else 1


if __name__ == "__main__":
    raise SystemExit(main())
