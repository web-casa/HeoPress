import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentIdempotency, settings, sites, type Database } from '@heopress/database';
import { outboundFetch } from '@heopress/runtime/node';
import { runSiteTransaction } from '../rls-transaction';
import { provisionSite, SiteProvisioningError, validateNewSite } from '../sites/site-provisioning';
import type { AgentAccessService, AgentPrincipal } from './agent-access-service';
import { MCP_TOOLS, toolByName, type McpToolDefinition, type ToolGroup } from './mcp-tool-catalog';

/**
 * Runs one `tools/call` of the agent MCP endpoint (HeoPress P10 tasks 1.2–1.4, 2.1, 2.2, 2.4, 2.5; specs
 * agents/mcp-access "身份只来自令牌", "工具约束"; agents/site-scope).
 *
 * The order of checks is the contract:
 * 1. identity fields in the arguments (`userId`, `actor`, `createdBy` …) are removed — the caller is the token's
 *    person or API key, never an argument — and the attempt is audited;
 * 2. the tool's group must be in the grant;
 * 3. the scope must be explicit: one `siteId` for site tools (an array, `siteIds` or `scope` on a write is a
 *    multi-site write and is pointed to `plans_submit`), `scope: { instance: true }` / `{ planId }` / `{ siteIds }`
 *    for the others — there is no default site;
 * 4. the site must be in the grant **and** still reachable by the person now (membership); otherwise 403;
 * 5. writes to existing resources need `expectedVersion`, creates need an `idempotencyKey`;
 * 6. high-risk tools are never written directly (`PLAN_REQUIRED`).
 * Then the call runs as an internal request to the same REST endpoint Studio uses, in the site's scope, as the
 * token's principal — so live RBAC, row-level security, holds and publish checks apply unchanged and the answer is
 * what Studio shows.
 */

/** Argument names that would claim an identity. They are ignored and audited. */
const IDENTITY_KEYS = new Set([
  'userId',
  'user_id',
  'user',
  'actor',
  'actorId',
  'actor_id',
  'actorEmail',
  'onBehalfOf',
  'on_behalf_of',
  'impersonate',
  'createdBy',
  'updatedBy',
  'userCreated',
  'userUpdated',
  'user_created',
  'user_updated',
  'principal',
  'apiKeyId',
]);

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif' };
/** The site setting naming the hosts images may be fetched from by URL. */
const IMAGE_HOST_ALLOWLIST_KEY = 'agents.imageHostAllowlist';

export interface DispatchRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  path: string;
  json?: unknown;
  raw?: { body: Uint8Array; contentType: string };
  headers?: Record<string, string>;
}

interface DispatchResponse {
  status: number;
  body: unknown;
}

/** The internal request to the REST API, as the principal, in `siteId`'s scope. */
export type Dispatch = (siteId: string, request: DispatchRequest) => Promise<DispatchResponse>;

type AuditSink = (siteId: string | null, event: string, metadata: Record<string, unknown>) => Promise<void>;

export interface RunnerDeps {
  db: Database;
  access: AgentAccessService;
  principal: AgentPrincipal;
  dispatch: Dispatch;
  audit: AuditSink;
  /** Fetches an image by URL. Defaults to the outbound boundary (no redirects, 10 MiB, 15 s). */
  fetchImage?: (url: string) => Promise<Response>;
}

/** A call refused for authorization: the endpoint answers HTTP 403 (insufficient scope). */
export interface ToolForbidden {
  kind: 'forbidden';
  code: string;
  message: string;
}

/** A tool result: `isError` results carry `{ code, message, … }`. */
export interface ToolOutcome {
  kind: 'result';
  isError: boolean;
  value: Record<string, unknown>;
}

const fail = (code: string, message: string, extra: Record<string, unknown> = {}): ToolOutcome => ({ kind: 'result', isError: true, value: { code, message, ...extra } });
const forbid = (code: string, message: string): ToolForbidden => ({ kind: 'forbidden', code, message });
const done = (value: unknown): ToolOutcome => ({ kind: 'result', isError: false, value: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : { data: value } });

