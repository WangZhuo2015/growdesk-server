# Legacy cutover runner

Status: `REVIEWED_LOCAL_GATES_PASSED`

This card adds the explicit, fail-closed orchestration boundary for the final
legacy import rehearsal. `deploy/import-legacy-target.py` now requires an
immutable snapshot directory and its manifest; it no longer selects a dated
snapshot implicitly. `scripts/legacy-import/cutover_runner.py` validates the
archive/source hashes and source ID, checks that the target is the pinned
GrowDesk Compose PostgreSQL service, runs each materializer in sequence, and
writes 0600 machine-readable phase receipts below a 0700 receipt directory.

The attachment phase is intentionally explicit. It requires the private S3
configuration, executes the object-store/database promotion CLI, retains the
planner receipt for AiArchive and business-reference proof, and stops on any
quarantine or unresolved reference. `verify_target.py` reports source table
counts, target legacy rows, mapping receipts, phase failures, quarantine, and
unresolved attachments. It emits `cutoverReady: true` only when those gates
are clean.

Validation completed locally without Docker, PostgreSQL, SQLite production
files, or credentials:

```text
python3 scripts/legacy-import/test_cutover_runner.py       # 8 passed
python3 scripts/legacy-import/test_verify_target.py        # 2 passed
python3 -m py_compile deploy/import-legacy-target.py scripts/legacy-import/cutover_runner.py scripts/legacy-import/verify_target.py
npx tsc -p tsconfig.backend.json --noEmit
npx eslint scripts/legacy-import/attachment-reference-backfill-cli.ts scripts/legacy-import/attachment-promotion-cli.ts
git diff --check
```

The runner is not a production cutover approval. Before routing traffic, the
operator still needs a final stopped-writer SQLite snapshot, a fresh-target
rehearsal with rollback evidence, complete object-store configuration and
receipts, and a verification report whose `cutoverReady` is true. This card
does not deploy or switch the production Web.
