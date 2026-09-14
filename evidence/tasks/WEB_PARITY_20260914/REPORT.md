# Web integration: weather repair

Status: IMPLEMENTED_NOT_REVIEWED. No deployment or production migration.

## Baseline

- Repository: WangZhuo2015/growdesk-server
- Target: codex/wip-growdesk-web-integration-20260914
- Published WIP: 20f64116ca8f5757c796040cf0173e3f5c572b40
- Feature branch: codex/growdesk-feature-parity-20260914
- The published WIP differs from the supplied offline snapshot only in the handoff distribution paragraph.

## Changes

Validate external forecast JSON before using numeric values; reject malformed parallel arrays and out-of-order hours; preserve unknown WMO codes; validate coordinates before provider access. Return 502 on provider/schema failure instead of fabricating successful data. Preserve unavailable AQI and apply European AQI bands. Request two days and select the next eight local hours across midnight.

The existing UI response shape is retained. No database, Redis, S3, production configuration, service or migration was changed.

## Executed validation

On Node 22.16.0 with installed TypeScript 5.8.3 and a transpile-only source loader, `apps/api/tests/weather-service.test.ts` passed 8/8. These tests use injected HTTP responses, not a live weather provider. The upload was checked against local Git blob hashes:

- weather-service.ts: 7e9e79a38900389a6344549eabfb264d16913461
- weather-service.test.ts: 363634a27298ce7a3ba25d1a74874c104a6886c7

`npm run backend:build` was attempted and exited 2 because repository dependencies, including @sinclair/typebox, are unavailable in this execution environment. No full-build success is claimed. Node 24 and the repository-locked TypeScript 5.9.3 remain required for authoritative CI validation. PostgreSQL/Redis/S3 and browser E2E were not run.

## Remaining gates

Independent review; Node 24 locked-dependency build and tests; Web/API integration using isolated test_ tenants; live-provider smoke only in an authorized isolated environment. Nutrition, AI jobs, MCP/OAuth, attachments and historical migration remain separate tracked work, not completed by this change.
