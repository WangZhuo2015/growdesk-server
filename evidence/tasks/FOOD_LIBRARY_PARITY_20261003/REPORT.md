# Food library parity implementation evidence

Status: `IMPLEMENTED_NOT_REVIEWED` — no commit, deployment, or acceptance is claimed.

## Scope

This worktree implements the old Web food reference catalog and family-shared tried/status flow on the Go API. It preserves numerical nutrient profiles separately from Web text nutrition notes, adds family-scoped compare-and-swap and event projections, and makes custom-item creation replay-safe when the client supplies an idempotency key. It does not add custom-item edit/delete APIs; the Web does not expose those actions in the scoped library flow.

The source catalog is `baby_panel_for_cecilia/data/04_foods.json` with SHA-256 `89d96cdb829f552982ddb1da76d51b85eb8d2d02a70194386e3b200cff8453d2`. The migration promotes exactly 45 reference items and fails if that count is not met. It carries the Web introduction, allergy, choking, preparation, nutrition text, age texture, source, icon, and catalog-order fields. Family status is shared across a family's babies and includes tried/status, first-added date, acceptance, reaction, and version.

## Real isolated HTTP evidence

Latest and authoritative run: [http-run-07.json](http-run-07.json). The earlier `http-run-06.json` is retained as historical evidence from the previous base, before migration 028 was integrated.

The runner built and started a temporary API on loopback, with an owned PostgreSQL 18 test database and Redis 8 process. It registered three fresh `test_` principals, created one `test_` family and two `test_` babies, and performed all food reads and writes over HTTP. Only the viewer-role setup used a SQL fixture in the private disposable database because the public family API does not offer role promotion; the food authorization assertions themselves remained HTTP requests. No existing family or child data was read or written.

The run used server base `263d0107f07ea2732f08747f5d1d37c4bd291a6e` and passed 50 assertions: all 45 reference rows matched the Web source; unauthenticated/foreign/viewer restrictions returned expected statuses; same-key custom creation replay returned the original response and a changed body returned 409; profile and status updates covered explicit clears, stale versions, and a concurrent base-version-zero race with one winner; injected feed-write failures returned errors and left projection, receipt, cursor, and feed state unchanged; relaunch-style HTTP reads retained state; and a bounded worker processed only the test family's snapshot, whose `food_item` and `food_status` pages and content digests were verified.

Cleanup evidence in the run is `cleanupVerified: true`: the owned API and Redis processes stopped, PostgreSQL stopped, the temporary directory was removed, and the run created no container resources. External providers and push were not configured. Object storage was not used because these food-library operations do not involve attachments.

The exact local API URL from the completed run is retained only in its evidence JSON; it is no longer running. The stack is not suitable for iOS simulator use after cleanup.

## Checks

Passed on the implementation worktree:

- `go test ./...`
- `npm run backend:typecheck`
- `npm run backend:test:unit` — 159 passed, 0 failed, 0 skipped
- `npm run backend:contracts:generate` followed by `npm run backend:contracts:check` — 126 paths, 175 operations
- `npm run backend:db:generate`
- `npm run backend:db:validate` — Prisma schema valid; all 29 migrations, including 028 and this task's 029, verified
- `python3 -m py_compile scripts/go-food-library-parity-integration.py`
- `git diff --check`
- Real isolated HTTP run `http-run-07.json` — PASS, 50 assertions, cleanup verified

The legacy TypeScript route retains its published response schema locally. Expanding the shared typed food DTO otherwise caused the retiring TypeScript API to reject its existing response with a missing-`icon` validation error; its service and behavior were not changed.

## Source integrity

[SHA256SUMS.txt](SHA256SUMS.txt) records the reviewed source paths and the authoritative HTTP report hash. The exact loopback URL is evidence-only and no longer running.
