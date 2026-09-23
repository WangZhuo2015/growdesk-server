# PR #10 implementation review and outstanding completion work

Date: 2026-09-23.
Status: **WIP / IMPLEMENTED_NOT_REVIEWED**.
This report is author self-review plus executed CI evidence. It is not an independent ACCEPTED review, full backend completion, benchmark result or production approval.

## Revisions

- PR base: `d798459f2b1217986e2d1046672acdc8f20d17d1`.
- Reference implementation/schema: `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`.
- Start of this continuation: `c940dadb97680efc2e03ab81116872bb0c165092` (80 native operations).
- Reviewed code checkpoint: `df1421e78cef9b6f3e29e345866d4cac17a8f406` (86 native operations).
- Later documentation-only commits update scope and evidence; their CI must be reported separately from the code checkpoint.

PR #10 contains 18 operations beyond the merged PR #9 foundation: food plans (2), food/supplement records (10), app configuration/development knowledge (4), family reading status (2). The final six were added in this continuation. There are **65 unimplemented declared operations**. `--require-complete` continues to exit nonzero. Registering a route is not proof of full behavior.

## Findings, changes and actual verification

| Finding or review concern | Disposition | Evidence |
| --- | --- | --- |
| Actual knowledge/book routes validate query fields absent from frozen OpenAPI | FIXED in a scoped runtime overlay; no frozen source/schema edits | `month=2.0` failed in run 35813402818; corrected native/reference suites pass in 35814698994 |
| Go numeric parsing can accept signed hex floats and trim a different Unicode whitespace set than JS | FIXED with explicit decimal grammar and ECMAScript whitespace | Table tests and actual HTTP requests through Go and TypeScript, including U+FEFF/U+0085, radix/exponent and rejected Go-only syntax |
| Reference serializer removes extra root catalog keys but retains nested public details | PRESERVED with explicit projection; no blanket field-dropping in differential assertions | Complete catalog responses, release metadata, filtering and deep-copy unit tests; exact HTTP comparisons |
| Book PATCH and GET do not expose identical nested status fields | PRESERVED separately; false/zero values and explicit status precedence retained | Actual list/PATCH comparison, zero count, false favorite and stale-version tests |
| Book record, family cursor and family change could partially commit | VERIFIED atomic transaction with family lock and permission recheck | Forced PostgreSQL change-insert failure for both initial creation and existing-row update; record/list/cursor/change state unchanged; retry then succeeds |
| Concurrent writes and withdrawn permission | VERIFIED for covered cases | Six same-version writers yield one success/five conflicts; viewer denial, cross-family isolation, revoked membership with old bearer, native tombstoned-parent denial |
| Public catalog response could mutate shared embedded data | VERIFIED independent nested copies | Unit tests mutate response details without changing source snapshots; complete race suite |
| Retaining raw JSON for every request would duplicate request memory unnecessarily | LIMITED to future growth create/update receipt paths | Server source review and original native/TCP/session regressions remain passing |
| Flat ordered hash and JS fixed rounding helpers could be mistaken for finished growth endpoints | NOT an implemented growth module | Helpers have focused tests only; growth handlers are absent from inventory and remain in missing list |
| Full Go rewrite and independent acceptance | NOT COMPLETE | 86/151 inventory; full-operation gate red; Worker/Scheduler, byte-storage lifecycle and browser acceptance unfinished |

The attempt to add `internal/backend/growth.go` was blocked by the authoring tool before a repository write. No growth handler, chart or associated integration completion is claimed. The blocked request was not rerouted through an editing workflow or alternate execution path. Remaining work outside that module is also unfinished; this tool result is not presented as the reason all 65 operations remain missing.

The locally available execution tool repeatedly failed with a transport/client error. No local Go, database or benchmark execution is claimed. Code was submitted using normal repository writes and validated by GitHub Actions. No temporary workflow modifies code or expands permissions.

## CI at the reviewed code checkpoint

All these runs correspond to `df1421e78cef9b6f3e29e345866d4cac17a8f406`:

