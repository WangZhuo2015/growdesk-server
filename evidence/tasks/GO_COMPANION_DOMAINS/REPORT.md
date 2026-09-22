# GO_COMPANION_DOMAINS

Status: **IMPLEMENTED_NOT_REVIEWED**

## Scope and immutable baseline

- Repository: `WangZhuo2015/growdesk-server`.
- Work branch: `codex/go-backend-parity-20260922`.
- Draft integration PR: https://github.com/WangZhuo2015/growdesk-server/pull/9 .
- TypeScript reference: `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`.
- Validated Go checkpoint: `e0001cf0e6f847043b2b67b4b6234c96e0e775de`.
- This task adds 18 native operations: Web AI sessions (6), voice history (4), notifications/push-device registration (4), and family formula-product catalog (4).
- The branch also contains a separately developed food-library slice (3). Together with the initial 47 operations, the branch registers 68/151; 83 remain unimplemented. A registered operation is not automatically accepted for all inputs.
- No main merge, deployment, production-data operation, real-user account, paid AI request, push delivery or benchmark was performed. Existing Web pages, reference source, public OpenAPI and PostgreSQL migrations are unchanged.

## Implementation

All 18 handlers access PostgreSQL natively. There is no fallback proxy to TypeScript, per-process durable state, successful-empty substitute for a database failure, or added dependency on Node for these native HTTP handlers.

### Notifications and device registration

`internal/backend/notifications.go` implements keyset pages, omission of null notification data, stable first-read timestamps, and atomic owner-filtered reads. Device registration uses PostgreSQL upsert on `(user_id, installation_id)`; deletion is idempotent and scoped to that user. An omitted device label clears the existing label, matching the reference. This does not implement delivery to a push provider.

### Voice result history

`internal/backend/voice_logs.go` implements durable creation, owner-filtered history, detail and acknowledgement. A normal list returns an array/page; asynchronous unread mode returns one object or null and uses the existing 24-hour window. Family and explicit baby membership are checked. Active viewers may save private conversation history; they do not acquire clinical-record write permission. This does not implement ASR or asynchronous voice execution.

### Web AI session history

`internal/backend/web_ai_sessions.go` implements creation, list, detail, rename, deletion and append. It preserves private versus baby-scoped sessions, title/context normalization, complete history, and separate bounded summaries. Parent rows serialize message appends; client message IDs support exact replay and controlled conflicts. Replay does not advance the parent's timestamp. History limits reject writes/reads rather than truncate stored content. Active AI tasks prevent session deletion. Protected image paths require authorized ready attachment metadata; actual S3 access is outside this slice.

List summaries use a bounded batch query instead of per-session queries, retain a 4,096-character last-message summary, and do not include image/tool payloads. Full detail returns the complete stored message payload.

### Formula products

`internal/backend/formula_products.go` preserves family scope, decimal-string/null/zero distinctions, omitted PATCH fields, archive filtering, keyset pages, soft deletion, and existing catalog metadata. It intentionally does not invent care idempotency receipts, family change cursors or version increments that the reference catalog API does not have. The SQL mutation fields are allowlisted.

### Contract adaptation

`internal/backend/contract_nullable.go` repairs an in-memory interpretation issue: the frozen TypeBox export uses nullable `$ref` siblings that an OpenAPI 3.0 reader can ignore. The loader represents these as an unchanged reference or a null-only schema. The public OpenAPI is not modified; malformed non-null values remain invalid, and the referenced schema is not globally made nullable. Dedicated positive and negative tests cover these properties.

## Actual verification

The complete **Go backend** push workflow for the exact checkpoint above succeeded:

https://github.com/WangZhuo2015/growdesk-server/actions/runs/35714725516

Its required jobs cover:

| Job | Result | Scope |
| --- | --- | --- |
| `native-static` | PASS | Locked modules, vet, full Go race tests, cgo-disabled executable, operation inventory and SHA-256 checksums |
| `native-postgres` | PASS | Authentication foundation, existing business suite, and companion persistence/restart/authorization tests on real exclusively owned PostgreSQL/Redis |
| `native-reference-parity` | PASS | Frozen-reference guard, builds of both implementations, existing business differential checks and companion HTTP/database interoperability |

The companion differential suite records **86 observations**, in addition to the existing domain suite's **71 observations**. These are scenario observations, not an operation-coverage percentage. They preserve business times, array order, null/absent distinctions, decimals and versions. Generated identities and generated timestamps are normalized after format checks. Error comparisons cover status/code, not byte-exact error messages/request IDs.

