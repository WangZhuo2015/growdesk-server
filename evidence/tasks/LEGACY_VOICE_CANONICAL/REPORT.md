# GrowDesk AgentVoiceLog canonicalization — 2026-09-19

Status: **IMPLEMENTED_NOT_REVIEWED**. No commit, production migration, deployment, or production data access was performed.

## Scope implemented

- Added canonical PostgreSQL `public.agent_voice_logs` and Prisma `AgentVoiceLog` with explicit `user_id`, `family_id`, `baby_id`, prompt/reply, async/fast-path flags, acknowledgement, timestamp, composite family/baby foreign key, and query indexes.
- Added migration `prisma/migrations/202609190022_agent_voice_logs/migration.sql`.
- Added canonical contracts and four authenticated API operations: list, create, get, and acknowledge. The service derives family scope from the database baby row and requires current active family and baby membership from `request.principal`; no request-supplied user/family identity is trusted.
- Switched GrowDesk Web voice history routes and voice-result persistence to the backend bridge. Existing Web response envelopes remain `{success, logs}`, `{success, unreadLog}`, `{success, log}`, or `{success}`. Legacy Prisma mode remains available for the old path.
- Added an old `AgentVoiceLog` materializer. It verifies the immutable `legacy_import.import_rows.payload_hash`, proves user/family/baby scope, writes the canonical row and `legacy_idempotency_mappings` receipt atomically under an advisory lock, preserves post-import edits on replay, and fails closed on receipt/target/source conflicts.
- Added owned PostgreSQL integration coverage for API membership isolation and materializer replay/tamper behavior. Both suites are wired into `scripts/test-integration.py`; the runner requires its private `test_growdesk_integration` manifest.

## Files in this card

Server files:

- `prisma/migrations/202609190022_agent_voice_logs/migration.sql`
- `prisma/schema.prisma` (AgentVoiceLog model and User/Family/Baby relations only; the file also contains concurrent work)
- `packages/contracts/src/voice-logs.ts`
- `packages/contracts/src/index.ts` and `packages/contracts/src/routes.ts` (voice exports/definitions)
- `apps/api/src/services/voice-log-service.ts`
- `apps/api/src/routes/voice-log-routes.ts`
- `apps/api/src/app.ts` (voice schema and route registration only; the file also contains concurrent work)
- `tests/integration/voice-logs.test.ts`
- `scripts/legacy-import/materialize_voice_logs.py`
- `scripts/legacy-import/test_voice_log_materializer.py`
- `scripts/legacy-import/test_voice_log_materializer_integration.py`
- `scripts/test-integration.py` (runner wiring)

Web files:

- `lib/growdesk/voice-log-api.ts`
- `app/api/agent/voice/logs/route.ts`
- `app/api/agent/voice/logs/[id]/route.ts`
- `app/api/agent/voice/route.ts`
- `tests/unit/growdesk-voice-log-api.test.ts`

## Validation evidence

Passed:

- `python3 scripts/legacy-import/test_voice_log_materializer.py` — 6/6 pure materializer checks.
- `npx tsx --env-file=.env.test --test tests/unit/growdesk-voice-log-api.test.ts` — 4/4.
- `npm run typecheck` in `baby_panel_for_cecilia` — passed.
- `npm run --workspace=@growdesk/contracts typecheck` — passed.
- `npx prisma validate --schema prisma/schema.prisma` — passed.
- `git diff --check` for the card paths — passed.
- Targeted Web `oxlint` — exit 0; existing `no-explicit-any`/escape warnings remain.

The complete Web unit command ran against the repository's isolated `dev_test.db`: 641 passed and 2 pre-existing `growdesk-mcp-oauth` assertions failed (`tests/unit/growdesk-mcp-oauth.test.ts`, fine-grained upstream operations). The new voice bridge tests passed within that run.

## Open blockers and unclaimed proof

- The owned PostgreSQL runner was attempted but could not reach the business suites because concurrent work currently prevents the backend build/startup: `record-snapshot-service.ts` has two bigint type errors; Fastify contract startup also reports a duplicate `VaccineCatalogItem` schema from concurrent vaccine work. `backend:contracts:check` therefore remains blocked by that vaccine schema error. `backend:db:validate` currently sees an empty concurrent `prisma/migrations/202609190022_record_snapshots` directory. No successful owned PG integration result is claimed here.
- The Web repository has no `START_HERE.md`; its `AGENTS.md` and referenced plan sections were read.
- This is implementation evidence only. Independent review, deployment, production migration, browser cutover, restart durability, and old-data reconciliation remain separate gates.
