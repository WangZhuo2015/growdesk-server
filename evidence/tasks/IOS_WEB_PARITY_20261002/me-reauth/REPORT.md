# Account reauthentication and export idempotency

Status: **IMPLEMENTED_NOT_REVIEWED**. Changes are frozen for independent review in `/private/tmp/growdesk-server-me-reauth-20261003`, branch `codex/me-reauth-20261003`, based on `516371a5959e11db865969cd0b2f9aa42be9bfa2`. No commit was created. This report does not claim integration, deployment, or production behavior.

## Behavior

- `POST /api/v1/me/export` and `DELETE /api/v1/me` retain the live-session and five-minute recent-reauthentication checks. Export checks run in this order inside its transaction: user lock, live session, recent session, then key validation/receipt lookup. A stale or revoked session cannot replay an existing receipt.
- Export accepts an optional `Idempotency-Key`. Supplied values must be one 1–128 character ASCII value matching `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; omitted keys retain the prior queue behavior without a receipt. The key's receipt is scoped by the authenticated `Principal.UserID` in both `actor_id` and `scope_id`, and by the `native-user-export:` command namespace.
- A new task, its outbox row, and its 202 receipt are written in one PostgreSQL transaction. `lockUser` serializes requests for the same principal, so concurrent same-key requests converge before the receipt lookup. A matching request replays the stored queued task ID; a changed body returns 409 `IDEMPOTENCY_KEY_REUSED`. The request hash includes the operation and complete decoded body so later body fields cannot silently reuse the old result; a missing body and explicit `{}` normalize to the same canonical empty object. Different principals in one family have separate receipts.
- The TypeBox export route declares the optional header and 400/403/409/429 responses. The account-delete summary now states the current synchronous soft-delete and session-revocation behavior; it does not imply the planned asynchronous deletion task exists.
- Implementation details are in `internal/backend/native_exports.go:15-30,150-216`, contract declarations in `packages/contracts/src/routes.ts:386-409`, and the validation/hash unit cases in `internal/backend/native_export_idempotency_test.go`.

## Verification

- `go test ./...` — passed, including optional key validation and canonical body-hash tests.
- `npm run --workspace=@growdesk/contracts build`, followed by `npm run backend:contracts:generate` and `npm run backend:contracts:check` — passed at 112 paths / 159 operations. The generated POST export operation has an optional `Idempotency-Key` header and responses 202/400/401/403/409/429. DELETE `/me` has the synchronous summary and responses 200/401/403.
- `python3 -m py_compile scripts/go-me-reauth-integration.py` and `git diff --check` — passed.
- Earlier final `python3 scripts/go-me-reauth-integration.py` — **43 real HTTP checks passed** and remain preserved in `http-result-20261003T090911Z-f5f8c37f.json`. This result predates the quota-boundary and raw duplicate-header assertions below.
- Follow-up `python3 scripts/go-me-reauth-integration.py` — **107 real HTTP checks passed** against a Go binary built from this worktree with a fresh loopback PostgreSQL, Redis, and MinIO stack. In addition to the original coverage, the runner fills the 64-pending-task quota using only authenticated POST export calls, verifies a new key returns 429 `TASK_QUOTA_EXCEEDED` without task/outbox/receipt effects, verifies a previously committed key still replays the original 202/task ID at quota, and sends two raw Idempotency-Key header lines to verify 400 with no side effects.
- Current follow-up evidence: `http-result-20261003T092728Z-85373c7b.json`. It records the run's source revision and SHA-256 hashes, including `packages/contracts/src/routes.ts` (`aa88a168e832765fabce2506ab64b1e6bddce1d2663ae58ce8cd7a5aa0abbb44`), generated `contracts/openapi.json` (`0c94fcc3d405548dec783347dae22fd7d4770c57636dc34ce5d6883187c42288`), the runner (`c38c4984dbb185ce1278f2d57e312bf01391d5750f36800b6d6245b455b051a0`), and the built API (`f18611a57d8d1a46777f9238cf1d21b77a6d410e5e31a08665dd4401284c68a0`). Full hashes and all tested files are in the JSON evidence.
- The runner used three `test_` users, a `test_` family and baby, a non-superuser test database role, and no worker, external AI provider, or push credentials. Cleanup confirms the API, PostgreSQL, Redis, MinIO, database cluster, and private build directory were stopped or removed.

## Preserved evidence

- The pre-idempotency report and 25-check HTTP result are preserved as `REPORT-reauth-before-idempotency.md` and `http-result-reauth-before-idempotency.json`.
- The first new run, `http-result-20261003T090247Z-0593e390.json`, is preserved as a failed attempt with successful cleanup. It exposed an obsolete test assertion that expected zero owner tasks after deletion even though the expanded test had already queued owner exports. The runner was corrected to compare the owner's task count before and after the collaborator request.
- `http-result-20261003T090413Z-5cfe0462.json` is a successful 41-check intermediate run. `http-result-20261003T090539Z-4bb923df.json` is a successful 42-check run that added the changed-body 409 assertion. The 43-check result verifies nil/empty-body hash normalization. The current verification result is the follow-up 107-check run.
- `http-result-20261003T092413Z-d134f6c7.json` is a failed follow-up attempt with successful cleanup. It stopped at an existing invalid-key assertion because the initial dependency bridge resolved the main checkout's contracts package and generated stale OpenAPI; the worktree's contract package was then rebuilt and the local dependency bridge corrected before the successful 107-check run.

## Review handoff

Please independently review the user-lock/receipt ordering, the atomic task/outbox/receipt transaction, principal scoping, body-hash conflict behavior, recent-session check before replay, OpenAPI generated from the normal TypeBox source, and the final isolated HTTP evidence. The older 25-check report remains available for comparison. No Xcode, 60756 API, production endpoint, production secret, or production family data was used in this task.
