// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono } from 'hono';
import { internalTlsRouter } from './routes/internal-tls';
import { cors } from 'hono/cors';
import type { AppEnv } from './env';
import { resolveCorsOrigin } from './config/cors';
import { adminPathGuard } from './middleware/admin-path-guard';
import { withAuditContext } from './middleware/audit-context';
import { withJsonBodyLimit } from './middleware/body-limit';
import { withAuth } from './middleware/auth';
import { withDb } from './middleware/db';
import { withLogger } from './middleware/logger';
import { withRateLimit } from './middleware/rate-limit';
import { withDeliverRateLimit } from './middleware/deliver-rate-limit';
import { withRls } from './middleware/rls';
import { withRuntime } from './middleware/runtime';
import { requireSetupComplete } from './middleware/setup-required';
import { withSiteMembership } from './middleware/site-membership';
import { withStudioAccess } from './middleware/studio-access';
import { withControlPlaneAccessGuard } from './middleware/control-plane-access-guard';
import { withFileUploadPolicy } from './middleware/file-upload-policy';
import { withSecurityHeaders } from './middleware/security-headers';
import { withTenant } from './middleware/tenant';
import { withTenantExists } from './middleware/tenant-exists';
import { withTracing } from './middleware/tracing';
import { activityRouter } from './routes/activity';
import { accessRouter } from './routes/access';
import { accessGrantsRouter } from './routes/access-grants';
import { adminRouter } from './routes/admin';
import { configRouter } from './routes/config';
import { authRouter, meRouter } from './routes/auth';
import { tfaAuthRouter, tfaMeRouter } from './routes/tfa';
import { adminSecurityRouter } from './routes/admin-security';
import { adminAuthIssuersRouter } from './routes/admin-auth-issuers';
import { adminEncryptionRouter } from './routes/admin-encryption';
import { editorialRouter } from './routes/editorial';
import { adminErasureRouter } from './routes/admin-erasure';
import { adminFieldAccessRouter } from './routes/admin-field-access';
import { adminSarRouter } from './routes/admin-sar';
import { apiKeysRouter } from './routes/api-keys';
import { collectionsRouter } from './routes/collections';
import { automatedDecisionsRouter } from './routes/automated-decisions';
import { consentRouter } from './routes/consent';
import { dataExportRouter } from './routes/data-export';
import { restrictionRouter } from './routes/restriction';
import { retentionRouter } from './routes/retention';
import { emailPublicRouter } from './routes/email-public';
import { deliverRouter } from './routes/deliver';
import { deploymentsRouter, deploymentsWebhookRouter } from './routes/deployments';
import { extensionsRouter } from './routes/extensions';
import { filesRouter } from './routes/files';
import { flowsRouter } from './routes/flows';
import { itemsRouter } from './routes/items';
import { handleGraphQL } from './graphql';
import { enabledFeatures, requireFeature } from './config/features';
import { permissionsRouter } from './routes/permissions';
import { policiesRouter } from './routes/policies';
import { presetsRouter } from './routes/presets';
import { realtimeRouter } from './routes/realtime';
import { relationsRouter } from './routes/relations';
import { releasesRouter } from './routes/releases';
import { rolesRouter } from './routes/roles';
import { healthRouter } from './routes/health';
import { insightsRouter } from './routes/insights';
import { mediaRouter } from './routes/media';
import { editorMediaRouter } from './routes/editor-media';
import { transformPresetsRouter } from './routes/transform-presets';
import { uploadsRouter } from './routes/uploads';
import { marketplaceRouter } from './routes/marketplace';
import { materializeRouter } from './routes/materialize';
import { metricsRouter, withMetrics } from './routes/metrics';
import { searchRouter } from './routes/search';
import { settingsRouter } from './routes/settings';
import { domainsRouter } from './routes/domains';
import { storageProfilesRouter } from './routes/storage-profiles';
import { notificationChannelsRouter } from './routes/notification-channels';
import { ingestDocumentsRouter } from './routes/ingest-documents';
import { ingestSourcesRouter } from './routes/ingest-sources';
import { ingestProvidersRouter } from './routes/ingest-providers';
import { ingestLifecycleRouter } from './routes/ingest-lifecycle';
import { llmRouter } from './routes/llm';
import { qualityGateRouter } from './routes/quality-gate';
import { flowDraftsRouter } from './routes/flow-drafts';
import { promptWorkbenchRouter } from './routes/prompt-workbench';
import { autoPublishRouter } from './routes/auto-publish';
import { siteRouter } from './routes/site';
import { pluginEndpointsRouter } from './routes/plugin-endpoints';
import { pluginAdminRouter } from './routes/plugin-admin';
import { studioRouter } from './routes/studio';
import { sitesRouter } from './routes/sites';
import { themesRouter } from './routes/themes';
import { previewLinksRouter } from './routes/preview-links';
import { internalPreviewRouter } from './routes/internal-preview';
import { redirectsRouter } from './routes/redirects';
import { editorialProfileRouter } from './routes/editorial-profile';
import { translationGroupsRouter } from './routes/translation-groups';
// Registers the public projection flush that every site transaction runs before committing (P06).
import './services/site-network/public-projection';
import { systemRouter } from './routes/system';
import { shareAdminRouter, sharePublicRouter } from './routes/shares';
import { teamsRouter } from './routes/teams';
import { translationsRouter } from './routes/translations';
import { tmRouter } from './routes/translation-memory';
import { typegenRouter } from './routes/typegen';
import { usersRouter } from './routes/users';
import { utilsRouter, cacheUtilsRouter } from './routes/utils';
import { pagesRouter } from './routes/pages';
import { webhooksRouter } from './routes/webhooks';
import { testAuthRouter } from './routes/test-auth';
import { aiRouter } from './routes/ai';
import { agentRouter } from './routes/agent';
import { intentsRouter } from './routes/intents';
import { mcpRouter } from './routes/mcp';
import { agentAccessRouter, oauthPublicRouter } from './routes/agent-access';
import { agentsMcpRouter } from './routes/agents-mcp';
import { agentPlansRouter } from './routes/agent-plans';
import { setAgentDispatchApp } from './middleware/agent-dispatch';
import { emailRouter } from './modules/email/routes';
import { setupRouter } from './modules/setup/routes';
import { recoveryRouter } from './modules/recovery/routes';
import { auditRouter } from './modules/audit/routes';
import { cdcFeedRouter } from './modules/cdc/change-feed/routes';
import { pageviewsRouter, pageviewsPublicRouter } from './modules/pageviews/routes';
import {
  gitRouter,
  gitPublicRouter,
} from './modules/git-integration/routes';
import { formatSafeError } from '@heopress/contracts/utils';
import { RetryExhaustedError } from './services/rls-transaction';

