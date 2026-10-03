# Server nutrition analysis and trends

**Status: `IMPLEMENTED_NOT_REVIEWED`**  
**Worktree:** `/private/tmp/growdesk-server-nutrition-analysis-20261003`  
**Base delivery:** `5437b6a6cd99eda72bc231f71bd38831b729d97c`  
**Date:** 2026-10-03

This delivery adds principal-scoped server calculation for the legacy Web daily nutrition summary and calendar-day trend. The only operations added are `getNutritionAnalysis` and `getNutritionTrends`; TypeBox remains the contract source, and OpenAPI was generated through the repository script. No iOS files or unrelated server features were changed. The worktree is uncommitted for parent review.

## Behavior

| Operation | Request | Behavior |
|---|---|---|
| `getNutritionAnalysis` | `GET /api/v1/babies/{babyId}/nutrition/analysis?date=YYYY-MM-DD&datasetVersion=…` | Reads one family-local calendar day, derives the baby’s age for that day, returns source-separated nutrients, target/UL comparisons where the legacy table has them, and coverage metadata. |
| `getNutritionTrends` | `GET /api/v1/babies/{babyId}/nutrition/trends?from=YYYY-MM-DD&to=YYYY-MM-DD&datasetVersion=…` | Returns each requested local day and per-day averages; includes days without records and rejects ranges over 90 calendar days. |

Both operations call `babyScope` with the authenticated principal, derive `familyId` on the server, and read the baby, family timezone, records, and family catalog products in one read snapshot. Queries constrain records to both `family_id` and `baby_id`, and products to the baby’s family. Foreign-family access returned `403 FAMILY_ACCESS_DENIED` in the isolated HTTP run.

Amounts keep the old Web categories while making their reliability explicit: formula and supplement profile calculations are in `calculatedAmount`; breast-milk and food table estimates are in `estimatedAmount`; `knownSubtotalAmount` is explicitly a subtotal of known sources, not a claim that all intake is captured. Per-nutrient and day-level coverage reports unknown profiles/units/foods, notes that only IDs in the pinned 38-nutrient dataset are evaluated, and marks logging completeness `unverified`. Missing amounts, unknown food IDs, unsupported units, and absent profile values do not receive guessed numeric totals. A free-text supplement amount with an unparsed unit is not treated as an exact dose. Vitamin A IU-to-RAE conversion retains the legacy Web factor and records that assumption because the source compound is not captured.

Formula data is only calculated when a same-family product profile has a supported `per_100g` or `per_100ml` basis; per-100g data additionally needs a usable reconstitution ratio. Supplement values are calculated from the exact numeric dose and same-family product profile. Breastfeeding duration, recorded milk volume composition, and food servings remain explicitly estimated from the legacy Web tables/curve. Trend intake averages divide by all requested days, including empty days. Each nutrient also returns `targetDaysCount` and `targetCoverageRatio`; its achievement rate is `null` unless an age-dependent target exists for every requested day. Age is calculated separately for every local date. Families with invalid timezones fail closed rather than silently shifting date buckets.

Malformed/empty birth dates and a requested local day before birth now produce `ageMonths: null` and `ageGroup: "unknown_age"`; age-dependent targets, ULs, achievement rates, and UL-comparison results remain `null`. The fixed Baby and CreateBaby contracts require a birth date (`prisma/schema.prisma` maps a non-null `DATE`, and `CreateBabyRequestSchema` requires `birthDate`), so the real HTTP test exercises a valid future birth date and queries the day before it instead of fabricating a missing value. Invalid and missing date parsing are covered by Go unit tests.

The new target-value tests exposed a separate serializer defect in the same calculator: DRI values were converted to `*big.Rat`, but the decimal helper did not accept that type, so valid targets were being returned as `null`. The helper now copies `*big.Rat` values correctly. UL comparison is also nullable when there is no UL to compare against; `false` no longer stands in for “no reference value.”

## Reference data and clinical boundary

The embedded `internal/backend/nutrition_reference_legacy_v1.json` is a frozen copy of the legacy Web nutrient IDs, DRI tables, breast-milk composition, static-food nutrient table, portion multipliers, and category fallbacks. The current calculator intentionally does not use category fallbacks. The dataset SHA-256 is `c727dbebf1682a0e73b7e06a306db0d745bf1939254cbb0efb1c04f8525ec6ee`; the API returns its version, hash, source description, and `validationStatus: legacy_values_not_independently_cross_checked`.

