# DeviceSyncBinding and initial import

Status: **IMPLEMENTED_NOT_REVIEWED**

The implementation is based on fixed delivery `ff967e876616f0a03367c1c5f1d639b211fd7d54`. It adds ten contract operations for binding enrollment/list/read, import plan/read/chunk, activation, pause, resume, and revoke. The server derives the owner from the validated bearer principal, checks active family membership and writer role, assigns the binding state and generation, and stores a unique binding for each principal/installation/local-vault/family tuple. `installationId` and request headers remain client-provided identifiers; they do not attest a physical device.

`executeSyncCommands` now requires the binding ID and generation. Admission is checked against the authenticated principal, then each command transaction locks the active binding while checking generation, family, and baby scope. The same transaction applies the record mutation and records the binding/generation with its receipt, so a concurrent revoke either linearizes after a committed command or rejects it as stale. Pause, resume, and revoke advance generation; action receipts bind idempotency keys to request hashes. Resume requires renewed consent.

Initial import persists a pending manifest and ordered chunk descriptors before data is accepted. Empty imports still require a plan and an explicit activation request. Non-empty chunks are create-only for feeding, sleep, diaper, food log, supplement record, and growth measurement. The server validates each baby against the binding family and applies the records with the chunk checkpoint in one transaction. Existing IDs conflict without mutation; attachment-bearing records are rejected. A replay with the same chunk ID and request bytes returns the stored receipt; changed bytes conflict. Activation requires every declared chunk to be applied. Lost activation responses can be read back from the binding/plan. This proves durable, scoped receipt of the client-declared manifest, not completeness or authenticity of the local source dataset; attachment migration is not implemented.

## Verification

The canonical build sequence completed on the isolated worktree:

- `npm run backend:db:generate` — passed.
- `npm run backend:build` — passed.
- `npm run backend:contracts:generate` — generated 125 paths and 174 operations.
- `npm run backend:contracts:check` — passed with 125 paths and 174 operations.
- `npm run backend:db:validate` — passed with 28 migrations.
- `npm run backend:typecheck` — passed.
- `npm run backend:test:unit` — 157 passed, 0 failed, 0 skipped.
- `go test ./...` — passed.
- `python3 scripts/go-device-sync-binding-integration.py` — 73 real-HTTP assertions passed on an owned, isolated stack.

The real-HTTP run is recorded in `http-result-20261003T150920Z-03e5d830.json`. It used three newly registered `test_` principals and `test_` family/baby names, loopback PostgreSQL/Redis/MinIO/API services, and a non-superuser test database role. Business writes used HTTP; SQL was used only for read assertions. No worker, external AI provider, push credential, production account, or shared stack was used. API and supporting services stopped, the private temporary directory was removed, and the isolated database disappeared with its private PostgreSQL cluster.

The HTTP run includes concurrent enrollment and sync/revoke cases, principal and family denial, empty-plan activation and dropped-response readback, two imported chunks across all six supported record kinds, replay/conflict/no-overwrite behavior, attachment rejection, and family-scoped measured-food validation (`32.5` grams succeeds for a profiled family food; grams without a family profile are rejected without a row write). An earlier run with the same cleanup guarantees exposed a test expectation mismatch (`FST_ERR_VALIDATION` versus the actual `BAD_REQUEST`); that unique failure artifact is preserved and the test now asserts the actual Go response.

Source hashes for the tested files, canonical OpenAPI digest, evidence digest, and aggregate source-manifest digest are in `source-digests-ff967e8.json`. The passing HTTP artifact also includes its per-file source hashes and API binary hash.

## Admission coverage still required

The new generation admission protects `executeSyncCommands` and the dedicated binding/import operations. Existing generic-bearer REST mutation routes remain unchanged: feeding, sleep, diaper, food, and supplement POST/PATCH/DELETE; growth measurement POST/PATCH/DELETE; medical report POST/PATCH/DELETE; vaccine record POST/PATCH/DELETE; and vaccine selection PUT. Existing `getFamilyChanges`, `getUserChanges`, `createFamilySnapshot`, `getFamilySnapshot`, and `getFamilySnapshotPage` are also not binding-generation-gated. There is no user-scoped snapshot route. Therefore binding revocation does not stop an old client that still has the generic `baby-panel-api` bearer from bypassing the binding through ordinary REST. Keep native offline opt-in and outbox dispatch disabled; do not fall back to ordinary REST.

For full remote-revocation semantics, keep Web on its current API audience and use a server-issued, short-lived device-sync purpose/audience for native sync admission. Derive subject, session, binding ID, and generation on the server; never use a client `userId`, `familyId`, `babyId`, or client-kind header as authorization. Require the device-sync audience on sync-specific mutation/feed/snapshot routes and recheck active binding generation plus family membership under a transaction lock. To prevent an old generic API bearer from bypassing those routes, the native app also needs a distinct trusted audience or must dispatch offline mutations only through the sync-specific routes; a purpose token by itself cannot revoke access to existing generic REST routes if those routes continue accepting the same bearer.

Root's separate iOS auth-fence draft is still under review and is not integrated by this server task. No commit or runtime upgrade was made.
