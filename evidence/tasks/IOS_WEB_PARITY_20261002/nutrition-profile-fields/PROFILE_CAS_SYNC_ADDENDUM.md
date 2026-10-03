# Nutrition profile CAS and food sync validation addendum

Status: **IMPLEMENTED_NOT_REVIEWED**. This addendum extends the nutrition profile worktree based on `a6389d389648812d677b6ae5684f584aa1699fc8`. The earlier 55-check HTTP evidence and `REPORT.md` were preserved unchanged; this work adds a separate result artifact.

## Changes

Formula updates now require `baseVersion` when changing nutrient values, serving basis, or reconstitution ratio. When a formula already has a nutrient profile, changing `scoopGrams` or `waterMlPerScoop` also requires compare-and-swap because those inputs change the per-100g calculation. Profile-less legacy formula edits to scoop/water remain compatible. The conditional rule is described by the TypeBox request schema and exported through normal OpenAPI generation; the contract remains 116 paths / 164 operations.

REST and `executeSyncCommands` now call the same transactional measured-food invariant. A non-null `foodAmountGrams` must refer to exactly one food item and, when adding or changing the measured quantity/item, that item must have a current per-100g profile owned by the record's family. This blocks the sync create/update bypass. A previously accepted historical record can still be restored after its current family profile is cleared; its mass is preserved while analysis reports unknown.

## Real HTTP evidence

Final isolated run: `http-result-20261003T140714Z-8781a3.json`, SHA-256 `f07c26f05cfa776eaa890a6ecb390f03dd3f08d182d2c18ab038314bb09b262e`. It contains 91 passing HTTP checks and exact tested source hashes. The separate test stack used loopback PostgreSQL/Redis/MinIO/API, 27 migrations, the fixture provider, no worker, and no push credentials. No production secrets or legacy SQLite database were used; all owned services and tenant data were removed, with empty database diagnostics.

Formula profile results: initial scoop/water inputs calculated 1.2 g protein at 90 mL; versioned water change calculated 2.4 g; versioned scoop change calculated 4.8 g. Missing versions returned `BASE_VERSION_REQUIRED` (400), stale versions returned `CONCURRENCY_CONFLICT` (409), and a versioned `nutrientsJson: null` clear advanced the product to version 4. Analysis then reported unknown. A no-profile legacy water edit without `baseVersion` still succeeded.

Sync results: a family-profile custom food create applied at version 1 and read back 25 g; updating to 30 g applied at version 2 and analysis returned 1.275 g protein. Measured mass on a non-profile food and measured mass on multiple foods were rejected on both create and update with `BAD_REQUEST`; rejected updates left the existing record unchanged. A foreign tenant received `FAMILY_ACCESS_DENIED`. Soft-delete and restore succeeded after the current food profile was cleared, preserved the 30 g historical mass, and remained unknown in analysis.

## Validation

- `go test ./...` — pass.
- `npm run backend:test:unit` — 156 passed, 0 failed, 0 skipped; includes TypeScript package builds.
- `npm run --workspace=@growdesk/contracts build`, `npm run backend:contracts:generate`, and `npm run backend:contracts:check` — pass, 116 paths / 164 operations.
- `node --import tsx --test packages/contracts/tests/nutrition-profile.test.ts` — 5 passed.
- `npm run backend:db:validate` — schema valid, 27 migrations verified.
- `python3 -m py_compile scripts/go-nutrition-analysis-integration.py` and `git diff --check` — pass.

No commit, deployment, iOS change, shared-stack restart, or worker execution was performed. The unrelated Web food-attempt/custom-description audit remains paused as requested.
