---
version: 8
lastUpdated: 2026-10-10T10:34:36.657Z
sourceLang: en
contentHash: d0e7028900cd9e37
codeVerified: 2026-10-10T10:34:36.657Z
codeVerifiedHash: d0e7028900cd9e37
codeVerifiedClaims: 74
---

# Environment Variables Reference

<!-- verify-code-refs: planned HEOPRESS_REALTIME_ENABLED -->

> **For AI agents:** All required variables must be set before starting the CMS API. Missing required variables will cause startup to fail with an explicit error message.

This page documents every environment variable and Cloudflare binding used by HeoPress.

---

## Core runtime

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEOPRESS_ENV` | ✓ | — | Environment label: `development`, `staging`, `production` |
| `HEOPRESS_RUNTIME` | ✗ | `docker` | Only `docker` is supported (the Cloudflare Workers runtime was removed in P02); any other value fails startup |
| `JWT_SECRET` | ✓ | — | Secret for signing/verifying application JWTs. Min 32 chars. **Provide it as a secret (`JWT_SECRET_FILE` or the orchestrator's secret store); never commit it.** |
| `HEOPRESS_DEV_AUTH` | Local dev only | `false` | Set to `true` to bypass Logto auth in local dev. **Never enable in production; `validateProductionConfig()` refuses it at startup.** |
| `HEOPRESS_REALTIME_ENABLED` | ✗ | — | **Not implemented.** Nothing reads this yet; setting it has no effect. Tracked as the "explicit enablement" goal in [realtime implementation](../architecture/realtime-websocket-implementation.md). |
| `VITE_HEOPRESS_ALLOW_ADMIN_PATH_REDIRECT` | Setup/debug only | `false` | Client-side opt-in that allows convenience redirects to the private admin path. Keep unset in production except for a temporary controlled setup/debug window. |

The admin path is **not** configured by an environment variable. It is chosen during
the Setup Wizard and stored in the database, so it can be rotated without a
redeploy — and so it never sits in a build artifact.

It is private operational state. Do not expose it through `VITE_*` environment
variables or client build metadata, and do not automatically redirect
public/setup routes to it in production. See
[Private admin path](./private-admin-path.md).

---

## First-run setup

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEOPRESS_REQUIRE_SETUP_TOKEN` | ✗ (Node/Docker only) | off | `true`, `1` or `yes` makes `POST /api/v1/setup/complete` demand a one-time setup token. Turn it on for any instance that someone other than you can reach before setup is finished — otherwise whoever reaches the port first creates the admin account. |

With the flag on, every process that serves HTTP (`HEOPRESS_PROCESS_ROLE` `web` or
`all`) mints the token as it starts, before it accepts requests, and prints it once:

```text
[heopress-cms] SETUP_TOKEN=<token>
```

Paste it into the setup wizard, or send it as `setupToken` to `/setup/complete`. Only
its SHA-256 hash is stored, and the hash is cleared when setup completes.

A restart does **not** print a new token: the stored hash is kept so a token you already
have stays valid, and the startup log says so instead. If you lost the line, clear the
hash and restart — the next start prints a fresh token:

```sql
UPDATE lumibase_system_state SET setup_token_hash = NULL WHERE id = 'singleton';
```

Several replicas starting at once print exactly one token between them, so read it
from whichever replica printed it.

---

## Encryption

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENCRYPTION_KEY` | Before first use | — | Base64 of 32 random bytes (`openssl rand -base64 32`). Wraps encrypted item fields and TOTP two-factor seeds. Resolved as key version `v0`. **Set as a secret** (`wrangler secret put ENCRYPTION_KEY --env production`); never commit it or place it in `[env.production.vars]` |
| `ENCRYPTION_KEY_<id>` | ✗ | — | Versioned key material, e.g. `ENCRYPTION_KEY_v1`, used for rotation |
| `ENCRYPTION_ACTIVE_KEY_ID` | ✗ | only configured key, else `v0` | Which key version encrypts new data |
| `ENCRYPTION_KEY[_<id>]_FILE` | ✗ | — | Path to read the key from instead of the variable (Docker secrets). The direct variable wins |

"Before first use" means before anyone enrolls in 2FA or writes an encrypted
field — not before boot. Without a key, enrollment fails closed with a `500`
rather than a typed error.

> **Once seeds exist, a key can never be removed.** TOTP seeds pin the key
> version that wrapped them and are **not** re-wrapped by the envelope
> migration, so retiring an old key locks those users out of their second
> factor. Rotation is also not a remedy for a leaked key. See
> [Encryption key operations](../operations/encryption-keys.md).

---

## Authentication (Logto)

| Variable | Required | Description |
|----------|----------|-------------|
| `LOGTO_ENDPOINT` | ✓ | Logto instance URL (e.g., `https://your-tenant.logto.app`) |
| `LOGTO_APP_ID` | ✓ | Logto application ID |
| `LOGTO_APP_SECRET` | ✓ | Logto application secret |
| `LOGTO_JWKS_URI` | ✗ | Override JWKS URL (auto-derived from `LOGTO_ENDPOINT` if not set) |
| `CF_ACCESS_CERTS_URL` | CF Access only | Cloudflare Access JWKS URL for admin tunnel auth |
| `CF_ACCESS_AUDIENCE` | CF Access only | Cloudflare Access application audience tag |

