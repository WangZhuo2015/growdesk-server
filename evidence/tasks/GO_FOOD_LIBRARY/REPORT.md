# Go food catalog increment — 2026-09-22

**IMPLEMENTED_NOT_REVIEWED.** This is an implementation and regression report, not independent acceptance, a full-backend parity claim, a benchmark result, or production approval.

## Fixed checkpoints

- Branch: `codex/go-backend-parity-20260922`; existing draft PR #9.
- Validated branch checkpoint: `2ccdfc49194a7dda119fe6fcd59472461ff047f3`.
- Actual PR merge commit checked out by the runs: `c6b30d92c12594c65c7654972f318f1fd0104e25`.
- GitHub compare between those two commits returned no changed files. They have the same source content; their Git identities differ.
- Unchanged TypeScript/database/OpenAPI reference: `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`.
- This report is committed after validation; its own new commit is not the tested program revision.

## Delivered slice

Three newly registered native operations: authenticated GET/POST `/api/v1/food/items`, and GET `/api/v1/food/guidelines`. The executable inventory contains 68 registered and 83 unimplemented operations out of 151. Registration counts are not independent verification counts. Food logs/plans and other missing operations are not completed by this increment.

The code uses actual PostgreSQL, parameterized SQL, current family membership, a family-scoped catalog/status projection, and an atomic item/status creation transaction. Missing versus false `tried`, explicit null reaction, zero age, ordering, unknown-field stripping, read-only roles, revoked access and restart persistence are covered. No Node proxy, local JSON persistence or additional production migration is introduced.

Small commits separate native implementation (`6eceb85`), wire/scope tests (`c88dff2`), registration (`e22d70a`), real PostgreSQL/Fastify differential tests (`4574026`), CI (`a3c10dc`), explicit spec drift (`f1d2826`), same-snapshot authorization (`322093d`), database error compatibility (`5e530c6`, `8aa1081`, `ebbee0e`), and reproducibility documentation (`2ccdfc4`). Concurrent changes already on the branch were preserved.

## Actual completed validation

### Go food library parity — SUCCESS

Run: https://github.com/WangZhuo2015/growdesk-server/actions/runs/35715294952

- `food-library-native`, job `106705336668`: SUCCESS.
- `food-library-reference`, job `106705336362`: SUCCESS.
- Real PostgreSQL 18 / Redis 8, exclusively owned disposable containers and `test_` users.
- Actual Go and unchanged Fastify HTTP servers, not handler mocks.
- `food-reference.json`: status PASS, **41 matching differential response/state observations**.
- Script counters: Go 46 HTTP assertions; TypeScript 47. Additional direct cross-runtime checks are not included in those counters.
- Verified Go reads reference-created food rows with the same ordinary Bearer session, and the reference reads a Go-created food row.
- Forced second-INSERT failure rolled back the first INSERT in both implementations. The response is HTTP 500 / P2039 in both, not a successful partial write.
- Reference report artifact: `10688724037`, `food-library-reference-c6b30d92c12594c65c7654972f318f1fd0104e25`. Downloaded and inspected after run completion.

### Existing Go backend suite — SUCCESS

Run: https://github.com/WangZhuo2015/growdesk-server/actions/runs/35715294822

- `native-static`, job `106705311510`: SUCCESS; dependency verification, vet, full Go race tests and cgo-disabled binary build.
- `native-postgres`, job `106705312433`: SUCCESS; existing authentication, business and companion isolated database suites.
- `native-reference-parity`, job `106705313973`: SUCCESS; existing business and companion HTTP/state comparisons.
- Native binary/inventory/checksums artifact: `10688648936`, `native-go-c6b30d92c12594c65c7654972f318f1fd0104e25`.

These CI results do not imply unimplemented endpoints have become compatible. The local working container was used for source inspection, formatting, Python syntax checks and artifact verification; the pinned Go build, race and database suites above ran on GitHub Actions.

## Existing differences explicitly retained

1. The frozen generated OpenAPI creation response declares `{data: item}`, but the actual Fastify route declares and returns the raw item. Go preserves the real wire. A dedicated unit regression records the spec drift, separately validates the item schema, and the real-HTTP differential locks down the raw response. Neither frozen source nor OpenAPI was edited to manufacture success. The canonical contract needs a later coordinated correction; this is not full frozen-envelope conformance.
2. The reference exposes Prisma P2039 for PostgreSQL SQLSTATE P0001. The food-specific Go adapter preserves that status/code and deliberately sanitizes internal SQL/constraint/message details. Cancellation, domain errors and unrelated SQL errors retain their normal handling. The first differential run failed on this exact code difference; the implementation was corrected without deleting the assertion.
3. Success comparisons preserve business values, null/omission and ordering, mapping generated IDs through the shared scenario normalizer. Error comparisons cover status/code, not exact ORM-dependent prose or request IDs. This is not an exhaustive malformed-input/error-message matrix.
4. The Go final read authorizes membership and data within one statement snapshot. Lost access is not silently converted into an empty successful catalog.

## Remaining and benchmark limits

Remaining scope includes food logs/plans, other unimplemented operations, full Worker/Scheduler and AI/ASR pipelines, attachment/S3 behavior, complete BFF ciphertext interoperability and full-browser acceptance. No merge into main, deployment, production data write, real provider call or benchmark was performed in this increment.

Reproduction commands and benchmark boundaries are in `docs/GO_FOOD_LIBRARY.md`. Benchmark the fixed native artifact or rebuild the fixed source checkpoint on the target platform; count successful native business operations only, exclude 503/authorization failures, and report CPU/RSS, database load and latency together. The Go SQL projection differs from the reference's repository queries, so any future benchmark compares implementations rather than isolating language effects.
