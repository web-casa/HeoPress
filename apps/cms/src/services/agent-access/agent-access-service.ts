import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { SignJWT, jwtVerify } from 'jose';
import { agentGrants, apiKeys, oauthClients, oauthCodes, oauthTokens, sites, users, userSites, type Database } from '@heopress/database';
import { outboundBlockOf, outboundFetch } from '@heopress/runtime/node';
import { TOOL_GROUPS, type ToolGroup } from './mcp-tool-catalog';
import { ClientRegistrationError, redirectUriMatches, validateClientMetadata } from './oauth-clients';

/**
 * The OAuth 2.1 authorization server and token store behind the agent MCP endpoint (HeoPress P10 tasks 1.1–1.5;
 * spec agents/mcp-access).
 *
 * - Authorization code + PKCE, `S256` only; a request without a challenge is refused.
 * - Every token is bound to one resource (RFC 8707): the MCP endpoint's URL. A request for another resource is
 *   refused (`invalid_target`), and a token whose resource is not this endpoint is not accepted by it.
 * - Codes are single use and live 60 s; presenting a used code revokes the grant it issued.
 * - Refresh tokens rotate on every use; presenting a used one revokes the whole grant (reuse detection).
 * - A grant records the sites and tool groups the person chose; every call intersects it with the person's live
 *   state (active, same `token_version`, still a member of the site) — the route then applies live RBAC.
 * - Personal access tokens are grants of kind `pat` with the same limits.
 *
 * Opaque tokens (32 random bytes, SHA-256 stored). Every read and write runs in a transaction that sets
 * `app.agent_access`, the only way the optional row-level security lets the application role at these tables.
 */

const ACCESS_TOKEN_TTL_S = 3600;
const REFRESH_TOKEN_TTL_S = 30 * 86_400;
const CODE_TTL_S = 60;
const REQUEST_TTL_S = 600;
const CIMD_TTL_MS = 86_400_000;
const PAT_MAX_DAYS = 365;

