# 8443 preview API exposure

Status: DEPLOYED_PREVIEW_VALIDATED (listed business flows only; not full feature acceptance)

## Root cause and deployed change

- `ampere.zwang.fun:8443` pointed at the old foundation container on loopback 3180, whose own login route also returned 404.
- A separate preview API already existed on 3181 with isolated preview PostgreSQL/Redis/MinIO. It had all 14 migrations. Its clean checkout was fast-forwarded from `ed8b4f5` to `d3ce9990f88a680c16a50fce61f29abac4ffc78c`, built successfully, and only `growdesk-preview-api.service` was restarted.
- The dedicated GrowDesk nginx include now forwards `/api/v1/`, `/mcp`, OAuth metadata and health routes to 3181. API paths and authorization headers remain intact, and response buffering is disabled for streaming.
- Added IPv6 8443 listener: without it, IPv6 connections received the certificate for baby.zwang.fun. TLS validation was never disabled.
- Only the private `/growdesk-preview/` bucket path is forwarded to MinIO 59000. Host including port is preserved for SigV4. The preview backend's S3 endpoint now uses `https://ampere.zwang.fun:8443`; credentials stayed on the host and were not printed or copied locally.

## Verification

- `nginx -t -c /etc/sing-box/nginx.conf` passed before each graceful reload.
- Public login with an empty JSON body changed from nginx HTML 404 to backend validation 400.
- 130 OpenAPI operations probed without credentials and with invalid/empty input: 119 reached backend routes, zero network errors or 5xx. This proves routing/authorization reachability, not successful business operations. Full results: `route-probes.json`.
- Signed HTTPS object PUT/GET returned 200 and exact test bytes; unsigned access returned 403; the unique test object was deleted.
- The nginx main configuration, baby site and ampere primary site hashes were unchanged. Original baby-panel PID 892386 and preview Web PID 430578 were unchanged. Original Web 3088, preview Web 3089 and foundation health 3180 each returned 200.

- Public HTTPS full business smoke passed 43 checks; 2 vaccine get/update checks were skipped because these operations are absent from the contract. Covered registration, login, refresh, families/babies, eight record lists, supported record CRUD, cross-account denial, and attachment init/upload/complete/download/delete. Results: `public-smoke.json`; reproducible script: `scripts/preview/public-api-smoke.mjs`.
- Cleanup removed all 4 test families and 2 test users created by this run. Database cleanup was guarded to the dedicated preview host, port, database and role; no existing family or baby was used.
- The preview database role was confirmed non-superuser without create-database/create-role privileges. Missing invite/session secrets were generated on-host and stored with restricted permissions; values were not printed.
- Successful raw HTTP responses do not establish native Swift decoding compatibility. The iOS fractional ISO8601 date decoding failure is tracked separately in the iOS `IOS_LOGIN_DATES` evidence.

## Actual unimplemented contract operations

Two `/sample/*` examples are not deployed product endpoints. Nine other declared operations are absent in the backend: PATCH `/api/v1/me`, POST `/api/v1/me/export`, POST `/api/v1/medical/ocr-runs`, three OAuth discovery endpoints, MCP token/revoke, and `/mcp`. They remain backend 404; no fake implementation or success response was added. External AI/OCR execution is not verified or enabled by this deployment.

## Backup / boundaries

Host backups are under `/home/ubuntu/growdesk/api-opening-20260916/`: original nginx include, preview dist archive, original revision and permission-restricted preview environment backup. Never commit environment backups. Rollback restores the original include (validate before graceful reload), environment and dist, then restarts only the preview API. Existing foundation containers, their imported database, production Web and configuration were left unchanged.

Local `deploy/Migration.Dockerfile` already had an uncommitted user change; it was preserved and not used for this deployment.
