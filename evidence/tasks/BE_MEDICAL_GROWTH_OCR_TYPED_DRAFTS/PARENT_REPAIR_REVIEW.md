# Parent repair review

Status: IMPLEMENTED_NOT_REVIEWED. This is a bounded parent review of the previous change-feed/cancellation/hash findings, not full product acceptance.

The previous missing family_changes finding is repaired. The medical confirmation holds the family lock, verifies baby membership inside the transaction, commits report and optional growth rows and their timeline projections, and publishes upsert changes at consecutive allocated cursors. Report update/delete publish changes too. Same-key replay returns before publishing a new event. The shared writer is also used by the existing record mutation path.

The final actual HTTP run live-0ebb8a84f51b.json records 81 assertions. Two authenticated test members receive the report/growth events; injected failure while advancing the cursor rolls back rows, receipts and feed. The held loopback provider response is released after a real HTTP cancellation; task/run/result/record state stays fenced. A cancellation after success preserves the result. Its task-owned PG/Redis/MinIO and database/object data were removed.

The parent independently verified all 25 frozen source digests against the files, inspected the new feed/cancellation test code, and reran complete go test ./... successfully. HTTP result SHA256: ed981fb3f59e3a6d03fcbeeefb23211e25ad7c1724928d67a9e944bfbd46bfd0. Source manifest SHA256: c247202dbf175e109ca358205928e4fb492287cd9953fd13f3438e35b2fb7e60. Earlier failed evidence is retained.

Limits: loopback provider fixtures do not establish OCR accuracy; the independent Docker medical runner could not start on this host. This worktree predates food/export delivery, so the combined source must be regenerated, built and run against new private infrastructure before SDK pinning. No production deployment or physical-device acceptance is claimed.
