import { Hono, type Context } from 'hono';
import { systemState } from '@heopress/database';
import type { AppEnv } from '../env';
import { withDb } from '../middleware/db';
import { consumeRateLimit } from '../middleware/rate-limit-helper';
import { AgentAccessService, OAuthError, scopeString } from '../services/agent-access/agent-access-service';
import { TOOL_GROUPS } from '../services/agent-access/mcp-tool-catalog';
import { recordSystemEvent } from '../services/ops/system-events';
import { formatSafeError } from '@heopress/contracts/utils';

/**
 * The OAuth 2.1 authorization server of the agent MCP endpoint and the person's agent access (HeoPress P10 tasks
 * 1.1–1.5; spec agents/mcp-access; docs/zh-CN/agents/mcp-authorization.md).
 *
 * Public (no session; each carries its own credential), mounted on the application before the tenant chain:
 * - `GET /.well-known/oauth-protected-resource[/api/v1/agents/mcp]` — protected resource metadata (RFC 9728);
 * - `GET /.well-known/oauth-authorization-server` — authorization server metadata (RFC 8414);
 * - `GET /api/v1/oauth/authorize` — validates the request, then sends the browser to the Studio consent page;
 * - `POST /api/v1/oauth/token`, `/register` (RFC 7591, rate limited), `/revoke` (RFC 7009).
 *
 * Signed in (Studio session only — never an API key, never an agent token), on the tenant chain:
 * - `GET|POST /api/v1/agent-access/consent` — the consent page's request and decision;
 * - `GET /api/v1/agent-access/grants`, `POST /api/v1/agent-access/tokens`, `DELETE /api/v1/agent-access/grants/:id`.
 */

const MCP_PATH = '/api/v1/agents/mcp';
const REGISTER_LIMIT_PER_HOUR = 20;

function env(c: Context<AppEnv>, key: string): string | undefined {
  const v = (c.env as unknown as Record<string, string | undefined> | undefined)?.[key] ?? process.env[key];
  return v?.trim() || undefined;
}

/** The public origin: `HEOPRESS_PUBLIC_URL` (set it in production), else the request's own origin. */
function publicBase(c: Context<AppEnv>): string {
  const explicit = env(c, 'HEOPRESS_PUBLIC_URL');
  if (explicit) return explicit.replace(/\/+$/, '');
  return new URL(c.req.url).origin;
}

/** The MCP endpoint's resource URL — the audience every token is bound to. */
export function mcpResource(c: Context<AppEnv>): string {
  return `${publicBase(c)}${MCP_PATH}`;
}

export function resourceMetadataUrl(c: Context<AppEnv>): string {
  return `${publicBase(c)}/.well-known/oauth-protected-resource${MCP_PATH}`;
}

export function agentAccessService(c: Context<AppEnv>): AgentAccessService {
  const jwtSecret = env(c, 'JWT_SECRET');
  if (!jwtSecret) throw new Error('JWT_SECRET configuration missing.');
  return new AgentAccessService({ db: c.get('db'), jwtSecret });
}

function oauthError(c: Context<AppEnv>, err: unknown) {
  c.header('Cache-Control', 'no-store');
  if (err instanceof OAuthError) {
    if (err.status === 401) c.header('WWW-Authenticate', 'Basic realm="heopress-oauth"');
    return c.json({ error: err.error, error_description: err.message }, err.status);
  }
  console.error('[oauth] unexpected error', formatSafeError(err));
  return c.json({ error: 'server_error', error_description: 'Unexpected error.' }, 500);
}

async function formOf(c: Context<AppEnv>): Promise<URLSearchParams> {
  const type = c.req.header('content-type') ?? '';
  if (!type.includes('application/x-www-form-urlencoded')) throw new OAuthError('invalid_request', 'Use application/x-www-form-urlencoded.');
  const text = await c.req.text();
  if (text.length > 16_384) throw new OAuthError('invalid_request', 'Request too large.');
  return new URLSearchParams(text);
}

export const oauthPublicRouter = new Hono<AppEnv>();
// Only the OAuth endpoints need the database (the metadata documents do not); nothing else on the application.
oauthPublicRouter.use('/api/v1/oauth/*', withDb());

