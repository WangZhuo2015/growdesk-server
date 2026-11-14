# Vaccine booklet corrections — 2026-11-14

Status: **IMPLEMENTED_NOT_REVIEWED**.

Baseline: `d89d9ef380482e39df3171a6f782de63101cebbb` on `main`.
Implementation was tested as an uncommitted working tree on
`codex/vaccine-booklet-20261114`. The baseline revision embedded in the test
executable identifies its starting commit, not a claim that the working tree was
committed. `http-regression.json` records the executable hash, tracked diff hash,
service versions and actual HTTP observations.

No production account, production database, deployment, real vaccination booklet
or external paid provider was accessed. All regression users, babies and fixtures
are synthetic and explicitly named `test_`.

## Problem and implemented behavior

The previous selection handler used the current date when a checkbox was marked
completed, rewrote a matching vaccination record and could delete that record when
the checkbox was cleared. It also assumed a first dose and substituted an actual
date for a missing appointment date. There was no versioned in-place correction
endpoint for an existing vaccination record.

This change separates preferences, appointments and clinical facts:

- `PUT .../vaccines/selections` changes the selection only. Its `completed` value
  is derived from live, completed records matching the same family, baby, vaccine
  and known dose. A supplied legacy `completed` value that disagrees with those
  records returns `400 VACCINE_RECORD_REQUIRED`, with a direction to enter or
  correct the actual record. An unchanged selection with a matching completion
  value is a no-op, including its record, timeline, receipt and cursor state.
- `PATCH .../vaccines/records/:id` updates the existing record atomically. It
  requires a positive decimal-string `baseVersion`; stale or exhausted versions
  return `409 CONCURRENCY_CONFLICT`. Omitted fields are preserved and explicit
  null clears nullable fields. IDs, family scope and creation receipts remain
  stable. The corresponding timeline entry is corrected in the same transaction.
- `DELETE .../vaccines/records/:id` accepts an optional observed version through
  either the JSON body or the `baseVersion` query parameter. Supplied values must
  agree and must match the stored record; an old editor cannot delete a newer
  correction. Old clients that omit the version remain compatible. Soft deletion
  increments the record version and the live timeline version.
- Added nullable `manufacturer`, `productName`, `traceabilityCode` and
  `injectionSite` through PostgreSQL, Prisma, Go, TypeScript and OpenAPI. The
  traceability code remains a string, preserving leading zeros. A missing dose
  remains null; raw `legacyName` and `legacyDose` are retained.
- The additive migration only creates four nullable columns. It does not infer
  or rewrite historical clinical fields or selections.

### Date semantics

| State/action | Actual and compatibility date | Appointment | Completion |
| --- | --- | --- | --- |
| Create completed record | Explicit full, real calendar date required in `administeredDate` | Missing means null | Equals the actual date |
| Create plan | Required legacy `administeredDate` is normalized to the explicit appointment | Explicit `scheduledDate` required | Null; no vaccination timeline entry |
| Reschedule plan | Compatibility anchor follows the new appointment | New explicit date | Remains null |
| Complete existing plan | PATCH must explicitly supply the actual `administeredDate` | Existing appointment preserved unless changed/cleared | Equals the actual date |
| Correct completed record | Same record ID, version increment and corrected timeline | Never inferred from the actual date | Equals the corrected actual date |

`isCompleted` still defaults to true on creation for existing clients, but that
does not supply a missing actual date. Partial or impossible dates are rejected.
Setting a record back to a plan requires an appointment and removes its live
vaccination timeline projection.

## Contract and client handoff

- Added operation `updateVaccineRecord` and its required versioned request.
- The deletion body is explicitly optional in OpenAPI. The compatible query
  version is also declared, so existing iOS deletion middleware remains usable.
- Declared the actual create-record 404/409 and selection 404 error responses.
- Canonical contract now contains **113 paths and 162 operations**. The current
  Go operation-inventory assertion was increased from 161 to 162 for the new
  operation. The frozen historical parity reference was not modified.
- Web and iOS must copy/pin this server contract and use the eventual server
  commit. This evidence does not claim those independent repositories have been
  deployed or accepted.

## Validation

Passed in this workspace:

- `npm ci --ignore-scripts --no-audit --no-fund` and Prisma client generation.
- `npm run backend:build` across all backend workspaces.
- `npm run backend:typecheck`.
- `npm run backend:contracts:generate` and `npm run backend:contracts:check`.
- Targeted ESLint for the modified TypeScript services, routes, contracts, test
  and contract generator.
