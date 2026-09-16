# Web AI session persistence repair — 2026-09-16

Status: **IMPLEMENTED_NOT_REVIEWED**. Submitted on a separate branch at the user's request; not merged, deployed or approved for production cutover.

## Baseline and publication

- Repository: WangZhuo2015/growdesk-server
- Branch: `codex/ai-session-persistence-20260916`
- Main baseline: `84401a494d8d3b85253f7e4945e0cafdaba21f76`
- Tested code commit: `ed86bcbc2b51e6ac0b92dcc02120dabcf528b77f`
- PR: https://github.com/WangZhuo2015/growdesk-server/pull/7
- Remaining integration work: https://github.com/WangZhuo2015/growdesk-server/issues/6 (not closed)

## Implemented scope

Recover only the durable conversation portion of checkpoint `56fb2a6`, not its broken broad rewrite of app.ts, temporary workflows, unconnected media transport or task-publication helpers.

The six authenticated `/api/v1/web/ai/sessions` operations provide creation, listing, detail, rename, deletion and idempotent message append using existing PostgreSQL tables. The new service does not use local JSON or in-memory success fallback. Reads and mutations check the authenticated owner and current baby/family membership. Appends serialize on their session and reject conflicting message IDs; oversized history produces an explicit error rather than silent truncation.

The current main application's schema registrations and initialization/cleanup paths are preserved. app.ts has only five added lines to import and register the Web plugin. This avoids the earlier blanket schema-registration startup failure (`ActivityRecommendation` already exists). The canonical OpenAPI snapshot and route exports are restored with the matching contract definitions.

## Actual verification

GitHub Actions run **35061213990** completed **success** for tested code `ed86bcb`:

https://github.com/WangZhuo2015/growdesk-server/actions/runs/35061213990

The existing workflow runs Prisma generation, workspace build, typecheck, lint/architecture checks, guard and unit tests, plus owned PostgreSQL 18 / Redis 8 integration tests and runner lifecycle tests. No checks were removed or relaxed.

Added coverage:

- Two startup/contract unit tests: repeated application initialization does not register duplicate schemas; all six Web operations are exported exactly once.
- Nine PostgreSQL integration subtests using Fastify injection: unauthenticated and foreign-baby access, creation, message replay/conflict, persistence across fresh application/service instances, foreign-user operations, revoked membership, concurrent identical submissions, invalid input without data mutation, and explicit deletion without resurrection.
- The regression suite is explicitly invoked by `scripts/test-integration.py` after migration setup. Test revocation uses the database's valid `revoked` state, not the invalid `inactive` state from the previous checkpoint.

The database is real and owned by the test runner. Fastify injection and fresh application objects are **not** browser E2E or an operating-system process-restart test. All fixtures use test-prefixed identities. No production database, credentials, external provider or paid AI invocation was used.

The local sandbox could inspect mounted source archives but could not resolve the npm registry; no local full dependency installation, build or database run is claimed. Verification above is the actual remote CI run. This report is a documentation-only follow-up to the tested code commit.

## Explicit remaining work

- The existing Web application still uses its original session store; no caller cutover or local-only history import is included here.
- AI jobs, voice logs, notifications and their local-state migration remain separate work.
- Voice transcription and daily-summary processors are not completed by this PR.
- Browser → Next.js → API → PostgreSQL/private-storage acceptance, full-field migration, attachment reconciliation and cutover/recovery rehearsal are not done here.

No changes were made to baby_panel_for_cecilia or either main branch. No branches were deleted or visibility changed. Keep the PR open for review; do not interpret successful CI as full-product completion.
