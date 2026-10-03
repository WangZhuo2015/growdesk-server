# Medical OCR attachment purpose regression

Status: `IMPLEMENTED_NOT_REVIEWED`. The detached worktree is based on
`47b4a1c41d598133161d35936bda511fbdcdf588`. No commit or pin was created;
the uncommitted diff and evidence are ready for review.

The pre-fix Go handler accepted any ready image attachment for
`createMedicalOcrRun`. A real request using a ready `growth_photo` PNG returned
202 and created a task, outbox entry, AI session/message/run/event, and receipt.
See `purpose-11f679616dc8.json` for the red reproduction. That run completed the
existing 124 HTTP assertions first, used a private `test_` PostgreSQL/Redis/
MinIO stack, started no worker, and removed its private stack at teardown.

The fix now requires `purpose == "medical_report"` and image/PDF MIME before
provider availability checks or any transaction side effects. It repeats
attachment/scope checks inside the family-locked transaction. This OCR route
maps inaccessible foreign attachments to the same 404 as missing attachments.
The TypeBox route and generated OpenAPI now declare the observed 404 and 409
responses; 409 is the existing idempotency-key-reuse response.

The live regression in `scripts/go-medical-ocr-purpose-live-integration.py`
creates only `test_` users, families, babies, and attachments via HTTP. It
uploads and completes real PNG and PDF objects in the owned MinIO instance,
then verifies:

- ready `medical_report` PNG and PDF each return 202 and create exactly one
  task, outbox entry, session, message, run, event, and receipt;
- ready `growth_photo` PNG with the same `image/png` MIME returns 400
  `BAD_REQUEST`, creates no task/receipt state, and leaves its idempotency key
  available for the subsequent valid medical attachment;
- a foreign-principal attachment returns 404 without task/receipt changes;
- exact replay returns the same run without new rows, and a changed attachment
  under the same key returns 409 `IDEMPOTENCY_KEY_REUSED` without new rows.

The final live run is `886d3de34e3f`; its 124 baseline HTTP assertions and the
purpose-specific results are in `purpose-886d3de34e3f.json` and
`purpose-live-cli-886d3de34e3f.json`. The Go API used the explicit local
fixture configuration, no worker was started, no provider calls were made,
and teardown removed the temporary database, role, PostgreSQL cluster, Redis,
MinIO bucket/process, API process, and private run directory.

Checks passed: `go test ./...`, TypeBox `tsc --noEmit`,
`node scripts/check-contracts.mjs` (112 paths/160 operations), Python compile,
and `git diff --check`. Xcode was not run.

## Contract and attachment-guard follow-up

Status remains `IMPLEMENTED_NOT_REVIEWED`; this follow-up does not constitute
final independent acceptance. The earlier red reproduction and green run
artifacts above were preserved unchanged.

The TypeBox route for `createMedicalOcrRun` now declares an optional
`Idempotency-Key` with a 1–200 character bound, plus the implemented 404, 409,
and 503 error responses. The regenerated OpenAPI snapshot contains 112 paths
and 160 operations. `contracts.test.ts` now checks that the generated header
is optional, enforces both length bounds, and includes 503.

The targeted live HTTP runner was extended to reserve a `medical_report`
`image/png` attachment and submit it before upload or completion. The real
request returned `400 ATTACHMENT_NOT_READY`; before/after counts for tasks,
outbox rows, AI sessions, messages, runs, events, and idempotency receipts were
identical. It also uploads and completes a test object declared as
`medical_report` / `audio/m4a`; OCR returned `400 BAD_REQUEST` with those same
durable counts unchanged. The test payload is a MIME fixture used to exercise
the server's declared-MIME guard after the real upload-integrity path; this is
not evidence of audio decoding or content sniffing. The rejected pending
request and later valid request reuse the same idempotency key, and the valid
request queues exactly one task and receipt, confirming the rejection did not
claim it.

Run `fe21735cb18b` used a private loopback API, PostgreSQL database
`test_growdesk_fe21735cb18b`, matching non-superuser role, Redis, and MinIO.
The worker remained stopped, external calls were disabled, and all owned
processes and the private database directory were removed. This follow-up runs
the purpose-specific HTTP suite; it does not repeat the existing 124 baseline
assertions, which remain recorded in `purpose-886d3de34e3f.json`.

The actual API binary served by the isolated stack has SHA-256
`ca71b9fbac59af1ac501c33fd16c1822a1a64588410b8ab1941377cf8751ba18`. Its
changed Go handler source has SHA-256
`17da3005023d0b58a895a520ff2b3fc70b403dd10aaf7f915bf64760965ce595`.
The route source, generated snapshot, and runner hashes are recorded alongside
those values in `purpose-followup-fe21735cb18b.json` and the raw runner output
`purpose-live-followup-fe21735cb18b.json`.

Follow-up checks passed: contracts package build, canonical contract
generation/check (112 paths / 160 operations), all 9 contract tests,
`go test ./...`, Python compile, and `git diff --check`. No Xcode or external
service was used.
