# BE_MEDICAL_GROWTH_OCR_TYPED_DRAFTS

Status: **IMPLEMENTED_NOT_REVIEWED**
Base: `263d0107f07ea2732f08747f5d1d37c4bd291a6e`
Migration: `202610030030_medical_growth_ocr_typed_drafts` (migration 030; 029 remains reserved)

## Delivered

- Added generated-contract-backed `MedicalOcrDraft` and `GrowthOcrDraft` shapes. Medical drafts expose title, category, report date, hospital, department, doctor notes, printed item name/value/unit/reference range/status/interpretation, and optional measurements. Growth drafts expose date, weight, height, and head circumference. Every extracted field carries confidence and uncertainty; measurements also retain the printed value and unit. Server-owned run kind, source attachment, model-source label, and source transcription are attached after provider parsing.
- Added durable `growth_ocr` run creation and worker processing alongside the existing medical OCR path. Upload purpose, ready state, supported MIME type, authenticated principal, family, baby, and the single source attachment are checked before queueing and rechecked by the worker. Medical OCR supports JPEG, PNG, WebP, and PDF; growth OCR supports JPEG, PNG, and WebP. HEIC is rejected.
- The worker stores typed extraction on the run and does not write a medical report or growth measurement. A successful typed run can be referenced by an explicit medical-report or growth-measurement create. The confirmation transaction revalidates principal/family/baby/run/attachment scope; optional medical growth data is committed with the report in the same transaction. The transaction publishes the report and optional growth record through `publishFamilyChange` at consecutive cursors; report create/update/delete also publish their change event. Create operations support idempotent replay and reject the same key with a changed body.
- Medical report category is persisted. Existing generic AI run fields and `resultSummary` remain available; `getAiRun` additionally returns `ocrDraft` when present. Failed or cancelled OCR runs can be explicitly retried using the existing run ID; retry clears any old draft before a new attempt.
- Added migration 030 and normal TypeBox contract generation. No generated OpenAPI was hand-edited.

## Verification

- `npm run backend:build` — passed; `backend:test:unit` also rebuilt all workspaces after contract generation.
- `npm run backend:contracts:generate` then `npm run backend:contracts:check` — passed; canonical OpenAPI contains 126 paths and 175 operations.
- `npm run backend:db:validate` — passed; 29 migrations verified.
- `npm run backend:typecheck` — passed.
- `npm run backend:lint` — passed; architecture check covered 141 TypeScript files.
- `npm run backend:test:unit` — passed, 160 tests, 0 failures, 0 skipped.
- `go test ./...` — passed across all Go packages.
- `python3 -m py_compile scripts/go-medical-growth-ocr-typed-integration.py scripts/go-medical-integration.py` — passed.
- Final isolated HTTP/worker run: [live-0ebb8a84f51b.json](live-0ebb8a84f51b.json). Its owned loopback PostgreSQL, Redis, and MinIO stack passed 81 HTTP assertions and four worker runs (invalid medical result, medical retry-success, held-provider cancellation race, and growth success). The account names use the `test_` prefix and the family/babies use `test_family_`/`test_baby_` names. No production or legacy Web service was contacted.
- The HTTP run confirmed that both the owner and a second family member receive the medical report and optional growth measurement at consecutive change cursors. It also verified medical report create, update, and delete events for both members. The final feed cursor/change count was 6. Same-key replay leaves the report, growth row, timeline, receipts, family feed, and cursor unchanged. An injected transaction failure left records, receipts, feed, and cursor unchanged (cursor stayed at 0).
- The cancellation race held a valid OCR response at a local OpenAI-compatible loopback fixture while the worker was running, cancelled the run over HTTP, then released the response. The run stayed cancelled with no result summary or OCR draft; task result references, assistant messages, medical/growth rows, timeline, receipts, feed, and cursor stayed unchanged. A completed worker also remained succeeded after a subsequent cancel request.
- Source manifest SHA-256: `c247202dbf175e109ca358205928e4fb492287cd9953fd13f3438e35b2fb7e60`. The manifest covers all changed source, schema, migration, generated contract, and relevant test/runner files, including the files omitted by the earlier review: `native_tasks.go`, `packages/contracts/src/ai.ts`, `packages/contracts/src/index.ts`, and `prisma/schema.prisma`.
- API binary SHA-256: `2f06bbe1a9f6fa45a4859530a2aa9d3f3d1c150635d60c6136a0b05736e68b2a`; worker binary SHA-256: `70ba497b7bb6f3441fe2f3d43d5b26f1f7cc21ccc68706c384162a97cd0bdc3e`; migration binary SHA-256: `73c1e7cd5e89a5aaff8ec933b2c17020e959c106bc34cd404c5e01454257ab64`. Individual source digests are in the linked JSON; `apiSourceRevision` is the base HEAD and the manifest binds the full dirty source set.
- The private stack, database, and object data were removed. The run used only virtual provider credentials and recorded no external provider calls, secret reads, tokens, or presigned URLs.

Historical evidence files are retained. `live-9e41859e9197.json` records the first harness-only failure: the test helper expected a `.data` wrapper on the raw sync-feed response; the helper was corrected and the later isolated runs passed. The final record above includes the same-key state assertion, create/update/delete feed checks, and complete source hash manifest.

## Limits

The fixture proves the queue, authorization, persistence, typed validation, confirmation, idempotency, change-feed, rollback, and worker cancellation-fence paths. It does not measure OCR accuracy or validate a real OCR provider. Extracted data remains a draft until a user explicitly submits the edited medical or growth record. No diagnosis or treatment recommendation is generated.

The separate `scripts/go-medical-integration.py` Docker-backed runner was attempted with a HEAD-matched API binary but could not start because the host has no `docker` executable; it failed before creating its test stack. The final task-owned HTTP run above does not depend on Docker and verifies the OCR confirmation, feed, rollback, and cancellation scenarios.