const PLAN_HINT = { tool: 'plans_submit', hint: 'Writes to two or more sites, and high-risk operations, go through a batch plan approved by a person in Studio.' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Remove identity claims from the top level and from `data`; returns the names found. */
export function stripIdentityArguments(args: Record<string, unknown>): { args: Record<string, unknown>; removed: string[] } {
  const removed: string[] = [];
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (IDENTITY_KEYS.has(k)) removed.push(k);
    else clean[k] = v;
  }
  if (isRecord(clean.data)) {
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(clean.data)) {
      if (IDENTITY_KEYS.has(k)) removed.push(`data.${k}`);
      else data[k] = v;
    }
    clean.data = data;
  }
  return { args: clean, removed };
}

const VISIBLE_ASCII = /^[\x21-\x7e]{1,255}$/;

export class McpToolRunner {
  private readonly fetchImage: (url: string) => Promise<Response>;

  constructor(private readonly deps: RunnerDeps) {
    this.fetchImage =
      deps.fetchImage ??
      ((url) => outboundFetch(url, { purpose: 'user', maxRedirects: 0, timeoutMs: 15_000, maxResponseBytes: IMAGE_MAX_BYTES, headers: { accept: 'image/*' } }));
  }

  /** The tools this principal may call (its groups), for `tools/list`. */
  listTools(): McpToolDefinition[] {
    return MCP_TOOLS.filter((t) => this.deps.principal.toolGroups.includes(t.group));
  }

  /** The sites of the grant the principal can reach now. */
  async authorizedSites(): Promise<string[]> {
    const p = this.deps.principal;
    if (!p.userId) return p.siteIds;
    return this.deps.access.liveSites(p.userId, p.siteIds);
  }

  async call(name: string, rawArgs: Record<string, unknown>): Promise<ToolOutcome | ToolForbidden> {
    const tool = toolByName(name);
    if (!tool) return fail('UNKNOWN_TOOL', `No tool named "${name}".`);
    const { args, removed } = stripIdentityArguments(rawArgs);
    const p = this.deps.principal;

    // 2. tool group (a plan needs the group of the operation it carries).
    let group: ToolGroup = tool.group;
    if (tool.effect === 'plan') {
      const op = typeof args.operation === 'string' ? toolByName(args.operation) : undefined;
      if (!op || op.effect === 'plan' || op.effect === 'read') return fail('INVALID_OPERATION', 'operation must name a write tool, e.g. "content_update".');
      group = op.group;
    }
    if (!p.toolGroups.includes(group)) {
      await this.deps.audit(null, 'mcp_tool_group_denied', { tool: name, group, principal: this.subject() });
      return forbid('TOOL_GROUP_NOT_GRANTED', `This authorization does not include the "${group}" tool group.`);
    }

    // 3–4. scope.
    let siteId: string | null = null;
    if (tool.scope === 'site') {
      const multi = Array.isArray(args.siteId) || args.siteIds !== undefined || args.scope !== undefined;
      if (multi) {
        return tool.effect === 'read'
          ? fail('SITE_REQUIRED', 'Give exactly one siteId; a tool call acts on one site.')
          : fail('PLAN_REQUIRED', 'A write to more than one site must be submitted as a batch plan.', PLAN_HINT);
      }
      if (typeof args.siteId !== 'string' || !args.siteId.trim()) {
        return fail('SITE_REQUIRED', 'siteId is required: name the one site this call acts on (sites_list shows the authorized sites).');
      }
      siteId = args.siteId;
      if (!(await this.authorizedSites()).includes(siteId)) {
        await this.deps.audit(null, 'mcp_site_denied', { tool: name, requestedSiteId: siteId, principal: this.subject() });
        return forbid('SITE_NOT_AUTHORIZED', `This authorization does not cover site "${siteId}".`);
      }
    } else {
      const scope = args.scope;
      const keys = isRecord(scope) ? Object.keys(scope).filter((k) => scope[k] !== undefined) : [];
      const want = tool.scope === 'instance' ? 'instance' : tool.scope === 'plan' ? 'planId' : null;
      const ok =
        keys.length === 1 &&
        (want ? keys[0] === want : keys[0] === 'siteIds' || keys[0] === 'instance') &&
        (keys[0] !== 'instance' || (scope as Record<string, unknown>).instance === true) &&
        (keys[0] !== 'planId' || typeof (scope as Record<string, unknown>).planId === 'string') &&
        (keys[0] !== 'siteIds' || (Array.isArray((scope as Record<string, unknown>).siteIds) && ((scope as Record<string, unknown>).siteIds as unknown[]).length > 0));
      if (!ok) {
        const expected = tool.scope === 'instance' ? '{ "instance": true }' : tool.scope === 'plan' ? '{ "planId": "…" }' : 'exactly one of { "siteIds": [...] } or { "instance": true }';
        return fail('SCOPE_REQUIRED', `scope is required and must be ${expected}; there is no implicit "all sites".`);
      }
      if (args.siteId !== undefined) return fail('SCOPE_REQUIRED', 'Give the scope only once: siteId is not used by this tool.');
    }

    // 5. versions and idempotency.
    if (tool.effect === 'update') {
      if (!Number.isInteger(args.expectedVersion) || (args.expectedVersion as number) < 1) {
        return fail('VERSION_REQUIRED', 'expectedVersion is required for a change to an existing resource: read it first.');
      }
    }
    if (tool.effect === 'create' && (typeof args.idempotencyKey !== 'string' || !VISIBLE_ASCII.test(args.idempotencyKey))) {
      return fail('IDEMPOTENCY_KEY_REQUIRED', 'idempotencyKey is required for a create (1–255 visible ASCII characters).');
    }

    if (removed.length) {
      await this.deps.audit(siteId, 'mcp_identity_argument_ignored', { tool: name, ignored: removed, principal: this.subject() });
    }

    // 6. high-risk operations are plans, even on one site.
    if (tool.planOnly) return fail('PLAN_REQUIRED', `${name} is a high-risk operation and is never run directly.`, PLAN_HINT);

    return this.execute(tool, args, siteId);
  }

