// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { Database } from '@heopress/database';
import type { RuntimeContext } from '@heopress/runtime';

/**
 * Process environment as seen by the Hono app (`c.env`). HeoPress runs only on
 * Node.js; the Cloudflare Worker bindings (Hyperdrive, KV, R2, Queues, Durable
 * Objects) were removed in P02.
 */
export interface Bindings {
  HEOPRESS_ENV: string;
  /** Semver package/application version for the deployed HeoPress build. */
  HEOPRESS_VERSION?: string;
  /** Source-control revision used for this build. */
  HEOPRESS_GIT_SHA?: string;
  /** ISO-8601 timestamp for when this build artifact was produced. */
  HEOPRESS_BUILD_TIME?: string;
  /** Release track for the artifact, e.g. development, staging, production. */
  HEOPRESS_RELEASE_CHANNEL?: string;
  /** Runtime mode. Only `'docker'` (the default) is supported; any other value fails startup. */
  HEOPRESS_RUNTIME?: string;
  // ── Email service (services/email/*) ────────────────────────────────────
  /** SMTP connection string (nodemailer format) for the Docker/Node runtime. */
  HEOPRESS_SMTP_URL?: string;
  /** Default envelope sender for all outbound mail. Falls back to no-reply@heopress.local. */
  HEOPRESS_MAIL_FROM?: string;
  /** Optional default Reply-To applied to outbound mail. */
  HEOPRESS_MAIL_REPLY_TO?: string;
  /** Operator kill switch: set to `"false"` to disable all email sending. */
  HEOPRESS_MAIL_ENABLED?: string;
  /** Comma-separated cc list for security notifications (legacy name kept). */
  HEOPRESS_SECURITY_RECIPIENTS?: string;
  /**
   * Max concurrent audience (public-plane) realtime sessions per subject on the
   * Node WebSocket hub. `0`/unset disables the cap. (realtime-audience-channels)
   */
  HEOPRESS_REALTIME_MAX_CONNECTIONS_PER_SUBJECT?: string;
  /** Direct Postgres connection string (used in local development). */
  DATABASE_URL?: string;
  /** Cloudflare Access Certificates URL (JWKS format) */
  CF_ACCESS_CERTS_URL?: string;
  /** Cloudflare Access Application Audience (AUD) */
  CF_ACCESS_AUDIENCE?: string;
  /** Secret key for signing internal Custom JWTs (for frontend users) */
  JWT_SECRET?: string;
  /**
   * Session-token TTL for the `studio` realm (staff/CMS). Accepts a
   * compact duration (`12h`, `30m`, `7d`) or a number of seconds.
   * Defaults to `12h`. Invalid values fall back to the default.
   */
  STUDIO_SESSION_TTL?: string;
  /**
   * Session-token TTL for the `frontend` realm (subscribers). Accepts a
   * compact duration (`30d`, `12h`) or a number of seconds. Defaults to
   * `30d`. Invalid values fall back to the default.
   */
  FRONTEND_SESSION_TTL?: string;
  /**
   * Refresh-token TTL for the `studio` realm — the "stay logged in"
   * horizon over which a short access token is silently renewed. Defaults
   * to `30d`. Invalid values fall back to the default.
   */
  STUDIO_REFRESH_TTL?: string;
  /** Refresh-token TTL for the `frontend` realm. Defaults to `90d`. */
  FRONTEND_REFRESH_TTL?: string;
  /**
   * Refresh cookie `SameSite`: `Lax` (default) | `Strict` | `None`. Use
   * `None` when the frontend is on a different site/domain than the API
   * (cross-site) — browsers then also require `Secure`, which is forced.
   */
  REFRESH_COOKIE_SAMESITE?: string;
  /** Refresh cookie `Domain`, e.g. `.example.com` to share across subdomains. */
  REFRESH_COOKIE_DOMAIN?: string;
  /** `"false"` allows the refresh cookie over plain http (local dev only). */
  REFRESH_COOKIE_SECURE?: string;
  /** When set to `"true"`, withAuth allows dev tokens (skip JWKS verify). */
  HEOPRESS_DEV_AUTH?: string;
  /** Secret key for AES-GCM per-field encryption (base64 encoded). */
  ENCRYPTION_KEY?: string;
  /** Comma-separated trusted origins for executable extension bundles. */
  EXTENSION_BUNDLE_ORIGINS?: string;
  /** JSON map `{ keyId: pem }` of publisher public keys (merged with the DB registry). */
  MARKETPLACE_PUBLIC_KEYS?: string;
  /** Deprecated since HeoPress P12 and ignored: unsigned plugins are accepted only with `HEOPRESS_ENV=development`. */
  HEOPRESS_EXT_SIGNATURE_POLICY?: string;
  /** Comma-separated frontend origins allowed by CORS. */
  CORS_ALLOWED_ORIGINS?: string;
  /** Data-retention horizon (days) for the `activity` log. 0/unset = disabled. */
  HEOPRESS_ACTIVITY_RETENTION_DAYS?: string;
  /** Data-retention horizon (days) for read/archived `notifications`. 0/unset = disabled. */
  HEOPRESS_NOTIFICATION_RETENTION_DAYS?: string;
  /** Maximum bytes accepted by the file upload policy. Defaults to 10 MiB. */
  FILE_UPLOAD_MAX_BYTES?: string;
  /** Cap for video uploads (mp4, webm); 50 MB by default (ADR-0020). */
  FILE_UPLOAD_VIDEO_MAX_BYTES?: string;
  /** Comma-separated MIME allowlist accepted by the file upload policy. */
  FILE_UPLOAD_ALLOWED_MIME_TYPES?: string;
  /** Bearer token required to read Prometheus metrics in production. */
  METRICS_TOKEN?: string;
  /** Delivery API shared-cache lifetime in seconds (`0` disables public caching). Default 60. */
  HEOPRESS_DELIVER_SMAXAGE?: string;
  /** Delivery API stale-while-revalidate window in seconds. Default 300. */
  HEOPRESS_DELIVER_SWR?: string;
  /** Negative-cache (tombstone) TTL in seconds before ±20% jitter. Default 30; `0` = off. */
  HEOPRESS_NEGATIVE_CACHE_TTL?: string;
  /** Delivery API IP rate limit (req/min). Default 1200; `0` = off. */
  HEOPRESS_DELIVER_RATE_LIMIT?: string;
  /** Authenticated API rate limit (req/min per principal). Default 600; `0` = off. */
  HEOPRESS_API_RATE_LIMIT?: string;
  /** Login attempts per IP per site per minute (default 30; `0` = off). P03. */
  HEOPRESS_LOGIN_RATE_LIMIT?: string;
  /** Requests per minute per IP on `GET /setup/state` (default 60; 0 = off). */
  HEOPRESS_SETUP_STATE_RATE_LIMIT?: string;
  /** In-process L1 cache TTL in ms (default 2000; `0` disables L1). P03. */
  HEOPRESS_CACHE_L1_TTL_MS?: string;
  /** `true` enables vector search; readiness then requires the `vector` extension. P03. */
  HEOPRESS_VECTOR_SEARCH?: string;
  /** Debounce window (seconds) for API-key `lastUsedAt` writes. Default 60; `0` = touch every request. */
  HEOPRESS_APIKEY_TOUCH_INTERVAL?: string;
  /** Max JSON request body in bytes for the app-level guard. Default 1 MiB. */
  HEOPRESS_MAX_JSON_BODY?: string;
  /** Sync flow run ceiling in ms when no queue worker (default 30000). */
  HEOPRESS_FLOW_SYNC_TIMEOUT?: string;
  /** Max items per bulk() batch (default 500). */
  HEOPRESS_BULK_MAX?: string;
  /**
   * Set to 'true' to make the general API rate limiter fail CLOSED (503) when
   * the runtime cache is missing or errors, instead of the default fail-open
   * behaviour. Use in hardened deployments where the throttle is load-bearing.
   */
  HEOPRESS_RATE_LIMIT_FAIL_CLOSED?: string;
  /** Max static cost accepted per GraphQL operation (default 1000). */
  HEOPRESS_GQL_MAX_COST?: string;
  /** List multiplier for GraphQL list fields lacking a literal pagination arg (default 20). */
  HEOPRESS_GQL_DEFAULT_LIST_SIZE?: string;
  /** Upper clamp on a GraphQL list field's cost multiplier (default 100). */
  HEOPRESS_GQL_MAX_LIST_MULTIPLIER?: string;
  // ── LLM Provider (POST-GA Task #1) ──────────────────────────────────────
  /**
   * `'openai'` | `'anthropic'` | `'claude'` | `'gemini'` | `'nvidia'`
   * | `'vertex'` | `'workers-ai'` | `'echo'` (default).
   */
  LLM_PROVIDER?: string;
  /** Provider-specific model override. */
  LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** NVIDIA hosted inference (build.nvidia.com / NIM) API key. */
  NVIDIA_API_KEY?: string;
  /** Optional NVIDIA endpoint override (e.g. a self-hosted NIM container). */
  NVIDIA_BASE_URL?: string;
  /** OAuth 2.0 bearer for Vertex AI (e.g. `gcloud auth print-access-token`). Billed to GCP, not AWS. */
  VERTEX_ACCESS_TOKEN?: string;
  /** Google Cloud project id that owns the Vertex AI models. */
  VERTEX_PROJECT_ID?: string;
  /** Vertex AI region. Defaults to `us-central1`. */
  VERTEX_LOCATION?: string;
  WORKERS_AI_ACCOUNT_ID?: string;
  WORKERS_AI_API_TOKEN?: string;
  /** Optional Workers AI gateway URL override. */
  WORKERS_AI_GATEWAY?: string;
  // ── Decision Provider (services/decision-provider.ts) ──────────────────
  /** `'typesafe'` | `'openrouter'` | `'llm'`. Unset disables `/ai/decisions`. */
  DECISION_PROVIDER?: string;
  /** Decision model override (default `jev-latest` / `~typesafe/jev-latest`). */
  DECISION_MODEL?: string;
  /** TypeSafe API key for Jev (System One API). */
  TYPESAFE_API_KEY?: string;
  /** Optional TypeSafe endpoint override. Defaults to `https://api.typesafe.ai/v1`. */
  TYPESAFE_BASE_URL?: string;
  /** OpenRouter API key, used when DECISION_PROVIDER = 'openrouter'. */
  OPENROUTER_API_KEY?: string;
  /** Total decision deadline in ms, retries included (default 20000, 1000–120000). */
  DECISION_TIMEOUT_MS?: string;
  /** Timeout of one upstream attempt in ms (default 8000, 500–120000). */
  DECISION_ATTEMPT_TIMEOUT_MS?: string;
  /** Retries after the first attempt (default 2, 0–5). */
  DECISION_MAX_RETRIES?: string;
  /** UTF-8 byte cap on serialized state + questions (default 131072). */
  DECISION_MAX_INPUT_BYTES?: string;
  /** Estimated token budget on the same payload (default 24000). */
  DECISION_MAX_INPUT_TOKENS?: string;
  // ── Custom domains (routes/domains.ts) ─────────────────────────────────
  /** Hostname custom domains CNAME to (shown in the manual DNS instructions), e.g. `cname.sites.example.com`. */
  HEOPRESS_SAAS_FALLBACK?: string;
  /** Suffix for free subdomains, e.g. `sites.example.com`. Unset: no free subdomains. */
  HEOPRESS_FREE_DOMAIN_SUFFIX?: string;
  // ── Git integration (modules/git-integration) ───────────────────────────
  /** Public origin used to build operator-facing webhook URLs (e.g. https://api.example.com). */
  HEOPRESS_PUBLIC_URL?: string;
  /** GitHub OAuth app client id (for PAT/OAuth connect flow). */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth app client secret. */
  GITHUB_CLIENT_SECRET?: string;
  /** GitHub App id (for installation-token minting). */
  GITHUB_APP_ID?: string;
  /** GitHub App private key, PKCS#8 PEM. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** GitLab OAuth application id. */
  GITLAB_CLIENT_ID?: string;
  /** GitLab OAuth application secret. */
  GITLAB_CLIENT_SECRET?: string;
}