---

## Database

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Docker only | The servers' PostgreSQL connection: the application role (e.g., `postgresql://heopress_app:<password>@postgres:5432/heopress`), to which row-level security applies. See [database roles](./docker.md#database-roles) |
| `DATABASE_OWNER_URL` | Docker (`cms`) | The owner of the tables: migrations and role provisioning in the `cms` entrypoint only, unset before the server starts. Unset: `DATABASE_URL` is used (a deployment from before security review S-5) |
| `HEOPRESS_APP_PASSWORD` | Docker (`cms`) | Password the `cms` entrypoint gives the application role `heopress_app` (the one in `DATABASE_URL`); unset before the server starts |
| `HEOPRESS_REQUIRE_APP_ROLE` | ✗ | `true`: `cms` refuses to start when `DATABASE_URL` bypasses row-level security (superuser, `BYPASSRLS`, the owner); default `false` logs a warning |
| `HEOPRESS_SKIP_APP_ROLE` | ✗ | `true` when the application role is provisioned outside the `cms` container |
| `DATABASE_POOL_MIN` | ✗ | Minimum DB pool connections (default: `2`) |
| `DATABASE_POOL_MAX` | ✗ | Maximum DB pool connections (default: `10`) |
| `DATABASE_SSL` | ✗ | `true` to require SSL for DB connection |
| `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` | ✗ | Comma-separated origins of self-hosted services the CMS may reach on a private network (service connections only), e.g. `http://minio:9000,http://crawl4ai:11235`. See [outbound requests](../security/outbound-requests.md) |
| `HEOPRESS_VECTOR_SEARCH` | ✗ | `true` enables vector search; readiness then requires the `vector` extension (default: off). See [database-image.md](./database-image.md) |


---

## Cache

The cache lives in PostgreSQL (HeoPress P03): an UNLOGGED table shared by all processes, with a short-lived in-process copy (L1) in front of it. Tag invalidation bumps a generation and is broadcast with `NOTIFY`; every read checks generations, so an entry written before an invalidation is never served from PostgreSQL. Another process can keep serving its L1 copy for the notification latency (milliseconds), or for about a second if its notification connection dropped unnoticed, and never longer than the L1 TTL. Redis is no longer used.

| Variable | Required | Description |
|----------|----------|-------------|
| `HEOPRESS_CACHE_L1_TTL_MS` | ✗ | In-process L1 TTL in milliseconds (default: `2000`). `0` disables L1: every read goes to PostgreSQL. |
| `CACHE_TTL_SCHEMA` | ✗ | Schema cache TTL in seconds (default: `60`) |
| `CACHE_TTL_PERMISSIONS` | ✗ | Permission cache TTL in seconds (default: `300`) |
| `CACHE_TTL_SETTINGS` | ✗ | Settings cache TTL in seconds (default: `60`) |

---

## Object storage

Local filesystem by default; any S3-compatible service by configuration. Examples for SeaweedFS/MinIO, AWS S3, R2, OSS and COS: [object-storage.md](./object-storage.md).