const protectedResourceMetadata = (c: Context<AppEnv>) =>
  c.json({
    resource: mcpResource(c),
    authorization_servers: [publicBase(c)],
    scopes_supported: TOOL_GROUPS.map((g) => `mcp:${g}`),
    bearer_methods_supported: ['header'],
    resource_name: 'HeoPress MCP',
  });

oauthPublicRouter.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, protectedResourceMetadata);
oauthPublicRouter.get('/.well-known/oauth-protected-resource', protectedResourceMetadata);

oauthPublicRouter.get('/.well-known/oauth-authorization-server', (c) => {
  const base = publicBase(c);
  return c.json({
    issuer: base,
    authorization_endpoint: `${base}/api/v1/oauth/authorize`,
    token_endpoint: `${base}/api/v1/oauth/token`,
    registration_endpoint: `${base}/api/v1/oauth/register`,
    revocation_endpoint: `${base}/api/v1/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: TOOL_GROUPS.map((g) => `mcp:${g}`),
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  });
});

/** Where the Studio is served: `HEOPRESS_STUDIO_URL`, else the public origin; under the private admin path. */
async function consentPageUrl(c: Context<AppEnv>, requestToken: string): Promise<string> {
  const studio = (env(c, 'HEOPRESS_STUDIO_URL') ?? publicBase(c)).replace(/\/+$/, '');
  const [state] = await c.get('db').select({ adminPath: systemState.adminPath }).from(systemState).limit(1);
  const adminPath = state?.adminPath ? `/${state.adminPath.replace(/^\/+|\/+$/g, '')}` : '';
  return `${studio}${adminPath}/agent-access/consent?request=${encodeURIComponent(requestToken)}`;
}

oauthPublicRouter.get('/api/v1/oauth/authorize', async (c) => {
  try {
    const outcome = await agentAccessService(c).authorize(new URL(c.req.url).searchParams, mcpResource(c));
    if (outcome.kind === 'error') {
      c.header('Cache-Control', 'no-store');
      return c.json({ error: outcome.error, error_description: outcome.description }, 400);
    }
    if (outcome.kind === 'redirect_error') return c.redirect(outcome.location, 302);
    return c.redirect(await consentPageUrl(c, outcome.requestToken), 302);
  } catch (err) {
    return oauthError(c, err);
  }
});

oauthPublicRouter.post('/api/v1/oauth/token', async (c) => {
  try {
    const tokens = await agentAccessService(c).token(await formOf(c), c.req.header('authorization'), mcpResource(c));
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    return c.json(tokens);
  } catch (err) {
    return oauthError(c, err);
  }
});

oauthPublicRouter.post('/api/v1/oauth/revoke', async (c) => {
  try {
    await agentAccessService(c).revokeToken(await formOf(c), c.req.header('authorization'));
    c.header('Cache-Control', 'no-store');
    return c.body(null, 200);
  } catch (err) {
    return oauthError(c, err);
  }
});

oauthPublicRouter.post('/api/v1/oauth/register', async (c) => {
  const ip = c.get('ip') ?? null;
  const limited = await consumeRateLimit(c.get('runtime')?.rateLimiter, `oauth-register:${ip ?? 'unknown'}`, Number(env(c, 'HEOPRESS_OAUTH_REGISTER_LIMIT') ?? REGISTER_LIMIT_PER_HOUR), 3600);
  if (limited.status !== 'allow') {
    c.header('Retry-After', String(limited.retryAfterSeconds));
    return c.json({ error: 'temporarily_unavailable', error_description: 'Too many client registrations; try again later.' }, 429);
  }
  const length = Number(c.req.header('content-length') ?? 0);
  if (length > 16_384) return c.json({ error: 'invalid_client_metadata', error_description: 'Registration too large.' }, 400);
  try {
    const body = await c.req.json().catch(() => {
      throw new OAuthError('invalid_client_metadata', 'Body must be JSON.');
    });
    const client = await agentAccessService(c).registerClient(body, ip);
    c.header('Cache-Control', 'no-store');
    return c.json(client, 201);
  } catch (err) {
    return oauthError(c, err);
  }
});

// ── signed-in: consent and the person's grants ───────────────────────

export const agentAccessRouter = new Hono<AppEnv>();

/** Only a person signed in to Studio decides about agent access — never an API key, a subscriber or an agent token. */
function personOf(c: Context<AppEnv>): string | null {
  const auth = c.get('auth');
  if (!auth?.userId || auth.type === 'api_key' || auth.type === 'anonymous' || auth.apiKeyId || auth.isFrontendUser) return null;
  if (auth.method !== 'session' && auth.method !== 'cf_access' && auth.method !== 'external') return null;
  return auth.userId;
}

const notPerson = (c: Context<AppEnv>) =>
  c.json({ errors: [{ code: 'FORBIDDEN', message: 'Agent access is managed by a person signed in to Studio.' }] }, 403);

const failure = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof OAuthError) {
    const status = err.status === 401 ? 400 : err.status;
    return c.json({ errors: [{ code: err.error.toUpperCase(), message: err.message }] }, status);
  }
  throw err;
};

agentAccessRouter.get('/consent', async (c) => {
  const userId = personOf(c);
  if (!userId) return notPerson(c);
  try {
    const service = agentAccessService(c);
    const request = await service.readRequest(c.req.query('request') ?? '');
    let redirectHost = '';
    try {
      redirectHost = new URL(request.redirectUri).host || new URL(request.redirectUri).protocol;
    } catch {
      redirectHost = '';
    }
    return c.json({
      data: {
        client: { id: request.clientId, name: request.clientName, redirectHost },
        requestedGroups: request.requestedGroups,
        groups: TOOL_GROUPS,
        sites: await service.choosableSites(userId),
        resource: request.resource,
      },
    });
  } catch (err) {
    return failure(c, err);
  }
});

agentAccessRouter.post('/consent', async (c) => {
  const userId = personOf(c);
  if (!userId) return notPerson(c);
  const body = (await c.req.json().catch(() => null)) as { request?: unknown; approve?: unknown; siteIds?: unknown; toolGroups?: unknown } | null;
  try {
    const out = await agentAccessService(c).decide(
      userId,
      typeof body?.request === 'string' ? body.request : '',
      { approve: body?.approve === true, siteIds: body?.siteIds, toolGroups: body?.toolGroups },
      publicBase(c),
    );
    await recordSystemEvent(c.get('db'), {
      level: 'info',
      source: 'agents',
      event: out.grantId ? 'agent_oauth_granted' : 'agent_oauth_denied',
      message: out.grantId ? 'An agent was authorized.' : 'An agent authorization was declined.',
      actor: userId,
      data: out.grantId ? { grantId: out.grantId, siteIds: body?.siteIds, scope: scopeString(Array.isArray(body?.toolGroups) ? (body.toolGroups as string[]) : []) } : {},
    });
    return c.json({ data: { redirectTo: out.redirectTo } });
  } catch (err) {
    return failure(c, err);
  }
});

agentAccessRouter.get('/grants', async (c) => {
  const userId = personOf(c);
  if (!userId) return notPerson(c);
  const service = agentAccessService(c);
  return c.json({ data: { grants: await service.listGrants(userId), sites: await service.choosableSites(userId), groups: TOOL_GROUPS, mcpEndpoint: mcpResource(c) } });
});

agentAccessRouter.post('/tokens', async (c) => {
  const userId = personOf(c);
  if (!userId) return notPerson(c);
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  try {
    const created = await agentAccessService(c).createPersonalToken(userId, body, mcpResource(c));
    await recordSystemEvent(c.get('db'), {
      level: 'info',
      source: 'agents',
      event: 'agent_token_created',
      message: 'A personal access token was created.',
      actor: userId,
      data: { grantId: created.grant.id, siteIds: created.grant.siteIds, toolGroups: created.grant.toolGroups },
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: created }, 201);
  } catch (err) {
    return failure(c, err);
  }
});

agentAccessRouter.delete('/grants/:id', async (c) => {
  const userId = personOf(c);
  if (!userId) return notPerson(c);
  const revoked = await agentAccessService(c).revokeGrant(userId, c.req.param('id'));
  if (!revoked) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No such authorization.' }] }, 404);
  await recordSystemEvent(c.get('db'), {
    level: 'info',
    source: 'agents',
    event: 'agent_grant_revoked',
    message: 'An agent authorization was revoked.',
    actor: userId,
    data: { grantId: c.req.param('id') },
  });
  return c.json({ data: { revoked: true } });
});
