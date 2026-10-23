# Passport device-support test evidence

Date: 2026-10-03 UTC. Scope: evidence for the existing Passport implementation under test. No source or test code was changed for this evidence task, and the passed tests were not rerun.

One earlier disposable PostgreSQL startup probe failed before migrations or tests ran. Its recovered output is preserved in [the pretest probe log](../../../build/review/passport-device-20261002/passport-postgres-start-probe.failed.stdout.log). That temporary directory was automatically removed. A later startup check succeeded, followed by the integration run below.

## Isolated PostgreSQL run

The existing .github/workflows/passport-review.yml gate was reproduced with local PostgreSQL 18.6 (Homebrew); Docker was unavailable. A fresh temporary PostgreSQL cluster was initialized for this run, with TCP bound only to 127.0.0.1 on random nondefault port 64241. The randomly named database and login role were both test_passport_aeea6aab; the role was non-superuser and owned the database. The runner scrubbed inherited database/provider settings, applied every tracked Prisma migration and native/migrations/0003_passport.sql, set PASSPORT_REQUIRE_INTEGRATION=1, and supplied only this disposable loopback database through TEST_PASSPORT_DATABASE_URL. No Redis or provider was required or used.

The guard SQL was:

    SELECT current_database()||'|'||current_user||'|'||rolsuper::text||'|'||pg_get_userbyid(datdba)
    FROM pg_database JOIN pg_roles ON rolname=current_user
    WHERE datname=current_database();

The runner compared the query result against the expected test database, test role, non-superuser flag, and matching database owner, then printed the captured PASS owned DB guard preflight line in [the integration stdout](../../../build/review/passport-device-20261002/passport-confirmation-revocation.stdout.log). The raw tuple itself was held in the runner and was not printed or separately persisted; it is not reconstructed here.

Command argv:

    go test -race -count=3 -v ./internal/backend -run '^TestPassportConfirmationRevocationIntegration$'

Environment for that command: PASSPORT_REQUIRE_INTEGRATION=1, GOFLAGS=-mod=readonly, and a generated, temporary TEST_PASSPORT_DATABASE_URL using the loopback host, nondefault port, and test_ database/role. The credential is not included in evidence.

The test passed six PostgreSQL-backed scenarios three times each (18 scenario executions total) with the race detector enabled: revoked device denial, expired principal denial, stale family-scope denial, revocation while confirmation waits on the family lock, baby-membership revocation while waiting, and confirmation holding authorization through commit. The final fixture counts were 0|0|0|0 for test users, families, babies, and devices. The runner stopped PostgreSQL and removed its temporary cluster.

The stdout file was recovered verbatim from this session's successful tool result. The SQL guard tuple was not emitted separately; only the runner's guard success line is preserved.

## Focused wire and projection units

The following separately executed command passed with the race detector:

    go test -race -count=1 -v ./internal/backend -run '^TestPassport(CardPresentEventEchoesTurnID|ProposalProjectionRejectsMultipleActions|CardProjection|ConfirmedActionID)$'

It covered TestPassportCardProjection, TestPassportProposalProjectionRejectsMultipleActions, TestPassportCardPresentEventEchoesTurnID, and TestPassportConfirmedActionID. Its recovered stdout is in [the wire-unit log](../../../build/review/passport-device-20261002/passport-wire-units.stdout.log).

## Not covered

- No WebSocket connection or hello/ready handshake; the database integration invokes the confirmation service directly with a synthetic PassportPrincipal.
- No Passport token exchange or authenticated WebSocket principal construction.
- No confirmation replay/idempotency assertion against PostgreSQL; the integration verifies a single successful record commit and authorization lock ordering.
- No provider fixture or real ASR/AI/TTS call. Provider behavior and audio recognition/output remain untested.
- No physical device, firmware, serial, display, button, microphone, speaker, or battery test.
- The integration checks stale family and revoked baby membership denial, but does not exercise a complete cross-family/multi-baby WebSocket authorization flow.
