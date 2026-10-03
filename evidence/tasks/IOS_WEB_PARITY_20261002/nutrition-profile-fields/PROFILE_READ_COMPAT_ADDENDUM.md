# Formula profile read-compatibility addendum

**Status: IMPLEMENTED_NOT_REVIEWED.** This addendum records the response-contract compatibility fix and isolated verification. It does not accept, merge, deploy, or change the previously frozen nutrition results.

## Change

- `FormulaProductSchema.nutrientsJson` is now `Nullable(Type.Unknown())` for reads, preserving historical JSON values without making the whole product list depend on each profile's shape.
- `CreateFormulaProductRequestSchema` and `UpdateFormulaProductRequestSchema` still use strict `NutritionProfileSchema`. Their generated requests require measurements containing exactly `amount` and `unit`.
- The analysis parser now treats a recognized nutrient value with extra measurement properties as invalid, just as it already treated a scalar as invalid. It marks that nutrient/source unknown, excludes it from calculations, and continues calculating other valid entries in the same profile.

## Verification

- `npm -w packages/contracts run build` — passed.
- `node --import tsx --test packages/contracts/tests/nutrition-profile.test.ts` — 6 passed, 0 skipped. Added coverage verifies raw legacy data/scalars are valid product responses but invalid create/update bodies.
- `npm run backend:contracts:generate` and `npm run backend:contracts:check` — passed; generated contract reports 116 paths, 164 operations, 58 schemas. The OpenAPI response field is nullable with no shape restriction; create/update request fields retain the nested strict `amount`/`unit` schema.
- `go test ./...` — passed.
- Python runner syntax check — passed.
- `python3 scripts/go-nutrition-analysis-integration.py` — 98 real HTTP checks passed on its new owned loopback PostgreSQL/Redis/MinIO/API stack. A fresh `test_` owner, family, and baby were used. The formula was created through HTTP, then only that run's PostgreSQL row was directly updated as a clearly identified historical-read fixture; this fixture seed is not a supported public write and does not replace CAS or authorization checks.

The HTTP list returned the mixed legacy JSON unchanged (extra `source` metadata, a numeric scalar, a valid measurement, and an unknown nutrient key). Analysis returned HTTP 200: the malformed protein and scalar iron were reported as `unknown`, while the valid vitamin D entry still calculated to 20 IU. The same malformed profile sent through typed HTTP create and update both returned 400 `FST_ERR_VALIDATION`.

The runner recorded cleanup success for API, PostgreSQL, Redis, MinIO, temporary directory, and tenant database. It used only loopback services, a virtual AI fixture, no worker, and no push credentials. The previous HTTP result `http-result-20261003T140714Z-8781a3.json` remains byte-identical at SHA-256 `f07c26f05cfa776eaa890a6ecb390f03dd3f08d182d2c18ab038314bb09b262e`.

## Evidence and source hashes

- Real HTTP result: `http-result-20261003T143556Z-73e601.json`
- Result SHA-256: `fd02aaefaeeb5610d582c9a55c1f8cf25b321fe1edfcef2e2dac570bec35e492`
- Check count: 98; status: PASS; all cleanup flags: true.

| Source | SHA-256 from the run |
|---|---|
| `packages/contracts/src/nutrition.ts` | `2d52619d3736c9cd0811757940e6c3dc409f85361171ddbfd3d2f7935dfe27d7` |
| `contracts/openapi.json` | `e2f3e5d44697346a25a4206ffc92001d78db7cef028969d55b4db70540300c77` |
| `packages/contracts/tests/nutrition-profile.test.ts` | `ae3130d7d0b07d2a73cf7a5e19fda8be1f505a85b6a973b97a433fc0c10c88ca` |
| `internal/backend/nutrition_analysis_calc.go` | `1ddab1e5290c76a18acd44f6404cbbbdc4b87e9e3ed8588bcebbed3a691a14fb` |
| `internal/backend/nutrition_analysis_test.go` | `374d586c5efb76f0b5925e0264c7219389d052633692ce97d8d9f2b2c46df147` |
| `scripts/go-nutrition-analysis-integration.py` | `2a61c6fb77059acbd10919b7a6bb809d27a83a0c3756d23f9bcfa4c9221bdbbd` |

This test establishes behavior for explicit test fixtures only. No production database was sampled, so it does not establish how often legacy shapes occur in existing accounts.
