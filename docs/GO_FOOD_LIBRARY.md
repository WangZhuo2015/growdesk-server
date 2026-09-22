# Native Go food catalog slice

Status: **IMPLEMENTED_NOT_REVIEWED**. This document covers three operations, not full backend parity, independent acceptance, a production cutover, or a performance claim.

## Scope

| Operation | Method / path | Actual success representation |
| --- | --- | --- |
| `listFoodLibraryItems` | `GET /api/v1/food/items` | `200 {"data": [...]}` |
| `createFoodLibraryItem` | `POST /api/v1/food/items` | `201` raw item, without a `data` envelope |
| `getFoodGuidelines` | `GET /api/v1/food/guidelines` | `200 {"data": [...]}` |

All require the existing Go Bearer/session authentication. Catalog handlers use PostgreSQL directly, not a Node proxy or an in-memory/file store. The guidelines are the literal reference dataset, not newly generated clinical advice.

A sole active family may be inferred. Multiple active families require an explicit `familyId`; none or a foreign family is denied. Public items and the selected family's custom items are visible, but tried/reaction status is always scoped to the selected family. Current membership, non-deleted family and user are checked. Viewers may read but not create. Readers distinguish lost authorization from an empty catalog; the final membership check and rows share one PostgreSQL statement snapshot.

Creates acquire the existing family transaction lock and recheck role after locking. The custom item and optional family status commit or roll back together. Absent `tried` creates no status row; explicit `false` creates and returns a false status, with `reaction: null`. Empty lists remain arrays, zero age remains zero, and persistence-only properties are not exposed. These operations do not have a care idempotency/version/sync event protocol; none is invented by the Go implementation.

## Frozen reference mismatch (not hidden)

Reference commit: `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`.

The real `apps/api/src/routes/food-routes.ts` declares `201: FoodLibraryItemSchema` and executes `reply.status(201).send(item)` for creation. However, `packages/contracts/src/routes.ts` and the generated `contracts/openapi.json` wrap the creation response in `data`. The real route also declares 403 whereas the generated creation operation omits it.

Go follows the real Fastify wire, preserving the existing consumer behavior. The frozen reference source, schemas and migration files remain unchanged. Tests explicitly record the envelope discrepancy; they validate the item schema separately and compare actual HTTP responses against the unchanged Fastify server. This must **not** be advertised as full response-envelope conformance to the frozen OpenAPI. A later coordinated contract correction must preserve the existing raw response, update the canonical route/OpenAPI and consumer tests together, and remove the obsolete drift regression.

The reference Prisma-backed route surfaces `P2039` for PostgreSQL `raise_exception` / SQLSTATE `P0001`. A food-only error adapter preserves that HTTP 500 error code without exposing SQL, private constraint names or driver messages. It does not emulate all Prisma errors, inspect error-message text, swallow cancellation, or convert errors to success. Other errors keep existing handling. Success DTOs are compared fully after generated-ID mapping; error comparisons cover HTTP status and code, not exact driver-dependent error prose or request IDs.

## Reproduce isolated checks

Use the pinned Go toolchain in `go.mod` / the workflow, Docker, and Python without optimization (`python -O` is rejected). The runner creates its own PostgreSQL 18 and Redis 8 containers on loopback random ports, independent credentials and a non-superuser role. It applies the unchanged migrations, uses only `test_` accounts, and tears down only resources it owns. It does not accept a production endpoint/database override or use paid AI/push providers.

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
python3 scripts/go-food-library-integration.py \
  --binary dist-go/growdesk-api --report dist-go/food-native.json

# Build the unchanged reference only for test comparison, not native serving.
git diff --exit-code f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4 \
  -- apps packages prisma contracts/openapi.json
npm ci --ignore-scripts --no-audit --no-fund
npm run backend:db:generate
npm run backend:build
python3 scripts/go-food-library-integration.py \
  --binary dist-go/growdesk-api --reference --report dist-go/food-reference.json
```

The dedicated read-only workflow `.github/workflows/go-food-library.yml` runs native and reference lanes independently and uploads reports bound to the tested commit. A report begins as RUNNING and becomes FAIL on exceptions; only a completed comparison can become PASS. No workflow edits or publishes application source during validation.

The scenarios exercise unauthenticated requests; a shared public item with differing private family statuses; custom item isolation; absent/false/true; sorting; unknown-field stripping; quoted/Unicode names; invalid requests; viewer/member roles; concurrent creates; restart persistence; revoked memberships; and real Go/TypeScript cross-reading of committed food rows with a regular Bearer session. They force the second INSERT to fail using a temporary trigger and check that the first INSERT did not leak a partial item. The trigger is removed in a finally block and both implementations must return the same error status/code.

This slice does not certify legacy BFF ciphertext interoperability, food logs/plans, nutrition analysis, all malformed numeric limits, attachments, Worker/Scheduler, or the whole Web. Do not infer those capabilities from the word "food" or from a passing catalog suite.

## Benchmark boundary

Benchmark only native operations present in the executable's `--contract-inventory` after their regressions pass. Preserve revision and SHA-256 checksums. Use isolated test data and report successful request throughput, errors, p95/p99, CPU/RSS, connection pool and database metrics separately. Do not count 503, failed authorization or duplicate/replayed operations as successful business work. Catalog sizes and PostgreSQL configuration must be comparable. The Go catalog uses a combined SQL projection while the reference uses repository queries; any difference measures these implementations, not language alone.
