# Vaccine PATCH duplicate idempotency header

Status: `IMPLEMENTED_NOT_REVIEWED` — frozen for independent review; not committed.

The worktree is `/private/tmp/growdesk-server-vaccine-idempotency-20261003`, branch `codex/vaccine-idempotency-header-20261003`, based on `47b4a1c41d598133161d35936bda511fbdcdf588`. The only implementation files changed are `internal/backend/vaccine_records.go`, `internal/backend/vaccine_records_test.go`, and `scripts/go-vaccine-edit-integration.py`. No TypeBox or OpenAPI source/artifact changed.

`updateVaccineRecord` now reads `Header.Values("Idempotency-Key")` and returns the existing 400 `BAD_REQUEST` when the count is not exactly one, before it reaches body hashing or `clinicalTransactionWithCursor`. A Go handler test calls this guard with two literal header values and a nil database server, proving it returns before transaction setup.

The isolated runner sends two separate `Idempotency-Key` header lines over raw HTTP/1.1 and explicitly declares `Content-Length` for the JSON body. The final HTTP response is 400 `BAD_REQUEST`, proving the request passed body validation and reached the duplicate-header guard. The runner compares the tenant's family cursor, vaccine family-change row count, the two candidate receipt count, and the vaccine record version/completion/date/notes before and after. Its final run passed 27 HTTP checks; all four durable values stayed identical:

```text
before = [cursor 2, vaccine change rows 1, duplicate-key receipts 0,
          record [version 2, completed true, date 2026-06-04, notes "test completed edit"]]
after  = [cursor 2, vaccine change rows 1, duplicate-key receipts 0,
          record [version 2, completed true, date 2026-06-04, notes "test completed edit"]]
```

Final real-HTTP evidence is [http-result-duplicate-key-content-length.json](http-result-duplicate-key-content-length.json). It records `status=PASS`, `checkCount=27`, two raw header values, a declared 64-byte body, and cleanup confirmation that the owned API, PostgreSQL, Redis, and MinIO stopped and the private test tenant directory was removed. Earlier runs are retained separately: one exposed a diagnostic SQL typo, one exposed the missing content-length false positive, and a prior pass did not persist before/after values. They are superseded by the final evidence; every run records successful cleanup.

Validation completed:

- `GOTOOLCHAIN=auto go test ./...` — pass.
- `GOTOOLCHAIN=auto go build -o /tmp/growdesk-vaccine-idempotency-api ./cmd/growdesk-api` — pass; temporary binary removed.
- `npm ci --ignore-scripts --no-audit --no-fund` and `npm run --workspace=@growdesk/contracts build` — pass.
- `npm run backend:contracts:generate` — 112 paths, 160 operations, 56 schemas; generated artifact had no tracked diff.
- `npm run backend:contracts:check` — pass, 112 paths / 160 operations.
- `python3 -m py_compile scripts/go-vaccine-edit-integration.py`, `gofmt -d` on both Go files, and `git diff --check` — pass.

No service from another worktree was started or restarted. The runner used a newly created test-only PG/Redis/MinIO stack, fixture AI configuration, no worker, and no push credentials. No production endpoint or secret was read.
