# Legacy data import (private host workflow)

Source: the active old service on 161.33.201.230, verified through its open file
handles, `/home/ubuntu/Github/baby_panel_for_cecilia/prod.db`.

`snapshot.py` uses SQLite's backup API with a read-only source connection. A
copied SQLite database is an immutable source snapshot, not the new server's
runtime database. It stays in `/home/ubuntu/growdesk/imports/` (private, outside
both source and Git). The source DB includes legacy security data, so it must
never be shared. `legacy.json` excludes OAuth, PAT, and push tables. Password
hashes remain sensitive. Private raw history is retained for later audited
business-model conversion; it must not be queried by public API endpoints.

Target identity model: preserve IDs and bcrypt hashes, explicit FamilyMember
and BabyMember backfill, no old login sessions or invite credentials activated.
The new API does not yet implement login/sync. Successful identity import does
not mean an old account can already sign in to the new app.

The iOS backup converter is a separate local trial path. It must not contain
user accounts, password hashes, sessions, or private chats belonging to other
users. A local backup does not establish cloud authorization or enable sync.

All test input is synthetic, uses test_ names, and runs on disposable local
PostgreSQL managed by scripts/test-integration.py. No test reads the live DB.

`attachment_promotion.py` is the read-only attachment promotion boundary. It
reads `legacy.json`, `files.json`, `manifest.json`, and optional exported
`import_rows.json`, then writes a new 0600 JSON receipt containing deterministic
Attachment IDs/object keys and explicit quarantine entries for missing files,
ownership conflicts, path traversal, size/hash/MIME mismatches, and orphan
files. It never writes PostgreSQL or S3/MinIO and its `storage` fields remain
`not_written`; a later worker must copy and verify the object before inserting
an Attachment row and transitioning it to `ready`.