const app = new Hono<AppEnv>();

// Global middleware. Order matters: logger first so it captures everything;
// CORS before auth so preflight requests succeed. Runtime must be available
// before tenant resolution (which may use the cache).
app.use('*', withLogger());
app.use('*', withTracing());
app.use('*', withSecurityHeaders());
app.use('*', withMetrics());
app.use('*', withRuntime());
app.use(
  '*',
  cors({
    origin: (origin, c) => resolveCorsOrigin(origin, c.env),
    credentials: true,
    allowHeaders: ['Authorization', 'Content-Type', 'X-HeoPress-Site', 'X-HeoPress-Client', 'X-Request-Id', 'X-HeoPress-Share-Password', 'X-HeoPress-Refresh'],
    exposeHeaders: ['X-Request-Id'],
  }),
);

// Audit-context middleware (admin-setup-wizard task 11.2; Req 15.1,
// 15.2; design §6.2). Slots in between `withLogger` (which sets
// `requestId`) and `adminPathGuard`, matching design §6.2's ordering:
// it resolves and stashes `ip` + `userAgent` onto the context so the
// guard, every route below, and every `AuditLogger.write` caller read
// the same audit dimensions uniformly. Placed after the
// `withRuntime`/`cors` block (which §6.2 doesn't enumerate) and just
// before the guard so the three audit dimensions are present for the
// entire downstream chain.
// App-level JSON body-size cap (high-load-cache-readiness Req 6.2).
// Defense-in-depth for deployments without the Caddy body limit; only
// guards JSON POST/PUT/PATCH via Content-Length, so it's a cheap no-op
// for reads and file uploads (which have their own policy).
app.use('*', withJsonBodyLimit());

