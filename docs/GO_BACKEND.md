# Native Go backend: implementation and validation scope

Status: **IMPLEMENTED_NOT_REVIEWED**. This is an incremental native implementation, not a complete replacement of GrowDesk and not production cutover approval.

The TypeScript reference is frozen at `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`. Its application source, packages, PostgreSQL schema/migrations and `contracts/openapi.json` remain unchanged. CI checks that boundary. Existing Web pages are not modified.

## Current native scope

The executable registers **47 of 151 declared operations**:

| Group | Native operations |
| --- | ---: |
| Health and authentication/session foundation | 14 |
| Families, invitation lifecycle and family membership | 10 |
| Baby profiles and explicit caregiver membership | 7 |
| Feeding, sleep and diaper CRUD/list | 15 |
| Timeline list | 1 |

Run `growdesk-api --contract-inventory` for exact paths and operation IDs. Registration is implementation coverage, not proof that all input combinations are compatible. The inventory deliberately does not label operations independently accepted. Missing operations return HTTP 503 with `GO_OPERATION_NOT_IMPLEMENTED`; they do not proxy to Node, return fake data, or count as successful throughput.

API business execution uses Go and PostgreSQL/Redis directly. Node is needed for building the reference implementation and existing tooling, not for serving the implemented native API operations. No Go Worker or Scheduler replacement is delivered in this slice.

## Build

CI pins Go **1.27.1**, and resolves only the committed `go.mod`/`go.sum` graph.

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

`-race` tests require a supported C toolchain; the deliverable above is built with cgo disabled. CI uploads the Linux amd64 executable, source revision, inventory and SHA-256 checksums as `native-go-<commit>`. No performance improvement is asserted by a successful build.

Runtime configuration includes explicit `DATABASE_URL`, password-protected `REDIS_URL`, `JWT_SECRET` (at least 32 bytes), `SESSION_ENCRYPTION_KEY`, `INVITE_SECRET`, `HOST` and `PORT`. Use isolated credentials and ports for tests. Default database pool size is 10 (`DB_POOL_MAX`); HTTP concurrency defaults to 256 (`HTTP_MAX_CONCURRENCY`). Existing migrations must be applied by the migration owner before starting the service; the server does not auto-migrate a database.

## Actual HTTP/database regression commands

The scripts require Docker and Python 3. They create exclusively owned PostgreSQL 18 and password-protected Redis 8 containers on loopback random ports, with temporary `test_` database/role names and a non-superuser business role. They apply real repository SQL migrations and remove only their own containers/processes. They do not accept a production database override.

```sh
python3 scripts/go-integration.py --binary dist-go/growdesk-api
python3 scripts/go-domain-integration.py \
  --binary dist-go/growdesk-api --report dist-go/native-domain.json

# Build the unchanged real reference, then compare both runtimes.
npm ci --ignore-scripts --no-audit --no-fund
npm run backend:db:generate
npm run backend:build
python3 scripts/go-domain-integration.py \
  --binary dist-go/growdesk-api --reference --report dist-go/http-parity.json
```

Do not use `python -O`: the regression harness uses assertions. PASS reports are written only after the corresponding checks finish successfully. GitHub workflow jobs are separate: `native-static`, `native-postgres`, and `native-reference-parity`. A green native job does not imply a green reference comparison. Consult the exact commit's run and artifacts, not an older screenshot or this document, for results.

The domain suite checks family/baby scope, invitations, member management, nullable fields, decimal strings, version conflicts, keyset pagination, soft deletion, timeline projections, idempotent replay, concurrent creation, sleep invariants and stale credentials after revocation. It injects a failure into the family change append and checks that record/timeline/cursor/receipt changes all roll back. In reference mode, it also replays TypeScript-created care receipts through the real Go HTTP API using the same isolated database and credentials.

For differential observations, generated UUIDs are mapped by identity and server-generated timestamps are normalized only after verifying their wire format. Business times, null versus absent, decimal representation, zero values, versions and array order are not stripped. Error comparison currently covers HTTP status and `error.code`, **not byte-exact error messages/request IDs**. Database observations check transactional counts/cursors and tested record results; they are not a complete field-by-field production migration audit.

## Deliberate limits and deviations

- **104 operations remain unimplemented**, including food/nutrition, growth, medical/vaccine domains, attachment storage APIs, notifications, AI runs/voice, synchronization, and other declared operations. Use inventory, not this illustrative list, as the exact backlog.
- Native BFF/session regression covers fresh Go sessions. Its encrypted replay/session format uses `go:v1:` and is **not an interoperable reader/writer for existing TypeScript BFF ciphertext**. Do not alternate those session flows across runtimes or advertise rolling-session migration compatibility. This must be resolved and tested before any whole-backend cutover.
- Go additionally refuses demoting the last effective baby administrator through membership upsert. That closes an orphaning path in the reference and is an intentional security deviation, not an exact-parity claim. It requires dedicated review; shared differential scenarios do not exercise that unsafe reference mutation.
- Full malformed-input/error-message equivalence, the entire permission matrix, real private-S3/avatar lifecycle, browser/Web integration and Worker/Scheduler behavior are not certified by the current domain suite.
- JSONB adapters and DTO projections still use generic objects at boundaries. Explicit SQL field allowlists are used; this does not claim a completed all-typed sqlc repository layer.
- The family synchronization row serializes mutations per family, matching the existing transactional design. Go's concurrency model does not remove that database contention constraint.

## Benchmark prerequisites

First require the exact tested commit's native and differential checks to pass. Only benchmark declared native operations whose requested behavior has passed validation. Do not count 503/401/409 responses or cached idempotency replays as successful create throughput.

Use equal CPU/memory limits, dataset sizes, PostgreSQL indexes and connection budgets. Keep bcrypt cost, authentication, validation, idempotency receipts, timeline and change-log writes enabled on both sides. Separate reads, fresh writes, intentional replays, conflicts and same-family contention from multiple-family traffic. Measure successful throughput, error rate, p50/p95/p99, process CPU/RSS, database time and pool waits. Do not benchmark the two application processes concurrently against the same constrained database unless measuring that contention intentionally.

No production deployment, data migration, branch merge, or benchmark result is included in this implementation slice.
