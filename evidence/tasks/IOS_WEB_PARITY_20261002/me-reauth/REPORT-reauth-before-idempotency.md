# Recent-session reauthentication for account export and deletion

Status: **IMPLEMENTED_NOT_REVIEWED**. Work is isolated in `/private/tmp/growdesk-server-me-reauth-20261003` on `codex/me-reauth-20261003`, based on `516371a5959e11db865969cd0b2f9aa42be9bfa2`. No commit was created. The separate vaccine-edit worktree remains frozen and unchanged.

## Behavior

- `POST /api/v1/me/export` and `DELETE /api/v1/me` now require the authenticated device session's `created_at` to be within the inclusive five-minute window at database `statement_timestamp()`. Future-dated session rows are rejected. The check runs inside each operation's existing transaction after locking the user and validating the live session.
- A stale live session receives HTTP 403 with `REAUTH_REQUIRED`. Refresh rotates credentials and updates `last_seen_at`, but it does not change `device_sessions.created_at`; therefore refreshing an old session cannot satisfy reauthentication.
- The canonical TypeBox route source declares 403 for both operations, and `contracts/openapi.json` was regenerated with the contract generator. No generated OpenAPI file was edited by hand.
- Successful export retains existing behavior: it queues one user-scoped export task and returns 202; the authenticated account remains active. Successful deletion retains the existing soft-delete behavior and revokes every device session and refresh credential. Shared family/baby rows and another active caregiver's access remain intact.

This change does not implement asynchronous deletion tasks or run/download the export worker. The API currently soft-deletes the account synchronously; that existing behavior is intentionally preserved and is not evidence that the plan's future queryable deletion-task flow is complete.

## Verification

- `go test ./...` — passed, including the exact five-minute inclusive cutoff, just-inside, just-outside, and future-date unit cases.
- `node scripts/check-contracts.mjs` — passed; 112 paths and 159 operations match the TypeBox source.
- `python3 -m py_compile scripts/go-me-reauth-integration.py` and `git diff --check` — passed.
- `python3 scripts/go-me-reauth-integration.py` — passed 25 real HTTP assertions against an API built from this worktree and a new local PostgreSQL/Redis/MinIO stack. It verifies stale-session export/delete denial with no state changes, refresh does not renew session age, fresh login permits export, revoked sessions cannot make requests, fresh login permits deletion and revokes all sessions/refresh tokens, another family member can still read the shared baby, and that member's export task is scoped to their own principal.

The latest sanitized response/state evidence is `http-result.json`. It records loopback service addresses, test-prefix tenant information, response codes, source hashes, empty database diagnostics, and successful cleanup. PostgreSQL used a fresh `test_` database and non-superuser `test_` role; the runner applied 25 Prisma migrations and three native migrations. Redis and MinIO also ran only on loopback with per-run virtual credentials. No worker, external AI provider, push credentials, production endpoint, 60756 API, or Xcode command was used. The runner stopped the API/PostgreSQL/Redis/MinIO processes and removed the private data and build directories.

`startup-failure-01.json` preserves the first runner startup failure, which occurred before the test API or tenant database was created. The default macOS temporary path made the PostgreSQL Unix-socket path too long, so the runner now uses a short private `/private/tmp` directory. That first report marked not-yet-started processes as not stopped; the runner's cleanup flags were corrected, and the latest run confirms every service and directory is removed. `http-result-01.json` and `http-result-02.json` preserve earlier successful runs; `http-result.json` is the latest complete run against the generated 403 contract, including the final revoked-session no-side-effect assertions.

## Review handoff

Please perform an independent read-only review before integration. Focus on `internal/backend/reauth.go`, `internal/backend/auth.go`, `internal/backend/native_exports.go`, `packages/contracts/src/routes.ts`, the generated OpenAPI response declarations, and the isolated HTTP runner. Verify the transaction/lock order, inclusive cutoff and future-date handling, refresh non-renewal, 403 contract declaration, principal scoping, and that stale/revoked denials cannot write tasks or delete the account. This report is implementation evidence only; it does not establish independent acceptance, iOS snapshot integration, deployment, or production behavior.