app.use('*', withAuditContext());

// Admin Path Guard (admin-setup-wizard Req 5.1, 5.2, 5.4, 5.6, 5.7;
// design §6.2 + §7.2).
//
// Mounted *after* the global request-id/runtime stack so the guard
// can resolve a per-request DB via `c.get('runtime')`, and *before*
// any route mount so a probing bot hitting `/admin`, `/studio`, etc.
// gets the indistinguishable 404 envelope without ever touching a
// route handler. The guard internally bypasses `/api/*`, `/health`,
// `/metrics`, `/scim/*`, `/setup`, `/.well-known/*` (so the wizard
// surface, ops endpoints, and SCIM provisioning keep working) and
// fails open while `system_state.state !== 'initialized'` so a fresh
// instance can still reach the Setup Wizard at `/setup`.
//
// The `audit-context` middleware (task 11.2) now slots in just above
// this guard (see `app.use('*', withAuditContext())` directly above),
// so `ip` / `userAgent` / `requestId` are all populated before the
// guard and every downstream handler run — matching design §6.2.
app.use('*', adminPathGuard());

// Public utility endpoints (no tenant, no auth).
app.route('/api/v1/utils', utilsRouter);
app.route('/api/v1/system', systemRouter);
// Prometheus metrics endpoint (public, no auth). Off by default (P02 5.1).
app.use('/metrics', requireFeature('metrics'));
app.use('/metrics/*', requireFeature('metrics'));
app.route('/metrics', metricsRouter);
// Comprehensive health check — tests DB, cache, search, storage, queue connectivity.
app.route('/health', healthRouter);
// Reverse-proxy certificate gate (HeoPress P04): internal peers only, see the router.
app.use('/internal/tls/*', withDb());
app.route('/internal/tls', internalTlsRouter);
// The rendering service's preview reads (HeoPress P06): shared secret, no proxied requests, see the router.
app.use('/internal/preview/*', withDb());
app.route('/internal/preview', internalPreviewRouter);
// Serves interactive auth testing page
app.route('/test-auth', testAuthRouter);

// Setup wizard surface (`/api/v1/setup/*`). Public — does not pass through
// `withTenant`/`withAuth` because no user exists during first-time setup.
// `withRuntime` already ran globally so the per-request `withDb()` inside
// the router resolves the connection through the runtime's DatabaseProvider.
app.route('/api/v1/setup', setupRouter);

// Public recovery surface (admin-setup-wizard task 10.7; Req 14.4, 14.5,
// 14.8; design §4.7, §4.8). PUBLIC / pre-auth on purpose: the operator
// is locked out and CANNOT authenticate, so `/admin/security/recover`
// and `/admin/security/forgot-path` must NOT pass through `withAuth` or
// the `admin` role gate. The router applies only `withDb()` internally
// (like `setupRouter`).
//
// Mounted at `/api/v1/admin/security` *before* `app.route('/api/v1', api)`
// below — where the AUTHENTICATED `adminSecurityRouter` lives. Hono
// flattens sub-apps and matches by METHOD + exact leaf path, and the
// recovery router only registers `/recover` + `/forgot-path`. Those leaf
// paths are DISJOINT from the authenticated `/unlock-user` + `/unblock-ip`,
// so this public mount can NOT shadow them: a request to `/unlock-user`
// never matches a handler here and falls through to the authenticated
// `api` mount, still gated by `withAuth` + the admin check. Same
// coexistence mechanism the public `setupRouter` already relies on. See
// the header doc in `modules/recovery/routes.ts` for the full rationale.
app.route('/api/v1/admin/security', recoveryRouter);