const TOKEN_PREFIX = { access: 'hpo_at_', refresh: 'hpo_rt_', pat: 'hpo_pat_', code: 'hpo_ac_', secret: 'hpo_cs_' } as const;
const REQUEST_AUDIENCE = 'heopress-oauth-authorization-request';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString('base64url')}`;
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** An OAuth error as the token, registration and revocation endpoints answer it (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status: 400 | 401 | 403 | 429 = 400,
  ) {
    super(message);
  }
}

/** The authorization request after validation; carried to the consent page as a signed, short-lived JWT. */
export interface AuthorizationRequest {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string | null;
  /** The groups the client asked for (`scope`); null when it asked for none (the person chooses freely). */
  requestedGroups: ToolGroup[] | null;
}

/** Where the authorization endpoint sends the browser. */
export type AuthorizeOutcome =
  | { kind: 'consent'; request: AuthorizationRequest; requestToken: string }
  /** Redirect back to the client with an error (the client and redirect URI were valid). */
  | { kind: 'redirect_error'; location: string }
  /** Never redirect: the client or redirect URI cannot be trusted. */
  | { kind: 'error'; error: string; description: string };

export interface AgentPrincipal {
  kind: 'oauth' | 'pat' | 'api_key';
  /** The person (OAuth, PAT); null for an API key. */
  userId: string | null;
  email: string | null;
  apiKeyId: string | null;
  grantId: string | null;
  siteIds: string[];
  toolGroups: ToolGroup[];
}

export type AuthenticateResult = { ok: true; principal: AgentPrincipal } | { ok: false; reason: string };

export interface IssuedTokens {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export interface AgentAccessDeps {
  db: Database;
  /** HS256 secret signing the authorization request handed to the consent page. */
  jwtSecret: string;
  now?: () => Date;
  /** Fetches a client id metadata document. Defaults to the platform outbound boundary (`purpose: 'user'`). */
  fetchClientMetadata?: (url: string) => Promise<Response>;
}

const defaultFetchClientMetadata = (url: string): Promise<Response> =>
  outboundFetch(url, {
    purpose: 'user',
    maxRedirects: 0,
    timeoutMs: 5_000,
    maxResponseBytes: 64 * 1024,
    headers: { accept: 'application/json' },
  });

export function scopeString(groups: readonly string[]): string {
  return groups.map((g) => `mcp:${g}`).join(' ');
}

/** `mcp:read mcp:content` → groups; unknown scopes are an error. */
export function parseScope(scope: string | null | undefined): ToolGroup[] | null {
  if (!scope || !scope.trim()) return null;
  const groups: ToolGroup[] = [];
  for (const token of scope.trim().split(/\s+/)) {
    const g = token.startsWith('mcp:') ? token.slice(4) : '';
    if (!(TOOL_GROUPS as readonly string[]).includes(g)) throw new OAuthError('invalid_scope', `Unknown scope "${token}".`);
    if (!groups.includes(g as ToolGroup)) groups.push(g as ToolGroup);
  }
  return groups;
}

function normalizeGroups(input: unknown): ToolGroup[] {
  if (!Array.isArray(input)) return [];
  const out: ToolGroup[] = [];
  for (const g of input) if ((TOOL_GROUPS as readonly string[]).includes(String(g)) && !out.includes(g as ToolGroup)) out.push(g as ToolGroup);
  return TOOL_GROUPS.filter((g) => out.includes(g));
}

export class AgentAccessService {
  private readonly now: () => Date;
  private readonly fetchClientMetadata: (url: string) => Promise<Response>;

  constructor(private readonly deps: AgentAccessDeps) {
    this.now = deps.now ?? (() => new Date());
    this.fetchClientMetadata = deps.fetchClientMetadata ?? defaultFetchClientMetadata;
  }

  /** Every access to the agent-access tables: one transaction with `app.agent_access` set. */
  private tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.deps.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.agent_access', 'on', true)`);
      return fn(tx);
    });
  }

  // ── clients ─────────────────────────────────────────────────────────

  /** Dynamic client registration (RFC 7591). Public clients get no secret. */
  async registerClient(body: unknown, ip: string | null): Promise<Record<string, unknown>> {
    let meta;
    try {
      meta = validateClientMetadata(body);
    } catch (err) {
      if (err instanceof ClientRegistrationError) throw new OAuthError(err.error, err.message);
      throw err;
    }
    const id = `hpc_${randomBytes(16).toString('base64url')}`;
    const secret = meta.tokenEndpointAuthMethod === 'none' ? null : randomToken(TOKEN_PREFIX.secret);
    const createdAt = this.now();
    await this.tx((tx) =>
      tx.insert(oauthClients).values({
        id,
        source: 'dcr',
        clientName: meta.clientName,
        redirectUris: meta.redirectUris,
        tokenEndpointAuthMethod: meta.tokenEndpointAuthMethod,
        clientSecretHash: secret ? sha256(secret) : null,
        metadata: meta.metadata,
        registeredIp: ip,
        createdAt,
      }),
    );
    return {
      client_id: id,
      client_id_issued_at: Math.floor(createdAt.getTime() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: meta.clientName ?? undefined,
      redirect_uris: meta.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: meta.tokenEndpointAuthMethod,
      ...meta.metadata,
    };
  }

  /**
   * A client by id. An https client id is a client id metadata document: fetched through the outbound guard (no
   * redirects, 5 s, 64 KiB, internal addresses refused) and kept for a day. Null when unknown or unusable.
   */
  async client(clientId: string): Promise<typeof oauthClients.$inferSelect | null> {
    if (!clientId || clientId.length > 2048) return null;
    const [row] = await this.tx((tx) => tx.select().from(oauthClients).where(eq(oauthClients.id, clientId)).limit(1));
    if (row && (row.source === 'dcr' || (row.fetchedAt && this.now().getTime() - row.fetchedAt.getTime() < CIMD_TTL_MS))) return row;
    if (!clientId.startsWith('https://')) return row ?? null;
    return this.fetchMetadataDocument(clientId);
  }

  private async fetchMetadataDocument(clientId: string): Promise<typeof oauthClients.$inferSelect | null> {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || url.hash || url.username || url.password || url.pathname === '/') return null;
    let doc: unknown;
    try {
      const res = await this.fetchClientMetadata(url.href);
      if (res.status !== 200) return null;
      doc = await res.json();
    } catch (err) {
      // Blocked by the outbound guard (an internal address, a redirect …) or unreachable: the client is unknown.
      void outboundBlockOf(err);
      return null;
    }
    if (!doc || typeof doc !== 'object' || (doc as { client_id?: unknown }).client_id !== clientId) return null;
    let meta;
    try {
      meta = validateClientMetadata(doc);
    } catch {
      return null;
    }
    // A metadata document never carries a secret: the client is public.
    if (meta.tokenEndpointAuthMethod !== 'none') return null;
    const values = {
      id: clientId,
      source: 'cimd',
      clientName: meta.clientName,
      redirectUris: meta.redirectUris,
      tokenEndpointAuthMethod: 'none',
      clientSecretHash: null,
      metadata: meta.metadata,
      registeredIp: null,
      fetchedAt: this.now(),
    };
    const [row] = await this.tx((tx) =>
      tx
        .insert(oauthClients)
        .values(values)
        .onConflictDoUpdate({ target: oauthClients.id, set: { clientName: values.clientName, redirectUris: values.redirectUris, metadata: values.metadata, fetchedAt: values.fetchedAt } })
        .returning(),
    );
    return row ?? null;
  }

  // ── authorization endpoint ─────────────────────────────────────────

  async authorize(params: URLSearchParams, resource: string): Promise<AuthorizeOutcome> {
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri') ?? '';
    const client = await this.client(clientId);
    if (!client) return { kind: 'error', error: 'invalid_client', description: 'Unknown client.' };
    if (!redirectUri || !redirectUriMatches(client.redirectUris, redirectUri)) {
      return { kind: 'error', error: 'invalid_request', description: 'redirect_uri does not match a registered redirect URI.' };
    }
    const state = params.get('state');
    const fail = (error: string, description: string): AuthorizeOutcome => {
      const to = new URL(redirectUri);
      to.searchParams.set('error', error);
      to.searchParams.set('error_description', description);
      if (state) to.searchParams.set('state', state);
      return { kind: 'redirect_error', location: to.href };
    };
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type must be "code".');
    const challenge = params.get('code_challenge') ?? '';
    const method = params.get('code_challenge_method');
    if (!challenge) return fail('invalid_request', 'PKCE is required: code_challenge is missing.');
    if (method !== 'S256') return fail('invalid_request', 'PKCE code_challenge_method must be S256.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'code_challenge must be a base64url SHA-256 value.');
    const requestedResource = params.getAll('resource');
    if (requestedResource.length > 1 || (requestedResource[0] !== undefined && requestedResource[0] !== resource)) {
      return fail('invalid_target', 'The only resource this server issues tokens for is its MCP endpoint.');
    }
    let requestedGroups: ToolGroup[] | null;
    try {
      requestedGroups = parseScope(params.get('scope'));
    } catch (err) {
      return fail('invalid_scope', (err as Error).message);
    }
    const request: AuthorizationRequest = {
      clientId: client.id,
      clientName: client.clientName,
      redirectUri,
      codeChallenge: challenge,
      resource,
      state,
      requestedGroups,
    };
    const requestToken = await new SignJWT({ req: request })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(REQUEST_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${REQUEST_TTL_S}s`)
      .sign(new TextEncoder().encode(this.deps.jwtSecret));
    return { kind: 'consent', request, requestToken };
  }

  /** The authorization request behind a consent page; throws when forged or expired. */
  async readRequest(requestToken: string): Promise<AuthorizationRequest> {
    try {
      const { payload } = await jwtVerify(requestToken, new TextEncoder().encode(this.deps.jwtSecret), {
        algorithms: ['HS256'],
        audience: REQUEST_AUDIENCE,
      });
      return payload.req as AuthorizationRequest;
    } catch {
      throw new OAuthError('invalid_request', 'The authorization request is invalid or has expired; start again from the agent.');
    }
  }

  /** The sites a person may choose from: their memberships (every site for the instance administrator). */
  async choosableSites(userId: string): Promise<Array<{ id: string; name: string }>> {
    const [user] = await this.deps.db.select({ isBootstrap: users.isBootstrap, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user || user.status !== 'active') return [];
    if (user.isBootstrap) return this.deps.db.select({ id: sites.id, name: sites.name }).from(sites).orderBy(sites.name);
    return this.deps.db
      .select({ id: sites.id, name: sites.name })
      .from(userSites)
      .innerJoin(sites, eq(sites.id, userSites.siteId))
      .where(eq(userSites.userId, userId))
      .orderBy(sites.name);
  }

  private async checkChoice(userId: string, siteIds: unknown, toolGroups: unknown, cap: ToolGroup[] | null): Promise<{ siteIds: string[]; groups: ToolGroup[] }> {
    const wanted = Array.isArray(siteIds) ? [...new Set(siteIds.map(String))] : [];
    if (wanted.length === 0) throw new OAuthError('invalid_request', 'Choose at least one site.');
    const allowed = new Set((await this.choosableSites(userId)).map((s) => s.id));
    const outside = wanted.filter((s) => !allowed.has(s));
    if (outside.length) throw new OAuthError('access_denied', `You cannot authorize these sites: ${outside.join(', ')}.`, 403);
    const groups = normalizeGroups(toolGroups);
    if (groups.length === 0) throw new OAuthError('invalid_request', 'Choose at least one tool group.');
    if (cap && groups.some((g) => !cap.includes(g))) throw new OAuthError('invalid_scope', 'The agent did not ask for some of the chosen tool groups.');
    return { siteIds: wanted.sort(), groups };
  }

  /**
   * The person's decision on the consent page. Approval creates the grant and a code; the answer is where to send the
   * browser (back to the client's redirect URI, with `iss`).
   */
  async decide(
    userId: string,
    requestToken: string,
    decision: { approve: boolean; siteIds?: unknown; toolGroups?: unknown },
    issuer: string,
  ): Promise<{ redirectTo: string; grantId: string | null }> {
    const request = await this.readRequest(requestToken);
    const to = new URL(request.redirectUri);
    if (request.state) to.searchParams.set('state', request.state);
    to.searchParams.set('iss', issuer);
    if (!decision.approve) {
      to.searchParams.set('error', 'access_denied');
      return { redirectTo: to.href, grantId: null };
    }
    const choice = await this.checkChoice(userId, decision.siteIds, decision.toolGroups, request.requestedGroups);
    const code = randomToken(TOKEN_PREFIX.code);
    const grantId = await this.tx(async (tx) => {
      const [user] = await tx.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, userId)).limit(1);
      const [grant] = await tx
        .insert(agentGrants)
        .values({
          userId,
          kind: 'oauth',
          clientId: request.clientId,
          name: request.clientName ?? request.clientId,
          siteIds: choice.siteIds,
          toolGroups: choice.groups,
          resource: request.resource,
          tokenVersion: user?.tokenVersion ?? 0,
          expiresAt: new Date(this.now().getTime() + REFRESH_TOKEN_TTL_S * 1000),
        })
        .returning({ id: agentGrants.id });
      await tx.insert(oauthCodes).values({
        codeHash: sha256(code),
        grantId: grant!.id,
        clientId: request.clientId,
        redirectUri: request.redirectUri,
        codeChallenge: request.codeChallenge,
        resource: request.resource,
        expiresAt: new Date(this.now().getTime() + CODE_TTL_S * 1000),
      });
      return grant!.id;
    });
    to.searchParams.set('code', code);
    return { redirectTo: to.href, grantId };
  }

  // ── token endpoint ─────────────────────────────────────────────────

  /** Client authentication at the token and revocation endpoints. */
  async authenticateClient(form: URLSearchParams, authorization: string | undefined): Promise<typeof oauthClients.$inferSelect> {
    let clientId = form.get('client_id') ?? '';
    let secret = form.get('client_secret');
    if (authorization?.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i < 0) throw new OAuthError('invalid_client', 'Malformed client credentials.', 401);
      clientId = decodeURIComponent(decoded.slice(0, i));
      secret = decodeURIComponent(decoded.slice(i + 1));
    }
    const client = await this.client(clientId);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client.', 401);
    if (client.tokenEndpointAuthMethod === 'none') return client;
    if (!secret || !client.clientSecretHash || !safeEqual(sha256(secret), client.clientSecretHash)) {
      throw new OAuthError('invalid_client', 'Client authentication failed.', 401);
    }
    return client;
  }

  async token(form: URLSearchParams, authorization: string | undefined, resource: string): Promise<IssuedTokens> {
    const grantType = form.get('grant_type');
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
    }
    const client = await this.authenticateClient(form, authorization);
    const asked = form.getAll('resource');
    if (asked.length > 1 || (asked[0] !== undefined && asked[0] !== resource)) {
      throw new OAuthError('invalid_target', 'Tokens are only issued for this server’s MCP endpoint.');
    }
    return grantType === 'authorization_code' ? this.exchangeCode(form, client.id, resource) : this.refresh(form, client.id, resource);
  }

  private async exchangeCode(form: URLSearchParams, clientId: string, resource: string): Promise<IssuedTokens> {
    const code = form.get('code') ?? '';
    const verifier = form.get('code_verifier') ?? '';
    const redirectUri = form.get('redirect_uri') ?? '';
    const outcome = await this.tx(async (tx) => {
      const [row] = await tx.select().from(oauthCodes).where(eq(oauthCodes.codeHash, sha256(code))).limit(1);
      if (!row) return { error: 'The authorization code is invalid.' } as const;
      if (row.usedAt) {
        // Replay: the code was already exchanged — whoever holds the tokens it produced may not be the client.
        await this.revokeGrantIn(tx, row.grantId, 'code_replay');
        return { error: 'The authorization code was already used; its grant is revoked.' } as const;
      }
      if (row.expiresAt <= this.now()) return { error: 'The authorization code has expired.' } as const;
      if (row.clientId !== clientId) return { error: 'The authorization code was issued to another client.' } as const;
      if (row.redirectUri !== redirectUri) return { error: 'redirect_uri does not match the authorization request.' } as const;
      if (row.resource !== resource) return { error: 'The authorization code was issued for another resource.' } as const;
      if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEqual(s256(verifier), row.codeChallenge)) {
        return { error: 'PKCE verification failed.' } as const;
      }
      const claimed = await tx
        .update(oauthCodes)
        .set({ usedAt: this.now() })
        .where(and(eq(oauthCodes.codeHash, row.codeHash), isNull(oauthCodes.usedAt)))
        .returning({ grantId: oauthCodes.grantId });
      if (claimed.length === 0) {
        await this.revokeGrantIn(tx, row.grantId, 'code_replay');
        return { error: 'The authorization code was already used; its grant is revoked.' } as const;
      }
      const grant = await this.liveGrant(tx, row.grantId);
      if (!grant) return { error: 'The authorization is no longer valid.' } as const;
      return { tokens: await this.issue(tx, grant, null) } as const;
    });
    if ('error' in outcome) throw new OAuthError('invalid_grant', outcome.error!);
    return outcome.tokens;
  }

  private async refresh(form: URLSearchParams, clientId: string, resource: string): Promise<IssuedTokens> {
    const presented = form.get('refresh_token') ?? '';
    const outcome = await this.tx(async (tx) => {
      const [row] = await tx
        .select({ token: oauthTokens, grantClient: agentGrants.clientId })
        .from(oauthTokens)
        .innerJoin(agentGrants, eq(agentGrants.id, oauthTokens.grantId))
        .where(and(eq(oauthTokens.tokenHash, sha256(presented)), eq(oauthTokens.kind, 'refresh')))
        .limit(1);
      if (!row) return { error: 'The refresh token is invalid.' } as const;
      if (row.grantClient !== clientId) return { error: 'The refresh token was issued to another client.' } as const;
      if (row.token.usedAt) {
        await this.revokeGrantIn(tx, row.token.grantId, 'refresh_replay');
        return { error: 'The refresh token was already used; the authorization is revoked.' } as const;
      }
      if (row.token.revokedAt || row.token.expiresAt <= this.now()) return { error: 'The refresh token has expired or was revoked.' } as const;
      const claimed = await tx
        .update(oauthTokens)
        .set({ usedAt: this.now() })
        .where(and(eq(oauthTokens.id, row.token.id), isNull(oauthTokens.usedAt)))
        .returning({ id: oauthTokens.id });
      if (claimed.length === 0) {
        await this.revokeGrantIn(tx, row.token.grantId, 'refresh_replay');
        return { error: 'The refresh token was already used; the authorization is revoked.' } as const;
      }
      const grant = await this.liveGrant(tx, row.token.grantId);
      if (!grant || grant.resource !== resource) return { error: 'The authorization is no longer valid.' } as const;
      return { tokens: await this.issue(tx, grant, row.token.id) } as const;
    });
    if ('error' in outcome) throw new OAuthError('invalid_grant', outcome.error!);
    return outcome.tokens;
  }

  private async issue(tx: Tx, grant: typeof agentGrants.$inferSelect, parentId: string | null): Promise<IssuedTokens> {
    const access = randomToken(TOKEN_PREFIX.access);
    const refresh = randomToken(TOKEN_PREFIX.refresh);
    const now = this.now().getTime();
    await tx.insert(oauthTokens).values([
      { grantId: grant.id, kind: 'access', tokenHash: sha256(access), parentId, expiresAt: new Date(now + ACCESS_TOKEN_TTL_S * 1000) },
      { grantId: grant.id, kind: 'refresh', tokenHash: sha256(refresh), parentId, expiresAt: new Date(now + REFRESH_TOKEN_TTL_S * 1000) },
    ]);
    // A used grant stays alive as long as its newest refresh token.
    await tx.update(agentGrants).set({ expiresAt: new Date(now + REFRESH_TOKEN_TTL_S * 1000) }).where(eq(agentGrants.id, grant.id));
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TOKEN_TTL_S, refresh_token: refresh, scope: scopeString(grant.toolGroups) };
  }

  /** A grant that may still issue or accept tokens: not revoked, not expired, its person active with the same token version. */
  private async liveGrant(tx: Tx, grantId: string): Promise<typeof agentGrants.$inferSelect | null> {
    const [row] = await tx
      .select({ grant: agentGrants, status: users.status, tokenVersion: users.tokenVersion })
      .from(agentGrants)
      .innerJoin(users, eq(users.id, agentGrants.userId))
      .where(eq(agentGrants.id, grantId))
      .limit(1);
    if (!row || row.grant.revokedAt || (row.grant.expiresAt && row.grant.expiresAt <= this.now())) return null;
    if (row.status !== 'active' || row.tokenVersion !== row.grant.tokenVersion) return null;
    return row.grant;
  }

  private async revokeGrantIn(tx: Tx, grantId: string, reason: string): Promise<void> {
    const now = this.now();
    await tx.update(agentGrants).set({ revokedAt: now, revokeReason: reason }).where(and(eq(agentGrants.id, grantId), isNull(agentGrants.revokedAt)));
    await tx.update(oauthTokens).set({ revokedAt: now }).where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)));
  }

  /** RFC 7009: a refresh token (or a personal access token) ends its grant; an access token ends itself. Unknown tokens are not an error. */
  async revokeToken(form: URLSearchParams, authorization: string | undefined): Promise<void> {
    const client = await this.authenticateClient(form, authorization);
    const presented = form.get('token') ?? '';
    await this.tx(async (tx) => {
      const [row] = await tx
        .select({ token: oauthTokens, grantClient: agentGrants.clientId })
        .from(oauthTokens)
        .innerJoin(agentGrants, eq(agentGrants.id, oauthTokens.grantId))
        .where(eq(oauthTokens.tokenHash, sha256(presented)))
        .limit(1);
      if (!row || row.grantClient !== client.id) return;
      if (row.token.kind === 'refresh') await this.revokeGrantIn(tx, row.token.grantId, 'client');
      else await tx.update(oauthTokens).set({ revokedAt: this.now() }).where(eq(oauthTokens.id, row.token.id));
    });
  }

  // ── personal access tokens and the person's grants ───────────────────

  async createPersonalToken(
    userId: string,
    input: { name?: unknown; siteIds?: unknown; toolGroups?: unknown; expiresInDays?: unknown },
    resource: string,
  ): Promise<{ token: string; grant: GrantView }> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 100) throw new OAuthError('invalid_request', 'name: 1–100 characters.');
    const days = input.expiresInDays === undefined || input.expiresInDays === null ? 90 : Number(input.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > PAT_MAX_DAYS) throw new OAuthError('invalid_request', `expiresInDays: 1–${PAT_MAX_DAYS}.`);
    const choice = await this.checkChoice(userId, input.siteIds, input.toolGroups, null);
    const token = randomToken(TOKEN_PREFIX.pat);
    const row = await this.tx(async (tx) => {
      const [user] = await tx.select({ tokenVersion: users.tokenVersion }).from(users).where(eq(users.id, userId)).limit(1);
      const [created] = await tx
        .insert(agentGrants)
        .values({
          userId,
          kind: 'pat',
          name,
          siteIds: choice.siteIds,
          toolGroups: choice.groups,
          resource,
          tokenVersion: user?.tokenVersion ?? 0,
          tokenHash: sha256(token),
          tokenPrefix: token.slice(0, 14),
          expiresAt: new Date(this.now().getTime() + days * 86_400_000),
        })
        .returning();
      return created!;
    });
    return { token, grant: this.view(row, null) };
  }

  async listGrants(userId: string): Promise<GrantView[]> {
    const rows = await this.tx((tx) =>
      tx
        .select({ grant: agentGrants, clientName: oauthClients.clientName })
        .from(agentGrants)
        .leftJoin(oauthClients, eq(oauthClients.id, agentGrants.clientId))
        .where(and(eq(agentGrants.userId, userId), isNull(agentGrants.revokedAt)))
        .orderBy(sql`${agentGrants.createdAt} DESC`),
    );
    const now = this.now();
    return rows.filter((r) => !r.grant.expiresAt || r.grant.expiresAt > now).map((r) => this.view(r.grant, r.clientName));
  }

  /** Revoke one of the person's own grants. False when it is not theirs or already revoked. */
  async revokeGrant(userId: string, grantId: string): Promise<boolean> {
    return this.tx(async (tx) => {
      const [row] = await tx.select({ id: agentGrants.id }).from(agentGrants).where(and(eq(agentGrants.id, grantId), eq(agentGrants.userId, userId), isNull(agentGrants.revokedAt))).limit(1);
      if (!row) return false;
      await this.revokeGrantIn(tx, row.id, 'user');
      return true;
    });
  }

  private view(g: typeof agentGrants.$inferSelect, clientName: string | null): GrantView {
    return {
      id: g.id,
      kind: g.kind as 'oauth' | 'pat',
      name: g.kind === 'oauth' ? (clientName ?? g.name) : g.name,
      clientId: g.clientId,
      siteIds: g.siteIds,
      toolGroups: normalizeGroups(g.toolGroups),
      tokenPrefix: g.tokenPrefix,
      createdAt: g.createdAt.toISOString(),
      expiresAt: g.expiresAt?.toISOString() ?? null,
      lastUsedAt: g.lastUsedAt?.toISOString() ?? null,
    };
  }

  // ── the MCP endpoint's credential check ──────────────────────────────

  /**
   * Who is calling the MCP endpoint, from the bearer token alone: an OAuth access token or personal access token bound
   * to `resource`, or a site's API key (its own site; tool groups from `metadata.mcpToolGroups`, read-only when unset).
   */
  async authenticate(bearer: string, resource: string): Promise<AuthenticateResult> {
    if (!bearer) return { ok: false, reason: 'missing' };
    const now = this.now();
    if (bearer.startsWith(TOKEN_PREFIX.access) || bearer.startsWith(TOKEN_PREFIX.pat)) {
      const isPat = bearer.startsWith(TOKEN_PREFIX.pat);
      const row = await this.tx(async (tx) => {
        if (isPat) {
          const [g] = await tx.select().from(agentGrants).where(and(eq(agentGrants.tokenHash, sha256(bearer)), eq(agentGrants.kind, 'pat'))).limit(1);
          return g ? { grant: g, tokenOk: true } : null;
        }
        const [t] = await tx
          .select({ token: oauthTokens, grant: agentGrants })
          .from(oauthTokens)
          .innerJoin(agentGrants, eq(agentGrants.id, oauthTokens.grantId))
          .where(and(eq(oauthTokens.tokenHash, sha256(bearer)), eq(oauthTokens.kind, 'access')))
          .limit(1);
        return t ? { grant: t.grant, tokenOk: !t.token.revokedAt && t.token.expiresAt > now } : null;
      });
      if (!row) return { ok: false, reason: 'unknown_token' };
      const g = row.grant;
      if (!row.tokenOk || g.revokedAt || (g.expiresAt && g.expiresAt <= now)) return { ok: false, reason: 'revoked_or_expired' };
      if (g.resource !== resource) return { ok: false, reason: 'wrong_audience' };
      const [user] = await this.deps.db.select({ status: users.status, tokenVersion: users.tokenVersion, email: users.email }).from(users).where(eq(users.id, g.userId)).limit(1);
      if (!user || user.status !== 'active') return { ok: false, reason: 'user_inactive' };
      if (user.tokenVersion !== g.tokenVersion) return { ok: false, reason: 'credentials_changed' };
      if (!g.lastUsedAt || now.getTime() - g.lastUsedAt.getTime() > 60_000) {
        await this.tx((tx) => tx.update(agentGrants).set({ lastUsedAt: now }).where(eq(agentGrants.id, g.id)));
      }
      return {
        ok: true,
        principal: { kind: isPat ? 'pat' : 'oauth', userId: g.userId, email: user.email, apiKeyId: null, grantId: g.id, siteIds: g.siteIds, toolGroups: normalizeGroups(g.toolGroups) },
      };
    }
    const [key] = await this.deps.db.select().from(apiKeys).where(eq(apiKeys.tokenHash, sha256(bearer))).limit(1);
    if (!key) return { ok: false, reason: 'unknown_token' };
    if (key.revokedAt || (key.expiresAt && key.expiresAt <= now)) return { ok: false, reason: 'revoked_or_expired' };
    return {
      ok: true,
      principal: { kind: 'api_key', userId: null, email: null, apiKeyId: key.id, grantId: null, siteIds: [key.siteId], toolGroups: apiKeyToolGroups(key.metadata) },
    };
  }

  /** Of `siteIds`, the ones the person can still reach now (membership, or the instance administrator). */
  async liveSites(userId: string, siteIds: string[]): Promise<string[]> {
    if (siteIds.length === 0) return [];
    const [user] = await this.deps.db.select({ isBootstrap: users.isBootstrap }).from(users).where(eq(users.id, userId)).limit(1);
    if (user?.isBootstrap) {
      const rows = await this.deps.db.select({ id: sites.id }).from(sites).where(inArray(sites.id, siteIds));
      return siteIds.filter((s) => rows.some((r) => r.id === s));
    }
    const rows = await this.deps.db.select({ siteId: userSites.siteId }).from(userSites).where(and(eq(userSites.userId, userId), inArray(userSites.siteId, siteIds)));
    return siteIds.filter((s) => rows.some((r) => r.siteId === s));
  }
}

/** An API key's MCP tool groups (`metadata.mcpToolGroups`); read-only when it names none. */
export function apiKeyToolGroups(metadata: unknown): ToolGroup[] {
  const raw = metadata && typeof metadata === 'object' ? (metadata as { mcpToolGroups?: unknown }).mcpToolGroups : undefined;
  const groups = normalizeGroups(raw);
  return groups.length ? groups : ['read'];
}

export interface GrantView {
  id: string;
  kind: 'oauth' | 'pat';
  name: string;
  clientId: string | null;
  siteIds: string[];
  toolGroups: ToolGroup[];
  tokenPrefix: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}
