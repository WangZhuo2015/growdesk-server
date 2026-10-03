# Device binding enrollment lock-order regression

**Status:** `IMPLEMENTED_NOT_REVIEWED`  
**Base:** `ff967e876616f0a03367c1c5f1d639b211fd7d54`  
**Scope:** Existing-binding enrollment lookup only; no schema, contract, or authorization changes.

## Failure and fix

The old path acquired the family row lock, then selected an existing device binding `FOR UPDATE`. Pause/resume, import, and sync-command paths acquire the binding lock first and then lock the family synchronization row. Under concurrent enrollment and pause, PostgreSQL detected the reverse wait cycle; the API normalized SQLSTATE `40P01`/`40001` to HTTP `409 CONCURRENT_MODIFICATION` (`internal/backend/errors.go:37-45`).

The enrollment path now keeps the authorization checks and family-row lock, but reads an already-existing binding without a row lock (`internal/backend/device_sync_binding.go:98-145`). The family lock still serializes first enrollment for a given family, and the unique index remains the final duplicate guard. Enrollment does not mutate the existing binding or grant command admission. A response can describe the committed binding snapshot observed by that read; a following transition, import, or command still rechecks binding status/generation under its own binding lock and the family membership under the family lock. A concurrently changed generation must be read again before continuing.

This removes the `family → binding` edge from enrollment while preserving the existing `binding → family` order for operations that mutate/admit. It does not change principal derivation, family membership checks, or command authorization.

## Regression evidence

The new HTTP contention test was first run against the old locking implementation. It failed during the enrollment/pause race with `HTTP 409/CONCURRENT_MODIFICATION`; PostgreSQL `40P01` and `40001` map to that error in the source cited above. The failed run is retained as `http-result-20261003T152814Z-9f40b70b.json` (cleanup passed); an earlier unique setup failure is also retained and was not overwritten.

After the fix, the full isolated Go HTTP scenario passed **198 assertions** at `http-result-20261003T153034Z-be262304.json`. It used a private loopback PostgreSQL 18 / Redis 8 / MinIO stack, a non-superuser `test_` database role, three new `test_` principals, and `test_` family/baby. All domain writes were HTTP; direct SQL was limited to read assertions. No worker, external AI, push credentials, production service, or existing test tenant was used. API, database, Redis, MinIO, and private temp files all stopped/removed successfully.

Concurrent coverage includes six repeated enroll-versus-pause/resume races (12 duplicate enrollments plus 4 same-key transition replays per action), duplicate enrollment against five real import-chunk requests, and duplicate enrollment against four real sync-command submissions. The import and command races also assert their single durable receipt and absence of duplicate record writes. Existing concurrent chunk, revoke, replay, foreign-principal, family-scope, and data-import assertions continue to run in that same scenario.

## Verification

- `go test ./internal/backend` — passed.
- `go test ./...` — passed.
- `python3 scripts/go-device-sync-binding-integration.py` — passed, 198 assertions; private-stack cleanup passed.
- Python AST parse of the integration test — passed.

The API binary built by the isolated HTTP harness had SHA-256 `bcd747c2cece0e4f98d8c3b1f30486dae11abc282fab8221df9e2319302e8efd`. Changed source hashes and the exact evidence path are recorded in `source-digests-lock-order-20261003.json`. Existing 73-assertion evidence `http-result-20261003T150920Z-03e5d830.json` remains intact.
