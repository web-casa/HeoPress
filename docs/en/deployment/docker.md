---
version: 2
lastUpdated: 2026-10-10T05:00:15.277Z
sourceLang: en
contentHash: 6552429e41352200
codeVerified: 2026-10-13T19:22:02.312Z
codeVerifiedHash: 6552429e41352200
codeVerifiedClaims: 9
---

# Docker Deployment

Docker mode runs the same CMS API in Node.js and uses self-hosted infrastructure for stateful services.

## Services

`docker/docker-compose.yml` is a complete minimal deployment — nothing else
is required:

| Service | What it runs |
|---------|--------------|
| `postgres` | PostgreSQL 18 with pgvector and zhparser ([database image](database-image.md)), built from `docker/postgres/` |
| `cms` | HTTP API and the Studio (`HEOPRESS_PROCESS_ROLE=web`); applies migrations and creates the database roles on start, as the owner, then serves as the application role ([database roles](#database-roles)) |
| `cms-worker` | Queue workers and scheduled jobs (`HEOPRESS_PROCESS_ROLE=worker`), started once `cms` is healthy; connects as the application role |

Cache, queue, scheduled jobs, rate limits, full-text search and vectors all run
in PostgreSQL; media goes to the `storage` volume and image transforms run in
process. There is no Redis, MinIO, MeiliSearch or imgproxy to operate.

Optional services sit behind profiles:

| Profile | Service | Switch it on with |
|---------|---------|-------------------|
| `s3` | SeaweedFS (S3-compatible storage; creates `S3_BUCKET` and accepts only `S3_ACCESS_KEY` / `S3_SECRET_KEY`, for that bucket only; refuses to start without them) | `HEOPRESS_STORAGE=s3`, `S3_ENDPOINT=http://seaweedfs:8333`, `S3_BUCKET`, keys, `S3_FORCE_PATH_STYLE=true`, and `http://seaweedfs:8333` in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` |
| `meilisearch` | MeiliSearch | `MEILISEARCH_HOST=http://meilisearch:7700`, `MEILISEARCH_API_KEY`, and the origin in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` |

Overrides: `docker-compose.prod.yml` (published image, production settings,
no host port for the database), `docker-compose.build.yml` (build the
production image from the checkout), `docker-compose.dev.yml` (hot reload),
`docker-compose.tls.yml` (Caddy), `docker-compose.domains.yml` (Caddy with
on-demand certificates for site domains, see [custom domains](./custom-domains.md))
and `docker-compose.monitoring.yml`.

## Quick start (minimal deployment)

```bash
cp docker/.env.example docker/.env      # adjust; the defaults run as is locally
docker compose -f docker/docker-compose.yml up -d --build
curl -fsS http://localhost:1989/health/ready
```

`/health/ready` reports the database, migrations and capabilities (for
example a missing `vector` extension when `HEOPRESS_VECTOR_SEARCH=true`).
Then open `http://localhost:1989/setup` to create the first administrator.

## Configure for production

Start from the example environment file:

```bash
cp docker/.env.example docker/.env
```

Set production values for the database, JWT secret, encryption key, CORS
origins and, if used, object storage and MeiliSearch before starting the stack.
Every variable in `docker/.env` reaches the CMS containers.

> **If you run the production override against the bundled database, set `DATABASE_SSL_MODE=disable`.**
> The production override defaults it to `require`
> (`DATABASE_SSL_MODE: ${DATABASE_SSL_MODE:-require}` in
> `docker/docker-compose.prod.yml`), which is correct for a managed database but
> cannot connect to the PostgreSQL container in the base compose file — that one
> serves no TLS, so the CMS fails at startup with a connection error rather than
> a configuration one. Leave the default as `require` for real deployments.

## Database roles

The servers never connect as the owner of the tables (security review S-5). Three roles:

| Role | Used by | Connection |
|------|---------|------------|
| owner (`heopress`, the database image's superuser) | the `cms` entrypoint only: migrations, then creating or updating the two roles below; `heopress upgrade`, `heopress backup` / restore on the host | `DATABASE_OWNER_URL` |
| `heopress_app` — no superuser, no `BYPASSRLS`, owns none of the application tables, member of no role | the `cms` and `cms-worker` servers | `DATABASE_URL`; its password is `HEOPRESS_APP_PASSWORD` |
| `heopress_render` — reads the public projection only | `site-classic` | `HEOPRESS_RENDER_DATABASE_URL` |

The `cms` entrypoint runs `node dist/app-role.mjs` as the owner on every start (idempotent; `HEOPRESS_SKIP_APP_ROLE=true`
when the role is provisioned elsewhere), unsets `DATABASE_OWNER_URL` and both role passwords, then checks the
server's own connection (`node dist/app-role.mjs --check`): row-level security must apply to it — by the catalogue
and by a live probe on a temporary table with forced RLS. With `HEOPRESS_REQUIRE_APP_ROLE=true` (the
[installer](../../zh-CN/operations/install.md) sets it) a connection that bypasses RLS stops startup; otherwise it is
logged as a warning. The worker gets no owner connection at all and drops one `docker/.env` might give it.

This check proves only that the runtime role cannot bypass row-level security, not that the tables have policies: the
RLS policies are not part of the default migrations (`packages/database/migrations/rls-policies.sql` is applied by
hand; see `docs/known-issues.md`). Without them the tables have no policies and site isolation rests on the
application's own site conditions. The log line `row-level security applies` reports the role check and the probe,
not deployed policies.

What the application role is granted (`packages/database/src/app-role.ts`): `SELECT, INSERT, UPDATE, DELETE,
REFERENCES` on the tables and `USAGE, SELECT, UPDATE` on the sequences of `public` and `pgboss` (also for tables later
migrations create, through the owner's default privileges), `EXECUTE` on their functions, `USAGE, CREATE` on both
schemas (it creates its own vector-space and materialized tables), read-only access to the migration history; never
`TRUNCATE` or `TRIGGER` on the owner's tables, and no writes to the deleted-site-id hold or the maintenance switch
(only `heopress upgrade` sets it, as the owner). Extensions and the queue schema are installed by the migrations.
LISTEN/NOTIFY and advisory locks need no grant.

**A deployment from before this change** has `DATABASE_URL` set to the owner and no `DATABASE_OWNER_URL`: it keeps
starting, as the owner, with a warning in the `cms` log. To switch it:

1. In the env file, set `DATABASE_OWNER_URL` to the current `DATABASE_URL`, set `HEOPRESS_APP_PASSWORD` to a new
   random value (`openssl rand -hex 24`), set `DATABASE_URL` to
   `postgresql://heopress_app:<that password>@postgres:5432/heopress`, and `HEOPRESS_REQUIRE_APP_ROLE=true`.
2. `docker compose … up -d cms cms-worker` (the same files as always). The `cms` entrypoint creates the role and
   hands it the tables the runtime created as the owner (vector spaces, materialized tables:
   `[app-role] heopress_app now owns …`), then logs `heopress_app: row-level security applies`.

Backups and restores run on the host with the owner (or a replication role) as `HEOPRESS_BACKUP_DATABASE_URL`, not
in the containers (see the zh-CN [backup and restore](../../zh-CN/operations/backup-restore.md) guide). A restored
database gets the application role's grants back the next time `cms` starts.

## Start production

Pin the CMS image with `HEOPRESS_VERSION` so production runs a predictable
release. If unset, `docker/docker-compose.prod.yml` falls back to `latest`.

```bash
HEOPRESS_VERSION=0.4.3 docker compose -f docker/docker-compose.yml -f docker/docker-compose.prod.yml up -d
```

Verify the API:

```bash
curl -fsS http://localhost:1989/health/ready
```

## Build locally instead of pulling the published image

Keep local builds in a separate override so production uses the published image
by default. Add `docker/docker-compose.build.yml` after the production override:

```bash
docker compose \
  -f docker/docker-compose.yml \
  -f docker/docker-compose.prod.yml \
  -f docker/docker-compose.build.yml \
  up -d --build
```

## Note: `SERVICE_UNAVAILABLE` when the instance is under pressure

If a client receives HTTP `503` with a body similar to:

```json
{
  "errors": [
    {
      "code": "SERVICE_UNAVAILABLE",
      "message": "HeoPress API is temporarily unavailable because this instance is under pressure. Retry later.",
      "details": { "reason": "event_loop_delay" }
    }
  ]
}
```

it does not necessarily mean the CMS service is dead. In Docker mode, `HEOPRESS_PRESSURE_LIMITER_ENABLED=true` lets the CMS protect itself when the Node.js event loop is saturated. The guard returns `503` with `Retry-After` so clients and upstream proxies can retry in a controlled way instead of adding more work to an overloaded process.

Common causes include bursty API traffic, undersized CPU/RAM, heavy export or analytics endpoints, queries that fetch too much data before filtering or JSON processing in JavaScript, slow database queries (cache and queue live in PostgreSQL), or Docker networking misconfiguration such as using `localhost` instead of the Compose service name for PostgreSQL.

Quick checks:

```bash
docker stats
docker compose logs --since=10m cms
curl -i http://localhost:1989/health
curl -s http://localhost:1989/metrics | grep -E 'nodejs_eventloop|process_cpu|lumibase_http_request_duration'
```

Temporary tuning while investigating:

```env
HEOPRESS_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY=1500
HEOPRESS_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION=false
HEOPRESS_PRESSURE_LIMITER_RETRY_AFTER=5
```

Disable the guard only briefly when another layer already provides overload protection:

```env
HEOPRESS_PRESSURE_LIMITER_ENABLED=false
```

The long-term fix is to identify the endpoint causing spikes, optimize query/index/pagination/export streaming, or add CMS replicas/CPU.

## Request size & rate limits

The Caddy reverse proxy caps request bodies before they reach the CMS
(`docker/Caddyfile`): 10 MB for the general API and 50 MB for media/asset
upload routes (`/api/v1/media*`, `/api/v1/files*`). Keep the media cap in
sync with `FILE_UPLOAD_MAX_BYTES` and `FILE_UPLOAD_VIDEO_MAX_BYTES` (50 MB by
default: MP4 and WebM videos in articles) if you change any of them. Tune the general cap
for your workload — most JSON APIs never need more than a few MB.

As defense-in-depth for deployments that don't front the CMS with Caddy
(a bare Node process, or a different proxy), the app also rejects oversized
JSON bodies itself:

```env
# Max JSON request body in bytes for the app-level guard (default 1 MiB).
# Returns 413 { errors: [{ code: "PAYLOAD_TOO_LARGE" }] } when exceeded.
HEOPRESS_MAX_JSON_BODY=1048576
```

## Caching & write-amplification knobs

```env
# Delivery API shared-cache lifetime, seconds (default 60). 0 disables
# public caching (responses become private, no-store).
HEOPRESS_DELIVER_SMAXAGE=60
# Delivery API stale-while-revalidate window, seconds (default 300).
HEOPRESS_DELIVER_SWR=300
# Negative-cache (tombstone) TTL in seconds before ±20% jitter (default 30).
# 0 disables tombstones. See docs/en/features/caching.md.
HEOPRESS_NEGATIVE_CACHE_TTL=30
# Delivery API IP rate limit, requests per minute (default 1200). 0 = off.
HEOPRESS_DELIVER_RATE_LIMIT=1200
# Debounce window (seconds) for API-key lastUsedAt writes (default 60).
# Under read load, an API key's last-used timestamp is refreshed at most
# once per window instead of on every request. 0 = write on every request.
HEOPRESS_APIKEY_TOUCH_INTERVAL=60
```

## Roll back

To roll back the CMS container to a previous release:

1. Change `HEOPRESS_VERSION` back to the previous version.
2. Pull the pinned CMS image.
3. Recreate only the CMS service.

```bash
docker compose pull cms cms-worker
docker compose up -d cms cms-worker
```

Docker mode is useful for local production rehearsals and self-hosted installations. Cloudflare Workers remains the default edge deployment path.

## Updating

Before upgrading to any release whose changelog `Migrations` section lists database changes, create and verify a PostgreSQL backup or storage snapshot. Keep the snapshot until the new CMS version is healthy and the migration version matches the expected release notes.

Run a read-only preflight against the new image before replacing the running CMS container:

```bash
docker compose -f docker/docker-compose.prod.yml --env-file docker/.env run --rm -e MIGRATION_MODE=preflight cms
```

The preflight checks `DATABASE_URL` connectivity, prints the current Drizzle schema version, and lists pending migrations without applying DDL. Normal container startup runs this preflight before applying migrations unless `RUN_MIGRATION_PREFLIGHT=false` is set.
