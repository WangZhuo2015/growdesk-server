# Clinical decimal precision

**Status: IMPLEMENTED_NOT_REVIEWED.** This report records an isolated Go backend implementation and its validation. It does not claim independent acceptance, production migration, or deployment.

The pre-fix HTTP repro used a disposable PostgreSQL/Redis/MinIO stack and test-only principals. The API accepted ratio `0.133333333333333333`, weight `8.275`, height `70.55`, and head circumference `44.1375`, then returned `0.13333`, `8.28`, `70.6`, and `44.1`. See [pre-fix HTTP evidence](pre-fix-http-repro.json).

Migration 033 widens formula reconstitution ratio and Growth weight, height, and head circumference to unconstrained PostgreSQL `NUMERIC`. Existing populated values at their former supported scales remained unchanged during an actual 032-to-033 isolated upgrade. Growth read projection now returns the persisted decimal text directly after validating that it is a finite PostgreSQL numeric; it no longer passes through a binary float and `toFixed`-style display scale.

The real HTTP integration then verified create, update, get, and list round-trips for formula ratios and each Growth field. It also confirmed exact `optionalGrowth` values when a typed Medical OCR draft was accepted into a report, plus cross-scope denial and stale compare-and-swap conflicts. Food amount was inspected and left unchanged: its API rejects values above five fractional digits, matching its `NUMERIC(12,5)` column.

Prisma 7.10's generated DDL still maps an unannotated PostgreSQL `Decimal` client field to `DECIMAL(65,30)`. The Prisma schema comments state that this scalar does not describe the physical typmod. The database validation helper runs Prisma's schema-to-DDL diff to assert that default, verifies migration 033 uses unbounded `NUMERIC`, and rejects a later migration that restores a bounded precision/scale to these columns. `migrate deploy` continues to apply the hand-authored migration history; do not generate replacement column DDL from the Prisma scalar defaults without reviewing this override.

The main passing live integration artifact is [live-76f8d0ca5ec9.json](live-76f8d0ca5ec9.json). It records 92 HTTP assertions and source manifest SHA-256 `f8f9ecebfa526d02ca4bffd4ea775fca24b05a0f0f58fca366c4319307e725b4`. The disposable stack and data were removed after the run.

Validation completed:

- `go test ./...`
- `python3 scripts/go-medical-growth-ocr-typed-integration.py` — PASS, 92 HTTP assertions, private fixture only
- `npm run backend:db:validate` — Prisma 7.10 schema validation, migration inventory, and clinical decimal mapping guard passed
- `npm run backend:db:generate`
- `npm run backend:build`
- `npm run backend:lint`
- `npm run --workspace=@growdesk/contracts build`
- `npm run backend:contracts:check`
- `git diff --check`
