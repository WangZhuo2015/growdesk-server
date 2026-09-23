# Native Go backend: implementation and review scope

**Current continuation:** PR #10 registers **86/151 operations**, with **65 still missing**. See [GO_COMPLETION.md](GO_COMPLETION.md) for the added domains, current validation, remaining work and reproduction commands. The 68-operation table below records the historical PR #9 foundation, not the current branch's full inventory.

Status: **IMPLEMENTED_NOT_REVIEWED**. PR #9 introduced an isolated native preview alongside the existing service. Merging an increment is not completion of the Go rewrite, independent acceptance, a benchmark result, or production cutover approval. The default TypeScript deployment remains unchanged.

The TypeScript reference is frozen at `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`. Its `apps`, `packages`, PostgreSQL schema/migrations and `contracts/openapi.json` remain unchanged. CI checks this boundary. Existing Web pages are not modified. Changes to that reference require an explicit, separately reviewed parity rebaseline.

## Historical PR #9 native scope

At the PR #9 checkpoint, the executable registered **68 of 151 declared operations**:

| Group | Native operations |
| --- | ---: |
| Health and authentication/session foundation | 14 |
| Families, invitation lifecycle and family membership | 10 |
| Baby profiles and explicit caregiver membership | 7 |
| Feeding, sleep and diaper CRUD/list | 15 |
| Timeline list | 1 |
| Web AI conversation/session history | 6 |
| Voice result history and acknowledgement | 4 |
| Notifications and push-device registration | 4 |
| Family formula-product catalog | 4 |
| Food library catalog and feeding guidelines | 3 |

`growdesk-api --contract-inventory` lists every operation in the current build. Registration is not independent acceptance or exhaustive input coverage. The **83 operations missing at PR #9** remained explicit `503 / GO_OPERATION_NOT_IMPLEMENTED` failures after normal validation/authentication. The current missing count is reported in GO_COMPLETION.md and the compiled inventory. Missing operations never proxy to Node or return fabricated success.

Business execution uses Go and PostgreSQL/Redis directly. Node is used to build the reference and existing tooling, not to serve native operations. Conversation history is not AI execution; voice history is not ASR; device registration is not push delivery. Worker/Scheduler, remaining nutrition/food/growth/medical/vaccine/sync operations, and attachment/S3 lifecycle remain follow-up work.

## Build

CI pins Go **1.27.1** and uses only committed `go.mod`/`go.sum` dependencies:

```sh
export GOFLAGS=-mod=readonly
go mod download
go mod verify
go vet ./...
go test -race -count=1 ./...
mkdir -p dist-go
CGO_ENABLED=0 go build -trimpath \
  -ldflags="-s -w -X main.revision=$(git rev-parse HEAD)" \
  -o dist-go/growdesk-api ./cmd/growdesk-api
./dist-go/growdesk-api --version
./dist-go/growdesk-api --contract-inventory > dist-go/operations.json
```

Race tests require a supported C toolchain; the distributed binary is built with cgo disabled. Version/inventory commands do not connect to a database. CI checks out the exact PR head for native jobs, records that SHA and includes `source-sha.txt` in `SHA256SUMS`. Historical runs may have used a synthetic merge SHA: read the artifact's actual source identity, not its filename alone.

## Mandatory isolated runtime boundary

This incomplete executable **refuses production startup**. Both configuration loading and direct database initialization enforce:

- Explicit `GROWDESK_GO_EXPERIMENTAL=1`; environment `test` or `development` only.
- `HOST=127.0.0.1`; a separate HTTP port, never the old Web's 3088/3089.
- PostgreSQL at `127.0.0.1`, an explicit non-default port, explicit credentials, and `test_` database/role names. The connected role must actually be non-superuser. This parser is not proof of ownership; the harness independently creates and tracks its containers.
- Password-protected loopback Redis on a non-default port, explicit database number, and no query/fragment overrides.
- `JWT_SECRET` and `SESSION_ENCRYPTION_KEY` of at least 32 bytes. If the latter is omitted, current configuration uses the strong JWT secret; distinct keys are recommended. There is no embedded development secret.

The supplied integration harness sets the opt-in and generated test credentials automatically. Do not weaken guards to connect to existing production services. Remote benchmark traffic can enter through a deliberately configured private tunnel to the isolated listener; do not expose this preview as the production API.

Defaults: database pool 10 (`DB_POOL_MAX`), HTTP concurrency 256 (`HTTP_MAX_CONCURRENCY`), request timeout 30 seconds (`HTTP_TIMEOUT_SECONDS`). Socket reads follow the request budget; writes have that budget plus five seconds, preventing slow clients from retaining a handler indefinitely. These are not completed long-lived AI/SSE policies. Future streaming implementations must add bounded per-stream handling without disabling ordinary response deadlines.

Apply the existing migrations through the migration owner; API startup never auto-migrates. No default deployment, ingress or production database is changed by this PR.

## Reproducible HTTP/database regressions

Docker and Python 3 are required. Scripts create exclusively owned PostgreSQL 18 and password-protected Redis 8 containers on random loopback ports, apply actual SQL migrations, use non-superuser `test_` identities and remove only owned resources. They reject optimized Python and do not accept a production database override.