- `node --import tsx --test apps/api/tests/vaccine-booklet.test.ts`: **4 passed**.
- `go test ./internal/backend -run TestVaccine -count=1`.
- `go test ./... -count=1`: all discovered Go packages passed.
- Go API compilation with the baseline revision recorded in the executable.
- Python syntax checks for both vaccine HTTP scripts.
- `git diff --check`.

### Real PostgreSQL and HTTP regression

`scripts/go-vaccines-local-integration.py --reference` runs the same
`VaccineScenario` against the real Go API and the real TypeScript API. Each run
creates a new cluster, a new `test_` database and a dedicated non-superuser role;
the runner validates the loopback host, generated database/role identity and live
role privileges before applying all migrations. It accepts executable paths,
never an externally supplied connection URL, existing cluster or real account.
PostgreSQL and Redis bind only to fresh loopback TCP ports. Owned child processes
and temporary data are removed on completion or failure.

Services used: **PostgreSQL 18.6 and Redis 7.4.0**. The normal Docker harness pins
Redis 8; that exact infrastructure matrix is not claimed here. No SQLite,
in-memory database or transaction/authorization mock substitutes for PostgreSQL.
Object storage and external AI are not used by this scenario.

`http-regression.json` records a **PASS**, with 16 matching Go/TypeScript
observations. There are 66 tracked scenario HTTP assertions for Go and 67 for
TypeScript, plus two real simultaneous PATCH requests per runtime and two direct
cross-runtime reads. Health probes are additional.

The scenario verifies:

- Known/unlisted vaccine resolution, nullable unknown dose, raw booklet fields,
  leading-zero traceability code and nullable metadata clearing.
- Explicit appointments, appointment-only rescheduling and the absence of a
  vaccination timeline entry for plans.
- Rejection of completing a plan without an explicit actual date, impossible
  dates and inconsistent completion dates.
- Original-ID correction, version increments, stale-version rejection and two
  concurrent writers producing exactly one success and one conflict.
- Checkbox changes leaving historical record dates, fields, versions, receipts
  and timeline untouched; mismatched completion requests rejected; matching
  no-op requests leaving the cursor untouched.
- Actual record deletion changing the derived completion state; body/query
  version conditions, stale deletes, mismatched body/query versions and old
  versionless clients.
- Idempotent identical creation replay and conflicting key reuse.
- PostgreSQL trigger-induced cursor failure rolling back record, timeline,
  selection, receipt and cursor mutations together for create/update/delete and
  selection changes.
- Outsider isolation, viewer write rejection and live family revocation despite
  a previously issued session token.
- Persistence after restarting each API and consistent Go reads of TypeScript
  records and selections.

The first two local attempts exposed runner-fixture issues (the `pg` DATE parser
converted a calendar date through the host timezone, and hand-written test
memberships omitted their required `updated_at`). Both fixtures were corrected;
the final run starts from entirely new databases and passes both real runtimes.

## Reproduction

Build workspace packages and generate the Prisma client first. Build the Go API
from this checkout with `main.revision` set to its baseline or eventual commit.
Then run, using local paths to real executables:

```sh
python3 scripts/go-vaccines-local-integration.py \
  --postgres-bin /path/to/postgresql18/bin \
  --redis-binary /path/to/redis-server \
  --binary /path/to/growdesk-api \
  --reference \
  --report /path/to/http-regression.json
```

The existing Docker entry point `scripts/go-vaccines-integration.py --reference`
also reuses the updated scenario; Docker execution was unavailable here.

## Limits and remaining review gates

- This is implementation evidence, not independent acceptance, production
  migration or deployment. No old-data reconciliation or real booklet import
  was attempted.
- The medical/vaccine REST path still advances the family cursor without
  emitting `family_changes`. Vaccine commands were not added to the incremental
  sync protocol. This task does **not** establish incremental cross-device sync.
- Go full snapshot/export projection now derives selection completion using
  the same live-record rule and includes the new record fields. Its worker/object
  storage delivery was not exercised by this HTTP test.
- Attachment linkage, vaccine OCR candidate confirmation and multi-row photo
  import are not implemented here. The existing medical OCR/AI paths must not be
  presented as a complete vaccination import flow.
- `scripts/go-coverage.py` still checks its frozen 151-operation historical
  reference; baseline `main` already had 161 canonical operations. That existing
  global parity/rebaseline gate remains unchanged and is not claimed green.
- The whole historical TypeScript integration suite, Docker/Redis 8 matrix,
  full lint/architecture gate and iOS Xcode/device build were not run by this
  server task. Required migration rollout and independent review remain open.
