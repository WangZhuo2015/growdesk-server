# GrowDesk server local validation — 2026-10-22

## Scope and safety

Repository: `/Users/wangzhuo/Documents/GitHub/growdesk-server`  
Branch: `codex/server-local-changes-20261022`  
HEAD at validation start: `516371a5959e11db865969cd0b2f9aa42be9bfa2`

This run performed local unit, static, contract, and build checks only. Go checks used an empty environment with `GOPROXY=off`; TypeScript checks used `npm --offline` and a temporary empty HOME. No production `.env` was read. `TEST_PASSPORT_DATABASE_URL` and all provider credentials were absent, so no PostgreSQL/Redis service or external push provider was contacted. Linux ARM64 outputs were compiled and inspected as ELF files; none were executed.

## Results

| Check | Result | Exit |
|---|---:|---:|
| `go test -json ./...` with cached Go 1.27.0 | 419 passed, 10 guard-skipped, 0 failed | 0 |
| `go vet ./...` | Passed | 0 |
| `go build ./...` | Passed | 0 |
| Linux ARM64 build: `./cmd/growdesk-api` | Passed; ELF aarch64 output at `linux-arm64/growdesk-api` | 0 |
| Linux ARM64 build: `./cmd/growdesk-migrate` | Passed; ELF aarch64 output at `linux-arm64/growdesk-migrate` | 0 |
| Linux ARM64 build: `./cmd/growdesk-scheduler` | Passed; ELF aarch64 output at `linux-arm64/growdesk-scheduler` | 0 |
| Linux ARM64 build: `./cmd/growdesk-worker` | Passed; ELF aarch64 output at `linux-arm64/growdesk-worker` | 0 |
| `npm run backend:test:unit` | 150 passed, 0 skipped, 0 failed | 0 |
| `npm run backend:typecheck` | Passed | 0 |
| `npm run backend:contracts:check` | Passed; 113 paths, 161 operations in sync | 0 |
| `npm run backend:test:guard` | 18 passed, 0 skipped, 0 failed | 0 |
| `npm run backend:lint` | Passed; ESLint and architecture check (140 TypeScript source files) | 0 |
| Original working-file SHA-256 comparison | 497/497 baseline paths matched; none missing | 0 |

The Go unit suite also exercised the local native push endpoint validation, VAPID/subscription handling, cancellation/redirect transport, and family-notification payload/content tests. Its transport tests use local test servers; they do not demonstrate delivery through APNs or another external provider.

## Guard-skipped Go tests

Each was skipped because `TEST_PASSPORT_DATABASE_URL` was intentionally unset; the test requires an owned, migrated `test_` PostgreSQL database.

- `TestPassportConfirmationRevocationIntegration`
- `TestPassportConfirmedRecordsIntegration`
- `TestPassportFoodCatalogContextIntegration`
- `TestPassportShortTurnWebSocketIntegration`
- `TestPassportVoiceNonDataOperationOmitsRecordContextIntegration`
- `TestPassportVoiceQueryRejectsProviderWriteActionIntegration`
- `TestPassportVoiceRecordContextAllKindsIntegration`
- `TestPassportVoiceRecordContextLocalWindowAndTruncationIntegration`
- `TestPassportVoiceRecordQueryContextDiagnostic`
- `TestPassportVoiceWriteTurnUsesFamilyTimeZoneWithoutRecordContextIntegration`

## Toolchain preflight attempts

These two commands exited before starting tests. The first picked the system Go 1.26.2 with `GOTOOLCHAIN=local`, which is below the module's `go 1.27.0` requirement. The second selected Go 1.27.0 through the wrapper but could not verify its cached toolchain module with `GOSUMDB=off`. The suite then ran successfully by invoking the already cached Go 1.27.0 binary directly with network access disabled.

| Attempt | Outcome | Exit |
|---|---|---:|
| `go test -json ./...` with wrapper + `GOTOOLCHAIN=local` | Toolchain version mismatch; no tests ran | 1 |
| `go test -json ./...` with wrapper + `GOTOOLCHAIN=go1.27.0` | Toolchain checksum verification unavailable; no tests ran | 1 |

## Coverage limits

This quick validation does not cover PostgreSQL/Redis transaction, authorization, concurrency, outbox/worker, or recovery behavior; the PostgreSQL-guarded tests above were skipped and the full integration runner was not started. It does not prove external push delivery or physical-device receipt. Linux ARM64 artifacts were cross-compiled only. No Linux local ASR/TTS process or device acceptance was run.

The checks establish local implementation/build evidence only; they do not constitute independent review, production migration/deployment, or acceptance.

## Raw evidence

Every validation command, raw output, and exit code is preserved under `runs/`; `exit-codes.tsv` is the consolidated exit-code list. Cross-compiled binaries are in `linux-arm64/`. Baseline hash verification output is `runs/baseline-hash-check.log`.

## Repository archive note

The raw-evidence paths above describe the original `/tmp/growdesk-server-push-validation-20261022` validation workspace. This commit archives text only under `validation/`; `validation/FILE_INDEX.json` maps original command/output/exit files to their saved `.txt` paths. Cross-compiled binaries remain local and are not included in this archive.
