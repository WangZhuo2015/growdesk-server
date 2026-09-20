# Legacy attachment reference backfill

Status: `IMPLEMENTED_NOT_REVIEWED`

This slice adds a separate business-reference boundary after the existing
attachment promotion runtime. It links only canonical references that are
present in the current schema:

- `Baby.avatarUrl` receives `/api/attachments/<uuid>` and private mapping
  metadata.
- `GrowthMeasurement.attachmentId` receives the verified attachment ID.
- `MedicalReportAttachment` receives a deterministic report/attachment join.

The implementation does not copy objects and does not change the attachment
promotion runtime. Every receipt is checked against the immutable
`legacy_import` batch/row, source hash and normalized archive path, the
attachment promotion mapping, and the live ready Attachment row. Family,
Baby, purpose, uploader membership, and target ownership are checked inside a
single PostgreSQL transaction. Public or external URLs are rejected; an
existing conflicting canonical reference fails closed. AI and voice source
fields are quarantined because the canonical schema has no approved reference
field for them.

The transaction takes a PostgreSQL advisory lock, locks source targets and
Attachment rows, and creates a deterministic `attachment_reference`
idempotency mapping. Replays are verified and return `replayed`; a matching
existing canonical link can be reconciled. Any quarantine or database failure
returns `database: not_written` and rolls back the whole batch.

## Files

- `scripts/legacy-import/attachment-reference-backfill.ts`
- `tests/unit/legacy-attachment-reference-backfill.test.ts`
- `tests/integration/legacy-attachment-reference-backfill.test.ts`

## Evidence

All commands were run from the repository root. The integration run used a
new private PostgreSQL 18 cluster, a `test_runner` role/database, a private
`BOOT02_RUN_FILE`, and the complete local migration sequence. It did not read
production credentials or connect to a production service.

- `npm run backend:typecheck` — passed.
- `npx eslint scripts/legacy-import/attachment-reference-backfill.ts tests/unit/legacy-attachment-reference-backfill.test.ts tests/integration/legacy-attachment-reference-backfill.test.ts` — passed.
- `node --import tsx --test tests/unit/legacy-attachment-reference-backfill.test.ts` — 3 passed.
- `node --import tsx --test tests/integration/legacy-attachment-reference-backfill.test.ts` in the one-off owned PostgreSQL 18 harness — 1 passed.

The owned PostgreSQL test proves first-run writes for Baby/Growth/Medical,
private avatar URL output without `legacyUrl`, ready-state enforcement,
cross-family rejection, public URL conflict rejection, idempotent replay, and
whole-batch rollback when a later reference crosses tenant scope.

Independent review and deployment remain outstanding.
