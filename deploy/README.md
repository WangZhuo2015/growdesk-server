# GrowDesk single host container deployment

This Compose project is the first cloud runtime boundary for `growdesk-server`. It builds and runs the API only. Worker and scheduler services are intentionally absent until their business entry points and durable job contracts exist; this stack must not keep an idle worker or scheduler alive.

The Compose project name is `growdesk`. The API is published only on `127.0.0.1:3180` on the host and listens on port `3080` inside its container. An existing host reverse proxy may forward its configured HTTPS server to `http://127.0.0.1:3180`; this file does not assume a domain, certificate path, nginx directory, sing-box route, or public API port. PostgreSQL and Redis have no host port publication.

Use Docker Engine with Docker Compose v2.23.1 or newer. The version requirement is for the inline Compose config used to bootstrap the PostgreSQL application role. Run `docker compose ... config --quiet` before any start so missing external environment values and rendered boundaries fail during review.

## Fixed images and build contract

The default image references are patch-level tags pinned to recorded registry digests:

| Component | Default image | Purpose |
| --- | --- | --- |
| API build/runtime | `node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c` | Node 24 multi-stage build; final stage runs as the built-in non-root `node` user |
| PostgreSQL | `postgres:18.6-bookworm@sha256:1c59e2c3c818eaa0f0628f695b36e7c9e362d6b219b36a54a32df645cbd7e1af` | PG18 data directory is mounted at `/var/lib/postgresql` |
| Redis | `redis:8.10.1-alpine@sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576` | Redis 8 AOF queue runtime with `noeviction` |

`GROWDESK_POSTGRES_IMAGE` and `GROWDESK_REDIS_IMAGE` can override the two default references with another deployment-recorded immutable reference such as `registry.example/postgres@sha256:<digest>`. The release procedure should record the resolved digests, the Git SHA, the lockfile hash, and a sanitized Compose configuration before starting the stack. Do not use `latest` or an unrecorded floating tag.

The API image is built from the checkout. Set `GROWDESK_IMAGE_TAG` to the exact Git SHA (or another immutable release identifier) when building; its default `local` value is intended only for local review. `GROWDESK_NODE_IMAGE` optionally supplies a resolved Node image reference, including a digest. The Dockerfile also accepts the equivalent `NODE_IMAGE` build argument and records `BUILD_REVISION` in both the OCI revision label and runtime environment.

## Required environment

Provide these values from the host environment or an untracked, permission-restricted deployment environment file. Compose fails before creating containers when a required value is missing.

| Variable | Required | Used by |
| --- | --- | --- |
| `POSTGRES_SUPERUSER_PASSWORD` | yes | PostgreSQL bootstrap superuser `postgres`; never passed to the API |
| `GROWDESK_DB_PASSWORD` | yes | The non-superuser `growdesk` application role and API `DATABASE_URL` |
| `REDIS_PASSWORD` | yes | Redis `requirepass` and API `REDIS_URL` |
| `GROWDESK_IMAGE_TAG` | release | API image tag; use the exact Git SHA |
| `GROWDESK_HOST_PORT` | optional | Host API port; defaults to `3180` and remains bound to loopback |
| `GROWDESK_POSTGRES_IMAGE` | optional | PG18 tag or recorded digest |
| `GROWDESK_REDIS_IMAGE` | optional | Redis8 tag or recorded digest |
| `GROWDESK_NODE_IMAGE` | optional | Node24 tag or recorded digest used as the build/runtime base |

Use generated URL-safe passwords containing only letters, digits, `.`, `_`, and `-`; the deployment wrapper should reject shorter values. The URL form is intentionally assembled in Compose as:

```text
DATABASE_URL=postgresql://growdesk:${GROWDESK_DB_PASSWORD}@postgres:5432/growdesk
REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379/0
```

Do not commit a `.env` file or put real credentials in this README, the image, a Dockerfile `ARG`, or a GitHub artifact. The Compose file passes the app password to the PostgreSQL first-cluster bootstrap only so it can create the separate `growdesk` role; it does not make that role a superuser, database owner, role creator, database creator, replication role, or RLS bypass role. The app role receives database `CONNECT` and `public` schema `USAGE` only. Future migrations need a separately controlled migration role and must not run as `postgres` from the API container.

## First-cluster initialization

The inline `growdesk-postgres-init` Compose config is executed by the official PostgreSQL entrypoint only when the named volume is empty. It creates or updates the login role `growdesk`, revokes public database/schema access, and grants the app role the minimum bootstrap access. Existing data volumes are never reinitialized by changing environment variables. Password rotation therefore requires an explicitly reviewed SQL operation against the current cluster and an aligned API restart; changing `GROWDESK_DB_PASSWORD` alone cannot change an already-created role.

The two named volumes are independent:

- `growdesk-postgres-data` → `/var/lib/postgresql`
- `growdesk-redis-data` → `/data`

The API shares two internal networks with the dependencies: `growdesk-db` contains API and PostgreSQL, and `growdesk-redis` contains API and Redis. Neither dependency is attached to a host-published network.

## Health and start order

The dependency checks use `pg_isready` and an authenticated Redis `PING`. The API healthcheck calls `/health/ready`, which the API must implement as the core readiness contract: return success only when PostgreSQL and Redis checks pass, return an unavailable status when either dependency is unavailable, and state that business routes are not implemented yet. `/health/live` remains the process liveness endpoint and does not prove dependency readiness.

Both health routes are now implemented and tested against an isolated PostgreSQL/Redis instance. This is foundation readiness only: authentication, business schema and sync routes do not exist yet. The existing singbox nginx should expose only the accepted health routes after dependency readiness succeeds.

## Review and release sequence

Run these checks from the repository root with the deployment environment loaded; they do not start containers:

```sh
docker compose -f deploy/compose.yaml config --quiet
docker compose -f deploy/compose.yaml images
```

For a release, the wrapper should set `GROWDESK_IMAGE_TAG` to the checked-out Git SHA, build the API image, resolve and record the PG/Redis image digests, and then use a sanitized configuration as the review artifact (the full render contains passwords). A normal start is:

```sh
docker compose -f deploy/compose.yaml build api
docker compose -f deploy/compose.yaml up -d --wait --wait-timeout 180 postgres redis api
docker compose -f deploy/compose.yaml ps
```

The repository release packager at `scripts/package-cloud-release.mjs` creates a clean-checkout archive and SHA-256 manifest. It does not read or package credentials. If the existing nginx instance is used, resolve every placeholder in `deploy/nginx/growdesk.conf.template` from live host inspection and validate the resulting include before reloading nginx; the template does not authorize replacing the existing nginx configuration.

Do not run `down -v` against this project as routine cleanup: it deletes the named PostgreSQL and Redis volumes. Stopping or replacing the API container preserves both data volumes. The release wrapper must also verify that no other Compose project owns the `growdesk-*` networks or volumes before its first start.

The stack intentionally does not run migrations, seed data, workers, schedulers, or business test fixtures. Migration and application readiness are separate gates, and the current API skeleton has no business API to accept production traffic.

Target-host steps and rollback boundaries: [中文部署手册](HOST_RUNBOOK.zh-CN.md).

API also joins a dedicated normal bridge (`growdesk-ingress`) so Docker can publish its loopback port. PostgreSQL and Redis remain exclusively on their respective internal networks. An API attached only to internal networks had healthy container probes but no published host listener on Docker 29.
