## @heopress/cms

Hono API for HeoPress. Runs only on Node.js 24+ (Docker / VPS); the upstream
Cloudflare Workers build was removed in P02 (ADR-0002).

### Entry points

- `src/serve.ts` — the Node process: HTTP API, Studio, realtime WebSocket server,
  cron jobs and queue consumers (`HEOPRESS_PROCESS_ROLE=web|worker|all`).
- `src/index.ts` — the Hono app itself (mounted by `serve.ts` and by tests).

### Endpoints

- `GET /health/live` — liveness (no dependency probes).
- `GET /health/ready` — readiness (database reachable and fully migrated, plus cache/search/storage/queue).
- `GET /api/v1/deliver/page/:site_id/:slug` — Page Hydration API.

### Development

```bash
pnpm install
export DATABASE_URL=postgresql://heopress:heopress_dev@localhost:5432/heopress
pnpm db:migrate
pnpm --filter @heopress/cms dev     # tsx watch src/serve.ts (port 1989)
pnpm --filter @heopress/cms build   # dist/serve.cjs + dist/migrate.cjs
```
