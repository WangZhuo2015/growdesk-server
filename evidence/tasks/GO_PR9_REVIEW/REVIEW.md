# PR #9 review and remediation

Status: **IMPLEMENTED_NOT_REVIEWED** under repository policy. This is an implementer self-review and remediation record, not an independent ACCEPTED decision.

## Reviewed baseline and scope

- PR: https://github.com/WangZhuo2015/growdesk-server/pull/9
- Starting head: `84762a3644bda513a700eec9513fd30c1a86ecf3`.
- Target: `codex/web-parity-20260919`, reference `f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4`.
- Scope remains the 68-operation isolated Go increment, not the remaining 83 operations or a whole-backend production replacement.
- No deployment, production access, branch merge, reference/schema change, or live AI/push call is authorized or performed here.

The baseline already contained preview startup guards, bcrypt marker/rehash repair, password-reset-aware login locking, consistent read snapshots, strict JSON media parsing and startup/shutdown fixes. These were retained; they are not attributed as newly implemented by this continuation.

## Findings and fixes

| ID | Severity | Finding | Remediation and regression |
| --- | --- | --- | --- |
| R1 | High | Credential rebinding overwrote the BFF pointer without revoking the superseded device session/refresh credentials. | `bff_binding.go` acquires involved user locks in sorted order, then device/BFF locks, revalidates credentials and binding identity, and commits old revocation/new session/binding together. Stale or initially absent binding races are controlled 409 conflicts. Owned-PG tests exercise same-user/cross-user/concurrent rebinding and reject old tokens. |
| R2 | High | Request context cancellation did not bound blocked response socket writes. The server had no WriteTimeout. | `configuredHTTPServer` supplies bounded read/write/header/idle deadlines. Real loopback TCP tests hold an incomplete body and stop reading a large generated response, requiring the handler to receive a timeout. |
| R3 | Medium | Numeric -0 and 0 could create different native care receipt hashes, unlike the reference's JSON.stringify behavior. | Normalize numeric zero at declared request fields before hashing, preserving scalar types and decimal strings. Unit tests exercise the frozen feeding request validator and exact receipt equality/distinction. This is not an exhaustive JavaScript number/JSON compatibility claim. |
| R4 | Medium | Documentation omitted mandatory preview opt-in and incorrectly described reference BFF data as ciphertext. | README now documents startup constraints and the actual plaintext-to-encrypted one-way handoff. The real reference handoff test includes the unsupported reverse-refresh case rather than equating cached-token success with bidirectional compatibility. |
| R5 | Medium | Native CI only ran on the source branch after push; artifact names could identify synthetic merge commits rather than the advertised source. | Native and food jobs now also run on target-branch/main pushes; native jobs pin the PR head and checksum the actual source-sha file with their binary/inventory. Required-check configuration on GitHub is not changed or claimed. |
| R6 | Low | Temporary review-export workflow unnecessarily remained in the delivery diff. | Removed `go-review-snapshot.yml`; normal validation/artifact workflows remain read-only. |

Important semantic difference for R1: a successful BFF rebind intentionally retires the old credential. The unsafe reference lifecycle is not reproduced. Clients racing to rebind may receive `CONCURRENT_MODIFICATION` and should retry with current credentials. Rollback preserves the previous working binding, including its unrevoked credentials.

## Verification design

Current-commit results and canonical run links belong in the PR's validation table/comment. This file is not itself a CI receipt; it is committed before final-current-head validation so the reported head can be tested without another source update afterward.

Mandatory checks:

1. `go vet ./...`, complete `go test -race -count=1 ./...`, locked module verification and CGO-disabled build.
2. Existing owned-PG/Redis authentication, family/baby/care, companion and food suites, including real Fastify/Go HTTP and durable-state comparisons.
3. `scripts/go-session-review-integration.py` in native and `--reference` modes. It checks old-token retirement, single active binding after races, unrelated-session preservation, process restart and domain-bound decryption failures.
4. A trigger deliberately aborts the BFF UPDATE after the transaction has attempted revocation and new session/credential creation. All durable state must remain unchanged; the previous token must still work.
5. Actual reference BFF creation writes plaintext; forced expiry then Go refresh encrypts it. Ordinary Bearer validation works across implementations. Forced reverse refresh fails as explicitly documented, and Go can still recover/revoke the session.
6. Existing TypeScript backend and migration-integrity jobs must also remain green. The frozen reference, database schema/migrations and OpenAPI must have no diff from the pinned baseline.

The current conversational runtime could not execute a local container or Python process (transport timeouts). No local build, database execution or benchmark is claimed. Implementation validation uses the actual GitHub Actions steps; independent review remains a separate gate.

## Merge versus release

This increment is eligible for consideration as a disabled-by-default, loopback/test-database-only preview after current CI passes and an independent reviewer approves. It does not replace the default TS deployment. There is no `ACCEPTED` assertion or automatic main merge.

Whole-backend activation remains blocked by the 83 missing operations, Worker/Scheduler, attachment byte/S3 lifecycle, complete browser flows, full protocol/input matrix and coordinated refresh/BFF interoperability. Existing raw-item/OpenAPI drift and last-administrator/soft-deleted-parent hardening remain explicit review exceptions. A benchmark must not treat missing-operation errors or authentication failures as successful business throughput.

## Prompt for an independent local agent

```text
Review growdesk-server PR #9 as a separate reviewer. Do not assume the author's
self-review or a green summary proves acceptance.

Read AGENTS.md, START_HERE.md, docs/GO_BACKEND.md and this REVIEW.md. Obtain the
current PR head/base from GitHub, create a fresh isolated worktree at that exact
head, and preserve all existing user work. Do not reset branches, merge, deploy,
read production secrets, use existing databases/Redis, call paid AI, or send push.

Scope: the 68-operation native preview, not approval of the whole Go rewrite.
Check that the default deployment/reference/apps/packages/prisma/OpenAPI remain
unchanged from f0f046f9f01ee34b1ed3f59ed993e4acb5d5bdf4. Verify production startup
is refused and direct constructor use cannot bypass the preview DB boundary.

Using the pinned Go toolchain and locked dependencies, run go vet, full race tests
and CGO_ENABLED=0 build. Run all native and --reference commands documented in
docs/GO_BACKEND.md against exclusively owned disposable test_ PG18/Redis8
containers. Do not bypass safety guards, remove assertions or replace database
transactions with mocks. No benchmark is required for correctness acceptance.

Focus independently on BFF lock ordering, initially absent/cross-user bind races,
old-token revocation, password-reset interleavings, failure rollback, encrypted
payload AAD/key isolation, request/response timeout behavior, numeric signed-zero
idempotency and string/null preservation. Review current family/baby permissions,
read snapshots and the last-effective-administrator security differences.

Confirm the BFF handoff is only TS-to-Go. Do not approve bidirectional refresh,
S3/browser/Worker parity, or the 83 missing operations. Distinguish raw food-item
HTTP parity from the known frozen OpenAPI envelope mismatch.

Record exact SHA/tool versions/commands/results, findings with file and line,
and any unexecuted checks. If scoped checks pass with no blocking findings, issue
an independent scoped review; otherwise return CHANGES_REQUESTED. Never mark
the full Go migration or production release accepted on this evidence alone.
```
