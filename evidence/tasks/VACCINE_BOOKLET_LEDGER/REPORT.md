# VACCINE_BOOKLET_LEDGER

Status: **IMPLEMENTED_NOT_REVIEWED**. No production migration, merge or deployment was performed.

## Request, scope and baseline

Make vaccination recording usable against a paper booklet: preserve each administration, separate appointments from completed vaccinations, retain uncertain source text, and keep manufacturer/batch/clinic details. No supplied image, child identity, real vaccination row or traceability identifier is included in the repository.

Baseline: `d89d9ef380482e39df3171a6f782de63101cebbb`.

Companion Web repository: `WangZhuo2015/baby_panel_for_cecilia`, baseline `ecf29fb3ce0c1dabdb20c545fdc264acd44d0189`. The Web changes opt into the ledger representation and include the recording/editing UI. Native iOS was audited for compatibility; its UI and pinned contract snapshot are not changed here.

## Implementation

- Add `recordStatus` (`completed`, `planned`, `needs_review`), nullable actual dates and booklet metadata to vaccine records.
- Require a real explicit nonfuture actual date for completion, using the Shanghai calendar day. Planned dates never silently become actual administrations. Unverified source dates can be retained without counting as completion.
- Add `PATCH /api/v1/babies/{babyId}/vaccines/records/{id}` with `baseVersion`, scoped authorization, atomic transaction and timeline updates. Omitted metadata is preserved. DELETE accepts the observed version.
- Preserve unknown dose ordinals and explicitly unassigned products. Selected product codes/IDs resolve exactly; unknown legacy free text remains raw text.
- Keep stable create idempotency receipts and reject reuse for different content.
- Make `selection.completed` read-only and derive it from confirmed dated records. Changing a selection can no longer create, redate or delete a clinical record.
- Add `x-growdesk-representation: ledger` on record endpoints. The opt-in view exposes truthful nullable dates; the default response retains the old iOS non-null date transport shape for completed/planned rows and omits review rows. `Vary` distinguishes these representations.
- Keep existing public family snapshots on the legacy projection, omitting review rows without manufacturing dates. The complete ledger is available through the opt-in records endpoint; this is not a new native snapshot protocol.
- Keep the TypeScript reference service compatible with the additive schema and the new record-driven completion semantics.

The additive migration relaxes the date constraint before clearing appointment transport placeholders, adds metadata and lifecycle constraints, and moves future-dated historical completion claims into review while retaining their reported date. Existing record dates remain reviewable; no schedule-derived or current date is inserted as a missing actual date.

## Contract and validation

- Generated OpenAPI contains **162 unique HTTP operations**, including `updateVaccineRecord`.
- `npm run backend:db:generate`: passed.
- Prisma schema validation and migration-directory validation: passed.
- `npm run backend:build`: passed after generating the Prisma client.
- `npm run backend:typecheck`: passed.
- `npm run backend:contracts:check`: passed.
- Python compilation for the changed HTTP harness and coverage checker: passed.
- `git diff --check`: passed.

New pure Go regressions cover missing/future/invalid actual dates, plan-to-completion confirmation, Shanghai midnight, metadata-preserving updates, unknown ordinals, unverified reported dates and the old/new response representations. The real PostgreSQL scenario covers record-driven completion, versions, replay conflicts, scope, rollback, tombstones and restart. The companion Web CI also exercises real Next HTTP -> Go -> PostgreSQL for the ledger.

**Go compilation, Go tests and PostgreSQL integration were not run locally.** The workspace's `/usr/bin/go` is not the Go compiler; no usable Go/gofmt, PostgreSQL or container runtime was available, and official toolchain download attempts timed out. `.github/workflows/vaccine-ledger.yml` adds a dedicated candidate validation job without removing existing CI checks.

## Existing CI baseline limitations

Three older workflows compare all `apps`, `packages`, `prisma` and `contracts/openapi.json` files against frozen commit `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`. Baseline main already differs in 28 protected paths before this change. Those historical guards remain unchanged; they are not evidence that this candidate passed or failed a behavioral test.

The old coverage script also hardcoded 151 while baseline OpenAPI already contained 161 operations. Its coverage check now requires an exact, nonempty match against every operation in the committed contract, preserving duplicate/mismatch/missing-handler failures. The contract inventory fixture now expects 162 operations.

## Acceptance and rollout gates

1. Dedicated native ledger CI must pass compilation, Go tests and real owned PostgreSQL HTTP/transaction checks. Local TypeScript checks do not substitute for these.
2. Run paired Web integration against this exact backend commit, then review mobile browser interaction separately.
3. Review the migration against an owned copy of representative legacy schema/records, including pre-migration record-snapshot restore compatibility. Review rows are intentionally absent from the old iOS and public family-snapshot projections.
4. Apply the backend migration/API before the new Web ledger. Do not change the pinned iOS contract or claim native UI completion as part of this change.