// SCIM 2.0 provisioning was removed in HeoPress P02; `/scim/*` answers 404.

// Plugin public endpoints (HeoPress P12 task 3.3): `/_ext/<plugin>/<endpoint>`, public on purpose — forms are checked
// against the site's approved origins, callbacks by their signature; the site comes from the host (or `?site=`).
app.use('/_ext/*', withDb());
app.route('/_ext', pluginEndpointsRouter);

// Inbound deployment status webhook. PUBLIC / pre-auth on purpose: the
// provider (Vercel/Netlify) authenticates via request signature, not a bearer
// token. Needs `withTenant` (X-HeoPress-Site → siteId) + `withDb` to update the
// `deployments` row; `withRuntime` already ran globally for the KeyProvider.
app.use('/api/v1/deployments/webhook/*', withTenant(), withDb());
app.route('/api/v1/deployments/webhook', deploymentsWebhookRouter);

// Git integration public surface — OAuth callback + signature-verified webhook
// receiver. PUBLIC on purpose: providers and OAuth redirects cannot carry a
// session. The router applies only `withDb()` internally (like `setupRouter`).
// Mounted BEFORE the authenticated `api` so its leaf paths
// (`/oauth/:provider/callback`, `/webhook/:provider/:siteId/:integrationId`)
// win; all other `/integrations/git/*` paths fall through to the authenticated
// `gitRouter` below.
app.route('/api/v1/integrations/git', gitPublicRouter);

// Instance control plane (HeoPress P07 task 0.1): creating and deleting sites. The session is checked
// against the site it was issued for (tokens are site-bound), but nothing here acts on that site, and
// membership in it, Studio access and row-level security of it do not apply: the target site is in the
// request, and the instance capability (`services/sites/site-provisioning.ts`) decides. Mounted before the
// tenant-scoped `api` so its handlers answer first.
app.use('/api/v1/instance/*', withTenant(), withDb(), withTenantExists(), withAuth(), withRateLimit(), requireSetupComplete());
app.route('/api/v1/instance/sites', sitesRouter);

// External agents (HeoPress P10): the OAuth 2.1 authorization server (metadata, authorize, token, register,
// revoke — each carries its own credential) and the instance-level MCP endpoint, whose sites come from the token.
// Tool calls run as internal requests through this same application (`setAgentDispatchApp` below).
app.route('/', oauthPublicRouter);
app.route('/api/v1/agents/mcp', agentsMcpRouter);