  private subject(): string {
    const p = this.deps.principal;
    return p.userId ? `user:${p.userId}` : `api_key:${p.apiKeyId}`;
  }

  private async rest(siteId: string, request: DispatchRequest): Promise<ToolOutcome | ToolForbidden> {
    const res = await this.deps.dispatch(siteId, request);
    const body = isRecord(res.body) ? res.body : {};
    const first = Array.isArray(body.errors) && isRecord(body.errors[0]) ? body.errors[0] : null;
    if (res.status === 401 || res.status === 403) {
      // Live RBAC said no (a role changed, the membership ended): the same answer as a scope the grant lacks.
      return forbid(typeof first?.code === 'string' ? first.code : 'FORBIDDEN', typeof first?.message === 'string' ? first.message : 'Not permitted.');
    }
    if (res.status >= 400) {
      return fail(typeof first?.code === 'string' ? first.code : `HTTP_${res.status}`, typeof first?.message === 'string' ? first.message : `Request failed (${res.status}).`, {
        status: res.status,
        errors: body.errors ?? [],
      });
    }
    return done('data' in body ? { data: body.data, ...(body.meta ? { meta: body.meta } : {}) } : body);
  }

  private async execute(tool: McpToolDefinition, args: Record<string, unknown>, siteId: string | null): Promise<ToolOutcome | ToolForbidden> {
    const enc = encodeURIComponent;
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    switch (tool.name) {
      case 'sites_list': {
        const ids = await this.authorizedSites();
        const rows = ids.length ? await this.deps.db.select({ id: sites.id, name: sites.name }).from(sites).where(inArray(sites.id, ids)).orderBy(sites.name) : [];
        return done({ data: rows });
      }
      case 'site_get':
        return this.rest(siteId!, { method: 'GET', path: '/api/v1/site' });
      case 'content_query': {
        const q = new URLSearchParams();
        for (const k of ['limit', 'offset', 'sort', 'status'] as const) if (args[k] !== undefined) q.set(k, String(args[k]));
        if (args.filter !== undefined) q.set('filter', JSON.stringify(args.filter));
        return this.rest(siteId!, { method: 'GET', path: `/api/v1/items/${enc(str(args.collection))}?${q}` });
      }
      case 'content_get':
        return this.rest(siteId!, { method: 'GET', path: `/api/v1/items/${enc(str(args.collection))}/${enc(str(args.id))}` });
      case 'content_create':
        if (!isRecord(args.data)) return fail('VALIDATION', 'data must be an object.');
        return this.rest(siteId!, {
          method: 'POST',
          path: `/api/v1/items/${enc(str(args.collection))}`,
          json: { data: args.data, status: 'draft' },
          headers: { 'idempotency-key': str(args.idempotencyKey) },
        });
      case 'content_update':
        if (!isRecord(args.data)) return fail('VALIDATION', 'data must be an object.');
        return this.rest(siteId!, {
          method: 'PATCH',
          path: `/api/v1/items/${enc(str(args.collection))}/${enc(str(args.id))}`,
          json: { data: args.data, expectedVersion: args.expectedVersion },
        });
      case 'content_publish':
        return this.rest(siteId!, {
          method: 'PATCH',
          path: `/api/v1/items/${enc(str(args.collection))}/${enc(str(args.id))}`,
          json: { status: 'published', expectedVersion: args.expectedVersion },
        });
      case 'media_upload_from_url':
        return this.uploadFromUrl(siteId!, str(args.url), str(args.idempotencyKey));
      case 'seo_audit_issues':
        return this.rest(siteId!, { method: 'GET', path: `/api/v1/site/audit${args.limit !== undefined ? `?limit=${enc(String(args.limit))}` : ''}` });
      case 'seo_link_impact': {
        const q = new URLSearchParams();
        for (const k of ['depth', 'limit'] as const) if (args[k] !== undefined) q.set(k, String(args[k]));
        return this.rest(siteId!, { method: 'GET', path: `/api/v1/site/links/impact/${enc(str(args.itemId))}?${q}` });
      }
      case 'translation_status':
        return this.rest(siteId!, { method: 'GET', path: `/api/v1/items/${enc(str(args.collection))}/${enc(str(args.id))}/translation-status` });
      case 'site_update_seo_settings':
        if (!isRecord(args.settings)) return fail('VALIDATION', 'settings must be an object.');
        return this.rest(siteId!, { method: 'PUT', path: '/api/v1/site/seo-settings', json: { ...args.settings, version: args.expectedVersion } });
      case 'themes_list':
        return this.rest(siteId!, { method: 'GET', path: '/api/v1/themes' });
      case 'sites_create':
        return this.createSite(args);
      case 'plans_submit':
        return this.submitPlan(args);
      case 'plans_get':
        return fail('PLAN_NOT_FOUND', 'No such plan for this caller.');
      default:
        return fail('UNKNOWN_TOOL', `No tool named "${tool.name}".`);
    }
  }