The earlier PR-triggered run `35714138415` also demonstrated the 71 + 86 HTTP observations and cross-runtime persistence, but its static job failed on the then-unfixed food-library contract test. That earlier run is not described as fully green.

### Durable and fault-injection checks

- Concurrent exact message replay stores only one message row.
- A PostgreSQL trigger fails the parent-session update after message insertion; the entire transaction rolls back, with no orphan inserted message. After removing the test trigger, the append succeeds.
- The message-count guard preserves all 5,001 rows in an intentionally oversized fixture rather than silently dropping history.
- Queued tasks block session deletion; a cancelled task permits deletion and cascading message cleanup.
- Existing bearer credentials read committed sessions, voice logs and formula products after the API process is actually terminated and restarted.
- Go and TypeScript read/write the same exclusively owned database during the interoperability phase: messages and exact replay, voice acknowledgement, formula decimals, and notification cursor pages.
- Already issued bearer credentials do not retain baby-scoped access after caregiver revocation.
- Notification first-read timestamps and other users' device records remain unchanged on repeated/unauthorized operations.

The historical family-viewer permission fixture is inserted only in the isolated test database. The read schema permits that role, while the family management API accepts only admin/member; the rejected management request is explicitly tested, not bypassed in the production implementation.

### Artifacts at the validated checkpoint

The Go workflow contains `native-go-e0001cf0e6f847043b2b67b4b6234c96e0e775de` (Linux amd64 binary, revision, inventory, checksums), `native-domain-...`, and `http-parity-...`.

Binary bundle artifact: https://github.com/WangZhuo2015/growdesk-server/actions/runs/35714725516/artifacts/10688018104 .

Artifact zip digest reported by GitHub: `sha256:1a31504e2dc23a423bb4bae15325c769b4471434885c10a539ab776705447294`. This is the bundle digest, not the uncompressed binary checksum; use the included `SHA256SUMS` for individual files.

## Known exceptions and remaining work

1. **Not all APIs implemented:** 83 declared operations, Go Worker/Scheduler, AI execution/ASR, object-storage lifecycles, further nutrition/food/growth/medical/vaccine/sync domains remain incomplete. Missing operations return explicit 503 and must not count as successful benchmark throughput.
2. **BFF session interoperability:** the existing native foundation's `go:v1:` encrypted session/replay format is not an interoperable TypeScript BFF ciphertext format. Ordinary bearer-token/shared-row tests do not certify this flow. Resolve and test it before whole-backend replacement or rolling mixed-runtime sessions.
3. **Food-library contract export drift:** the real frozen `POST /api/v1/food/items` returns a bare item; the frozen OpenAPI export declares a data envelope. The native implementation follows actual HTTP behavior. The distinction has its own explicit regression and must not be generalized to ignore unrelated validation failures.
4. **Food-library injected internal error drift at e0001cf0:** workflow `35714725679` passed the native food scenario but the reference comparison found HTTP 500 / `P2039` from Prisma versus HTTP 500 / `INTERNAL_ERROR` from Go for an injected transaction failure. Both implementations rolled back. This is a known status-code-body difference, not a fully passing food parity result. Subsequent fixes must be checked at their own SHA; this report does not anticipate them.
5. **Intentional hardening:** the native implementation rejects soft-deleted parents, prevents orphaning the last effective baby administrator, and controls concurrent cross-session message-ID conflicts. These stricter cases require review rather than a claim to reproduce unsafe reference behavior exactly.
6. **Verification limits:** complete malformed-input/error-message equivalence, all authorization interleavings, real private S3 bytes, browser integration, resource-leak/load behavior and independent code review have not been certified here. Passing tests are not a benchmark result or production readiness decision.
7. Existing generic JSONB/DTO boundaries remain; this is not a completed all-typed sqlc data-access layer.

## Reproduction and benchmark boundaries

See `docs/GO_BACKEND.md` for locked builds, environment keys and safe test commands. In particular:

```sh
python3 scripts/go-companion-integration.py \
  --binary dist-go/growdesk-api --reference \
  --report dist-go/companion-parity.json
```

The command needs the unchanged reference built beforehand and uses temporary Docker-managed PostgreSQL 18/Redis 8 resources. Do not pass production credentials or use `python -O`.

For benchmarking, pin both revisions and preserve equivalent validation, authorization, bcrypt cost, database connection budgets and transactional effects. Separate fresh writes from idempotent replays, error traffic and same-family lock contention. Voice-history throughput is not ASR throughput; push registration is not push delivery; session CRUD is not model inference. No performance advantage is claimed in this report.
