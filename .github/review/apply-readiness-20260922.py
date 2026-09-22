"""One-shot source edits on the explicitly owned review branch; no runtime services."""
from pathlib import Path
import subprocess

EXPECTED_BRANCH = "codex/migration-readiness-20260922"
if subprocess.check_output(["git", "branch", "--show-current"], text=True).strip() != EXPECTED_BRANCH:
    raise SystemExit("wrong review branch")


def edit(path, expected_blob, transform):
    file = Path(path)
    actual = subprocess.check_output(["git", "hash-object", str(file)], text=True).strip()
    if actual != expected_blob:
        raise RuntimeError("source changed: " + path)
    before = file.read_text()
    after = transform(before)
    if before == after:
        raise RuntimeError("empty edit: " + path)
    file.write_text(after)


def replace(text, before, after, count=1):
    if text.count(before) != count:
        raise RuntimeError("source anchor changed")
    return text.replace(before, after)


def verifier(text):
    text = replace(text, "import argparse\n", "import argparse\nimport importlib.util\n")
    marker = '\n\ndef verify(\n'
    helper = '''\n\ndef _verification_module(name: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    if spec is None or spec.loader is None:
        raise RuntimeError("verification module unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
\n\ndef verify(\n'''
    text = replace(text, marker, helper)
    text = replace(text, '    receipt_dir: str | Path | None = None,\n) -> dict[str, Any]:',
                   '    receipt_dir: str | Path | None = None,\n    release_evidence: str | Path | None = None,\n) -> dict[str, Any]:')
    old = '    cutover_ready = not unmapped and not static_reference_failures and not receipt["phaseFailures"] and quarantined == 0 and unresolved == 0\n'
    new = '''    attachment_report = None
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
'''
    text = replace(text, old, new)
    text = replace(text, '        "businessHistoryReady": cutover_ready,', '''        "canonicalReconciliation": canonical,
        "importIntegrityReady": import_ready,
        "releaseCutoverReady": cutover_ready,
        "releaseGate": release,
        "businessHistoryReady": import_ready,''')
    pos = text.index('\n\nif __name__ == "__main__":')
    text = text[:pos] + '''\n\ndef main(argv=None, *, verifier=verify) -> int:
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
                stream.write(json.dumps(result, ensure_ascii=False, indent=2) + "\\n")
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
'''
    return text


def runner(text):
    text = replace(text, '"--target-container", self.target_container, "--receipt-dir", str(self.receipt_dir), "--output", str(output),',
                   '"--target-container", self.target_container, "--receipt-dir", str(self.receipt_dir), "--output", str(output), "--require", "import",')
    text = replace(text, '                "cutoverReady": bool(verification.get("detail", {}).get("cutoverReady")),', '''                "cutoverReady": bool(verification.get("detail", {}).get("releaseCutoverReady")),
                "releaseCutoverReady": bool(verification.get("detail", {}).get("releaseCutoverReady")),
                "importIntegrityReady": bool(verification.get("detail", {}).get("importIntegrityReady")),''')
    text = replace(text, '            if not report["cutoverReady"]:\n                raise CutoverError("target verification is not cutover-ready")',
                   '            if not report["importIntegrityReady"]:\n                raise CutoverError("target canonical verification is incomplete")')
    text = replace(text, '        return 0\n    except Exception as error:', '        return 0 if report["cutoverReady"] else 1\n    except Exception as error:')
    return text


def care_test(text):
    text = replace(text, 'materializer = load("materialize_care")', 'materializer = load("materialize_care")\ncanonical = load("canonical_verification")')
    text = replace(text, '    execute("SELECT current_user || \'|\' || current_setting(\'cluster_name\')")',
                   '    assert execute("SELECT current_user || \'|\' || current_setting(\'cluster_name\')") == run["user"] + "|" + run["token"]')
    text = replace(text, '        execute(promotion_sql)\n        execute(promotion_sql)\n', '''        execute(promotion_sql)
        execute(promotion_sql)
        def verify_runtime():
            return canonical.verify_canonical(data, checksum, lambda sql: json.loads(execute(sql)))
        assert verify_runtime()["passed"] is True
        source_feeding = ids["FeedingRecord"]
        before_receipts = execute("SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id=" + sql_literal(checksum))
        execute("UPDATE public.feeding_records SET amount_ml=amount_ml+1 WHERE id=" + sql_literal(source_feeding))
        assert verify_runtime()["passed"] is False
        assert execute("SELECT count(*) FROM public.legacy_idempotency_mappings WHERE source_batch_id=" + sql_literal(checksum)) == before_receipts
        execute("UPDATE public.feeding_records SET amount_ml=amount_ml-1 WHERE id=" + sql_literal(source_feeding))
        assert verify_runtime()["passed"] is True
''')
    return text

edit("scripts/legacy-import/verify_target.py", "3d23aed5a384b5ac441921f77dca74dfff9d46ee", verifier)
edit("scripts/legacy-import/cutover_runner.py", "6b07bbb971e35450e6cfe7618d3247ea02ef825c", runner)
edit("scripts/legacy-import/test_care_materializer_integration.py", "cb02212f451fb0882a68f7b0958d523661c03dce", care_test)
