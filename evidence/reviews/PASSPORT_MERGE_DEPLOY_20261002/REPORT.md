# Passport independent review and release validation — 2026-10-02

Scope: GrowDesk server PR #18 and IoT PR #1. Original review inputs were server `4393837ef8a7f06b64d5c0241bc0430f491d644c` against `99105020eab8e786c2627ec921bad3ee2e6ccf8e`, and IoT `f02493a6e693354b31c89a13f4a6571fdb68f4ae` against `63b29a4eaca332b873d92d0b26866d53e84ace68`. The existing checkouts and their unrelated changes were preserved; review and fixes used isolated worktrees.

## Standards

Independent review found two issues requiring repair. The server only checked device revocation during the WebSocket handshake, allowing an already-connected device to confirm after revocation. Its family scope and token expiration also needed to remain valid throughout the connection. IoT string extraction rejected overflow, but card parsing ignored display-field extraction failures and could accept a card with blank fields.

The server now locks and checks the matching, unrevoked device row inside the confirmation transaction, after acquiring the family lock. The device owner/family/baby must match the connection principal; the baby's current family is checked again. The connection uses the JWT expiration deadline, closes an idle socket at that deadline and cancels its workers/database operations. IoT rejects a present but malformed or overflowing card field, while preserving optional missing fields. No Fowler smell findings were reported.

## Spec

Independent review confirmed the original server patch's exact single-action array validation, atomic proposal snapshot, CAS clearing and receipt entity type. The IoT patch correctly bounded container lookups, preserved sibling-field isolation and rejected truncated control metadata. The display overflow issue above was a partial implementation of the stated rejection requirement and has been repaired.

Real gateway validation used only a fresh, owned PostgreSQL 18 cluster, a password-protected loopback Redis process, test-prefixed tenants and loopback ASR/LLM fixture responses. No production account/database or billable provider was used. The database and WebSocket paths were real; this does not certify speech quality or device behavior.

## Validation

- Go 1.27.0: locked module verification, `go vet ./...`, full `go test -race -count=1 ./...`, and CGO-disabled builds passed.
- Existing authentication, domain, companion and BFF session-review scenarios passed on fresh native PostgreSQL/Redis instances. Docker was unavailable locally; the temporary harness replaced only owned-service provisioning, retaining the scenario code and actual database/HTTP behavior.
- Real Passport HTTP pairing, claim, one-time credential delivery, token exchange and authenticated WebSocket handshake passed.
- Invalid/missing/empty/duplicate/non-string action arrays rejected without durable record writes.
- A controlled provider barrier plus a real PostgreSQL family-row lock proved that a new card published during an older confirmation survives that confirmation; both receipts returned `diaper`, and replay produced no additional records.
- Revoking a device through the real REST endpoint prevented confirmation through its already-open WebSocket.
- Revocation also prevented a new audio turn on that connection, before any provider call. Authorization is checked again when a recorded turn is submitted. Previously authorized in-flight external requests do not have an instantaneous cancellation guarantee.
- An idle connection closed at its signed JWT expiration.
- Six PostgreSQL authorization/concurrency cases passed three race-detector repetitions. They cover pre-existing revocation, expired principals, stale family scope, revocation/membership removal while waiting for the family lock, and revocation waiting for an already-authorized confirmation to commit. A dedicated CI job provisions its owned non-superuser test database and requires these tests to run.
- IoT: static repository checks, host tests, ASAN/UBSAN and the complete ESP-IDF 5.5.3 firmware/layout/archive gate passed after the display overflow fix. The new overflow test failed against the pre-fix parser before repair. macOS does not support the requested LSan option; ASAN/UBSAN passed without enabling LSan.
- IoT device tests: NOT RUN. Only Bluetooth/debug-console ports were present; no Passport board was detected. Compilation does not establish real card rendering, speech, pairing or hardware behavior.

Raw server logs and sanitized scenario reports are adjacent to this report. IoT logs and matching firmware archives are retained locally in the task output directory. Firmware/debug bundles were not uploaded publicly.

The `reproduce/` scripts retain the local native-service harness and real gateway scenarios. Set `PASSPORT_REVIEW_ROOT` to the checkout and `PASSPORT_REVIEW_OUTPUT` to a disposable directory containing `bin/growdesk-api` built from that checkout. They require native PostgreSQL 18 tools, Redis, Python `websocket-client`, and create/clean only their own temporary clusters. The PostgreSQL confirmation regression is also a maintained Go test under `internal/backend` and is exercised by the dedicated Passport CI job.

Standards: two original issue groups, repaired; no outstanding scoped blocker. Spec: one partial display-overflow requirement, repaired; server snapshot/action-selection requirements passed. The lightweight parser's scalar grammar and RFC3339 semantic validation remain baseline limitations, outside the stated parser scope. Complete speech/TTS lifecycle and physical-device acceptance are not claimed.

## Existing CI limitations

At the original PR head, native-static, native PostgreSQL, authentication regression, MCP mutation races and migration integrity checks passed on GitHub. Other jobs failed against the existing frozen-reference policy: the coverage script still requires exactly 151 operations, and parity jobs assert that contracts/reference code have not changed since `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`. Passport had already added eight routes and contract changes on base `9910502`; that main commit has the same failed workflows. No failing test or policy was disabled or silently rebaselined as part of this patch. Scoped acceptance uses independent review and actual native/gateway validation; whole-backend parity is not claimed.

## Release boundary

The live host was inspected before deployment. The existing Passport REST/WebSocket routes target the Go systemd service on loopback 3081. Loopback 3180 is the historical foundation container and 3181 serves the other preview routes. This patch requires no schema migration, credential changes, nginx changes or data conversion. Deployment must update only the existing Go binary, preserve a rollback binary, verify its revision/checksum and inspect local readiness plus public unauthenticated rejection. Keep all existing data and other services.