// Authenticated + tenant-scoped surface.
const api = new Hono<AppEnv>();
api.use('*', withTenant(), withDb(), withTenantExists(), withAuth(), withSiteMembership(), withRateLimit(), requireSetupComplete(), withStudioAccess(), withControlPlaneAccessGuard(), withFileUploadPolicy(), withRls());
// Sub-routers must be attached to their parent BEFORE the parent is mounted
// on `api`: Hono's `route()` copies the child's routes at call time, so
// anything registered on `authRouter`/`meRouter` afterwards is invisible to
// the composed app and answers 404.
authRouter.route('/', tfaAuthRouter);
api.route('/auth', authRouter);
// `/me/*` — current-user endpoints kept outside `/auth` to honour the
// URL contract from admin-setup-wizard design §7.3 (`GET /api/v1/me/admin-path`).
// Mounted on the authenticated `api` Hono so `withAuth` already enforces
// that the caller has a valid session before the handler runs.
meRouter.route('/', tfaMeRouter);
api.route('/me', meRouter);
// `/me/consents` — self-service consent management (GDPR Art. 7, PDPD).
// Separate router from `meRouter`; mounted under the same authenticated `api`
// chain so the caller can only read/write their own consent.
api.route('/me/consents', consentRouter);
// `/me/data-export` — self-service "download my data" (GDPR Art. 15/20).
api.route('/me/data-export', dataExportRouter);
// `/me/restriction` — self-service restriction of processing (GDPR Art. 18).
api.route('/me/restriction', restrictionRouter);
// `/me/automated-decisions` — transparency over agent processing (GDPR Art. 22).
api.route('/me/automated-decisions', automatedDecisionsRouter);
// `/retention` — admin general data-retention pruning (site-admin only).
api.route('/retention', retentionRouter);
api.route('/collections', collectionsRouter);
api.route('/relations', relationsRouter);
api.route('/pages', pagesRouter);
api.route('/items', itemsRouter);
api.route('/releases', releasesRouter);
api.route('/editorial', editorialRouter);
// GraphQL surface (Yoga). Mounted inside the authenticated `api` sub-app so
// it inherits the full tenant → db → auth → RLS chain; `all` covers POST
// (operations) and GET (GraphiQL / introspection in non-prod).
// Off by default (P02 5.1): 404 unless HEOPRESS_ENABLE_GRAPHQL=true.
api.all('/graphql', requireFeature('graphql'), (c) => handleGraphQL(c));
api.route('/typegen', typegenRouter);
api.route('/roles', rolesRouter);
api.route('/policies', policiesRouter);
api.route('/permissions', permissionsRouter);
// Non-staff permission picker (`/api/v1/access/grants/*`). Mounted BEFORE
// `accessRouter` so its `/grants*` leaf paths win; every other `/access/*`
// path falls through to the import/export router, whose leaf paths
// (`/export`, `/import`, `/conflicts/check`) are disjoint from these.
api.route('/access', accessGrantsRouter);
api.route('/access', accessRouter);
api.route('/config', configRouter);
api.route('/api-keys', apiKeysRouter);
api.route('/search', searchRouter);
api.route('/media', mediaRouter);
api.route('/editor-media', editorMediaRouter);
api.route('/transform-presets', transformPresetsRouter);
// Upload policy config (effective allowlist/size for the picker; admin edits).
api.route('/uploads', uploadsRouter);
// Future routers: presets, translations, ...
api.route('/presets', presetsRouter);
api.route('/translations', translationsRouter);
api.route('/settings', settingsRouter);
api.route('/site', siteRouter);
// Plugin admin panels, settings and private storage (HeoPress P12 tasks 3.5–3.7).
api.route('/plugins', pluginAdminRouter);
api.route('/studio', studioRouter);
// Site themes (HeoPress P06): immutable versions, checked, activated under the site's settings lock.
api.route('/themes', themesRouter);
// Preview links (HeoPress P06): signed, time-limited, served on the preview origin by the rendering service.
api.route('/preview-links', previewLinksRouter);
api.route('/redirects', redirectsRouter);
api.route('/editorial-profile', editorialProfileRouter);
api.route('/translation-groups', translationGroupsRouter);
api.route('/domains', domainsRouter);
api.route('/storage-profiles', storageProfilesRouter);
api.route('/notification-channels', notificationChannelsRouter);
// Content sources (HeoPress P08): what each site ingests, when, and on what terms.
api.route('/ingest/sources', ingestSourcesRouter);
api.route('/ingest/providers', ingestProvidersRouter);
// Source documents (HeoPress P08 task 2.5): the raw snapshot only as an administrator's download.
api.route('/ingest/documents', ingestDocumentsRouter);
// After registration (HeoPress P08 tasks 1.6, 1.7, 2.9): settings, the licence review queue, research leads, media licences.
api.route('/ingest', ingestLifecycleRouter);
api.route('/llm', llmRouter);
// The AI content quality gate (HeoPress P09): results, reviews, per-site check levels.
api.route('/quality-gate', qualityGateRouter);
api.route('/auto-publish', autoPublishRouter);
// Prompt workbench trials (no content written) and agent-drafted flows awaiting a person's approval (HeoPress P09).
api.route('/prompt-workbench', promptWorkbenchRouter);
api.route('/flow-drafts', flowDraftsRouter);
api.route('/shares', shareAdminRouter);
api.route('/users', usersRouter);
api.route('/teams', teamsRouter);
api.route('/files', filesRouter);
api.route('/webhooks', webhooksRouter);
api.route('/deployments', deploymentsRouter);
api.route('/email', emailRouter);
api.route('/activity', activityRouter);
api.route('/realtime', realtimeRouter);
api.route('/extensions', extensionsRouter);
api.route('/pageviews', pageviewsRouter);
api.route('/admin', adminRouter);
// Admin Security surface (admin-setup-wizard task 6.4; Req 7.6, 7.7,
// 8.7, 8.8, 8.9; design §4.5, §4.6). Mounted *under* `withAuth` so the
// admin-role gate inside the router can rely on `c.get('auth').roles`
// being populated. Sibling to `/admin` rather than nested so future
// recovery routes (task 10.7) can mount alongside without reshuffling.
api.route('/admin/security', adminSecurityRouter);
// Admin Encryption surface (regulated-content-readiness task 3.4; Req 3.5).
// Sibling to `/admin/security`, also under `withAuth` with an in-router
// admin-role gate. Handles key-rotation metadata + key listing.
api.route('/admin/encryption', adminEncryptionRouter);
// Admin Erasure surface (regulated-content-readiness task 9.4; Req 11).
api.route('/admin/erasure', adminErasureRouter);
// Field Access Log query (regulated-content-readiness task 5.3; Req 6.3).
api.route('/admin/field-access-log', adminFieldAccessRouter);
// Subject Access Request export (regulated-content-readiness task 10.3; Req 13).
api.route('/admin/sar', adminSarRouter);
// Trusted external JWT issuers (external-jwt-auth §5). Admin-only CRUD.
// Off by default (P02 5.1): 404 unless HEOPRESS_ENABLE_EXTERNAL_ISSUERS=true.
api.use('/admin/auth/issuers', requireFeature('externalIssuers'));
api.use('/admin/auth/issuers/*', requireFeature('externalIssuers'));
api.route('/admin/auth/issuers', adminAuthIssuersRouter);
// Audit-log QUERY + EXPORT surface (admin-setup-wizard task 12.3; Req
// 15.4, 15.6; design §4.9, §4.10, §10.3, §10.4). SIBLING mount alongside
// `adminSecurityRouter` above, both under `withAuth`. The admin-role gate
// is enforced INSIDE `auditRouter` via its own `requireAdmin(c)` check
// (mirroring `adminSecurityRouter`), returning 403 FORBIDDEN when
// `c.get('auth').roles` lacks `'admin'`.
//
// Safe + non-shadowing: Hono flattens `app.route(...)` sub-apps and
// matches by METHOD + exact leaf path, and this router's leaf paths
// (`/audit-log`, `/audit-log/export`) are DISJOINT from
// adminSecurityRouter's (`/unlock-user`, `/unblock-ip`). So
// `/api/v1/admin/security/audit-log` resolves to `auditRouter` while
// `/unlock-user` still resolves to `adminSecurityRouter`, both behind
// `withAuth`. Same disjoint-leaf-path coexistence the recovery router
// relies on.
api.route('/admin/security', auditRouter);
api.route('/tm', tmRouter);
api.route('/flows', flowsRouter);
api.route('/marketplace', marketplaceRouter);
api.route('/materialize', materializeRouter);
api.route('/utils/cache', cacheUtilsRouter);
api.route('/dashboards', insightsRouter);
api.route('/ai', aiRouter);
// Content goals / drift detection / auto-repair and the multi-agent newsroom
// are off by default (P02 5.1); their paths answer 404 until enabled.
api.use('/agent/intents', requireFeature('contentGoals'));
api.use('/agent/intents/*', requireFeature('contentGoals'));
api.use('/agent/roles', requireFeature('agentNewsroom'));
api.use('/agent/roles/*', requireFeature('agentNewsroom'));
api.use('/agent/goals/:id/decompose', requireFeature('agentNewsroom'));
api.use('/agent/goals/:id/settle', requireFeature('agentNewsroom'));
api.route('/agent/intents', intentsRouter);
api.route('/agent', agentRouter);
// Which optional features this instance runs (Studio hides the rest).
api.get('/features', (c) => c.json({ data: enabledFeatures(c.env as unknown as Record<string, unknown>) }));
// MCP server (content-os task 4; Req 4.1). Same authenticated chain as the
// Agent API — the MCP adapter passes the token's roles to the harness, so
// both surfaces share one decision codepath (Property 14).
api.route('/mcp', mcpRouter);
// The person's agent access (HeoPress P10): OAuth consent, connected agents, personal access tokens.
api.route('/agent-access', agentAccessRouter);
// Batch operation plans (HeoPress P10 tasks 3.2–3.4): reviewed, approved and run by a person in Studio.
api.route('/agent-plans', agentPlansRouter);