| Variable | Required | Description |
|----------|----------|-------------|
| `HEOPRESS_STORAGE` | ✗ | `local` or `s3` (default: `s3` when `S3_BUCKET` or `S3_ENDPOINT` is set, else `local`) |
| `HEOPRESS_STORAGE_DIR` | ✗ | Root directory for local storage (default: `./data/storage`) |
| `S3_ENDPOINT` | ✗ | S3-compatible endpoint (omit for AWS S3); a private one must be in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS` |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | S3 only | Credentials (also `*_FILE`) |
| `S3_BUCKET` | ✗ | Bucket (default: `heopress-media`) |
| `S3_REGION` | ✗ | Region (default: `us-east-1`; `auto` for R2) |
| `S3_FORCE_PATH_STYLE` | ✗ | `true`/`false`; default `true` with a custom endpoint. OSS and COS need `false` |
| `HEOPRESS_IMAGE_MAX_DIMENSION` | ✗ | Largest width/height an image transform may produce (default: `4096`) |

----------|----------|-------------|
| `S3_ENDPOINT` | Docker/S3 only | S3-compatible endpoint URL (e.g., SeaweedFS in compose: `http://seaweedfs:8333`) |
| `S3_ACCESS_KEY_ID` | Docker/S3 only | S3 access key |
| `S3_SECRET_ACCESS_KEY` | Docker/S3 only | S3 secret key |
| `S3_BUCKET` | Docker/S3 only | Storage bucket name (default: `heopress-media`) |
| `S3_REGION` | ✗ | S3 region (default: `us-east-1`) |
| `S3_PUBLIC_URL` | ✗ | Public base URL for assets (e.g., CDN URL pointing to the bucket) |

---

## Search (optional MeiliSearch)

Search runs on PostgreSQL unless `MEILISEARCH_HOST` is set (see [Full-text Search](../features/search.md)).

| Variable | Required | Description |
|----------|----------|-------------|
| `MEILISEARCH_HOST` | No | MeiliSearch instance URL, e.g. `http://meilisearch:7700`; unset = PostgreSQL search |
| `MEILISEARCH_API_KEY` | With `MEILISEARCH_HOST` | MeiliSearch master or search API key |

---

## AI Copilot

| Variable | Required | Description |
|----------|----------|-------------|
| `LLM_PROVIDER` | ✗ | LLM provider: `openai`, `anthropic`, `claude`, `gemini`, `nvidia`, `echo` (`vertex` and `workers-ai` were removed in P02 and fail startup) (default: `echo`) |
| `OPENAI_API_KEY` | If `openai` provider | OpenAI API key |
| `ANTHROPIC_API_KEY` | If `anthropic` / `claude` provider | Anthropic API key |
| `GEMINI_API_KEY` | If `gemini` provider | Google Gemini API key |
| `NVIDIA_API_KEY` | If `nvidia` provider | NVIDIA hosted-inference key (build.nvidia.com / NIM). Billed by NVIDIA. |
| `NVIDIA_BASE_URL` | ✗ | Override the NVIDIA endpoint — e.g. a self-hosted NIM container (`http://nim:8000/v1`). Defaults to `https://integrate.api.nvidia.com/v1`. |
| `LLM_MODEL` | ✗ | Model name override (e.g., `gpt-4.1-nano`, `claude-3-5-haiku-latest`, `gemini-3.5-flash`, `meta/llama-3.1-8b-instruct`) |
| `LLM_PRICE_INPUT_PER_1M` | For the instance model to be used | Price per million input tokens, in currency units (e.g. `0.27`). Without both prices, calls that would use the instance model are refused (`PRICE_NOT_CONFIGURED`). See [model providers](model-providers.md). |
| `LLM_PRICE_OUTPUT_PER_1M` | For the instance model to be used | Price per million output tokens. |
| `LLM_PRICE_CURRENCY` | ✗ | Currency of these prices (default `USD`); also the currency of a site without model settings. |
| `HEOPRESS_LLM_RATE_LIMIT_PER_MINUTE` | ✗ | Model-call attempts per model service and site per sliding minute (default `60`; `0`: no limit). A limited service is passed over for the next model in the failover list; when none is left the call is deferred, not failed. |
| `HEOPRESS_LLM_BREAKER_FAILURES` | ✗ | Service failures in a row (network error, timeout, 429, 5xx — never 400) that open a model service's circuit breaker (default `5`). |
| `HEOPRESS_LLM_BREAKER_COOLDOWN_SECONDS` | ✗ | How long an open breaker keeps the service out before one trial request (default `60`). |

