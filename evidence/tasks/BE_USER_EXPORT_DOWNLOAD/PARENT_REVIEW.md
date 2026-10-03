# Parent review of account export download

Status: IMPLEMENTED_NOT_REVIEWED; bounded source/evidence review, not deployment or full iOS acceptance.

Verified all 15 final source hashes and final HTTP JSON SHA-256 05bacd257f5043affb84ac9b5b37a93a948a941db6f6728962f2d1b625c25c81. Independently reran go test ./... successfully. Read worker export scope capture, user -> sorted family -> task lease transaction, current family/baby grants and permission epoch validation, immutable payload/file digest checks, owner/type/status/expiry download and safe task status, and scheduler payload purge. No blocking defect found in this reviewed scope. Private HTTP evidence records 58 assertions and every cleanup true.

Limits: normal-size payloads only; >12 MiB actual HTTP limit exercise and iOS download/share are still open. The fileSha256 guard rejects older completed task results that lack this metadata, even though baby/highWater metadata can be derived; those exports need a fresh request. Real provider/object attachment export is not included. Existing WT base is 263d010; combination with later food/clinical/weather commits requires normal contract regeneration and tests on final combined sources.
