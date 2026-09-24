# Go completion work: PR #10

Status: **WIP / IMPLEMENTED_NOT_REVIEWED**. This is a continuation, not completion of the full native backend or approval for production. This branch currently registers **86/151 operations**; **65 are missing**. Counts describe method/path registrations, not a percentage of work, independent acceptance, or exhaustive behavioral equivalence.

Code checkpoint: `df1421e78cef9b6f3e29e345866d4cac17a8f406`.
PR base: `d798459f2b1217986e2d1046672acdc8f20d17d1` (merged PR #9).
Frozen TypeScript reference: `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`.
The default TypeScript deployment, Web pages, `apps`, `packages`, `prisma` and `contracts/openapi.json` remain unchanged. CI checks that boundary. Existing preview-only configuration and database guards remain mandatory.

## Added since PR #9

| Native area | Operations | Verification entrypoint |
| --- | ---: | --- |
| Food-plan retrieval and transactional save | 2 | `scripts/go-food-plan-integration.py` |
| Food and supplement record CRUD/list | 10 | `scripts/go-nutrition-records-integration.py` |
| Application configuration and development catalogs | 4 | `scripts/go-knowledge-integration.py` |
| Family book catalog and reading status | 2 | `scripts/go-knowledge-integration.py` |
| Total increment | 18 | Native and actual TypeScript HTTP/state comparisons |

`docs/GO_BACKEND.md` also describes the original PR #9 foundation, configuration and benchmark boundaries. Do not mistake its historical 68-operation milestone for the current inventory. The compiled inventory is authoritative for registration.

## Behavior and review boundaries

Food/supplement mutations use a shared transactional command path: current authorization, family synchronization locking, record mutation, timeline/change/cursor updates and idempotency receipt belong to one transaction. Actual PostgreSQL failure injection and HTTP comparisons must continue passing when any part changes.

Reading status has its own reference semantics, not invented care semantics. It updates `family_book_statuses`, advances the family cursor and inserts `family_changes` atomically. It does not add care records, care receipts or timeline entries. Optional `baseVersion` detects stale state. Explicit `readCount: 0`, `isFavorite: false` and explicit status precedence are preserved. List responses omit `details.status`; mutation responses include it, matching the reference serializer. Six racing writes with one base version must produce one success and five conflicts.

Public reference datasets are embedded as the original frozen JSON literals from the repository. Go decodes these literals without executing TypeScript, calling Node, fetching remote sources or creating a second edited dataset. Each response receives its own copy of nested details. Root response fields follow the actual Fastify serialization allowlist; catalog array order and release metadata remain intact. Empty results are arrays, not null.

### Explicit schema drift

The frozen exported OpenAPI omits `month`/`category` query parameters for development catalogs and the required `familyId` parameter for book listing. The real TypeScript routes validate them. `knowledge_query.go` implements this narrowly scoped validation before authentication, removes unknown query keys, rejects repeated parameters, enforces category length and matches accepted numeric month representations.

The HTTP differential includes `2.0`, exponent/radix forms, JavaScript numeric whitespace including U+FEFF, and rejection of U+0085, numeric separators and Go-only hexadecimal float syntax. It checks status/error code for invalid inputs, not byte-identical error prose. This is an explicit reference/schema discrepancy, not permission to relax unrelated operations or silently rewrite the frozen contract.

Reading tests also verify denial after membership revocation and native denial of soft-deleted family access. Parent tombstone hardening remains an intentional safety difference; it is not a claim that the unsafe reference behavior is copied.

### Groundwork is not an implemented endpoint

`scalar_receipt.go` and its tests provide a bounded flat-object property-order hash and JavaScript-compatible fixed-decimal rounding for future growth work. They do **not** implement growth CRUD or charts. The request buffer is retained only for those future ordered-receipt routes, not all requests. Growth is still missing from the compiled native inventory.

BFF credential handoff limitations from PR #9 remain: TypeScript-to-Go refresh takeover is not bidirectional or rolling compatibility. Do not alternate refresh writers or downgrade encrypted Go credentials to plaintext.

## Exact-checkpoint validation

The code checkpoint above has the following actual GitHub Actions results:

| Workflow | Run | Result |
| --- | --- | --- |
| Go backend | 35814698914 | SUCCESS |
| Go food library parity | 35814698948 | SUCCESS |
| GrowDesk backend | 35814699042 | SUCCESS |
| Migration integrity | 35814698947 | SUCCESS |
| Go completion parity | 35814698994 | FAILURE: full-operation gate remains red; all six domain native/reference jobs pass |

The previous knowledge attempt at `39d559c` / run 35813402818 failed on `month=2.0`. It is retained in history. Production validation was corrected and the real suites were rerun; the failing request was not removed. The later review additionally tightened JavaScript numeric grammar and whitespace and reran the same databases, rollback, restart and cross-runtime checks.

The completion workflow checks **151/151**, not an increasing partial threshold. A registration-only gate cannot prove worker execution, data correctness or permission coverage; its success will not alone authorize a release. It currently exits nonzero because implementation is incomplete. No `continue-on-error`, fabricated success response or TypeScript proxy is used to disguise missing operations.

The authoring session's local container execution failed. Validation evidence is actual GitHub Actions, not a claimed local run. These results do not assert an independent review, a browser/S3 end-to-end pass, production data reconciliation, deployment or benchmark results. Documentation-only commits after the checkpoint require their own CI status to be reported separately.

## Reproduce in a clean, isolated checkout

Use the pinned Go toolchain, Docker and Python 3. Never import production environment files or override the test harness database. The harness creates and tracks its own loopback PostgreSQL 18 and password-protected Redis 8, applies existing migrations and uses non-superuser `test_` identities.

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
python3 scripts/go-coverage.py dist-go/operations.json

for module in food-plan nutrition-records knowledge; do
  python3 "scripts/go-${module}-integration.py" \
    --binary dist-go/growdesk-api --report "dist-go/${module}-native.json"
done

npm ci --ignore-scripts --no-audit --no-fund
npm run backend:db:generate
npm run backend:build
for module in food-plan nutrition-records knowledge; do
  python3 "scripts/go-${module}-integration.py" \
    --binary dist-go/growdesk-api --reference \
    --report "dist-go/${module}-reference.json"
done

# Intentionally fails until all declared operations are truly implemented.
python3 scripts/go-coverage.py dist-go/operations.json --require-complete
```

Run the original foundation, food-library, companion and BFF session suites described in `GO_BACKEND.md` as well. New domain tests do not replace those suites. Bind the binary, source revision and reports to the same clean checkout. Do not delete or overwrite user work to obtain a clean tree; use a separate worktree when required.

## Still outstanding

The compiled inventory lists each missing method/path. Major groups are growth and charts, medical/vaccine flows, supplement products/schedules, account export/deletion, snapshot/restore and synchronization, core AI execution and resumable events, OAuth/MCP, and authorized attachment byte/storage lifecycles. Worker/Scheduler, full ASR/AI/push execution, browser acceptance and complete failure/permission interleaving matrices are not finished.

Benchmark only implemented operations already validated on the exact tested binary. Separate fresh writes, reads, cached idempotency replays, conflicts and rejected requests. Use equivalent data, indexes, connection budgets, authorization, validation and transactional side effects. A fast 503 or a returned queued task is not successful full-business throughput. This PR must remain draft while the requested full backend remains incomplete.
