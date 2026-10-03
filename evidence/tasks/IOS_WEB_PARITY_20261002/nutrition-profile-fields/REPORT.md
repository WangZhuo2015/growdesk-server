# Nutrition product and food profiles

Status: **IMPLEMENTED_NOT_REVIEWED**. This worktree is based on `a6389d389648812d677b6ae5684f584aa1699fc8`; no changes were committed or deployed.

## Changes

The typed Go API now accepts and returns formula nutrient profiles, serving basis, and profile versions. Formula profiles can be updated with compare-and-swap (`baseVersion`) and explicitly cleared. The accepted label bases include `per_100g`, `per_100ml`, and `per_100kJ`; analysis calculates the first two only when its inputs support that basis. Since feeding records provide volume but no consumed-kilojoule measurement, a `per_100kJ` profile is retained but reported as unknown for calculated intake.

Family food-library items now support typed per-100g nutrient profiles, versions, and a CAS update route. A food record can carry `foodAmountGrams`. The analysis scales a per-100g profile only from this explicitly recorded mass. Without measured grams, or after the profile is cleared, analysis reports unknown rather than deriving mass from `portionDescription`. Existing static food portion estimates remain classified as estimates. The new food-library and measured-grams migrations apply in the owned test database.

The new family profile values are caregiver-provided and are not independently source-verified. Analysis uses the current profile; records do not snapshot an earlier profile version, so changing a profile can change historical analysis. Existing legacy reference values also remain marked `legacy_values_not_independently_cross_checked`.

## Verification

The isolated HTTP run exercised 55 checks against a newly registered `test_` owner and a separate `test_` foreign tenant, with a `test_family_` and `test_baby_` record scope. It verified formula and food profile creation, reads, CAS updates, explicit clears, calculated and unknown outcomes, stale-version conflicts, invalid amounts/units, and foreign-family denial. Representative exact results:

- A formula profile at 90 mL yielded 1.125 g protein and 18 IU vitamin D; after a CAS profile update it yielded 1.8 g protein. A stale profile update returned 409, and a cleared profile no longer supplied stale calculated values.
- A custom food profile with 4.25 g protein per 100 g yielded 2.125 g at 50 g. Updating the profile to 6.5 g/100 g yielded 3.25 g at 50 g and 3.9 g at 60 g. Missing measured mass and a cleared profile were reported as unknown. Stale record/profile versions returned 409; a foreign principal received 403.
- The runner applied 27 Prisma migrations. Its fixture provider was enabled; no worker or push credentials were present. Every service used loopback, no production secrets or legacy database were used, and cleanup stopped the owned services and removed the tenant database and private temporary directory.

Commands passed:

- `python3 scripts/go-nutrition-analysis-integration.py` — 55 real HTTP checks and cleanup.
- `go test ./...`.
- `npm run backend:test:unit` — 156 passed, 0 failed, 0 skipped; includes backend build.
- `npm run backend:contracts:check` — canonical OpenAPI in sync, 116 paths / 164 operations.
- `npm run backend:db:validate` — schema valid, 27 migrations verified.
- `node --import tsx --test packages/contracts/tests/nutrition-profile.test.ts` — 5 passed.
- `python3 -m py_compile scripts/go-nutrition-analysis-integration.py` and `git diff --check`.

The TypeScript changes are compatibility mappings for historical schema/build consumers. The real profile-write and analysis behavior above was verified through the Go API. This task did not run Xcode or a device test, use an external paid provider, or start a worker.

## Evidence

Final isolated HTTP result: `http-result-20261003T134607Z-e48ef9.json`. Its `sourceFileHashes` record the exact tested source files; it includes redacted tenant identifiers and no credentials. The run reports all cleanup flags true and an empty database diagnostics list.

Generated OpenAPI is the output of the normal contract generator, not a hand edit. The contract inventory advances from the analysis baseline of 115 paths / 163 operations to 116 / 164 with the new food profile update operation.