> **Provider ↔ billing:** `nvidia` calls an *external* cloud — NVIDIA
> and Google Cloud respectively — so their usage is **not** covered by AWS
> credit. `nvidia` (or a self-hosted NIM via `NVIDIA_BASE_URL`) and MeiliSearch
> are the pieces that pair naturally with AWS-hosted infrastructure.

### Decision model (TypeSafe Jev)

Backs `POST /api/v1/ai/decisions`: typed `noul` / `choice` / `score` answers with probabilities instead of generated text. Independent of `LLM_PROVIDER`; unset means the endpoint answers `503 DECISION_NOT_CONFIGURED`.

| Variable | Required | Description |
|----------|----------|-------------|
| `DECISION_PROVIDER` | ✗ | `typesafe` (TypeSafe Jev, direct), `openrouter` (same System One API via OpenRouter, billed to OpenRouter), or `llm` (reuses `LLM_PROVIDER` in structured decision mode, no tools; answers are flagged `calibrated: false`). A configured choice, not an automatic failover. Unset = disabled. |
| `DECISION_MODEL` | ✗ | Model override. Defaults to `jev-latest` (`typesafe`) or `~typesafe/jev-latest` (`openrouter`). |
| `TYPESAFE_API_KEY` | If `typesafe` provider | TypeSafe API key. |
| `TYPESAFE_BASE_URL` | ✗ | TypeSafe endpoint override. Defaults to `https://api.typesafe.ai/v1`. |
| `OPENROUTER_API_KEY` | If `openrouter` provider | OpenRouter API key. |
| `DECISION_PRICE_PER_REQUEST` | For `typesafe` / `openrouter` | Price of one decision request in `LLM_PRICE_CURRENCY` units; each attempt is recorded in the site's model ledger. Without it, decisions are refused (`DECISION_REFUSED`). |
| `DECISION_TIMEOUT_MS` | ✗ | Total deadline per decision in ms, retries and backoff included (default `20000`, range 1000–120000). |
| `DECISION_ATTEMPT_TIMEOUT_MS` | ✗ | Timeout of one upstream attempt in ms (default `8000`, range 500–120000), capped by what remains of the deadline. |
| `DECISION_MAX_RETRIES` | ✗ | Retries after the first attempt for 429/503/529, network errors and attempt timeouts (default `2`, range 0–5). |
| `DECISION_MAX_INPUT_BYTES` | ✗ | UTF-8 byte cap on the serialized state + questions (default `131072`). Over the cap → `413 DECISION_INPUT_TOO_LARGE` before any provider call. |
| `DECISION_MAX_INPUT_TOKENS` | ✗ | Estimated token budget for the same payload (default `24000`). The estimate counts ~4 ASCII chars or 1 non-ASCII code point per token; it is not the provider's tokenizer. |

Invalid values in these five variables are ignored with a warning and the default applies.

---

## Email (Resend)

| Variable | Required | Description |
|----------|----------|-------------|
| `RESEND_API_KEY` | If email enabled | Resend API key for transactional email |
| `EMAIL_FROM` | If email enabled | Sender address (e.g., `noreply@yourdomain.com`) |

---

## Pressure limiter (Docker / Node.js)

