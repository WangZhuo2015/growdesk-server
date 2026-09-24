# Owned object storage verification — IMPLEMENTED_NOT_REVIEWED

2026-09-19: `MINIO_BIN=/tmp/growdesk-minio-tools-20260919 python3 scripts/test-integration.py --s3 --web-root /Users/wangzhuo/Documents/GitHub/baby_panel_for_cecilia --web-ui` exited 0. Log: `/tmp/growdesk-owned-s3-ui-round15.log`.

The runner owns new loopback PostgreSQL 18, Redis 8 and MinIO children, temporary data directories and a run-token bucket. It scrubs inherited storage credentials and refuses an unowned endpoint/identity. All subprocess errors propagate; cleanup removes its processes and private data. Test identities use test_/e2e_ prefixes. No production database, existing object store or port 3088 was used.

`tests/integration/owned-object-storage.test.ts` uses an actual Fastify TCP listener and AWS SDK, a valid 1x1 PNG and two independent synthetic families. Verified signed PUT, exact object bytes, SHA/size mismatch rejection, anonymous raw object denial, authenticated streaming reads, cross-family complete/read/delete denial, removal of the reusable signed-GET API, and physical/idempotent deletion. Private reads have no-store/nosniff headers.

MinIO was compiled solely for local verification using Go modules, with checksum verification enabled. Source: `github.com/minio/minio@RELEASE.2025-09-07T16-13-09Z`, resolved `v0.0.0-20250907161309-07c3a429bfed`, module sum `h1:deu0m9BiyqnMbGWfJi1PpVyotSXlDnTmRIme1cUXnxo=`. Binary SHA-256: `1b9fd7ab4ba8713ceff154e891908af01cc19d9fc2e930f7f7ae2d0e8a7a8dcb`. This binary is not a production deployment artifact.

This checkpoint does not prove browser image uploads: its UI backend still used MockStorageDriver. It also does not cover signed PUT expiration/renewal, invalid image decoding, or injected storage failure/retry. Follow-up changes and runs must record their own evidence. The current production cutover gate remains open because historical business import and strict JSON parity are incomplete.
