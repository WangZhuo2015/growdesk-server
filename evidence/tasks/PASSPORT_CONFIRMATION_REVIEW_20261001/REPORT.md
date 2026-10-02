# Passport confirmation review — 2026-10-01

Status: **IMPLEMENTED_NOT_REVIEWED**

## Scope and baseline

Reviewed the Passport addition at `99105020eab8e786c2627ec921bad3ee2e6ccf8e` against the device protocol at growdesk-iot `63b29a4eaca332b873d92d0b26866d53e84ace68`. This patch is limited to confirmation selection and pending-proposal publication; it is not acceptance of the complete new voice gateway.

## Findings and changes

1. The firmware emits `actionIds`, but the gateway read `actionId` and silently substituted the pending action. Parse the actual array, require exactly one string equal to the presented action, and reject missing, mismatched, duplicate, extra or non-string selections before invoking record mutation.
2. Voice workers and the WebSocket reader accessed `currentPending` without synchronization. Publish immutable proposal pointers through `atomic.Pointer` and load one snapshot per confirmation.
3. The success path cleared the proposal before deriving `entityType`, producing the fallback `feeding` for every receipt. Build the receipt from the confirmed snapshot instead.
4. A new proposal could be published while an old confirmation was committing, then be erased by the old confirmation's unconditional reset. Clear with compare-and-swap, retaining a newer proposal.

Changed files: `internal/backend/passport_ws.go`, the new dependency-free `passport_confirmation.go` and its regression tests, and this report. No contracts, database schema, deployment configuration or production data changed.

## Validation actually performed

The source workspace was assembled from GitHub files because repository download/dependency resolution was unavailable. The original `passport_ws.go` blob was verified against `061c45a17ce6274be5f6c0da35e6f58f44200532` before editing.

Available toolchain: Go 1.23.2. The repository requires Go 1.27.0; `go.mod` was not downgraded or modified.

From `internal/backend`:

```sh
gofmt -w passport_ws.go passport_confirmation.go passport_confirmation_test.go
GO111MODULE=off GOTOOLCHAIN=local go test -race -count=10 \
  passport_confirmation.go passport_confirmation_test.go
GO111MODULE=off GOTOOLCHAIN=local go vet \
  passport_confirmation.go passport_confirmation_test.go
```

- Focused helper tests: **PASS**, including 12 JSON selection cases, empty canonical ID rejection, retaining a replacement proposal, and 8 concurrent publishers/readers with 1,000 iterations each.
- Race detector: **PASS**, 10 repetitions of the focused suite.
- Focused `go vet`: **PASS**.
- `gofmt`: **PASS** (syntax parsing/formatting is not a complete backend build).
- Full Go 1.27 module build and backend test suite: **NOT RUN**.
- Real PostgreSQL authorization/transaction/concurrency tests and end-to-end WebSocket/device tests: **NOT RUN**. The helper tests do not stand in for those tests.

Before merging, run the repository's normal build and isolated backend tests with its required toolchain, including confirmation of a non-feeding card, a new card arriving during confirmation, and mismatched action selection through a real WebSocket.

## Remaining review scope

This change does not implement voice-turn/TTS cancellation ownership, authorization renewal for an already-upgraded connection, message-size limits before WebSocket allocation, or device HTTP/WebSocket transport reassembly. In particular, the baseline still checks device revocation at connection authentication rather than inside the card mutation transaction; that path needs a separate authorization fix and real-database regression coverage before the gateway is treated as production-accepted.

No production services, real family data, provider credentials, billable APIs or USB devices were accessed. No deployment, merge or firmware flashing was performed.
