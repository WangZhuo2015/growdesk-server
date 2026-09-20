"""Build a fail-closed plan for promoting legacy files to private attachments.

This module is deliberately a pure, read-only planner.  It reads an immutable
``snapshot.py`` archive (``legacy.json``, ``files.json`` and ``manifest.json``)
and optional exported ``import_rows`` metadata, then emits deterministic
Attachment metadata plus machine-readable receipts and quarantine entries.

It does not connect to PostgreSQL, S3 or MinIO and it never copies a file.  A
separate, reviewed worker must use this plan to copy and hash-verify objects
and insert ``public.attachments`` rows in one idempotent workflow.  Keeping the
boundary explicit prevents a successful local file scan from being reported as
an atomic database/object-storage promotion.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import uuid
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import unquote, urlsplit


MAPPING_VERSION = "attachment-promotion-v1"
REPORT_VERSION = 1
MAX_SOURCE_FILE_BYTES = 256 * 1024 * 1024
MAX_IMAGE_OR_DOCUMENT_BYTES = 20 * 1024 * 1024
MAX_AUDIO_BYTES = 25 * 1024 * 1024

ALLOWED_PURPOSES = {"avatar", "medical_report", "voice_note", "growth_photo"}
ALLOWED_MIME_TYPES = {
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/heic",
    "audio/m4a",
    "audio/wav",
    "audio/mpeg",
    "audio/mp4",
    "application/pdf",
}

_SHA256 = re.compile(r"[0-9a-f]{64}\Z")
_SAFE_KEY_SEGMENT = re.compile(r"^[^/\\\x00-\x1f\x7f]+$")
_EXTENSION_MIME = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".jpe": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".heic": "image/heic",
    ".heif": "image/heic",
    ".m4a": "audio/m4a",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mpeg": "audio/mpeg",
    ".mpga": "audio/mpeg",
    ".mp4": "audio/mp4",
    ".pdf": "application/pdf",
}
_MAGIC_MIME = (
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"%PDF-", "application/pdf"),
)


class AttachmentPromotionError(ValueError):
    """The archive envelope or manifest is not safe to inspect."""


class _MappingError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


def _require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise AttachmentPromotionError(f"{label} must be an object")
    return value


def _read_json(path: Path, root: Path, label: str, *, required: bool = True) -> Any:
    if not path.exists():
        if required:
            raise AttachmentPromotionError(f"Missing {label}")
        return None
    if path.is_symlink() or not path.is_file():
        raise AttachmentPromotionError(f"{label} must be a regular non-symlink file")
    try:
        if not path.resolve(strict=True).is_relative_to(root):
            raise AttachmentPromotionError(f"{label} escapes archive root")
        return json.loads(path.read_text(encoding="utf-8"))
    except UnicodeDecodeError as error:
        raise AttachmentPromotionError(f"{label} is not UTF-8 JSON") from error
    except json.JSONDecodeError as error:
        raise AttachmentPromotionError(f"{label} is not valid JSON") from error


def _source_hash(row: Mapping[str, Any]) -> str:
    try:
        return _sha256_bytes(_canonical_json(row).encode("utf-8"))
    except (TypeError, ValueError) as error:
        raise _MappingError("INVALID_SOURCE_ROW", "source row is not canonical JSON") from error


def _non_empty_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _MappingError("INVALID_METADATA", f"{field} must be a non-empty string")
    return value


def _optional_string(value: Any, field: str) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise _MappingError("INVALID_METADATA", f"{field} must be a string")
    return value


def _valid_hash(value: Any, field: str) -> str:
    if not isinstance(value, str) or _SHA256.fullmatch(value) is None:
        raise _MappingError("INVALID_HASH", f"{field} must be a lowercase SHA-256")
    return value


def _json_rows(value: Any, label: str) -> list[Mapping[str, Any]]:
    if value is None:
        return []
    if isinstance(value, Mapping):
        value = value.get("rows", value.get("items", value))
    if not isinstance(value, list):
        raise AttachmentPromotionError(f"{label} must be an array")
    rows: list[Mapping[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, Mapping):
            raise AttachmentPromotionError(f"{label}[{index}] must be an object")
        rows.append(item)
    return rows


def _table_rows(snapshot: Mapping[str, Any], table: str) -> list[Mapping[str, Any]]:
    tables = snapshot.get("tables")
    if not isinstance(tables, Mapping):
        raise AttachmentPromotionError("legacy.json tables must be an object")
    return _json_rows(tables.get(table, []), f"legacy.json tables.{table}")


def _table_row_index(snapshot: Mapping[str, Any]) -> dict[tuple[str, str], Mapping[str, Any]]:
    tables = snapshot.get("tables")
    if not isinstance(tables, Mapping):
        raise AttachmentPromotionError("legacy.json tables must be an object")
    result: dict[tuple[str, str], Mapping[str, Any]] = {}
    for table, raw_rows in tables.items():
        if not isinstance(table, str):
            raise AttachmentPromotionError("legacy table name must be a string")
        for row in _json_rows(raw_rows, f"legacy.json tables.{table}"):
            row_id = row.get("id")
            if not isinstance(row_id, str) or not row_id:
                # Non-entity/reference rows are still invalid source metadata;
                # do not let them become an ambiguous attachment owner.
                raise AttachmentPromotionError(f"{table} row has no non-empty id")
            key = (table, row_id)
            if key in result:
                raise AttachmentPromotionError(f"Duplicate source row {table}/{row_id}")
            result[key] = row
    return result


def _normalize_manifest_path(raw: Any, *, source: str = "manifest") -> str:
    if not isinstance(raw, str) or not raw:
        raise _MappingError("INVALID_PATH", f"{source} path must be a non-empty string")
    if "\x00" in raw or "\\" in raw or "%" in raw:
        raise _MappingError("PATH_TRAVERSAL", f"{source} path uses a forbidden separator or encoding")
    path = PurePosixPath(raw)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise _MappingError("PATH_TRAVERSAL", f"{source} path is not a normalized relative path")
    normalized = path.as_posix()
    if not (normalized.startswith("public/uploads/") or normalized.startswith("data/archive/")):
        raise _MappingError("PATH_OUTSIDE_ALLOWED_ROOT", f"{source} path is outside captured attachment roots")
    return normalized


def _normalize_reference_path(raw: Any) -> str:
    if not isinstance(raw, str) or not raw.strip():
        raise _MappingError("MISSING_PATH", "source attachment path is missing")
    value = raw.strip()
    parts = urlsplit(value)
    if parts.scheme or parts.netloc or parts.query or parts.fragment:
        raise _MappingError("EXTERNAL_PATH", "source attachment path is not a local archive path")
    if "%" in value:
        # Decode only for detection; reject encoded traversal instead of
        # guessing what the legacy web server would have served.
        decoded = unquote(value)
        if decoded != value or ".." in PurePosixPath(decoded).parts:
            raise _MappingError("PATH_TRAVERSAL", "source attachment path uses encoded traversal")
        raise _MappingError("INVALID_PATH", "encoded source attachment paths are unsupported")
    value = value.lstrip("/")
    if value.startswith("uploads/"):
        value = "public/" + value
    return _normalize_manifest_path(value, source="source")


def _path_in_archive(root: Path, relative: str) -> Path:
    files_directory = root / "files"
    if files_directory.is_symlink() or not files_directory.is_dir():
        raise _MappingError("SYMLINK_REJECTED", "archive files root is missing or is not a real directory")
    files_root = (root / "files").resolve(strict=False)
    candidate = root / "files" / relative
    current = files_root
    for part in PurePosixPath(relative).parts:
        current = current / part
        if current.is_symlink():
            raise _MappingError("SYMLINK_REJECTED", "archive attachment path contains a symlink")
    resolved = candidate.resolve(strict=False)
    if not resolved.is_relative_to(files_root):
        raise _MappingError("PATH_TRAVERSAL", "archive file resolves outside files root")
    return candidate


def _canonical_mime(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        raise _MappingError("INVALID_MIME", "MIME metadata must be a string")
    mime = value.strip().lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    if mime == "application/octet-stream":
        # This is an advisory legacy upload type; magic/extension must still
        # determine an allowed canonical type below.
        return None
    return mime


def _sniff_mime(path: Path, extension: str) -> str | None:
    with path.open("rb") as source:
        prefix = source.read(64)
    for magic, mime in _MAGIC_MIME:
        if prefix.startswith(magic):
            return mime
    if len(prefix) >= 12 and prefix[:4] == b"RIFF" and prefix[8:12] == b"WEBP":
        return "image/webp"
    if len(prefix) >= 12 and prefix[:4] == b"RIFF" and prefix[8:12] == b"WAVE":
        return "audio/wav"
    if len(prefix) >= 12 and prefix[4:8] == b"ftyp":
        brand = prefix[8:12]
        compatible = prefix[16:64]
        if brand == b"M4A " or b"M4A " in compatible:
            return "audio/m4a"
        if brand in {b"mp42", b"mp41", b"isom", b"iso2", b"MSNV"} or any(
            marker in compatible for marker in (b"mp41", b"mp42", b"isom")
        ):
            # Only audio/mp4 is allowed by the canonical attachment contract;
            # the extension/declared MIME must confirm that this is audio.
            return "audio/mp4"
        if brand.startswith(b"heic") or brand in {b"mif1", b"msf1", b"heix"}:
            return "image/heic"
    if prefix.startswith(b"ID3") or (len(prefix) >= 2 and prefix[0] == 0xFF and (prefix[1] & 0xE0) == 0xE0):
        return "audio/mpeg"
    # An extension is only a consistency check. It cannot establish the media
    # type because arbitrary bytes can be renamed to an allowed suffix.
    return None


def _extension_for_mime(mime: str) -> str:
    return {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
        "image/heic": "heic",
        "audio/m4a": "m4a",
        "audio/wav": "wav",
        "audio/mpeg": "mp3",
        "audio/mp4": "mp4",
        "application/pdf": "pdf",
    }[mime]


def _infer_mime(path: Path, declared: Any) -> str:
    declared_mime = _canonical_mime(declared)
    extension = path.suffix.lower()
    sniffed = _sniff_mime(path, extension)
    extension_mime = _EXTENSION_MIME.get(extension)
    if sniffed is None or sniffed not in ALLOWED_MIME_TYPES:
        raise _MappingError("UNSUPPORTED_MIME", "file MIME could not be established from allowed types")
    if declared_mime is not None and declared_mime not in ALLOWED_MIME_TYPES:
        raise _MappingError("UNSUPPORTED_MIME", "declared MIME is not allowed")
    if declared_mime is not None and declared_mime != sniffed:
        raise _MappingError("MIME_MISMATCH", "declared MIME does not match file signature")
    if extension_mime is not None and extension_mime != sniffed:
        # A renamed file is ambiguous even when its bytes are otherwise valid.
        raise _MappingError("MIME_EXTENSION_MISMATCH", "file extension does not match file signature")
    return sniffed


def _safe_key_segment(value: str, field: str) -> str:
    if not _SAFE_KEY_SEGMENT.fullmatch(value) or value in {".", ".."}:
        raise _MappingError("UNSAFE_OWNER_ID", f"{field} cannot be used in an object key")
    # Percent-escape all non-ASCII/key punctuation rather than interpolating
    # arbitrary legacy IDs into a path.  The resulting key has no slash.
    from urllib.parse import quote

    return quote(value, safe="-_.~")


def _pick_consistent(values: Iterable[tuple[str, Any]], field: str) -> Any:
    present = [(name, value) for name, value in values if value not in (None, "")]
    if not present:
        return None
    first = present[0][1]
    if any(value != first for _, value in present[1:]):
        raise _MappingError("OWNER_CONFLICT", f"{field} metadata disagrees across source references")
    return first


def _row_value(row: Mapping[str, Any], entry: Mapping[str, Any] | None, *names: str) -> list[tuple[str, Any]]:
    values: list[tuple[str, Any]] = []
    for source_name, source in (("row", row), ("manifest", entry or {})):
        for name in names:
            if name in source and source[name] not in (None, ""):
                values.append((f"{source_name}.{name}", source[name]))
    return values


def _purpose_for_source(
    table: str,
    field: str,
    row: Mapping[str, Any],
    entry: Mapping[str, Any] | None,
    linked_rows: Sequence[Mapping[str, Any]] = (),
) -> str:
    explicit = _pick_consistent(_row_value(row, entry, "purpose", "attachmentPurpose"), "purpose")
    if explicit is not None:
        if not isinstance(explicit, str) or explicit not in ALLOWED_PURPOSES:
            raise _MappingError("UNSUPPORTED_PURPOSE", "attachment purpose is not in the canonical allowlist")
        return explicit
    if table == "Baby" and field == "avatarUrl":
        return "avatar"
    if table == "GrowthMeasurement" and field == "imageUrl":
        return "growth_photo"
    if table == "MedicalReport" and field == "imageUrl":
        return "medical_report"
    if table == "AiJob" and field in {"imageUrl", "inputArchiveId"}:
        job_type = str(row.get("type", "")).lower()
        if "growth" in job_type:
            return "growth_photo"
        if "medical" in job_type or "ocr" in job_type:
            return "medical_report"
        if any(token in job_type for token in ("voice", "asr", "audio", "transcrib")):
            return "voice_note"
    if table == "AiArchive":
        kind = str(row.get("kind", "")).lower()
        if kind == "input_audio":
            return "voice_note"
        linked_purposes = {
            _purpose_for_source("AiJob", "imageUrl", linked, None)
            for linked in linked_rows
            if isinstance(linked, Mapping)
        }
        if len(linked_purposes) == 1:
            return linked_purposes.pop()
    raise _MappingError("MISSING_PURPOSE", "attachment purpose cannot be derived safely")


def _identity_context(snapshot: Mapping[str, Any]) -> tuple[set[str], set[str], dict[str, str], set[tuple[str, str]], dict[str, set[str]]]:
    families = set()
    for row in _table_rows(snapshot, "Family"):
        family_id = row.get("id")
        if isinstance(family_id, str) and family_id:
            families.add(family_id)
    babies: dict[str, str] = {}
    for row in _table_rows(snapshot, "Baby"):
        baby_id, family_id = row.get("id"), row.get("familyId")
        if not isinstance(baby_id, str) or not baby_id or not isinstance(family_id, str) or not family_id:
            continue
        if baby_id in babies and babies[baby_id] != family_id:
            raise AttachmentPromotionError(f"Baby {baby_id} has conflicting families")
        babies[baby_id] = family_id
    users = {row.get("id") for row in _table_rows(snapshot, "User") if isinstance(row.get("id"), str) and row.get("id")}
    memberships: set[tuple[str, str]] = set()
    family_admins: dict[str, set[str]] = {}
    for row in _table_rows(snapshot, "FamilyMember"):
        family_id, user_id = row.get("familyId"), row.get("userId")
        if isinstance(family_id, str) and isinstance(user_id, str) and row.get("status", "active") == "active":
            memberships.add((family_id, user_id))
            if row.get("role") in {"owner", "admin"}:
                family_admins.setdefault(family_id, set()).add(user_id)
    return families, users, babies, memberships, family_admins


def _load_import_rows(root: Path) -> list[Mapping[str, Any]]:
    for name in ("import_rows.json", "legacy_import_rows.json"):
        value = _read_json(root / name, root, name, required=False)
        if value is not None:
            return _json_rows(value, name)
    return []


def _build_manifest_files(root: Path, raw_files: Any, report: dict[str, Any]) -> list[dict[str, Any]]:
    files = _json_rows(raw_files, "files.json")
    result: list[dict[str, Any]] = []
    by_path: dict[str, int] = {}
    for index, item in enumerate(files):
        record: dict[str, Any] = {"index": index, "raw": item, "path": item.get("path")}
        try:
            relative = _normalize_manifest_path(item.get("path"))
            record["path"] = relative
            if relative in by_path:
                raise _MappingError("DUPLICATE_MANIFEST_PATH", "file manifest path appears more than once")
            by_path[relative] = index
            expected_size = item.get("size")
            if isinstance(expected_size, bool) or not isinstance(expected_size, int) or expected_size <= 0:
                raise _MappingError("INVALID_SIZE", "file manifest size must be a positive integer")
            if expected_size > MAX_SOURCE_FILE_BYTES:
                raise _MappingError("FILE_TOO_LARGE", "file exceeds the immutable snapshot file limit")
            expected_hash = _valid_hash(item.get("sha256"), "file manifest sha256")
            path = _path_in_archive(root, relative)
            if path.is_symlink() or not path.exists() or not path.is_file():
                raise _MappingError("MISSING_FILE", "manifest file is missing or not a regular file")
            file_stat = path.stat()
            if not stat.S_ISREG(file_stat.st_mode):
                raise _MappingError("UNSUPPORTED_FILE", "manifest file is not a regular file")
            actual_size, actual_hash = _sha256_file(path)
            if actual_size != expected_size:
                raise _MappingError("SIZE_MISMATCH", "manifest size does not match archive file")
            if actual_hash != expected_hash:
                raise _MappingError("HASH_MISMATCH", "manifest SHA-256 does not match archive file")
            record.update(valid=True, expectedSize=expected_size, sha256=expected_hash, pathObject=path)
        except _MappingError as error:
            record.update(valid=False, code=error.code, message=error.message)
            _add_quarantine(report, code=error.code, message=error.message, source_path=record.get("path"))
        result.append(record)
    return result


def _add_quarantine(
    report: dict[str, Any],
    *,
    code: str,
    message: str,
    source_table: str | None = None,
    source_id: str | None = None,
    source_field: str | None = None,
    source_path: str | None = None,
    source_hash: str | None = None,
) -> None:
    item: dict[str, Any] = {"code": code, "message": message}
    for key, value in (
        ("sourceTable", source_table),
        ("sourceId", source_id),
        ("sourceField", source_field),
        ("sourcePath", source_path),
        ("sourceHash", source_hash),
    ):
        if value not in (None, ""):
            item[key] = value
    report["quarantine"].append(item)


def _candidate(
    table: str,
    source_id: str,
    field: str,
    path: Any,
    row: Mapping[str, Any],
    *,
    manifest: Mapping[str, Any] | None = None,
    linked_rows: Sequence[Mapping[str, Any]] = (),
    import_row: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    return {
        "table": table,
        "id": source_id,
        "field": field,
        "rawPath": path,
        "row": row,
        "manifest": manifest,
        "linkedRows": list(linked_rows),
        "importRow": import_row,
    }


def _collect_candidates(
    snapshot: Mapping[str, Any],
    file_entries: Sequence[Mapping[str, Any]],
    import_rows: Sequence[Mapping[str, Any]],
    report: dict[str, Any],
) -> list[dict[str, Any]]:
    row_index = _table_row_index(snapshot)
    import_by_key: dict[tuple[str, str], Mapping[str, Any]] = {}
    for metadata in import_rows:
        table = metadata.get("sourceTable")
        source_id = metadata.get("sourceId")
        if not isinstance(table, str) or not isinstance(source_id, str) or not source_id:
            _add_quarantine(report, code="INVALID_IMPORT_ROW_METADATA", message="import_rows entry has no source key")
            continue
        key = (table, source_id)
        if key in import_by_key:
            _add_quarantine(report, code="DUPLICATE_IMPORT_ROW_METADATA", message="import_rows source key appears more than once", source_table=table, source_id=source_id)
            continue
        import_by_key[key] = metadata
        payload = metadata.get("payload")
        if isinstance(payload, str):
            try:
                payload = json.loads(payload)
            except json.JSONDecodeError:
                _add_quarantine(report, code="INVALID_IMPORT_ROW_PAYLOAD", message="import_rows payload is not valid JSON", source_table=table, source_id=source_id)
                continue
        if not isinstance(payload, Mapping):
            _add_quarantine(report, code="INVALID_IMPORT_ROW_PAYLOAD", message="import_rows payload must be an object", source_table=table, source_id=source_id)
            continue
        try:
            payload_hash = _source_hash(payload)
            declared_hash = metadata.get("payloadHash", metadata.get("sourceHash"))
            if declared_hash is not None and _valid_hash(declared_hash, "import row payloadHash") != payload_hash:
                raise _MappingError("SOURCE_ROW_HASH_MISMATCH", "import_rows payload hash does not match payload")
            if key in row_index and _source_hash(row_index[key]) != payload_hash:
                raise _MappingError("SOURCE_ROW_HASH_MISMATCH", "import_rows payload differs from immutable legacy snapshot row")
        except _MappingError as error:
            _add_quarantine(report, code=error.code, message=error.message, source_table=table, source_id=source_id)

    jobs_by_archive: dict[str, list[Mapping[str, Any]]] = {}
    for job in _table_rows(snapshot, "AiJob"):
        archive_id = job.get("inputArchiveId")
        if isinstance(archive_id, str) and archive_id:
            jobs_by_archive.setdefault(archive_id, []).append(job)

    candidates: list[dict[str, Any]] = []
    candidate_keys: set[tuple[str, str, str, str]] = set()

    def add(item: dict[str, Any]) -> None:
        raw_path = item.get("rawPath")
        # Keep duplicate references to different fields, but collapse the same
        # source field/path discovered through both legacy.json and manifest
        # metadata.  A separate source key is created later for each row.
        try:
            normalized = _normalize_reference_path(raw_path)
        except _MappingError:
            normalized = str(raw_path)
        key = (item["table"], item["id"], item["field"], normalized)
        if key in candidate_keys:
            return
        candidate_keys.add(key)
        item["normalizedPath"] = normalized
        candidates.append(item)

    source_fields = {
        "Baby": ("avatarUrl",),
        "GrowthMeasurement": ("imageUrl",),
        "MedicalReport": ("imageUrl",),
        "AiJob": ("imageUrl",),
        "AiArchive": ("filePath",),
    }
    for table, fields in source_fields.items():
        for row in _table_rows(snapshot, table):
            source_id = row.get("id")
            if not isinstance(source_id, str) or not source_id:
                continue
            import_row = import_by_key.get((table, source_id))
            for field in fields:
                raw_path = row.get(field)
                if raw_path not in (None, ""):
                    linked = jobs_by_archive.get(source_id, ()) if table == "AiArchive" else ()
                    add(_candidate(table, source_id, field, raw_path, row, linked_rows=linked, import_row=import_row))

    # A richer manifest can carry typed source references directly.  This is
    # useful for a frozen file inventory created independently of legacy.json;
    # it still needs an identity row or explicit ownership metadata to map.
    for entry in file_entries:
        raw = entry.get("raw", {})
        table = raw.get("sourceTable")
        source_id = raw.get("sourceId")
        field = raw.get("sourceField", "file")
        if isinstance(table, str) and isinstance(source_id, str) and source_id:
            row = row_index.get((table, source_id), raw)
            add(_candidate(table, source_id, str(field), raw.get("sourcePath", raw.get("path")), row, manifest=raw, import_row=import_by_key.get((table, source_id))))
        references = raw.get("references")
        if isinstance(references, list):
            for reference in references:
                if not isinstance(reference, Mapping):
                    _add_quarantine(report, code="INVALID_FILE_REFERENCE", message="manifest references entry must be an object", source_path=entry.get("path"))
                    continue
                ref_table, ref_id = reference.get("sourceTable"), reference.get("sourceId")
                if isinstance(ref_table, str) and isinstance(ref_id, str) and ref_id:
                    row = row_index.get((ref_table, ref_id), reference)
                    add(_candidate(ref_table, ref_id, str(reference.get("sourceField", "file")), reference.get("sourcePath", raw.get("path")), row, manifest={**raw, **reference}, import_row=import_by_key.get((ref_table, ref_id))))

    # Attach manifest metadata by exact path when it did not carry a source
    # key; row-derived candidates still remain authoritative for ownership.
    path_entries: dict[str, list[Mapping[str, Any]]] = {}
    for entry in file_entries:
        if isinstance(entry.get("path"), str):
            path_entries.setdefault(entry["path"], []).append(entry)
    # A duplicate path is ambiguous even if one duplicate happened to pass
    # validation.  Exclude all copies from mapping and leave the manifest
    # quarantine as the only evidence.
    by_path = {
        path: entries[0]
        for path, entries in path_entries.items()
        if len(entries) == 1 and entries[0].get("valid")
    }
    for item in candidates:
        if item.get("manifest") is None:
            matched = by_path.get(item.get("normalizedPath"))
            item["manifest"] = matched.get("raw") if isinstance(matched, Mapping) else None
    return candidates


def _linked_value(candidate: Mapping[str, Any], *names: str) -> list[tuple[str, Any]]:
    values: list[tuple[str, Any]] = []
    row = candidate["row"]
    entry = candidate.get("manifest")
    values.extend(_row_value(row, entry if isinstance(entry, Mapping) else None, *names))
    for index, linked in enumerate(candidate.get("linkedRows", [])):
        if isinstance(linked, Mapping):
            for name in names:
                if name in linked and linked[name] not in (None, ""):
                    values.append((f"linked[{index}].{name}", linked[name]))
    import_row = candidate.get("importRow")
    if isinstance(import_row, Mapping):
        for name in names:
            if name in import_row and import_row[name] not in (None, ""):
                values.append((f"importRow.{name}", import_row[name]))
    return values


def _map_candidate(
    candidate: Mapping[str, Any],
    *,
    snapshot: Mapping[str, Any],
    file_by_path: Mapping[str, Mapping[str, Any]],
    families: set[str],
    users: set[str],
    babies: Mapping[str, str],
    memberships: set[tuple[str, str]],
    family_admins: Mapping[str, set[str]],
    source_system: str,
    source_batch_id: str,
) -> dict[str, Any]:
    table = str(candidate["table"])
    source_id = _non_empty_string(candidate["id"], "sourceId")
    field = _non_empty_string(candidate["field"], "sourceField")
    row = candidate["row"]
    if not isinstance(row, Mapping):
        raise _MappingError("INVALID_SOURCE_ROW", "source row must be an object")
    raw_path = candidate.get("rawPath")
    path = _normalize_reference_path(raw_path)
    manifest = candidate.get("manifest")
    if isinstance(manifest, Mapping) and isinstance(manifest.get("raw"), Mapping):
        manifest = manifest["raw"]
    manifest = manifest if isinstance(manifest, Mapping) else file_by_path.get(path, {}).get("raw", {})
    file_entry = file_by_path.get(path)
    if file_entry is None:
        raise _MappingError("MISSING_MANIFEST_ENTRY", "source path is not present in files.json")
    if not file_entry.get("valid"):
        raise _MappingError(str(file_entry.get("code", "INVALID_FILE")), str(file_entry.get("message", "file manifest entry is invalid")))
    path_object = file_entry.get("pathObject")
    if not isinstance(path_object, Path):
        raise _MappingError("MISSING_FILE", "source path has no validated archive file")

    source_hash = _source_hash(row)
    import_row = candidate.get("importRow")
    if isinstance(import_row, Mapping):
        declared_row_hash = import_row.get("payloadHash", import_row.get("sourceHash"))
        if declared_row_hash is not None and _valid_hash(declared_row_hash, "import row payloadHash") != source_hash:
            raise _MappingError("SOURCE_ROW_HASH_MISMATCH", "import_rows hash does not match source row")
    declared_source_hash = _pick_consistent(_linked_value(candidate, "sourceHash", "payloadHash"), "sourceHash")
    if declared_source_hash is not None and _valid_hash(declared_source_hash, "sourceHash") != source_hash:
        raise _MappingError("SOURCE_ROW_HASH_MISMATCH", "source metadata hash does not match source row")

    uploader_id = _pick_consistent(
        _linked_value(candidate, "uploaderId", "uploader_id", "recordedById", "recorded_by_user_id", "userId", "user_id", "ownerUserId", "createdById", "actorId"),
        "uploaderId",
    )
    if uploader_id is not None:
        uploader_id = _non_empty_string(uploader_id, "uploaderId")
        if uploader_id not in users:
            raise _MappingError("UNKNOWN_UPLOADER", "uploader is absent from the immutable identity snapshot")

    baby_id = _pick_consistent(_linked_value(candidate, "babyId", "baby_id"), "babyId")
    family_id = _pick_consistent(_linked_value(candidate, "familyId", "family_id"), "familyId")
    if baby_id is not None:
        baby_id = _non_empty_string(baby_id, "babyId")
        if baby_id not in babies:
            raise _MappingError("UNKNOWN_BABY", "baby is absent from the immutable identity snapshot")
        derived_family = babies[baby_id]
        if family_id not in (None, derived_family):
            raise _MappingError("CROSS_FAMILY_REFERENCE", "baby and family metadata disagree")
        family_id = derived_family
    if family_id is None and uploader_id is not None:
        uploader_families = sorted(family for family, user in memberships if user == uploader_id)
        if len(uploader_families) == 1:
            family_id = uploader_families[0]
    if family_id is None:
        raise _MappingError("MISSING_FAMILY", "attachment has no unambiguous family owner")
    family_id = _non_empty_string(family_id, "familyId")
    if family_id not in families:
        raise _MappingError("UNKNOWN_FAMILY", "family is absent from the immutable identity snapshot")
    if baby_id is not None and babies.get(baby_id) != family_id:
        raise _MappingError("CROSS_FAMILY_REFERENCE", "baby does not belong to attachment family")

    if uploader_id is None and table == "Baby" and field == "avatarUrl":
        administrators = sorted(family_admins.get(family_id, set()))
        if len(administrators) == 1:
            uploader_id = administrators[0]
    if uploader_id is None:
        raise _MappingError("MISSING_UPLOADER", "historical source does not identify an attachment uploader")
    if uploader_id not in users or (family_id, uploader_id) not in memberships:
        raise _MappingError("UPLOADER_OUTSIDE_FAMILY", "uploader is not an active member of attachment family")

    purpose = _purpose_for_source(table, field, row, manifest, candidate.get("linkedRows", ()))
    declared_size = _pick_consistent(_linked_value(candidate, "byteSize", "byte_size", "size"), "byteSize")
    if declared_size is not None:
        if isinstance(declared_size, bool) or not isinstance(declared_size, int) or declared_size <= 0:
            raise _MappingError("INVALID_SIZE", "source byteSize must be a positive integer")
        if declared_size != file_entry["expectedSize"]:
            raise _MappingError("SIZE_MISMATCH", "source byteSize does not match manifest/file size")
    sha256 = file_entry["sha256"]
    declared_content_hash = _pick_consistent(_linked_value(candidate, "contentHash", "content_hash", "sha256"), "sha256")
    if declared_content_hash is not None and _valid_hash(declared_content_hash, "contentHash") != sha256:
        raise _MappingError("HASH_MISMATCH", "source content hash does not match manifest/file hash")

    declared_mime = _pick_consistent(_linked_value(candidate, "mimeType", "mime", "contentType", "content_type"), "mimeType")
    mime_type = _infer_mime(path_object, declared_mime)
    max_size = MAX_AUDIO_BYTES if mime_type.startswith("audio/") else MAX_IMAGE_OR_DOCUMENT_BYTES
    if file_entry["expectedSize"] > max_size:
        raise _MappingError("FILE_TOO_LARGE", "file exceeds canonical attachment size limit")

    safe_family = _safe_key_segment(family_id, "familyId")
    attachment_id = str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            f"growdesk/legacy-attachment/{source_system}/{table}/{source_id}/{field}/{path}",
        )
    )
    object_key = f"families/{safe_family}/attachments/{purpose}/legacy/{attachment_id}.{_extension_for_mime(mime_type)}"

    return {
        "sourceSystem": source_system,
        "sourceBatchId": source_batch_id,
        "sourceTable": table,
        "sourceId": source_id,
        "sourceField": field,
        "sourcePath": path,
        "sourceHash": source_hash,
        "mappingVersion": MAPPING_VERSION,
        "result": "planned",
        "storageState": "not_copied",
        "targetAttachmentId": attachment_id,
        "targetObjectKey": object_key,
        "targetSha256": sha256,
        "targetByteSize": file_entry["expectedSize"],
        "attachment": {
            "id": attachment_id,
            "familyId": family_id,
            "babyId": baby_id,
            "uploaderId": uploader_id,
            "purpose": purpose,
            "mimeType": mime_type,
            "byteSize": file_entry["expectedSize"],
            "sha256": sha256,
            "objectKey": object_key,
            # The row is not inserted by this planner.  The copy worker must
            # transition pending→ready only after its storage verification.
            "status": "pending",
        },
    }


def _archive_envelope(root: Path) -> tuple[Mapping[str, Any], Mapping[str, Any], Any, list[Mapping[str, Any]]]:
    manifest = _require_mapping(_read_json(root / "manifest.json", root, "manifest.json"), "manifest.json")
    snapshot = _require_mapping(_read_json(root / "legacy.json", root, "legacy.json"), "legacy.json")
    files_value = _read_json(root / "files.json", root, "files.json", required=False)
    if files_value is None:
        files_value = manifest.get("files", manifest.get("fileManifest"))
    if files_value is None:
        raise AttachmentPromotionError("Missing files.json/file manifest")
    import_rows = _load_import_rows(root)
    if snapshot.get("formatVersion") != 1 or snapshot.get("timeZone") != "Asia/Shanghai":
        raise AttachmentPromotionError("Unsupported legacy snapshot format or timezone")
    source_id = snapshot.get("sourceId")
    if not isinstance(source_id, str) or not source_id:
        raise AttachmentPromotionError("legacy.json sourceId must be non-empty")
    if manifest.get("sourceId") not in (None, source_id):
        raise AttachmentPromotionError("manifest/source snapshot sourceId mismatch")
    archive_hash = manifest.get("archiveSha256")
    if archive_hash is not None:
        _valid_hash(archive_hash, "manifest archiveSha256")
        legacy_bytes = (root / "legacy.json").read_bytes()
        if _sha256_bytes(legacy_bytes) != archive_hash:
            raise AttachmentPromotionError("legacy.json hash does not match manifest archiveSha256")
    source_hash = manifest.get("sourceSha256", snapshot.get("sourceSha256"))
    if source_hash is not None:
        _valid_hash(source_hash, "sourceSha256")
        source_file = root / "source.sqlite"
        if source_file.exists():
            if source_file.is_symlink() or not source_file.is_file() or _sha256_file(source_file)[1] != source_hash:
                raise AttachmentPromotionError("source.sqlite hash does not match manifest sourceSha256")
    return snapshot, manifest, files_value, import_rows


def plan_attachment_promotion(
    archive_root: str | os.PathLike[str],
    *,
    import_rows: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a deterministic attachment promotion report.

    The function performs no writes.  It returns successful mapping receipts
    and explicit quarantine records for every file/reference that cannot be
    proven safe.  A caller may pass ``import_rows`` from an isolated database
    export; otherwise the optional ``import_rows.json`` in the archive is used.
    """

    supplied_root = Path(archive_root).expanduser()
    if supplied_root.is_symlink():
        raise AttachmentPromotionError("archive_root must be a regular directory")
    root = supplied_root.resolve(strict=True)
    if not root.is_dir():
        raise AttachmentPromotionError("archive_root must be a regular directory")
    snapshot, manifest, raw_files, archive_import_rows = _archive_envelope(root)
    report: dict[str, Any] = {
        "reportVersion": REPORT_VERSION,
        "mappingVersion": MAPPING_VERSION,
        "status": "planned",
        "sourceSystem": snapshot.get("sourceId"),
        "sourceSnapshot": manifest.get("sourceSha256", snapshot.get("sourceSha256")),
        "sourceBatchId": manifest.get("archiveSha256") or _sha256_bytes((root / "legacy.json").read_bytes()),
        "archiveRoot": "<private-archive>",
        "receipts": [],
        "quarantine": [],
        "counts": {},
        "storage": {"database": "not_written", "objectStore": "not_written"},
    }
    file_entries = _build_manifest_files(root, raw_files, report)
    path_entries: dict[str, list[Mapping[str, Any]]] = {}
    for entry in file_entries:
        if isinstance(entry.get("path"), str):
            path_entries.setdefault(entry["path"], []).append(entry)
    # Do not let a valid duplicate shadow an invalid duplicate, or vice versa.
    file_by_path = {
        path: entries[0]
        for path, entries in path_entries.items()
        if len(entries) == 1
    }
    selected_import_rows = list(import_rows) if import_rows is not None else archive_import_rows
    families, users, babies, memberships, family_admins = _identity_context(snapshot)
    candidates = _collect_candidates(snapshot, file_entries, selected_import_rows, report)
    declared_file_count = manifest.get("attachmentFiles")
    if declared_file_count is not None:
        if isinstance(declared_file_count, bool) or not isinstance(declared_file_count, int) or declared_file_count != len(file_entries):
            _add_quarantine(report, code="MANIFEST_COUNT_MISMATCH", message="manifest attachmentFiles does not match files.json count")
    declared_file_bytes = manifest.get("attachmentBytes")
    if declared_file_bytes is not None:
        actual_file_bytes = sum(entry.get("expectedSize", 0) for entry in file_entries if entry.get("valid"))
        if isinstance(declared_file_bytes, bool) or not isinstance(declared_file_bytes, int) or declared_file_bytes != actual_file_bytes:
            _add_quarantine(report, code="MANIFEST_BYTES_MISMATCH", message="manifest attachmentBytes does not match validated files")
    consumed_paths: set[str] = set()
    source_keys: set[str] = set()
    target_ids: set[str] = set()
    for candidate in candidates:
        source_path = candidate.get("normalizedPath")
        source_hash: str | None = None
        try:
            row = candidate.get("row")
            if isinstance(row, Mapping):
                source_hash = _source_hash(row)
            mapped = _map_candidate(
                candidate,
                snapshot=snapshot,
                file_by_path=file_by_path,
                families=families,
                users=users,
                babies=babies,
                memberships=memberships,
                family_admins=family_admins,
                source_system=str(snapshot["sourceId"]),
                source_batch_id=str(report["sourceBatchId"]),
            )
            source_key = "/".join((mapped["sourceTable"], mapped["sourceId"], mapped["sourceField"], mapped["sourcePath"]))
            if source_key in source_keys:
                raise _MappingError("DUPLICATE_SOURCE_REFERENCE", "source reference maps more than once")
            if mapped["targetAttachmentId"] in target_ids:
                raise _MappingError("DUPLICATE_TARGET_ID", "deterministic target attachment ID collides")
            source_keys.add(source_key)
            target_ids.add(mapped["targetAttachmentId"])
            report["receipts"].append(mapped)
            consumed_paths.add(mapped["sourcePath"])
        except _MappingError as error:
            _add_quarantine(
                report,
                code=error.code,
                message=error.message,
                source_table=str(candidate.get("table")),
                source_id=str(candidate.get("id")),
                source_field=str(candidate.get("field")),
                source_path=source_path if isinstance(source_path, str) else None,
                source_hash=source_hash,
            )

    for entry in file_entries:
        path = entry.get("path")
        if entry.get("valid") and isinstance(path, str) and path not in consumed_paths:
            _add_quarantine(report, code="ORPHAN_FILE", message="manifest file has no proven source reference", source_path=path)

    report["counts"] = {
        "manifestFiles": len(file_entries),
        "sourceCandidates": len(candidates),
        "mapped": len(report["receipts"]),
        "quarantined": len(report["quarantine"]),
        "orphanFiles": sum(1 for item in report["quarantine"] if item["code"] == "ORPHAN_FILE"),
    }
    if report["quarantine"]:
        report["status"] = "quarantined"
    return report


