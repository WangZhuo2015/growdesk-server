# BE_USER_EXPORT_DOWNLOAD

Status: `IMPLEMENTED_NOT_REVIEWED`. This work is uncommitted in the isolated worktree `/private/tmp/growdesk-server-account-export-20261003`, based on `263d0107f07ea2732f08747f5d1d37c4bd291a6e`. It has not been merged, deployed, or accepted.

## Result

The existing authenticated `POST /api/v1/me/export` flow now has a typed task-status route and a private JSON download route:

- `GET /api/v1/me/exports/{id}/status` returns only task state, attempt/timestamps, expiry, and an allowlisted error code. It never returns result payloads or internal error details.
- `GET /api/v1/me/exports/{id}` streams the completed version-1 JSON file with `application/json`, a task-scoped `.json` filename, exact `Content-Length`, `X-Content-SHA256`, and `private, no-store` caching.
- Download authorization rechecks the authenticated task owner and task kind, succeeded state, expiry, the user's current family membership, exact current baby grants, family permission epoch/version, canonical payload hash, and the hash of the exact response bytes. Family/baby revocation makes an existing export return `410 EXPORT_SCOPE_CHANGED`.
- The worker exports the user's public profile and authorized family snapshot pages, with the existing 32-family and 12 MiB limits. It excludes password hashes, sessions, recovery codes, and provider secrets. V1 does not package original attachment bytes.
- Recent password reauthentication remains required before receipt lookup. The optional `Idempotency-Key` remains backward-compatible; same-key/same-body requests replay the same task before and after worker completion, while a changed body returns `409 IDEMPOTENCY_KEY_REUSED`.
- Migration `202610030031_user_export_payload_expiry` stores and indexes an explicit payload expiry and backfills existing completed exports. Scheduler reconciliation physically replaces expired JSON payloads with `{"payloadPurged":true}` while keeping minimal task status queryable.

The legacy Web audit remains accurate: the old Web application has no login-user whole-account export page or download API. Its operator database backup and browser-local draft downloads are separate features. This implements the Plan 02 account-export workflow; it does not claim to replicate a legacy Web export flow. See [the source audit](/Users/wangzhuo/Documents/GitHub/growdesk-ios/evidence/tasks/IOS_WEB_PARITY_20261002/work-in-progress/account-export-download-audit/REPORT.md).

## Validation

Normal TypeBox/OpenAPI generation and consistency checks passed: 127 paths, 176 operations. Contract tests passed 11/11. `npm run backend:build`, `npm run backend:typecheck`, and `npm run backend:db:validate` passed; Prisma validation found 29 migration folders. `go test ./...` passed, as did `git diff --check` and Python bytecode compilation for the integration runner.

The final real HTTP run passed 58 assertions using a new disposable local PostgreSQL/Redis environment, three `test_` principals, two explicitly created families plus each principal's registration-created test family, three babies, and two growth records. It created five export tasks through HTTP and ran the real bounded Go export worker five times and the scheduler once. It verified fresh login, queueing, typed status, unauthenticated/foreign/wrong-task-type denial, queued-not-ready behavior, same-key replay and changed-body conflict, exact JSON/MIME/filename/length/hash, family-only membership without baby leakage, one-baby grant excluding its sibling and record, revocation invalidation, sanitized worker failure status, and physical expiry cleanup with status retention. The exact sanitized observation list and binary/source SHA-256 values are in [http-result-05.json](http-result-05.json); its SHA-256 is `05bacd257f5043affb84ac9b5b37a93a948a941db6f6728962f2d1b625c25c81`. The source digest listing is [source-sha256-http-result-05.txt](source-sha256-http-result-05.txt).

The owned stack used random loopback ports, a fresh non-superuser `test_` PostgreSQL role/database, Redis bound to loopback, and a virtual-only AI fixture. It used no model/provider call, external billing, push credentials, object storage, production secret, old Web database, or 3088/3089 process. The only SQL fixtures modified two already HTTP-created test export tasks to exercise worker failure and expiry cleanup; users, families, babies, records, and exports were created through the real API. Cleanup evidence records API/Redis/PostgreSQL stopped, no containers created, and private temporary build/data directories removed.

The integration verified normal-size exports; it did not construct a payload over 12 MiB to exercise the rejection boundary. The size guard remains enforced in the worker and download handler. iOS download/share UI integration is outside this server-only task.

The first harness attempt (`http-result-01.json`) expected only the two explicitly created owner families and failed when the real registration flow's additional default family appeared in the export. All owned resources were cleaned. The runner was corrected to enumerate the principal's current families through the public API, require `test_family_` names, and compare the exact authorized set; subsequent runs passed.

## Changed paths

- `packages/contracts/src/user.ts`, `packages/contracts/src/routes.ts`, `packages/contracts/tests/contracts.test.ts`, `scripts/contract-generator.mjs`, and generated `contracts/openapi.json`
- `internal/backend/native_exports.go`, `internal/backend/native_tasks.go`, `internal/backend/native_export_idempotency_test.go`, `internal/backend/native_sync_test.go`, and `internal/backend/foundation_test.go`
- `prisma/schema.prisma` and `prisma/migrations/202610030031_user_export_payload_expiry/migration.sql`
- `scripts/go-user-export-download-integration.py`
