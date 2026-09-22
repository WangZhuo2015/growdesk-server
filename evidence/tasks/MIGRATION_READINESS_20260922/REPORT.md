# Migration readiness hardening — 2026-09-22

Status: **IMPLEMENTED_NOT_REVIEWED / partial delivery**. This report does not approve a production cutover or close the entire migration task.

## Scope and immutable revisions

- Base candidate: `cc35c0ac581b00fa057fdbac917d8e6fa6a15c73` (`codex/web-parity-20260919`).
- Implemented code checkpoint: `8e94e003ace348b16486d5b25c6609b9cde6bcf7`.
- Review branch: `codex/migration-readiness-20260922`; PR #8 targets the candidate, not main.
- Companion Web PR: [baby_panel_for_cecilia#21](https://github.com/WangZhuo2015/baby_panel_for_cecilia/pull/21).
- This report is documentation after the code checkpoint. No merge, deployment, production database operation, real account login, or paid AI call was performed.

## Implemented

### Actual runtime reconciliation

`canonical_verification.py` builds read-only predicates from the versioned pure materializers and reads the corresponding canonical runtime tables, instead of accepting archived rows and mapping counts as sufficient proof. It validates a bounded aggregate response and fails closed on absent attachment mappings and malformed results. The mapper remains the expected transformation specification; this does not independently prove that every business mapping rule itself is correct.

The managed PostgreSQL care regression imports synthetic data, verifies it, changes a canonical feeding amount without changing migration receipts, requires failure, restores the amount and requires success. This demonstrates detection of runtime corruption, not merely SQL-string assertions. Other materializer integration suites run as well; it is not a claim that every field in every domain has a separately injected-corruption test.

### Separate import and release gates

`verify_target.py` now reports `importIntegrityReady` separately from `releaseCutoverReady`. `cutoverReady` is an alias for the stricter release decision, not an alias for completed import phases.

`release_gate.py` requires explicit, private, bounded receipts tied by checksum to one source snapshot and a clean Web/Server commit pair. Required receipts cover paired browser/golden acceptance, attachments, the final stopped-writer snapshot, incremental reconciliation and restoration on a fresh target. Missing, stale, dirty, mismatched, malformed, tampered or unsafe evidence does not pass. The gate validates supplied evidence; it does not itself perform or authorize operational actions.

The verifier CLI defaults to `--require release` and exits nonzero when not ready. `--require import` is available to the orchestration runner and only means canonical import integrity. The cutover runner does not switch routing, and its final CLI status remains nonzero without release readiness.

### Legacy attachment object authorization

The new authenticated GET `/api/v1/web/attachments/resolve-legacy` resolves only completed attachment-reference mappings. It re-reads live family/baby memberships and ready, undeleted attachments, rejects unsafe paths and refuses ambiguous names. It returns only an attachment ID, not bytes, disk paths or public signed URLs. The companion BFF preserves old `/uploads/*` references through a same-origin redirect to the existing protected attachment endpoint, which authorizes again.

The resolver is wired into the actual application, canonical contracts and generated OpenAPI. Its real PostgreSQL regression is in the default managed integration runner: unauthenticated access, foreign family, unknown path, unsafe path, revoked baby membership using an old token, deletion and ambiguous mappings are covered. A valid historical mapping must already exist; no fallback to local files is offered for unmapped data.

### Query count and type quality

AI session list summaries are read in one bounded batch. A nonempty 30-session page uses three SQL round trips instead of 62, retaining the authorized page boundary and existing response shape. Five unit regressions cover query count, empty pages, last-message shape, malformed rows and input bounds.

Node-script globals and integration fixtures were corrected without disabling `no-undef` or `no-explicit-any`. HTTP fixture values now enter as unknown and are asserted before access. Original assertions, including ordered recipe results, remain.

### CI coverage

`migration-integrity.yml` separately runs 27 Python gate tests, the full backend guard/unit suite, and owned PostgreSQL/Redis integration with **`--legacy-care`**, including the materializers and runtime-corruption regression. These jobs do not silently disappear after a lint failure. The original backend workflow is retained.

## Actual validation

- [Run 35690767042, attempt 2](https://github.com/WangZhuo2015/growdesk-server/actions/runs/35690767042/attempts/2), job `106628085085`: Prisma generation, full workspace build, canonical contract generation, typecheck, lint/architecture, guard, full unit suite and `python3 scripts/test-integration.py --legacy-care` all **passed**. It exercised the exact application/test changes then published in `8e94e00`; only its temporary publishing workflow was removed in that commit.
- Earlier [Migration integrity run 35689673379](https://github.com/WangZhuo2015/growdesk-server/actions/runs/35689673379) passed all three jobs, including the 27 Python gate tests and real canonical-corruption check. This is earlier-checkpoint evidence, not a substitute for newer checks.
- Early validation failures were retained in history and fixed: Fastify schema typing, required attachment expiry in the fixture, and a control-character regex lint violation. No failing assertion or lint rule was removed to obtain the passing run.
- One-use editing/publishing workflows and scripts were removed after successful validation. No production-operation workflow was added.

## Not completed by this PR

- Full backend ownership of Web AI jobs/voice state, and real voice/daily-summary Worker processors.
- Durable MCP/OAuth/PAT credentials, real authorization context, scope narrowing and safe enablement of the remaining routes.
- Timeline batch-by-ID retrieval and complete supplement timeline data-source convergence.
- All existing Web unit/AI failures and current-pair strict golden/browser/private-object-store acceptance.
- Mandatory paired Web/S3/browser lanes in CI: the new workflow does **not** claim to run these optional lanes.
- Integration of candidate/main divergence, final writer stopping, incremental promotion, production attachment migration, restoration rehearsal and deployment.

Both PRs remain drafts. Passing these backend checks is not full product parity, visual acceptance, end-to-end production migration or independent review.