// Change Feed (spec cdc-extension-integration): capability-gated reads and
// site-admin management under `/api/v1/cdc/*`. The ClickHouse CDC control plane
// that shared this prefix was removed in HeoPress P02.
api.route('/cdc', cdcFeedRouter);


// Git integration (GitHub / GitLab) authenticated surface — `/api/v1/integrations/git/*`.
// Same posture as CDC: upstream tenant/auth/db/rls + the router's own
// `requireSiteAdmin()` gate. The public OAuth-callback + webhook routes are
// mounted above on the top-level `app` and win for their disjoint leaf paths.
api.route('/integrations/git', gitRouter);

// Share links are public. The opaque token resolves the site and share role.
app.use('/api/v1/shares/*', withDb());
app.route('/api/v1/shares', sharePublicRouter);

// Email unsubscribe is public (CAN-SPAM one-click). The signed token resolves
// the site, so no session/tenant header is required. Registered before the
// authenticated `api` mount so `/email/unsubscribe` wins; all other `/email/*`
// paths fall through to the authenticated `emailRouter`.
app.use('/api/v1/email/unsubscribe', withDb());
app.route('/api/v1/email', emailPublicRouter);

// Delivery (public) routes — tenancy is encoded in the URL. MUST be mounted
// BEFORE `app.route('/api/v1', api)`: the authenticated sub-app's `use('*')`
// chain flattens to `/api/v1/*`, so any handler registered after that mount
// runs the tenant/auth middleware first and an anonymous read is rejected
// with 400/401 before it can reach the handler. Registering the public
// handlers first makes them win for their disjoint paths (same mechanism as
// the shares/email mounts above).
app.use('/api/v1/deliver/*', withDb(), withDeliverRateLimit());
app.route('/api/v1/deliver', deliverRouter);

// Public pageview beacon — tenancy in the URL, unauthenticated. `withRuntime`
// ran globally; add `withDb` + the general rate limiter (keyed by IP since no
// principal exists) so a single client can't flood the ingest endpoint.
// Middleware is scoped to the beacon leaf so the authenticated
// `/api/v1/pageviews/stats` (mounted on `api` below) doesn't run it twice.
app.use('/api/v1/pageviews/:site_id/hit', withDb(), withRateLimit());
app.route('/api/v1/pageviews', pageviewsPublicRouter);

app.route('/api/v1', api);

app.notFound((c) =>
  c.json({ errors: [{ code: 'NOT_FOUND', message: 'Route not found.' }] }, 404),
);
app.onError((err, c) => {
  const requestId = c.get('requestId');
  // A write that kept having to start over (P07): the client may try again — never a 500.
  if (err instanceof RetryExhaustedError) {
    return c.json({ errors: [{ code: err.code, message: err.message, requestId }] }, 409);
  }
  console.error('[heopress-cms] unhandled error', { requestId, err: formatSafeError(err) });
  return c.json(
    { errors: [{ code: 'INTERNAL', message: 'Internal Server Error', requestId }] },
    500,
  );
});

setAgentDispatchApp(app);

export default app;
