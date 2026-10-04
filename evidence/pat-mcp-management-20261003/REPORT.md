# PAT, voice text-run, and MCP management evidence

Status: `IMPLEMENTED_NOT_REVIEWED`. This report records implementation and test evidence only; it does not claim review acceptance, deployment, or complete MCP OAuth parity.

Worktree: `codex/pat-mcp-management-20261003`, based on `88ecf7d4`.

## Delivered

- Personal access tokens are opaque `bp_pat_` credentials. The database stores SHA-256 digests and a display hint, never the bearer value. Creation is one-time display, scopes are fixed to `voice:submit`, and the active inventory is capped at 10 under the user lock.
- PAT authentication is admitted only for `POST /api/v1/voice/text-runs` and `GET /api/v1/voice/text-runs/:id`. The run path rechecks the live token under the same user lock used for revocation, checks the verified principal's baby membership, and queues the durable AI worker task. PATs cannot manage themselves, call general App APIs, confirm proposed actions, or call MCP. Confirmation remains an App-session operation.
- `GET /api/v1/connections` reports `managementAvailable:false` and `MCP_OAUTH_GRANTS_NOT_IMPLEMENTED`; `DELETE /api/v1/connections/:id` returns 503. The Go OAuth implementation does not currently persist or read grant rows, so the response does not represent an authoritative grant inventory.
- `GET /api/v1/me/ai-usage` reports `availability:"unavailable"` and `AI_USAGE_ACCOUNTING_NOT_IMPLEMENTED`; it does not fabricate usage or quota totals.
- Migration `202610030032_personal_access_tokens` and the TypeBox/OpenAPI routes define token lifecycle and the limited text-run path.

## Verification

`python3 scripts/test-integration.py` passed using its owned PostgreSQL 18 cluster and authenticated Redis 8 child. The driver applied the full migration sequence, built the backend packages, checked the generated OpenAPI contract, ran the PAT HTTP/worker acceptance against the same isolated services, and then ran the Node integration suites. It stopped and removed its private data directory and test processes.

The PAT HTTP/worker test passed with **112 tracked assertions**. It exercised authenticated token listing/creation/revocation, one-time secret handling and digest-only persistence, fixed scope, invalid and expired credentials, the 10-token limit, App/MCP audience separation, cross-tenant rejection, request idempotency and conflicting payloads, worker processing to `awaiting_confirmation`, App-session confirmation and record readback, and cleanup. The MCP boundary used a test-signed JWT that validates for the configured MCP resource audience and fails App audience validation; it did not call the unfinished OAuth exchange route. After revocation, the old key returned 401 for both POST and GET; a distinct token created afterward returned 200 when reading the same run. The expired-key check used a separate still-held test token so it did not confound the revocation result.

The two seeded tenants used `test_pat_*` users, `test_family_pat_*` families, and `test_baby_pat_*` babies. Cleanup verified zero remaining rows for each tenant and logged only SHA-256 fingerprints:

| Tenant | SHA-256 fingerprint | Remaining rows |
| --- | --- | ---: |
| Owner | `babcf24ea41a4f503944819b92466efa4de4201d5b319be1ec2cdf32d758cb67` | 0 |
| Second tenant | `df2138094c7e1eaa9bc71ee94ec98c57dc332b99e04d460777f35c081acf24bf` | 0 |

The final Node integration run reported 228 tests, 228 passed, 0 failed, 0 skipped. The PAT-tagged Go HTTP/worker test passed, as did `backend:build`, `backend:typecheck`, `backend:lint` (including architecture check across 142 TypeScript source files), `go test ./...`, the PAT-tagged Go test compile check, `go build`, `prisma validate`, contract consistency (133 paths / 183 operations), and `git diff --check`. Prisma validation used a dummy localhost `DATABASE_URL` and made no database connection.

The standalone Go build was written outside the worktree at `/private/tmp/growdesk-server-pat-final`; SHA-256: `9c54e99c265c8d4354cb889329f9d4868ca0b1cff216c65b66a0f5a03b034a6e`. The generated OpenAPI file SHA-256 is `f0a5bb9a5865b637c82edbb674be3697d4690f1e8410d0fe580e536c387f3809`.

## Preserved first-run failure

The first full integration run reported 226 passes and 2 failures. The two-count included the failing `FP-02` leaf plus its parent suite; there was one failing assertion. `tests/integration/feeding.test.ts` expected a formula-product DTO without `version`, while the live HTTP response returned `version: 1` and the canonical `FormulaProductSchema` requires it. The fixture assertion was updated to include `version: 1` without weakening the deep-equality check. The complete rerun then passed 228/228.

Full logs are retained beside this report as [first-full-run-226-2.log](first-full-run-226-2.log) (SHA-256 `de90ac1059ee03a568aa0ad67f5d01e98a0af9560b539499afcea46f21839595`) and [final-full-run.log](final-full-run.log) (SHA-256 `eaab99ffd4fdcecd89da11c386a1015db3b5bea33e1250125b7c80690c986e85`). The original temporary copies are `/private/tmp/growdesk-pat-full-int.log` and `/private/tmp/growdesk-pat-final-integration.log`.

## Remaining acceptance boundary

This implementation does not complete MCP OAuth authorization-code single-use exchange, refresh-token persistence, or grant revocation; these remain separate work. Connection management and provider usage stay explicitly unavailable. No App/SDK delivery, production migration, service deployment, or device acceptance was performed.

## Parent inventory repair

Independent parent inspection found that ordering all non-revoked tokens by creation date could hide still-live credentials behind recent expired rows when the capped response contained ten entries. A real isolated HTTP regression recycled twelve recently created test tokens while retaining ten active credentials. Before the repair the list exposed only one of the ten live credentials; the driver failed with `shown=1 expected=10` and still cleaned both owned tenants and processes. This failure is retained as `expired-inventory-before-fix.log`.

The list now orders live credentials first, then creation time and ID. This preserves the capped response and keeps every active credential visible for revocation; expired credentials may fill remaining slots. No token secret or scope behavior changed. `expired-inventory-after-fix.log` records the repaired complete isolated run: 112 PAT/worker assertions, 228/228 Node main tests, zero failures/skips, and both owned tenants at zero remaining rows. The parent reran typecheck, lint, complete Go tests, Go API build, and diff checks with exit 0. The original 85-assertion result and first fixture failure remain retained; their source boundary predates this repair.

State is still `IMPLEMENTED_NOT_REVIEWED`; the parent authored this repair, so it does not constitute independent acceptance of the repair. OAuth connections and AI usage are still incomplete.