The Chinese Nutrition Society’s official release page dates the 2023 China DRIs publication to 2023-09-15 and describes its expert revision process. Its official DRIs page lists infant reference tables for 0–6 months, 7–12 months, and 1–3 years. [CNS 2023 DRIs release](https://www.cnsoc.org/acadconfn/792310200.html), [CNS 2023 DRIs tables](https://www.cnsoc.org/drpostand/). These pages establish the publication and available age-table scope; the linked table images could not be used to verify every legacy numeric cell. The legacy values therefore remain marked unverified and are not represented as clinically validated or as independently reproduced from the book.

The old Web comments also cite the 2022 Dietary Guidelines for Chinese Residents, the sixth standard edition of the China Food Composition Table, GB 10769, and WS/T 578. The official NHC records identify WS/T 578.1 as a 2017 standard and WS/T 578.2/4/5 as 2018 standards; the metadata now calls these older editions out instead of implying they are the 2023 CNS book. [NHC WS/T 578.1—2017](https://www.nhc.gov.cn/wjw/yingyang/201710/fdade20feb8144ba921b412944ffb779.shtml), [NHC 2018 WS/T standards notice](https://www.nhc.gov.cn/fzs/c100048/201805/e821444378d64bafa7283779631096ce.shtml). Numeric breast-milk/food rows and nursing estimates were not independently cross-checked against those publications.

The server is the single calculation source for clients; that does not make the reference values clinically validated. The result has no medical recommendation text or diagnosis. Unknown age is explicitly `unknown_age`; age groups after 36 months are marked `unsupported_over_36m` and return no DRI target/UL from this dataset.

## Verified boundaries and remaining product-data gaps

- The pinned formula product create/update contract does not accept `nutrientsJson`; `formula_products.go` only writes the existing brand/name/stage/scoop/water/archive fields. A fresh test account therefore cannot enter a formula nutrient profile through the exposed API. The real HTTP test creates a formula product and feeding through HTTP and confirms that the server retains the 90 ml feeding but reports formula nutrients as unknown. No SQL fixture mutation was used to make that path appear complete. Formula-profile arithmetic and unit conversion are covered by Go unit tests. A separately scoped contract/API change is needed to make new family formula profiles calculable.
- Family-created food-library items have no nutrient profile in the pinned contract. Such items remain unknown; only legacy static IDs with an embedded profile are estimated. A logged serving is a proxy multiplier, not a measured food mass.
- Historical calculations use the current family formula/supplement profile because record rows have no product-profile snapshot. This is disclosed on formula source contributions and remains a data-history limitation.
- Supported conversions are explicit. Unrecognized serving bases, nutrient units, unparseable doses, and missing nutrient entries increase unknown/unsupported coverage instead of falling back to a category average or assumed formula concentration.
- Empty-day trend inclusion, per-day age, incomplete target coverage across the 36/37-month boundary, and suppression of achievement rates unless all requested days have targets were verified in Go and real HTTP tests. Trends are capped at 90 inclusive local calendar days.

## Validation evidence

Canonical OpenAPI generation and consistency check passed at **115 paths / 163 operations**. The fixed server contract inventory assertion was updated from 161 to 163 for these two operations.

Passed checks:

- `npm run backend:build`
- `npm run backend:contracts:generate`
- `npm run backend:contracts:check`
- `go test ./...`
- `go test ./internal/backend -run 'TestNutrition'`
- `python3 -m py_compile scripts/go-nutrition-analysis-integration.py`
- `python3 scripts/go-nutrition-analysis-integration.py`
- `git diff --check`

The updated isolated real HTTP run passed 25 checks using newly registered `test_` principals, a `test_` family, and clearly prefixed test babies, a disposable PostgreSQL database, Redis, MinIO, fixture-only AI config, and a loopback-only API. It exercised the valid-before-birth `unknown_age` response, absence of DRI/UL comparisons for unknown age, a 36/37-month trend with 1/2 target-day coverage and no achievement rate, complete target coverage for the supported-age trend, authentication, family timezone, formula/breastfeeding/food/supplement writes, refresh after writes, empty-day and multi-day analysis, age transitions, DRI metadata, exact supplement conversion, food-serving estimate, the 90/91-day boundary, unsupported dataset version, invalid date, and foreign-tenant denial. PostgreSQL, Redis, MinIO, and API stopped; the private temporary directory and tenant data were removed. No worker, production secret/database, external provider, old Web SQLite database, shared API port, or Xcode build was used.

Detailed final HTTP responses, cleanup evidence, and SHA-256 hashes for every tested source file are in [`http-result-20261003T124226Z-1366dd.json`](http-result-20261003T124226Z-1366dd.json). The first incremental P2 run is preserved separately as [`http-result-age-target-trend-20261003-initial.json`](http-result-age-target-trend-20261003-initial.json). The runner now writes timestamped, random-suffix result files so later runs do not overwrite evidence.

Evidence-preservation note: the original pre-P2 21-check `http-result.json` was overwritten by the first incremental P2 run before the runner was changed to unique output paths. No full copy of that original JSON was available for recovery; the original check count and source digests remain summarized in the pre-change report/history, but this report does not claim that its complete JSON was retained. The current final result is the unique-path 25-check run linked above. The main implementation files are [`nutrition_analysis.go`](../../../../internal/backend/nutrition_analysis.go), [`nutrition_analysis_calc.go`](../../../../internal/backend/nutrition_analysis_calc.go), and the canonical [`nutrition.ts`](../../../../packages/contracts/src/nutrition.ts) contract.
