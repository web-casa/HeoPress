import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { users } from './core';

/**
 * External agents' access to the MCP endpoint (HeoPress P10 tasks 1.1–1.5; spec agents/mcp-access, agents/site-scope).
 *
 * Instance-level, not site-level: one authorisation names the sites it covers. None of these tables carries a
 * `site_id`; under the optional row-level security (`migrations/rls-policies.sql`) the application role reads and
 * writes them only in a transaction that set `app.agent_access = 'on'`, which only the agent-access service does.
 *
 * Every secret (authorisation code, access token, refresh token, personal access token, client secret) is stored as
 * its SHA-256 only; the plaintext is shown once.
 */

/**
 * OAuth clients: registered dynamically (RFC 7591, `source = 'dcr'`) or known by their client ID metadata document
 * (`source = 'cimd'`: the client id is an https URL, fetched through the outbound guard and refreshed after a day).
 */
export const oauthClients = pgTable(
  'lumibase_oauth_clients',
  {
    /** Opaque id for registered clients; the metadata document URL for `cimd` clients. */
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    clientName: text('client_name'),
    /** Exact redirect URIs (a loopback http URI also matches on another port, RFC 8252 §7.3). */
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    /** `none` (public client with PKCE), `client_secret_basic` or `client_secret_post`. */
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').default('none').notNull(),
    clientSecretHash: text('client_secret_hash'),
    /** The other registration fields that were accepted (client_uri, logo_uri, scope …); never fetched. */
    metadata: jsonb('metadata').$type<Record<string, unknown>>().default({}).notNull(),
    registeredIp: text('registered_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    /** When a `cimd` client's document was last read. */
    fetchedAt: timestamp('fetched_at', { withTimezone: true }),
  },
  (t) => ({
    source: check('oauth_clients_source', sql`${t.source} IN ('dcr', 'cimd')`),
    authMethod: check('oauth_clients_auth_method', sql`${t.tokenEndpointAuthMethod} IN ('none', 'client_secret_basic', 'client_secret_post')`),
  }),
);

/**
 * One authorisation of one person: an OAuth consent (`kind = 'oauth'`, with its client) or a personal access token
 * (`kind = 'pat'`, its hash here). It records what the person chose — sites and tool groups — and the audience (the
 * MCP endpoint's resource URL). Every call intersects it with the person's live permissions; revoking it ends every
 * token issued under it.
 */
export const agentGrants = pgTable(
  'lumibase_agent_grants',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    clientId: text('client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
    /** A personal access token's label, or the client's name at consent time. */
    name: text('name').notNull(),
    siteIds: text('site_ids').array().notNull(),
    toolGroups: text('tool_groups').array().notNull(),
    /** The resource the tokens are bound to (RFC 8707). */
    resource: text('resource').notNull(),
    /** The user's `token_version` at consent: a password change or reset ends the grant. */
    tokenVersion: integer('token_version').default(0).notNull(),
    /** Personal access tokens only. */
    tokenHash: text('token_hash'),
    tokenPrefix: text('token_prefix'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** `user` | `admin` | `code_replay` | `refresh_replay` | `password_changed` … */
    revokeReason: text('revoke_reason'),
  },
  (t) => ({
    userIdx: index('agent_grants_user_idx').on(t.userId),
    tokenHash: uniqueIndex('agent_grants_token_hash_unique').on(t.tokenHash),
    kind: check('agent_grants_kind', sql`${t.kind} IN ('oauth', 'pat')`),
    oauthHasClient: check('agent_grants_oauth_client', sql`${t.kind} <> 'oauth' OR ${t.clientId} IS NOT NULL`),
    patHasHash: check('agent_grants_pat_hash', sql`${t.kind} <> 'pat' OR ${t.tokenHash} IS NOT NULL`),
  }),
);

/** Authorisation codes: single use, 60 seconds, bound to the client, redirect URI, PKCE challenge and resource. */
export const oauthCodes = pgTable('lumibase_oauth_codes', {
  codeHash: text('code_hash').primaryKey(),
  grantId: text('grant_id')
    .notNull()
    .references(() => agentGrants.id, { onDelete: 'cascade' }),
  clientId: text('client_id').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: text('resource').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Access and refresh tokens of OAuth grants. A refresh token is used once (`used_at`); presenting it again revokes
 * the whole grant (reuse detection). `parent_id` links a rotated token to the one it replaced.
 */
export const oauthTokens = pgTable(
  'lumibase_oauth_tokens',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    grantId: text('grant_id')
      .notNull()
      .references(() => agentGrants.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    tokenHash: text('token_hash').notNull(),
    parentId: text('parent_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tokenHash: uniqueIndex('oauth_tokens_token_hash_unique').on(t.tokenHash),
    grantIdx: index('oauth_tokens_grant_idx').on(t.grantId),
    kind: check('oauth_tokens_kind', sql`${t.kind} IN ('access', 'refresh')`),
  }),
);

/**
 * Idempotency of MCP create tools that have no item-level key of their own (creating a site): per caller, tool and
 * key, the request's hash and the result returned. The same key with another request is refused.
 */
export const agentIdempotency = pgTable(
  'lumibase_agent_idempotency',
  {
    /** `user:<id>` or `api_key:<id>`. */
    subject: text('subject').notNull(),
    tool: text('tool').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    result: jsonb('result').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.subject, t.tool, t.key] }),
  }),
);