- [Go backend 35814698914](https://github.com/WangZhuo2015/growdesk-server/actions/runs/35814698914): SUCCESS.
- [Go food library parity 35814698948](https://github.com/WangZhuo2015/growdesk-server/actions/runs/35814698948): SUCCESS.
- [GrowDesk backend 35814699042](https://github.com/WangZhuo2015/growdesk-server/actions/runs/35814699042): SUCCESS.
- [Migration integrity 35814698947](https://github.com/WangZhuo2015/growdesk-server/actions/runs/35814698947): SUCCESS.
- [Go completion parity 35814698994](https://github.com/WangZhuo2015/growdesk-server/actions/runs/35814698994): FAILURE overall; all six domain jobs SUCCESS, complete-registration job FAILURE.

Completed domain jobs: food-plan-native `107033626462`, food-plan-reference `107033626373`, nutrition-records-native `107033626326`, nutrition-records-reference `107033626442`, knowledge-native `107033626458`, knowledge-reference `107033626252`. The full-operation job is `107033626119`.

Do not summarize this as "all CI passed." The deliberately strict completeness failure is a real delivery blocker. Tests of existing functionality and tests of full implementation are separate gates.

## Remaining native operation groups

The canonical list is produced by the binary and `scripts/go-coverage.py`, including method/path and operation ID. The current 65 missing operations group as follows:

- Account: updateCurrentUser, deleteCurrentUser, exportUserData.
- Growth: listGrowthMeasurements, createGrowthMeasurement, getGrowthMeasurement, updateGrowthMeasurement, deleteGrowthMeasurement, getGrowthChart.
- Medical: listMedicalReports, createMedicalReport, getMedicalReport, updateMedicalReport, deleteMedicalReport, createMedicalOcrRun.
- Vaccines: getVaccineCatalog, getVaccineSchedule, listVaccineRecords, createVaccineRecord, deleteVaccineRecord, listVaccineSelections, upsertVaccineSelection.
- Supplement catalog/plans: listSupplementProducts, createSupplementProduct, updateSupplementProduct, deleteSupplementProduct, listSupplementSchedules, upsertSupplementSchedule, deleteSupplementSchedule.
- Record history: listRecordSnapshots, getRecordSnapshot, deleteRecordWithSnapshot, restoreRecordSnapshot, restoreLatestRecordSnapshot.
- Synchronization: getUserChanges, getFamilyChanges, executeSyncCommands, createFamilySnapshot, getFamilySnapshot.
- Core AI/voice/daily summary: listAiSessions, createAiSession, listAiSessionMessages, createAiRun, getAiRun, getAiRunEvents, confirmAiRun, cancelAiRun, retryAiRun, createVoiceRun, createDailySummaryRun, listDailySummaries.
- Attachment lifecycle: createAttachment, completeAttachment, getAttachmentContent, getAttachmentUploadUrl, deleteAttachment, resolveLegacyWebAttachment.
- OAuth/MCP: getOAuthAuthorizationServerMetadata, getOAuthProtectedResourceMetadata, getOAuthProtectedMcpResourceMetadata, exchangeMcpOAuthToken, revokeMcpOAuthToken, handleMcpRpc.
- Declared sample operations: createTimelineEvent, getGrowthRecord. These must never be counted as real business throughput in a benchmark.

Operation coverage also does not account for complete Worker/Scheduler execution, durable task cancellation/retry/fencing, real ASR/push, S3 byte validation and deletion, browser interaction compatibility, exhaustive malformed inputs and all authorization interleavings. Those are open deliverables. Existing BFF refresh handoff is one-way; cross-runtime record tests do not establish rolling credential-writer compatibility.

## Independent local-agent review task

```text
Independently review WangZhuo2015/growdesk-server PR #10 on
codex/go-completion-20260923. Do not merge or deploy. Read AGENTS.md,
START_HERE.md, docs/GO_BACKEND.md and docs/GO_COMPLETION.md first.

Fetch the current PR metadata and record the exact head/base/reference SHAs.
Preserve user work; use a separate clean worktree rather than reset --hard,
force-push or git clean. Do not copy production environment files, credentials,
private baby data or running service state into this test environment.

This increment is 86/151 native registrations, not a completed backend. Verify
that inventory rather than trusting the count in prose. Missing handlers must
remain explicit errors. Do not lower or bypass the full151 gate. Do not change
frozen apps/packages/prisma/contracts merely to make parity comparisons pass.

Run locked dependency checks, go vet, full go test -race, and a CGO_DISABLED
build carrying the exact source revision. Follow the documented owned PG18/
Redis8 harnesses: original foundation/domain/companion/BFF/food-library tests,
plus food-plan, nutrition-records and knowledge native/reference suites.
Use the actual unchanged TypeScript HTTP server for differential checks.
Do not replace transactions, membership checks or restart persistence with
in-memory mocks. Do not call real AI/push providers or expose the preview.

Review authorization inside transaction locks, read snapshot consistency,
record/timeline/cursor/change/receipt atomicity, stale-version and replay
behavior, request validation before authentication, zero/false/null semantics,
root versus nested response projection, reference dataset immutability,
Unicode/numeric query coercion, and rollback after injected SQL failures.
Add adversarial cases independent of implementation-authored expectations.
Do not drop business fields, timestamps, versions or array order to hide drift.
Inspect the property-order/rounding helpers as groundwork, not implemented
growth functionality. Keep the documented one-way BFF refresh boundary.

Report exact executed commands, exit codes, source/binary/report revisions,
reproduction steps and file/line evidence for findings. Separate blockers,
intentional safety differences, missing scope, unverified assumptions and
nonblocking improvements. A green partial suite cannot ACCEPT the full rewrite.
Return a review report; do not change branch protection, merge or deploy.
```

A successful independent review of these added operations would not close the remaining full-backend task. Benchmark only implemented and verified successful behavior under equivalent resource/database budgets. No benchmark has been run in this authoring session.
