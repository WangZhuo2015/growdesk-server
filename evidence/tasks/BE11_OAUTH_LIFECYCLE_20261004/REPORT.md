# BE-11 MCP OAuth lifecycle evidence

Status: `IMPLEMENTED_NOT_REVIEWED`. Independent review identified one P2 compatibility finding; follow-up review confirmed it is resolved and found no new confirmed P1/P2. This status does not claim acceptance, production deployment, iOS integration acceptance, or a live third-party MCP client acceptance.

Worktree: `/private/tmp/growdesk-server-mcp-oauth-20261004`, branch `codex/mcp-oauth-lifecycle-20261004`, based on `a3d6b5ac67e6faec9bbd4cb05313ac967bc312eb`.

## Delivered

- Added Go runtime routes for OAuth client registration, HTML login/consent, authorization-code exchange, refresh, and revocation. Existing well-known discovery routes remain, standard `/oauth/*` endpoints are advertised, and `/api/v1/mcp/oauth/*` aliases remain registered.
- Added durable public-client, opaque access credential, browser request-consumption and client lifecycle state in native migration `0004_oauth_lifecycle.sql`. Existing checksummed migrations `0001_oauth.sql`–`0003_passport.sql` were not modified. The integration runner applies and verifies the native migration after the owned Prisma database is prepared.
- Authorization requires an exact registered redirect URI, exact configured MCP resource audience, PKCE S256, explicit baby and scope consent, a verified browser login, and a one-time authorization request secret. Authorization codes are 256-bit random values stored only as SHA-256 digests and are atomically single-use under transaction locks.
- Access and refresh credentials are opaque 256-bit values stored only as hashes. Refresh rotates credentials, preserves or reduces scope, rejects expansion, and revokes the grant on reuse. The durable authorization session remains revocable through app session management for the grant lifetime; the browser JWT cookie remains HttpOnly, SameSite Strict, `/oauth`-scoped, and ten minutes long.
- MCP authentication reads live access/grant/session/family/baby membership state and rejects App-session JWTs. Mutating MCP tools recheck the credential and current membership inside the write transaction using the documented User → Family → DeviceSession → credential ordering.
- App session revocation, password recovery, account deletion, BFF rebinding, and password change revoke the applicable OAuth grants and credentials. Safe connection summaries and deletion events omit token values, hashes, authorization codes, refresh tokens, and secrets.
- Implemented owner-only `GET /api/v1/connections` and `DELETE /api/v1/connections/:id` against durable grants. TypeBox remains the canonical contract source; Go serves the iOS/backend runtime.
- Preserved legacy grants whose `client_id` has no `oauth_clients` row: the owner connection inventory uses a safe `Legacy OAuth client` display label and still exposes the public client ID. A staged PostgreSQL regression inserts a populated 0001-era grant after applying 0001–0003, applies 0004, and proves it remains visible and owner-revocable. The real revoke route also confirmed that updating `revoked_at` on the row passes the `NOT VALID` foreign-key constraint; no FK relaxation or migration rewrite was needed.

## Verification

Final `python3 scripts/test-integration.py --suite all` exited 0. The runner used owned PostgreSQL 18 and authenticated Redis 8 children, applied the full Prisma migration sequence, staged native migrations 0001–0003, upgraded a populated legacy OAuth grant through 0004, verified all native checksums, built the backend packages, and removed its private test database and processes afterward. Results included:

- `TestMCPOAuthLegacyGrantUpgradeIntegration`: pass. The historical grant was listed with a safe fallback and no credential fields, remained backed by its original live device session, was invisible and not revocable to a foreign account, rejected anonymous revoke, and was successfully revoked by its owner.
- `TestMCPOAuthLifecycleHTTPIntegration`: pass. Covers DCR, invalid redirect/resource/plain PKCE, browser login and consent, code/access/refresh hash-only storage, concurrent single code redemption, App/MCP audience separation in both directions, refresh scope shrink/expansion/reuse, `/oauth/revoke` immediately blocking MCP tools, owner-only connection list/delete, account deletion revocation, and session/grant lifetime alignment.
- `TestPersonalAccessTokensHTTPIntegration`: pass with 120 tracked HTTP/worker assertions. Both test tenants cleaned to zero rows.
- Legacy import integration: pass.
- Node integration summary: 228 tests, 228 passed, 0 failed, 0 skipped; the remaining owned-PostgreSQL suites and live object-permission checks passed.
- Contract check passed at 141 paths / 192 operations. `backend:build` completed inside the integration runner.

Additional completed checks: `go test ./...`; tagged OAuth test compilation with `go test -tags mcp_oauth_integration -run '^$' ./internal/backend`; `npm run backend:typecheck`; `npm run backend:lint` including the architecture check; `npm run backend:db:validate` (Prisma schema and 32 checked migrations); and `git diff --check`.

All generated tenants used `test_` names and test-prefixed families/babies. No production database, real external credentials, billing, pushes, deployment, or device was used.

## Native migration integrity

SHA-256 values were compared against the base commit `a3d6b5ac67e6faec9bbd4cb05313ac967bc312eb`. Migrations 0001–0003 are byte-for-byte unchanged; 0004 is the new lifecycle migration:

| Migration | SHA-256 |
| --- | --- |
| `0001_oauth.sql` | `bde35d470380232f00de11ec794c01d586a17c1782b24176c154dcc824986481` |
| `0002_object_cleanup.sql` | `ab219547e33f576baecb31652e89f02006efdc977f7d423447817a1ae51aa19a` |
| `0003_passport.sql` | `6f4b5d04a9c9b4cfcb2cb3a28ec2c3b9bb3648f8acd1785c895443f532c3a8ab` |
| `0004_oauth_lifecycle.sql` | `b149d178cb3b8341f5a35d1f9e98af987d0e6ac2cf508513883209d7f2a7f22e` |

## Remaining acceptance boundary

The initial and follow-up independent reviews are recorded in `INDEPENDENT_REVIEW.md`; the original P2 compatibility finding is fixed and covered by the staged PostgreSQL regression, with no new confirmed P1/P2 reported. The implementation remains `IMPLEMENTED_NOT_REVIEWED` by delivery convention. No CI/PR review, production migration, service deployment, iOS settings UI, App Store build, or real third-party MCP-client authorization smoke was performed. The existing MCP tool/domain behavior and AI usage availability were not expanded by this task.