The Docker CMS process includes an overload guard for the Node.js event loop. When enabled and the process is saturated, API requests fail fast with HTTP `503`, a `SERVICE_UNAVAILABLE` JSON envelope, `Retry-After`, and `X-HeoPress-Overload` instead of queueing until the container becomes unresponsive. The guard bypasses `/health` and `/metrics` by default so operators can still inspect the instance.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEOPRESS_PRESSURE_LIMITER_ENABLED` | Docker only | `true` | Enables the Node.js overload guard. Set `false` only as a temporary mitigation while you scale or optimize the overloaded path. |
| `HEOPRESS_PRESSURE_LIMITER_SAMPLE_INTERVAL` | ✗ | `250` | Sampling interval in milliseconds for event-loop pressure checks. |
| `HEOPRESS_PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY` | ✗ | `1000` | Maximum observed event-loop delay in milliseconds before API traffic receives `503`. Set `false` to disable this threshold. |
| `HEOPRESS_PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION` | ✗ | `false` | Optional utilization threshold such as `0.99`. Disabled by default because sustained useful CPU work can otherwise produce noisy rejections. |
| `HEOPRESS_PRESSURE_LIMITER_RETRY_AFTER` | ✗ | `5` | Seconds advertised in the `Retry-After` response header. |
| `HEOPRESS_PRESSURE_LIMITER_EXCLUDED_PATHS` | ✗ | `/health,/metrics` | Comma-separated path prefixes that should keep serving during overload checks. |

---

## Site domains and TLS

| Variable | Required | Default | Description |
|---|---|---|---|
| `HEOPRESS_TLS_ASK_ALLOW` | ✗ | loopback and private ranges | CIDRs that may ask the certificate gate `GET /internal/tls/ask` (the TCP peer is checked; forwarded requests are refused). See [custom domains](./custom-domains.md) |
| `HEOPRESS_TLS_ASK_RATE` | ✗ | `120` | Certificate-gate questions per minute per caller; `0` turns the limit off |

---

## Public site rendering (site-classic)

These configure the classic rendering service (`apps/site-classic`), which serves every public site from one process.
A value outside its range stops the service at start-up instead of falling back to the default. The start-up log
states the render thread count, the page cache size and the host memory.

| Variable | Required | Default | Description |
|---|---|---|---|
| `HEOPRESS_RENDER_DB_POOL` | ✗ | `10` | Database connections for page data (what a cache miss reads) |
| `HEOPRESS_RENDER_LOOKUP_DB_POOL` | ✗ | `4` | Database connections for page-cache and host lookups. Kept apart from page data, so a cache hit never waits for a connection a miss holds |
| `HEOPRESS_RENDER_WORKERS` | ✗ | usable CPUs − 1, from 2 to 8 | Render threads (1–64). The usable CPUs follow the process's CPU affinity (a container's `--cpuset-cpus`). One CPU is left to the event loop that answers cache hits. A 4 vCPU server gets 3 |
| `HEOPRESS_RENDER_HOST_MEMO_MS` | ✗ | `1000` | How long the process remembers a domain's row, in ms (0–2000; `0` reads it on every request). A removed or moved domain keeps its old answer for at most this long, inside the 10-second consistency budget |
| `HEOPRESS_RENDER_CACHE_MB` | ✗ | `64` | Size of the process's own page cache (level 1), in MB. The shared level is the `lumibase_render_cache` table |

---

## Rate limiting

Budgets are fixed windows counted in the logged PostgreSQL table `lumibase_rate_limit_windows`, so they are shared by all processes and survive a restart. When exceeded the API returns HTTP `429` with a `RATE_LIMITED` envelope and `Retry-After`.

- **General API throttle**: keyed per principal (user → API key → anonymous) and scoped per site; also sends `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`. It fails open when the limiter is unavailable unless `HEOPRESS_RATE_LIMIT_FAIL_CLOSED=true` (then `503`).
- **Security budgets** fail closed (`429`, `Retry-After: 60`) when the limiter is unavailable: login (`rl:login:<site>:<ip>`), recovery (`rl:recovery:<ip>`, 3 per hour shared by `/recover` and `/forgot-path`) and MFA verification. Each has its own budget. The client IP is the socket address; behind a reverse proxy list it (and, behind Cloudflare, Cloudflare's ranges) in `HEOPRESS_TRUSTED_PROXIES`, and the client becomes the rightmost `X-Forwarded-For` entry that is not a trusted proxy. `CF-Connecting-IP` is ignored.

Large imports can trip the default API budget. Raise `HEOPRESS_API_RATE_LIMIT` and prefer the bulk endpoint — see [Data import](../features/data-import.md).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEOPRESS_API_RATE_LIMIT` | ✗ | `600` | Max API requests per minute per principal, per site. `0` disables. |
| `HEOPRESS_RATE_LIMIT_FAIL_CLOSED` | ✗ | (unset) | `true` → the general throttle answers `503` when the limiter is unavailable. |
| `HEOPRESS_LOGIN_RATE_LIMIT` | ✗ | `30` | Login attempts per minute per client IP, per site. `0` disables. |
| `FILE_UPLOAD_VIDEO_MAX_BYTES` | ✗ | `52428800` | Size cap in bytes for video uploads (MP4, WebM); every other type keeps `FILE_UPLOAD_MAX_BYTES` (10 MB). Uploads into articles also need object storage (S3, R2 or OSS) with a public base URL bound to the site. Keep the proxy's media body cap (`docker/Caddyfile`, 50 MB) at least as large. |
| `HEOPRESS_SETUP_STATE_RATE_LIMIT` | ✗ | `60` | Requests per minute per client IP on `GET /api/v1/setup/state`, which Studio asks on every page load. Raise it when many people share one IP. `0` disables. |
| `HEOPRESS_DELIVER_RATE_LIMIT` | ✗ | `1200` | Max requests per minute per client IP on the public Delivery API (`/api/v1/deliver/*`). `0` disables. See [Caching — penetration](../features/caching.md). |
| `HEOPRESS_NEGATIVE_CACHE_TTL` | ✗ | `30` | Tombstone TTL (seconds) for confirmed absences on public read paths, before ±20% jitter. `0` disables. |

