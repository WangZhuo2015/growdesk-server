# Passport card turn correlation

Date: 2026-10-02 (local). Status: **IMPLEMENTED_NOT_REVIEWED**. The source change has not been independently reviewed or accepted. The authorized binary rollout and its limited runtime evidence are recorded below; they do not establish full feature acceptance.

Baseline: `main` at `516371a` (`growdesk-server`); the worktree was clean before this task.

## Change

The `card.present` contract now accepts an optional `turnId` of 1–63 characters. Optionality keeps older gateway payloads schema-valid during rollout. The Passport WebSocket gateway now emits the active audio turn ID on every card through `passportCardPresentEvent`, the same builder covered by the wire test.

Passport supports one action per displayed/confirmed card. `projectPassportActions` rejects multi-action provider results with `MULTI_ACTION_UNSUPPORTED` before card projection, plan hashing, or pending-confirmation storage; the error is sent visibly to the device. The confirmation schema now caps `actionIds` at one, matching the firmware parser and implemented server behavior. No database or confirmation-transaction behavior changed. The OpenAPI snapshot was not changed because the WebSocket event schema is not part of the HTTP operation schema.

The corresponding firmware change must reject a missing or non-current `turnId` before showing a card. The gateway binary now emits the field. Device handshake, card display, and confirmation acceptance remain separate gates.

## Local validation

- `gofmt -w internal/backend/passport_ws.go internal/backend/passport_ws_test.go` — passed.
- `go test -count=1 ./internal/backend -run '^TestPassport(CardPresentEventEchoesTurnID|ProposalProjectionRejectsMultipleActions)$'` — passed; the pure two-action case returns no partial projection and the visible unsupported code.
- `npm run --workspace=@growdesk/contracts build` — passed.
- `node --import tsx --test packages/contracts/tests/passport-card.test.ts` — 1/1 passed; covers bounded ID, legacy omission, invalid ID lengths, and rejection of multiple action IDs.
- `npm run backend:contracts:check` — passed; canonical OpenAPI remains unchanged (112 paths, 159 operations).
- `git diff --check` — passed.

The implementation checks above ran locally. The later authorized rollout did not read runtime configuration or secrets, issue a credential-bearing request, exercise a database transaction, invoke a voice provider, or send a push. It included one unauthenticated route check only. See [deployment evidence](DEPLOYMENT_EVIDENCE.md); this report does not claim provider, transaction, or device acceptance.

The integrating agent independently reran the two focused Go tests with `-count=1`, the TypeBox event test, the contract check, and `git diff --check`; all passed. `go build -o /tmp/growdesk-passport-gateway-reviewed ./cmd/growdesk-api` also passed. A projection failure now returns after its visible error, before TTS playback. The review diff is saved at `build/review/passport-card-20261002.patch`. These are source/build checks, not provider, transaction, or device acceptance.

## Runtime rollout record

On 2026-10-03 UTC, the exact `linux/arm64` binary built from this worktree was installed for `growdesk-api.service` on the verified Passport upstream. The active process and rollback hashes, readiness check, anonymous route result, certificate comparison, and rollback command are in `DEPLOYMENT_EVIDENCE.md`. The overall task status remains `IMPLEMENTED_NOT_REVIEWED` until independent code review and the remaining acceptance gates are complete.