/**
 * Authenticated principal resolved by `withAuth`.
 */
export interface AuthPrincipal {
  /** Principal kind. Defaults to `user` when omitted for legacy callers. */
  type?: 'user' | 'api_key' | 'anonymous';
  /**
   * How the request authenticated (HeoPress P04): `session` (a HeoPress
   * login JWT, `raw.sid`), `cf_access`, `external` (a trusted issuer),
   * `api_key`, `anonymous`, `dev`, `mcp` (a person through an agent grant, HeoPress P10: the internal
   * request of an MCP tool call; never a Studio session). Site switching depends on it.
   */
  method?: 'session' | 'cf_access' | 'external' | 'api_key' | 'anonymous' | 'dev' | 'mcp';
  /** Users.external_id (resolved from CF Access or OAuth). */
  externalId?: string;
  /** Internal users.id in PostgreSQL database. */
  userId?: string;
  /**
   * Role bound directly to the principal rather than through a membership.
   * Set for `anonymous` principals, which resolve to the site's `public`
   * role — `PermissionService` reads it as `ctx.roleId`.
   */
  roleId?: string;
  /** Internal api_keys.id for API-key principals. */
  apiKeyId?: string;
  /** Audit-safe API key metadata; never contains plaintext token or token hash. */
  apiKey?: Record<string, unknown>;
  email?: string;
  roles?: string[];
  /** Flag to identify if this principal is a frontend end-user (authenticated via Custom JWT) */
  isFrontendUser?: boolean;
  raw: Record<string, unknown>;
}

