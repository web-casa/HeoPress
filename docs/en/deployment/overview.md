---
version: 2
lastUpdated: 2026-09-07T03:34:14.317Z
sourceLang: en
contentHash: 1767648d90471727
codeVerified: 2026-09-07T03:34:14.317Z
codeVerifiedHash: 1767648d90471727
codeVerifiedClaims: 10
---

# Deployment Overview

HeoPress supports two deployment modes from the same CMS codebase:

- **Cloudflare Workers** for the edge API runtime.
- **Docker self-hosting** for teams that want to operate the full stack in containers.


The public documentation site is a static Vite app deployed separately to **Cloudflare Pages**.
The public Marketplace site is also deployed to **Cloudflare Pages** and reads the CMS marketplace catalog at build/runtime revalidation.
The **Studio** admin SPA is a static Vite app deployed to **Cloudflare Pages** as well — see [Studio API connectivity](#studio-api-connectivity).

## Studio API connectivity

The Studio SPA talks to the CMS over a single base URL resolved by
`apps/studio/src/lib/api-base.ts` (`getApiBaseUrl()`):

- **Dev / Docker single-origin:** leave `VITE_API_URL` unset. The Studio uses
  same-origin requests — the Vite dev server proxies `/api` to the local CMS,
  and the Docker image serves the Studio from the same origin as the CMS.

  The image ships the built SPA at `/app/studio` and the CMS mounts it, so an
  admin UI is reachable without a second deployment. Where it answers:

  | Path | Served |
  |------|--------|
  | `/setup` | the SPA shell, for first-run setup |
  | `/<adminPath>` and below | the SPA shell, once setup has chosen the admin path |
  | `/assets/*`, `/sw.js` | the build output |
  | `/`, `/admin`, `/studio`, anything else | the indistinguishable `404` — the Hide-Login guarantee is unchanged |

  Two environment variables control it. `HEOPRESS_STUDIO_DIST` overrides the
  bundle location (default: `./studio` relative to the working directory), and
  `HEOPRESS_SERVE_STUDIO=false` turns serving off. Turn it off when the Studio is
  also deployed to Pages in front of this CMS — two copies can drift to
  different versions, and which one a person gets then depends on the hostname
  they typed.

  This applies to the **image** (`docker/Dockerfile`). The hot-reload development
  image mounts source instead of building, so it has no bundle and runs API-only;
  use `pnpm studio:dev` alongside it.
- **Static hosting elsewhere:** a separately hosted Studio SPA has **no
  co-located backend**, so it must call the CMS cross-origin. Set
  `VITE_API_URL` at build time to the CMS origin (e.g.
  `https://api.example.com`).

Because the Studio then calls the CMS from a different origin, the CMS must
allow that origin via `CORS_ALLOWED_ORIGINS`.
Production rejects `*`, so list the exact Studio origin. If `VITE_API_URL` is
missing on a standalone deploy, the Studio falls back to same-origin and the
setup gate shows **"Couldn't reach the server."**

> The **dev / staging / demo** environments instead serve Studio and the CMS
> from a **single hostname** (`<env>.heopress.example`), so `VITE_API_URL` is empty
> (same-origin) and no CORS is needed. See
> [Shared-domain environments](./shared-domain-environments.md).

## Cloudflare Targets

| Target | Package | Output | Deploy command |
| --- | --- | --- | --- |
| CMS API Worker | `@heopress/cms` | Worker bundle | `pnpm --filter @heopress/cms deploy` |

Run the build or dry-run command before deploying:

```bash
pnpm --filter @heopress/cms build
```


## Required Cloudflare Services

The CMS Worker can run with only environment variables for local development, but production expects the Cloudflare bindings described in `apps/cms/wrangler.toml`:

- `HYPERDRIVE` for pooled PostgreSQL access.
- `CONFIG_CACHE` for KV-backed schema, permission and settings cache.
- `MEDIA` for R2 media storage.
- `SITE_ROOM` Durable Object for per-site realtime WebSocket fan-out.
- Cron Triggers for scheduled audit/login-attempt retention cleanup.

Secrets such as `JWT_SECRET`, Cloudflare Access values and database credentials must be set with Wrangler secrets or dashboard-managed secret variables, not committed to the repository.

## Recommended Release Flow

1. Install dependencies with `pnpm install`.
3. Run `pnpm --filter @heopress/cms build` to dry-run the Worker bundle.
4. Deploy docs with `pnpm docs:deploy`.
5. Deploy the CMS Worker with `pnpm --filter @heopress/cms deploy` after production bindings and secrets are configured.

See [Cloudflare deployment](./cloudflare.md) for the detailed Worker and Pages commands.
See [Private admin path](./private-admin-path.md) for the production no-redirect policy that keeps the Studio entry point secret.
See [Multi-tenant deployment topologies](./multi-tenant-topologies.md) for how to lay out cells, databases and domains when one deployment serves many tenants.