---

## Optional features

Off on a fresh install (ADR-0004). Set a variable to `true` and restart to turn a feature on. While off, its endpoints answer `404`, its scheduled work is not scheduled, its request-path work does not run, and Studio hides its entry points (`GET /api/v1/features` reports the current set).

| Variable | Feature | Endpoints / work when on |
|----------|---------|--------------------------|
| `HEOPRESS_ENABLE_GRAPHQL` | GraphQL | `/api/v1/graphql` |
| `HEOPRESS_ENABLE_AGENT_NEWSROOM` | Multi-agent newsroom (role library, planner delegation) | `/api/v1/agent/roles`, `/api/v1/agent/goals/:id/decompose`, `/api/v1/agent/goals/:id/settle` |
| `HEOPRESS_ENABLE_CONTENT_GOALS` | Content goals, drift detection, automatic repair | `/api/v1/agent/intents`; the one-minute goal dispatch tick |
| `HEOPRESS_ENABLE_EXTERNAL_ISSUERS` | External identity issuers (SSO) | trusted-issuer JWTs in `withAuth`; `/api/v1/admin/auth/issuers` |
| `HEOPRESS_ENABLE_LOGIN_ANOMALY` | Login anomaly scoring | geo/time/device detectors and baseline updates on login |
| `HEOPRESS_ENABLE_METRICS` | Prometheus metrics | `/metrics`; request metric collection |
| `HEOPRESS_ENABLE_FIELD_ENCRYPTION` | Encryption of content fields (`encrypted`, and the `pii`/`phi` classifications that require it) | turning a field's encryption on (`422 FIELD_ENCRYPTION_DISABLED` while off). Already encrypted fields keep working and can be turned off; encryption of stored secrets (tokens, keys, TOTP) is always on |

The per-site Content OS rollout flags (Studio → Mission Control) still apply once a feature is on.

## GraphQL

Every GraphQL operation is validated before it runs against a depth limit and a static cost limit, rejecting abusively deep or wide queries at parse time (CWE-770). Depth is a compile-time constant (12); cost is tunable. Raise `HEOPRESS_GQL_MAX_COST` if a legitimate query is rejected. See [`graphql-api-spec.md`](../api/graphql-api-spec.md#abuse-guards).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `HEOPRESS_GQL_MAX_COST` | ✗ | `1000` | Max static cost accepted per operation. |
| `HEOPRESS_GQL_DEFAULT_LIST_SIZE` | ✗ | `20` | Cost multiplier for a list field with no literal pagination argument (or a variable one). |
| `HEOPRESS_GQL_MAX_LIST_MULTIPLIER` | ✗ | `100` | Upper clamp on any single list field's cost multiplier. |

---

## Observability

| Variable | Required | Description |
|----------|----------|-------------|
| `HEOPRESS_ENABLE_METRICS` | ✗ | `true` to expose `/metrics` and record request metrics (off by default; see [Optional features](#optional-features)) |
| `LOG_LEVEL` | ✗ | Log level: `debug`, `info`, `warn`, `error` (default: `info`) |
| `LOG_FORMAT` | ✗ | `json` (default) or `pretty` (local dev) |

---

## Security checklist

Before deploying to production, verify:

- [ ] `JWT_SECRET` is at least 32 characters and stored as a Wrangler Secret or Docker secret
- [ ] `HEOPRESS_DEV_AUTH` is NOT set to `true`
- [ ] Database credentials are stored as secrets, not in `.env` files committed to git
- [ ] `S3_SECRET_ACCESS_KEY` is stored as a secret
- [ ] `RESEND_API_KEY` is stored as a secret
- [ ] CORS is configured to allow only your Studio and consumer domains