/**
 * Per-request variables hung off Hono's context.
 */
export interface Variables {
  db: Database;
  /** Active site id (Strict Rule #2). Set by `withTenant`. */
  siteId: string;
  /** The public domain the request came in on (rendering layer; HeoPress P04). */
  publicHost?: import('./services/domains/public-host').PublicHostResolution;
  /** Authenticated principal. Set by `withAuth`. */
  auth: AuthPrincipal;
  /** Correlation id for log lines. */
  requestId: string;
  /**
   * Resolved client IP for the current request (admin-setup-wizard
   * task 11.2; Req 15.1, 15.2; design §6.2). Populated by the
   * `audit-context` middleware (`withAuditContext`) via
   * {@link import('./modules/login-guard/ip-extract').extractClientIp}
   * so every downstream handler — and the AuditLogger callers — read
   * the SAME canonical IP form the LoginGuard writes into
   * `login_attempts.ip`. Optional: the middleware sets it on the global
   * chain, but a unit-test Hono app that doesn't mount the middleware
   * leaves it unset.
   */
  ip?: string;
  /**
   * Raw `User-Agent` header for the current request (admin-setup-wizard
   * task 11.2; Req 15.2). Populated by the `audit-context` middleware
   * alongside {@link Variables.ip} so audit entries can carry the UA
   * without each handler re-reading the header. `undefined` when the
   * header is absent or the middleware isn't mounted.
   */
  userAgent?: string;
  /** Runtime context providing cache, storage, database, search, queue, and media adapters. */
  runtime: RuntimeContext;
  /**
   * Internal response-type marker for observability/log enrichment.
   * Currently used by `adminPathGuard` (admin-setup-wizard Req 5.2) to
   * tag a request as serving the Studio HTML/asset bundle vs. a regular
   * API response. Optional — most requests leave it unset.
   */
  responseType?: 'STUDIO_HTML';
  /**
   * Test-only injection seam for the public recovery routes
   * (admin-setup-wizard task 10.7; design §4.7, §4.8). When set via
   * `c.set('recoveryServiceOverride', stub)` *before* the recovery
   * router runs, `modules/recovery/routes.ts` uses the stub instead of
   * constructing a real `RecoveryService` — so the route handlers can be
   * exercised without a live Postgres or the in-memory token stores.
   *
   * Declared structurally (rather than importing `RecoveryService`) to
   * keep `env.ts` free of route/service imports and avoid an import
   * cycle. The real `RecoveryService` satisfies this shape, mirroring
   * the `setupServiceOverride` convention referenced in
   * `modules/setup/routes.ts`.
   */
  recoveryServiceOverride?: {
    recover(
      email: string,
      backupCode: string,
      ip: string,
    ): Promise<{
      readonly adminPath: string;
      readonly oneTimeUnlockToken: string;
    } | null>;
    forgotPath(email: string, ip: string): Promise<void>;
    validateUnlockToken(token: string): Promise<{ readonly userId: string } | null>;
  };
  /**
   * Test-only injection seam for the public setup routes. When set via
   * `c.set('setupServiceOverride', stub)` *before* the setup router runs,
   * `modules/setup/routes.ts` uses the stub instead of constructing a real
   * `SetupService` — so `POST /setup/complete` can be exercised without a
   * live Postgres. Declared structurally (only the `complete` method the
   * route calls) to keep `env.ts` free of route/service imports, mirroring
   * `recoveryServiceOverride`. The real `SetupService` satisfies this shape.
   */
  setupServiceOverride?: {
    complete(
      input: unknown,
      ctx: unknown,
    ): Promise<
      | { readonly ok: true; readonly value: unknown }
      | { readonly ok: false; readonly error: unknown }
    >;
  };
}

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
