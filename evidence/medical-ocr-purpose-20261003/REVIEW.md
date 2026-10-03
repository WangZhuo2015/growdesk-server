# Independent review: medical OCR attachment purpose

**Review result: no P1 implementation/security blocker found.** Two P2 follow-ups remain for the contract surface and regression coverage. This review is limited to the frozen worktree diff and its recorded evidence; it does not mark the implementation accepted or deployed.

**Worktree:** `/private/tmp/growdesk-server-medical-ocr-purpose-20261003`
**Base/head:** `47b4a1c41d598133161d35936bda511fbdcdf588`
**Changed implementation:** `internal/backend/ai_run_commands.go`, `packages/contracts/src/routes.ts`, `contracts/openapi.json`; the live runner and test artifacts are under this evidence directory. No implementation files were edited during review.

## Findings

### P2 — Complete the OCR route's request and response contract

The medical OCR route now documents `202`, `400`, `401`, `404`, and `409` in [routes.ts](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/packages/contracts/src/routes.ts:1021), but two wire behaviors are missing from that declaration:

- `createAuxiliaryRun` reads `Idempotency-Key` and uses it for exactly-once replay, but `createMedicalOcrRun` has no `headers` schema. The live runner sends this header, so generated clients cannot discover the supported key or its optionality. Add an optional header constraint matching the handler's 200-character limit.
- A valid, authorized request can return `503`: `createAuxiliaryRun` checks provider configuration and object storage before opening the durable transaction ([ai_run_commands.go](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/internal/backend/ai_run_commands.go:279), [object_store.go](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/internal/backend/object_store.go:72)). `nativeProviderConfiguration` also returns `503 AI_PROVIDER_NOT_CONFIGURED` when no fixture or provider is configured ([ai_provider.go](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/internal/backend/ai_provider.go:34)). Add `503: ApiErrorRef`.

Regenerate OpenAPI and run the normal contract checker after both are added. This is a contract completeness follow-up; it does not invalidate the purpose guard or the recorded HTTP behavior.

### P2 — Add live negative cases for not-ready and disallowed MIME attachments

The handler checks `status == ready`, `purpose == medical_report`, and image/PDF MIME in `taskAttachments` ([ai_run_commands.go](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/internal/backend/ai_run_commands.go:44)). It calls that validation once before provider configuration and again after `lockSubmissionScope` acquires the family lock ([ai_run_commands.go](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/internal/backend/ai_run_commands.go:248)). This is the right ordering and the transactional recheck protects against attachment changes.

The live runner exercises a ready `growth_photo` PNG rejection, accepted ready `medical_report` PNG/PDF, and foreign-principal hiding ([runner](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/scripts/go-medical-ocr-purpose-live-integration.py:155)). It does not submit a pending `medical_report` attachment or a ready `medical_report` attachment with a disallowed MIME such as `audio/m4a`. Add both requests and assert each returns 400 with unchanged task/outbox/session/message/run/event/receipt counts. Current evidence proves the purpose rejection and foreign rejection have no durable side effects, but does not exercise those two guard branches over HTTP.

## Verified behavior and evidence

- The route is registered as non-public, and all scope derives from `r.Principal.UserID` plus the attachment row; there is no caller-supplied family or baby scope in the OCR request ([ai_run_commands.go](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/internal/backend/ai_run_commands.go:15), [medical.ts](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/packages/contracts/src/medical.ts:99)). A cross-tenant attachment’s authorization failure is translated to the same `404 RECORD_NOT_FOUND` as an unknown attachment before a task is written.
- `taskAttachments` checks ownership, baby/family consistency, readiness, purpose, and MIME. The transaction repeats family/baby authorization and attachment checks after acquiring the family lock; attachment mutations use that same family lock and then re-read/lock the attachment row ([attachments.go](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/internal/backend/attachments.go:85)).
- The latest recorded run `886d3de34e3f` shows 124 baseline HTTP assertions plus purpose-specific live requests: same-MIME wrong-purpose PNG rejected with 400 and no durable row-count changes; valid PNG and PDF queued; same-key replay returned the same run without new rows; changed attachment with the same key returned 409; foreign attachment returned 404 without durable changes. The API log revision is `47b4a1c-cloud-parity-886d3de34e3f`; the source worktree and contract comparison are recorded in [backend-run.json](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/evidence/medical-ocr-purpose-20261003/backend-886d3de34e3f/backend-run.json), and teardown is clean in [backend-cleanup.json](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/evidence/medical-ocr-purpose-20261003/backend-886d3de34e3f/backend-cleanup.json).
- The runner requires a literal `127.0.0.1` API, a `test_growdesk_<hex>` database and matching non-superuser role, a loopback DB host, fixture provider mode, external calls disabled, and no worker. Upload URLs must resolve to the supplied loopback MinIO port ([runner](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/scripts/go-medical-ocr-purpose-live-integration.py:47), [runner guards](/private/tmp/growdesk-server-medical-ocr-purpose-20261003/scripts/go-medical-ocr-purpose-live-integration.py:234)). The saved run reports local PostgreSQL/Redis/MinIO, virtual fixture keys, no worker, no external provider calls, and cleanup of all owned resources. The run does not exercise OCR model output or quality.
- Evidence-to-source linkage is good but not hash-complete: the final run identifies the exact worktree, base head, custom API revision, and `serverContractSha256`; that recorded contract hash matches current `contracts/openapi.json` SHA-256 (`6a77cb784465a1e52aadf91274050baadac1f4322436a611ca8439b0cad9d8f4`). Current reviewed source hashes are `internal/backend/ai_run_commands.go` `17da3005023d0b58a895a520ff2b3fc70b403dd10aaf7f915bf64760965ce595`, `packages/contracts/src/routes.ts` `cf0d517031a23c2e305124fb2472700659f430a344606ae5fb8829451ada59ed`, and `scripts/go-medical-ocr-purpose-live-integration.py` `877f53f7a0bd837f4f925b17424318540548b1bb893fb8d6b2546305c28d66ef`. The run JSON does not include SHA-256 of the changed Go source or API binary, so the source-to-binary link relies on the run ID/revision and worktree record rather than a cryptographic source manifest.

## Review checks and remaining boundary

- `go test ./internal/backend` — passed from cache; no external test stack was started.
- `python3 -m py_compile scripts/go-medical-ocr-purpose-live-integration.py` — passed.
- `git diff --check` — passed.
- Independent `npm run backend:contracts:check` could not run in this detached worktree because its `node_modules` lacks `fastify` (`ERR_MODULE_NOT_FOUND`). The saved implementation report records an earlier contract check pass, and the current OpenAPI hash matches the final backend-run contract hash, but this review did not independently rerun TypeBox/OpenAPI generation.
- The live runner intentionally starts no worker. It proves queue admission and purpose/authorization/idempotency behavior, not OCR execution, extraction accuracy, or medical-record creation from OCR results.
