# BE_AI_USAGE_BUDGET_PARITY_20261004

Status: `IMPLEMENTED_NOT_REVIEWED`. The change is on isolated branch `codex/ai-usage-budget-parity-20261004`, based on BE11 commit `eb79ddf599c47130f36ca114e2e0cfd814f1342b`. It is not merged, deployed, accepted, or integrated into the iOS API SDK. The API SDK remains frozen pending the next epoch decision.

## Implemented

- Replaced the unavailable `GET /api/v1/me/ai-usage` stub with an authenticated, owner-scoped snapshot. It returns actual Go MCP dispatch statistics, client/tool ranking, a 14-day call trend, recent audit rows, AI run state, provider-attempt usage, and the configured internal budget. Optional `babyId` is checked against the authenticated user's current baby membership. Coverage explicitly identifies native Go only and marks legacy Web history, client IP, unsupported legacy MCP tools, and unpriced provider cost as unavailable.
- Added an MCP call ledger. A row begins only after OAuth access authentication; it records method/tool, current grant/family/baby, result category/status, duration, and records created. The supported `create_supplement_product` mutation writes its record count in the same transaction as the product and idempotency receipt. Replays count zero. No arguments, credentials, or IP addresses are retained. This does not treat OAuth `last_used_at` as a call count.
- Added a provider-attempt ledger written transactionally before the provider request. It stores model/ASR phase, provider/model, terminal status, nullable token counts, and an explicit usage state. Successful responses without usage retain null counts and `unknown`; costs remain null with state `unpriced` because no rate card is specified. Attempt IDs are passed as provider idempotency keys.
- Added PostgreSQL-reserved internal budget units. Configuration must explicitly set `GROWDESK_AI_BUDGET_UNIT=ai_run_attempt`, `GROWDESK_AI_BUDGET_PERIOD=utc_day`, and positive user/family/global limits. No amount is represented as money or tokens, and no user-editable budget API/card was added because neither the Web flow nor the plan defines a budget-edit contract. Family/global active-run caps are configurable (`GROWDESK_AI_MAX_ACTIVE_FAMILY_RUNS`, `GROWDESK_AI_MAX_ACTIVE_GLOBAL_RUNS`) with bounded defaults; user concurrency is capped at two. Reservations are atomic in PostgreSQL and are settled or released through success, failure, cancellation, retry, reconciliation, and account deletion paths.
- Account deletion purges owner-scoped MCP/provider ledgers, reservations, and user budget windows; it releases undispatched family/global reservations while preserving settled aggregate units. A later claim of an ownerless queued task cancels the task without provider dispatch.

## Evidence

All integration data used isolated `test_` users and their test families/babies. `scripts/test-integration.py` owns and removes a disposable PostgreSQL/Redis runtime. The AI accounting test used only an in-process loopback virtual OpenAI-compatible provider returning known usage once and omitting usage once. No production connection, credential, paid provider, push, or old Web service/database was used.

Passed checks:

- `go test ./...`
- `go test -tags 'pat_integration,mcp_oauth_integration' -run '^$' ./internal/backend`
- `npm run backend:test:unit` — 165/165 tests
- `npm run backend:typecheck`
- `npm run backend:lint` — ESLint and architecture check
- `npm run backend:db:generate` and `npm run backend:db:validate` — Prisma client generated; schema valid, 32 migration folders checked
- `npm run backend:contracts:generate` and `npm run backend:contracts:check` — OpenAPI synchronized at 141 paths / 192 operations
- `python3 scripts/test-integration.py --suite all` — owned migration/readiness, Go AI-usage/PAT/OAuth HTTP integrations, and backend integration suites passed; owned resources were removed
- `python3 scripts/test-integration.py --suite mcp-oauth` — persisted MCP creation/replay accounting, usage aggregation, foreign-user/baby isolation, OAuth lifecycle, and deletion cleanup passed after the final assertion change
- `python3 -m py_compile scripts/test-integration.py`, `gofmt`, and `git diff --check`

The AI usage integration exercised two queued runs at the per-user concurrency limit, a third rejected run, known and absent provider usage, exactly-once worker/message replay, cross-user and cross-baby read isolation, an exhausted internal attempt budget, reservation release, and account deletion. The OAuth integration exercised a real Go `tools/list`, a real `create_supplement_product`, idempotent replay, exact owner dashboard counts/ranking/log count, cross-account isolation, and purge after account deletion.

## Resolved validation diagnostics

Initial attempts stopped before the final passing gates and were repaired:

- The first owned integration attempt had no worktree `node_modules` (`tsc: command not found`); `npm ci` restored the lockfile-defined dependencies without changing package manifests or lockfiles.
- The first contracts build caught a route metadata typo (`query` instead of `querystring`); the route now uses the repository's canonical `RouteDefinition.querystring` field.
- The next build required the generated Prisma client; `npm run backend:db:generate` generated it from the checked-in schema.
- The next owned run detected generated OpenAPI drift; `npm run backend:contracts:generate` updated `contracts/openapi.json`, and the consistency check then passed.

`npm ci` printed an advisory summary of 7 dependency vulnerabilities (2 moderate, 5 high); dependencies were not upgraded as part of this task. Existing Fastify schema warnings in `/api/v1/web/ai/sessions` appeared during the runner and were outside this route change.

## Gaps and boundary

- The plan specifies no user-editable budget protocol and no pricing/rate-card source. Public budget CRUD and currency/token cost claims remain out of scope.
- The actual Go MCP adapter currently supports only `tools/list` and `create_supplement_product`; older Web MCP tools and historical Web call records are not represented. The endpoint reports this coverage gap instead of inventing totals.
- This server branch only exposes the data contract. iOS SDK integration, review, production migration, deployment, old Web dashboard changes, and full legacy history parity remain separate work.

## Changed paths

- `internal/backend/ai_usage.go`, `ai_usage_read.go`, `mcp_usage.go`, and `native/migrations/0005_ai_usage_accounting.sql`
- AI provider, task, processor, OAuth, authentication, and PAT handlers plus the isolated integration tests
- `packages/contracts/src/personal-access-tokens.ts`, `packages/contracts/src/routes.ts`, and generated `contracts/openapi.json`
- `scripts/test-integration.py`