  /** Image by URL: the host must be on the site's allowlist; fetched through the SSRF guard without redirects. */
  private async uploadFromUrl(siteId: string, raw: string, idempotencyKey: string): Promise<ToolOutcome | ToolForbidden> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return fail('VALIDATION', 'url must be an absolute https URL.');
    }
    if (url.protocol !== 'https:' || url.username || url.password) return fail('VALIDATION', 'url must be an https URL without credentials.');
    const allowlist = await this.imageHostAllowlist(siteId);
    const host = url.hostname.toLowerCase();
    if (!allowlist.some((h) => host === h || host.endsWith(`.${h}`))) {
      await this.deps.audit(siteId, 'mcp_image_host_denied', { host, principal: this.subject() });
      return fail('HOST_NOT_ALLOWED', `"${host}" is not on this site’s image host allowlist (${IMAGE_HOST_ALLOWLIST_KEY}).`);
    }
    let res: Response;
    try {
      res = await this.fetchImage(url.href);
    } catch {
      return fail('FETCH_BLOCKED', 'The image could not be fetched: the address is not reachable or not allowed.');
    }
    if (res.status !== 200) return fail('FETCH_FAILED', `The image host answered ${res.status}.`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = IMAGE_TYPES[type];
    if (!ext) return fail('UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG, GIF, WebP and AVIF images are accepted.');
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > IMAGE_MAX_BYTES) return fail('PAYLOAD_TOO_LARGE', 'The image is larger than 10 MiB.');
    // The key follows from the idempotency key: a retry writes the same object, never a second one.
    const key = `agents/${createHash('sha256').update(`${this.subject()}\n${idempotencyKey}`).digest('hex').slice(0, 32)}.${ext}`;
    return this.rest(siteId, { method: 'POST', path: `/api/v1/media/${key}`, raw: { body, contentType: type } });
  }

  private async imageHostAllowlist(siteId: string): Promise<string[]> {
    const [row] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx.select({ value: settings.value }).from(settings).where(and(eq(settings.siteId, siteId), eq(settings.key, IMAGE_HOST_ALLOWLIST_KEY))).limit(1),
    );
    const value = row?.value as unknown;
    const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.hosts) ? value.hosts : [];
    return list.filter((h): h is string => typeof h === 'string' && h.length > 0).map((h) => h.toLowerCase().replace(/^\.+/, ''));
  }

  /** A new site: the instance capability is checked by provisioning; the key makes a retry return the same site. */
  private async createSite(args: Record<string, unknown>): Promise<ToolOutcome | ToolForbidden> {
    const p = this.deps.principal;
    if (!p.userId) return forbid('INSTANCE_CAPABILITY_REQUIRED', 'Creating sites needs a person with the instance capability.');
    const input = { id: args.id, name: args.name, ...(args.defaultLanguage !== undefined ? { defaultLanguage: args.defaultLanguage } : {}) };
    const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const key = String(args.idempotencyKey);
    const replay = async (): Promise<ToolOutcome | null> => {
      const [row] = await this.deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.agent_access', 'on', true)`);
        return tx
          .select()
          .from(agentIdempotency)
          .where(and(eq(agentIdempotency.subject, this.subject()), eq(agentIdempotency.tool, 'sites_create'), eq(agentIdempotency.key, key)))
          .limit(1);
      });
      if (!row) return null;
      if (row.requestHash !== requestHash) return fail('IDEMPOTENCY_KEY_REUSED', 'This idempotencyKey was used for a different request.');
      return done({ ...row.result, replayed: true });
    };
    const earlier = await replay();
    if (earlier) return earlier;
    try {
      const created = await provisionSite(this.deps.db, validateNewSite(input), p.userId);
      const result = { data: { id: created.id, name: created.name }, note: 'The new site is not part of this authorization; authorize it again to act on it.' };
      await this.deps.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.agent_access', 'on', true)`);
        await tx.insert(agentIdempotency).values({ subject: this.subject(), tool: 'sites_create', key, requestHash, result }).onConflictDoNothing();
      });
      await this.deps.audit(null, 'mcp_site_created', { siteId: created.id, principal: this.subject() });
      return done(result);
    } catch (err) {
      if (err instanceof SiteProvisioningError) {
        if (err.code === 'CONFLICT') {
          const raced = await replay();
          if (raced) return raced;
        }
        return err.status === 403 ? forbid('INSTANCE_CAPABILITY_REQUIRED', err.message) : fail(err.code, err.message);
      }
      throw err;
    }
  }

  /**
   * The batch-plan entry point (slice 2 implements plans). The scope is resolved now to a fixed list of site ids the
   * caller may act on — `instance` means every site of this authorization that is still reachable, never sites added
   * later — and a site outside the authorization is refused, never silently dropped.
   */
  private async submitPlan(args: Record<string, unknown>): Promise<ToolOutcome | ToolForbidden> {
    const scope = args.scope as { siteIds?: unknown[]; instance?: true };
    const authorized = await this.authorizedSites();
    let siteIds: string[];
    if (scope.instance) {
      siteIds = [...authorized].sort();
    } else {
      siteIds = [...new Set((scope.siteIds ?? []).map(String))].sort();
      const outside = siteIds.filter((s) => !authorized.includes(s));
      if (outside.length) return forbid('SITE_NOT_AUTHORIZED', `This authorization does not cover: ${outside.join(', ')}.`);
    }
    return fail('PLAN_NOT_AVAILABLE', 'Batch plans are not available in this release; nothing was changed.', {
      resolvedScope: { siteIds, count: siteIds.length, confirmation: `Plan "${String(args.operation)}" would cover exactly these ${siteIds.length} site(s); sites created later are not added.` },
    });
  }
}