# Keep the alias obvious for callers that use the task's "promotion" wording.
promote_attachments = plan_attachment_promotion


def _write_private_json(path: Path, value: Mapping[str, Any]) -> None:
    if path.exists():
        raise FileExistsError(f"Refusing to overwrite receipt: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode("utf-8")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(payload)
    except BaseException:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, help="private immutable snapshot directory")
    parser.add_argument("--output", required=True, help="new 0600 JSON receipt/quarantine report")
    parser.add_argument("--allow-quarantine", action="store_true", help="return success for inspection even when quarantine is non-empty")
    args = parser.parse_args(argv)
    output = Path(args.output).expanduser()
    try:
        report = plan_attachment_promotion(args.archive)
    except (AttachmentPromotionError, OSError, ValueError) as error:
        report = {
            "reportVersion": REPORT_VERSION,
            "mappingVersion": MAPPING_VERSION,
            "status": "invalid_archive",
            "receipts": [],
            "quarantine": [{"code": "INVALID_ARCHIVE", "message": str(error)}],
            "counts": {"manifestFiles": 0, "sourceCandidates": 0, "mapped": 0, "quarantined": 1, "orphanFiles": 0},
            "storage": {"database": "not_written", "objectStore": "not_written"},
        }
        try:
            _write_private_json(output, report)
        except OSError as write_error:
            print(json.dumps({"error": type(write_error).__name__}), file=sys.stderr)
            return 1
        print(json.dumps({"status": report["status"], "quarantined": 1}))
        return 0 if args.allow_quarantine else 1
    _write_private_json(output, report)
    print(json.dumps({"status": report["status"], "mapped": report["counts"]["mapped"], "quarantined": report["counts"]["quarantined"]}))
    return 0 if (args.allow_quarantine or not report["quarantine"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