```sh
python3 scripts/go-integration.py --binary dist-go/growdesk-api
python3 scripts/go-domain-integration.py --binary dist-go/growdesk-api --report dist-go/native-domain.json
python3 scripts/go-companion-integration.py --binary dist-go/growdesk-api --report dist-go/native-companion.json
python3 scripts/go-food-library-integration.py --binary dist-go/growdesk-api --report dist-go/food-native.json
python3 scripts/go-session-review-integration.py --binary dist-go/growdesk-api --report dist-go/native-session-review.json

npm ci --ignore-scripts --no-audit --no-fund
npm run backend:db:generate
npm run backend:build
python3 scripts/go-domain-integration.py --binary dist-go/growdesk-api --reference --report dist-go/http-parity.json
python3 scripts/go-companion-integration.py --binary dist-go/growdesk-api --reference --report dist-go/companion-parity.json
python3 scripts/go-food-library-integration.py --binary dist-go/growdesk-api --reference --report dist-go/food-reference.json
python3 scripts/go-session-review-integration.py --binary dist-go/growdesk-api --reference --report dist-go/session-reference.json
```

CI retains separate `native-static`, `native-postgres`, `native-reference-parity`, `food-library-native` and `food-library-reference` results. The session review suites are mandatory steps, not optional local-only checks. Workflows also run after merges into the candidate and main branches. No repository branch-protection settings are changed; workflows alone do not configure server-side required checks.

Domain tests cover scope, member management, versions, decimals, pagination, soft deletion, timeline, idempotency, concurrent creation and sleep invariants. Trigger-injected failures verify record/timeline/cursor/change/receipt rollback. Companion tests cover notifications, voice history, conversation ownership, message replay/conflicts, bounded summaries, active-task protection, metadata permissions, and formula catalog semantics. They exercise process restart and cross-runtime database reads/writes. Food tests additionally verify atomic item/status creation and its failure rollback.

Session review adds same-user and cross-user BFF rebinding, concurrent binders, superseded-token denial, rollback after a forced binding UPDATE failure, process restart, ciphertext row binding, and actual one-way TypeScript handoff. Real TCP unit tests exercise incomplete bodies and clients that stop reading responses. Test existence is not a PASS receipt: consult the exact commit's completed CI steps.

## Compatibility and intentional differences

**Ordinary HTTP/business parity.** Differential tests map generated IDs and generated timestamps only after validating their format. Business times, null/absence, decimal representation, zero values, versions and array order are retained. Errors compare status and `error.code`, not byte-identical prose/request IDs. Database observations are not a complete production data audit.

**BFF handoff is one-way.** The frozen TypeScript implementation stores a plaintext refresh token in the misleadingly named `encrypted_refresh_token` column. Go reads that representation and encrypts its replacement as `go:v1:` on successful refresh. The session review suite invokes both real servers to verify this path. TypeScript can temporarily return an already-cached access token, but it cannot rotate Go ciphertext. Refresh replay caches also differ: the reference stores JSON and Go stores domain-bound ciphertext. Do not alternate refresh writers, claim rolling-session compatibility, or downgrade Go storage to plaintext. Bidirectional compatibility requires a separate coordinated reference change before mixed-runtime deployment.

**Credential replacement.** A successful Go BFF credential rebind revokes the superseded device session and refresh credentials in the same transaction as the new binding. Racing binders receive a controlled `409 / CONCURRENT_MODIFICATION` when their preflight becomes stale; retry with current credentials. This closes the reference's orphan-session behavior and is an explicit security difference, not an exact-parity claim for that unsafe lifecycle.

**Published schema drift.** The frozen `POST /api/v1/food/items` HTTP response is a bare item while the OpenAPI export declares `{data: item}`. Go preserves the actual wire response. Tests record the exception and validate the item separately; neither reference source nor frozen OpenAPI is edited to manufacture success. Nullable `$ref` siblings are adapted in memory without relaxing non-null object validation or mutating shared schemas. PR #10 also records omitted query schemas for development catalogs and book listing; see GO_COMPLETION.md.

**Authorization hardening.** Go rejects removing the last effective baby administrator, soft-deleted parent access, and conflicting cross-session message IDs. Scope checks and authorized multi-query reads use a consistent snapshot where implemented. These differences need independent review, not replication of unsafe reference behavior.

**Catalog semantics.** Formula-product writes intentionally do not invent care receipts, cursor increments or versions absent from the reference. JSONB/DTO boundaries still contain generic objects with explicit SQL field allowlists; this is not a fully generated sqlc layer.

Full malformed-input/error-message equivalence, every permission interleaving, browser acceptance, private S3/avatar byte flows and complete Worker/Scheduler behavior remain outside this increment. Protected-image tests verify metadata only. An independent review must not mark the entire Go rewrite accepted on the strength of these suites.

## Benchmark boundaries

Require the exact tested commit's native and differential checks first. Benchmark only implemented, validated behavior. Do not count 503, failed authentication, conflicts, or cached idempotency replays as fresh-write throughput.

Use equal CPU/memory limits, data, indexes, connection budgets, bcrypt cost, authentication, validation and transactional side effects. Separate reads, fresh writes, replays, conflicts and same-family contention from multi-family traffic. The family synchronization row still serializes care mutations. Record successful throughput, error rate, p50/p95/p99, CPU/RSS, database time and pool waits. Different SQL projections mean a benchmark compares implementations, not language effects alone.

Compare conversation summaries separately from full histories and message writes. Device registration and voice-history benchmarks are not push/ASR benchmarks. No benchmark result, production deployment or branch merge is asserted by this document.
