# Combined Food, Export, and typed OCR verification

Status: `IMPLEMENTED_NOT_REVIEWED`. No deployment or Apple client acceptance is implied.

Source revision: `5457111c5a4991a19888f1c084f01ca358961e95`. Normal Prisma generation, backend build, contract generation/check, backend typecheck, complete Go tests, Node backend unit suite, and schema validation exited 0. Schema validation used a dummy loopback database URL and did not connect. Generated contract inventory is 129 paths and 178 operations; it was obtained from the normal generated contract rather than a manually edited expected count.

The combined-source typed medical/growth OCR driver passed 81 real HTTP assertions and four bounded worker runs using a disposable test PostgreSQL/Redis/MinIO environment and a loopback virtual recognition provider. It exercised cross-principal and baby scope, ready attachment purpose/MIME, durable cancellation races, human edited confirmation, atomic rollback, exact idempotency replay, and two-member medical/growth change feed readback. No report or growth measurement existed before explicit confirmation. All 25 recorded source hashes independently matched after the run. The driver stopped its owned processes and removed its private database/object data. This establishes protocol/transaction evidence with fixture recognition, not OCR recognition quality.

Clinical result: `../../BE_MEDICAL_GROWTH_OCR_TYPED_DRAFTS/live-b1d78933dd94.json`, SHA-256 `67e3d959f6306d46ff3756d978e5e75bda9a38941696bd47d3bb9f6b8cc876b0`.

The combined-source export driver passed 58 real HTTP assertions, five bounded export worker runs, and one scheduler run. All three new test principals and clearly named test families/babies were created through the actual Go HTTP API. Verification included queued/succeeded/failed status, exact JSON download bytes and Content-Type/Content-Disposition/Content-Length/X-Content-SHA256, same-key replay, conflicting body rejection, owner/foreign and per-baby grants, removal of baby/family membership after queueing, and TTL refusal followed by physical payload cleanup. All 15 source hashes independently matched after the run. API/Redis/PostgreSQL processes, private build directory, and owned temp data were removed. No real provider, production service, old Web SQLite, or push credentials were used.

Export result: `export-live.json`, SHA-256 `159f5061409c10852e9c97d94a62dd2f350a7edfbf0ec0766c5b01c2d68eff24`.

The 12 MiB production export cap was not filled to its boundary by this run. App export download/share and typed OCR review/confirmation still require client integration and UI testing. Earlier evidence remains retained and is not substituted for these combined-source results.
