/**
 * The MCP tool runner's contract, one branch at a time (HeoPress P10 tasks 1.2–1.4, 2.1–2.5, 4.1; P14 task 8.1).
 *
 * Every check here is a refusal that protects something: an identity claim in the arguments, a tool group the
 * authorization lacks, an implicit multi-site write, a write without a version or an idempotency key, a high-risk
 * operation run directly, an image fetched outside the site's allowlist. The runner is the only place these are
 * enforced, so each is pinned with the code and the audit event the endpoint answers — not only the HTTP shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { agentIdempotency, settings, sites } from '@heopress/database';
import { McpToolRunner, stripIdentityArguments, type RunnerDeps } from '../mcp-tool-runner';
import type { AgentPrincipal } from '../agent-access-service';
import type { PlanView } from '../../agent-plans/plan-service';
import { PlanError } from '../../agent-plans/plan-service';
import { SiteProvisioningError } from '../../sites/site-provisioning';

vi.mock('../../sites/site-provisioning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../sites/site-provisioning')>();
  return { ...actual, provisionSite: vi.fn() };
});
const { provisionSite } = await import('../../sites/site-provisioning');
const provisionSiteMock = vi.mocked(provisionSite);

interface DispatchCall {
  siteId: string;
  request: { method: string; path: string; json?: unknown; raw?: { body: Uint8Array; contentType: string }; headers?: Record<string, string> };
}

interface HarnessOptions {
  principal?: Partial<AgentPrincipal>;
  dispatch?: (siteId: string, request: DispatchCall['request']) => Promise<{ status: number; body: unknown }>;
  /** Rows the settings read (image host allowlist) answers. */
  imageHosts?: unknown;
  /** Rows the `agentIdempotency` read answers, per call. */
  idempotencyRows?: Array<Record<string, unknown>>;
  fetchImage?: (url: string) => Promise<Response>;
  plans?: Record<string, unknown>;
  liveSites?: (userId: string, siteIds: string[]) => Promise<string[]>;
}

function harness(options: HarnessOptions = {}) {
  const calls: DispatchCall[] = [];
  const audits: Array<{ siteId: string | null; event: string; metadata: Record<string, unknown> }> = [];
  const idempotencyRows = [...(options.idempotencyRows ?? [])];
  const inserts: Array<{ table: unknown; values: unknown }> = [];
  const principal: AgentPrincipal = {
    kind: 'pat',
    userId: 'usr_1',
    email: 'operator@example.test',
    apiKeyId: null,
    grantId: 'grant_1',
    siteIds: ['site_a', 'site_b'],
    toolGroups: ['read', 'content', 'publish', 'settings', 'theme'],
    ...options.principal,
  };

  const selectChain = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => Promise.resolve(rows);
    chain.then = (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) => Promise.resolve(rows).then(resolve, reject);
    return chain;
  };

  const db = {
    select: (projection?: Record<string, unknown>) => {
      let table: unknown;
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = t;
        return chain;
      };
      chain.where = () => chain;
      chain.orderBy = () => chain;
      const rows = () => {
        if (table === settings) return [{ value: options.imageHosts ?? null }];
        if (table === agentIdempotency) return idempotencyRows.splice(0, 1);
        if (table === sites) return principal.siteIds.map((id) => ({ id, name: id === 'site_a' ? 'A' : 'B' }));
        return [];
      };
      chain.limit = () => Promise.resolve(rows());
      chain.then = (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) => Promise.resolve(rows()).then(resolve, reject);
      void projection;
      return chain;
    },
    insert: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.values = (values: unknown) => {
        inserts.push({ table, values });
        return chain;
      };
      chain.onConflictDoNothing = () => chain;
      chain.returning = () => Promise.resolve([]);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    execute: () => Promise.resolve([]),
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => cb(db),
  };

  const deps: RunnerDeps = {
    db: db as never,
    access: {
      liveSites: options.liveSites ?? (async (_userId: string, siteIds: string[]) => siteIds),
      liveGrantScope: async () => ({ siteIds: ['site_a', 'site_b'], toolGroups: ['read', 'content', 'publish', 'settings', 'theme'] }),
    } as never,
    principal,
    dispatch: async (siteId, request) => {
      calls.push({ siteId, request });
      if (options.dispatch) return options.dispatch(siteId, request);
      return { status: 200, body: { data: { ok: true } } };
    },
    audit: async (siteId, event, metadata) => {
      audits.push({ siteId, event, metadata });
    },
    fetchImage: options.fetchImage,
    plans: options.plans as never,
  };
  const runner = new McpToolRunner(deps);
  return { runner, calls, audits, inserts };
}

const planView = (overrides: Record<string, unknown> = {}): PlanView =>
  ({
    plan: {
      id: 'plan_1',
      status: 'pending_approval',
      operation: 'content_update',
      revision: 1,
      planHash: 'hash_1',
      riskTier: 'medium',
      highRisk: false,
      requiresPreview: true,
      requiresCanary: false,
      approvalMode: 'team',
      requiredApprovals: 1,
      scopeKind: 'siteIds',
      scopeSummary: 'Exactly 1 site',
      siteCount: 1,
      draftedBy: 'usr_1',
      grantId: 'grant_1',
      expiresAt: new Date('2026-11-08T00:00:00.000Z'),
      coolingOffUntil: null,
      ...(overrides.plan as object),
    },
    items: [{ siteId: 'site_a', canary: false, status: 'pending', result: null, attempts: 0 }],
    approvals: [],
    approvalsCurrent: 0,
    drafterEmail: 'operator@example.test',
  }) as unknown as PlanView;

describe('identity arguments', () => {
  it('removes identity claims from the top level and from data, leaving everything else', () => {
    const { args, removed } = stripIdentityArguments({
      siteId: 'site_a',
      userId: 'attacker',
      data: { title: 'x', createdBy: 'attacker', nested: { userId: 'kept' } },
    });
    expect(args).toEqual({ siteId: 'site_a', data: { title: 'x', nested: { userId: 'kept' } } });
    expect(removed).toEqual(['userId', 'data.createdBy']);
  });

  it('leaves a non-object data value untouched', () => {
    const { args, removed } = stripIdentityArguments({ data: 'text', actor: 'x' });
    expect(args).toEqual({ data: 'text' });
    expect(removed).toEqual(['actor']);
  });
});

describe('tool groups, scope and versions', () => {
  it('refuses an unknown tool', async () => {
    const { runner } = harness();
    const out = await runner.call('nope_tool', {});
    expect(out).toMatchObject({ kind: 'result', isError: true, value: { code: 'UNKNOWN_TOOL' } });
  });

  it('lists only the tools of the principal’s groups', async () => {
    const { runner } = harness({ principal: { toolGroups: [] } });
    expect(runner.listTools()).toEqual([]);
  });

  it('refuses a tool whose group the authorization lacks, and audits it', async () => {
    const { runner, audits, calls } = harness({ principal: { toolGroups: ['read'] } });
    const out = await runner.call('content_create', { siteId: 'site_a', collection: 'posts', data: {}, idempotencyKey: 'k1' });
    expect(out).toMatchObject({ kind: 'forbidden', code: 'TOOL_GROUP_NOT_GRANTED' });
    expect(calls).toHaveLength(0);
    expect(audits).toEqual([
      { siteId: null, event: 'mcp_tool_group_denied', metadata: expect.objectContaining({ tool: 'content_create', group: 'content' }) },
    ]);
  });

  it('checks the group of the operation a plan carries, and refuses an operation that is not a write tool', async () => {
    const { runner } = harness({ principal: { toolGroups: ['read'] } });
    const missing = await runner.call('plans_submit', { operation: 'not_a_tool', scope: { instance: true } });
    expect(missing).toMatchObject({ kind: 'result', isError: true, value: { code: 'INVALID_OPERATION' } });
    for (const operation of ['content_query', 'plans_submit']) {
      const readOp = await runner.call('plans_submit', { operation, scope: { instance: true } });
      expect(readOp, operation).toMatchObject({ kind: 'result', isError: true, value: { code: 'INVALID_OPERATION' } });
    }
    // A plan-only operation is a write too: its group is checked, not bypassed because it needs a plan.
    for (const operation of ['content_update', 'content_delete', 'theme_activate']) {
      const denied = await runner.call('plans_submit', { operation, scope: { instance: true } });
      expect(denied, operation).toMatchObject({ kind: 'forbidden', code: 'TOOL_GROUP_NOT_GRANTED' });
    }
  });

  it('requires exactly one siteId for a site tool, and points a multi-site write to plans_submit', async () => {
    const { runner, calls } = harness();
    const missing = await runner.call('content_get', { collection: 'posts', id: 'p1' });
    expect(missing).toMatchObject({ kind: 'result', isError: true, value: { code: 'SITE_REQUIRED' } });
    const blank = await runner.call('content_get', { siteId: '  ', collection: 'posts', id: 'p1' });
    expect(blank).toMatchObject({ kind: 'result', isError: true, value: { code: 'SITE_REQUIRED' } });
    const array = await runner.call('content_get', { siteId: ['site_a'], collection: 'posts', id: 'p1' });
    expect(array).toMatchObject({ kind: 'result', isError: true, value: { code: 'SITE_REQUIRED' } });
    const readMulti = await runner.call('content_query', { siteIds: ['site_a', 'site_b'], collection: 'posts' });
    expect(readMulti).toMatchObject({ kind: 'result', isError: true, value: { code: 'SITE_REQUIRED' } });
    const writeMulti = await runner.call('content_create', { scope: { siteIds: ['site_a', 'site_b'] }, collection: 'posts', data: {}, idempotencyKey: 'k1' });
    expect(writeMulti).toMatchObject({ kind: 'result', isError: true, value: { code: 'PLAN_REQUIRED' } });
    expect(calls).toHaveLength(0);
  });

  it('refuses a site outside the grant and audits it', async () => {
    const { runner, audits, calls } = harness();
    const out = await runner.call('content_get', { siteId: 'site_z', collection: 'posts', id: 'p1' });
    expect(out).toMatchObject({ kind: 'forbidden', code: 'SITE_NOT_AUTHORIZED' });
    expect(calls).toHaveLength(0);
    expect(audits[0]).toMatchObject({ event: 'mcp_site_denied', metadata: { requestedSiteId: 'site_z' } });
  });

  it('drops a site the person can no longer reach from the authorized set', async () => {
    const { runner } = harness({ liveSites: async () => ['site_a'] });
    expect(await runner.authorizedSites()).toEqual(['site_a']);
    const out = await runner.call('content_get', { siteId: 'site_b', collection: 'posts', id: 'p1' });
    expect(out).toMatchObject({ kind: 'forbidden', code: 'SITE_NOT_AUTHORIZED' });
  });

  it('an API key has no membership lookup: its grant site list is the answer', async () => {
    const { runner } = harness({ principal: { kind: 'api_key', userId: null, apiKeyId: 'key_1' }, liveSites: async () => [] });
    expect(await runner.authorizedSites()).toEqual(['site_a', 'site_b']);
    const out = await runner.call('content_get', { siteId: 'site_a', collection: 'posts', id: 'p1' });
    expect(out).toMatchObject({ kind: 'result', isError: false });
  });

  it('requires the explicit instance scope and refuses a scope given twice', async () => {
    const { runner } = harness();
    for (const scope of [undefined, {}, { instance: false }, { siteIds: [] }, { instance: true, siteIds: ['site_a'] }]) {
      const out = await runner.call('sites_list', { scope });
      expect(out, JSON.stringify(scope)).toMatchObject({ kind: 'result', isError: true, value: { code: 'SCOPE_REQUIRED' } });
    }
    const twice = await runner.call('sites_list', { scope: { instance: true }, siteId: 'site_a' });
    expect(twice).toMatchObject({ kind: 'result', isError: true, value: { code: 'SCOPE_REQUIRED' } });
  });

  it('requires a scope of the tool’s own shape', async () => {
    const { runner } = harness({ plans: { view: async () => planView() } });
    const planScopeMissing = await runner.call('plans_get', { scope: { instance: true } });
    expect(planScopeMissing).toMatchObject({ kind: 'result', isError: true, value: { code: 'SCOPE_REQUIRED' } });
    const instanceOnly = await runner.call('sites_list', { scope: { planId: 'plan_1' } });
    expect(instanceOnly).toMatchObject({ kind: 'result', isError: true, value: { code: 'SCOPE_REQUIRED' } });
  });

  it('requires expectedVersion for an update and an idempotencyKey for a create', async () => {
    const { runner, calls } = harness();
    for (const expectedVersion of [undefined, 0, '2', 1.5]) {
      const out = await runner.call('content_update', { siteId: 'site_a', collection: 'posts', id: 'p1', data: {}, expectedVersion });
      expect(out, String(expectedVersion)).toMatchObject({ kind: 'result', isError: true, value: { code: 'VERSION_REQUIRED' } });
    }
    for (const idempotencyKey of [undefined, '', 'tab\tkey', 'ü'.repeat(200)]) {
      const out = await runner.call('content_create', { siteId: 'site_a', collection: 'posts', data: {}, idempotencyKey });
      expect(out, String(idempotencyKey)).toMatchObject({ kind: 'result', isError: true, value: { code: 'IDEMPOTENCY_KEY_REQUIRED' } });
    }
    expect(calls).toHaveLength(0);
  });

  it('audits identity claims it removed before running the call', async () => {
    const { runner, audits, calls } = harness();
    const out = await runner.call('content_get', { siteId: 'site_a', collection: 'posts', id: 'p1', userId: 'usr_2' });
    expect(out).toMatchObject({ kind: 'result', isError: false });
    expect(audits[0]).toMatchObject({ siteId: 'site_a', event: 'mcp_identity_argument_ignored', metadata: { ignored: ['userId'] } });
    expect(calls[0]!.request.path).toBe('/api/v1/items/posts/p1');
  });

  it('never runs a high-risk tool directly, even with a version', async () => {
    const { runner, calls } = harness();
    const out = await runner.call('content_delete', { siteId: 'site_a', collection: 'posts', id: 'p1', expectedVersion: 3 });
    expect(out).toMatchObject({ kind: 'result', isError: true, value: { code: 'PLAN_REQUIRED' } });
    expect(calls).toHaveLength(0);
  });
});

describe('the REST call each tool makes', () => {
  it('site_get, themes_list and the seo reads hit their endpoints', async () => {
    const { runner, calls } = harness();
    await runner.call('site_get', { siteId: 'site_a' });
    await runner.call('themes_list', { siteId: 'site_a' });
    await runner.call('seo_audit_issues', { siteId: 'site_a' });
    await runner.call('seo_audit_issues', { siteId: 'site_a', limit: 7 });
    await runner.call('seo_link_impact', { siteId: 'site_a', itemId: 'itém/1', depth: 2, limit: 5 });
    expect(calls.map((c) => `${c.request.method} ${c.request.path}`)).toEqual([
      'GET /api/v1/site',
      'GET /api/v1/themes',
      'GET /api/v1/site/audit',
      'GET /api/v1/site/audit?limit=7',
      'GET /api/v1/site/links/impact/it%C3%A9m%2F1?depth=2&limit=5',
    ]);
    expect(calls.every((c) => c.siteId === 'site_a')).toBe(true);
  });

  it('content_query passes only the filter keys it was given', async () => {
    const { runner, calls } = harness();
    await runner.call('content_query', { siteId: 'site_a', collection: 'posts' });
    await runner.call('content_query', {
      siteId: 'site_a',
      collection: 'posts',
      limit: 5,
      offset: 10,
      sort: '-created',
      status: 'published',
      filter: { featured: { _eq: true } },
    });
    expect(calls[0]!.request.path).toBe('/api/v1/items/posts?');
    expect(calls[1]!.request.path).toBe(
      `/api/v1/items/posts?limit=5&offset=10&sort=-created&status=published&filter=${encodeURIComponent(JSON.stringify({ featured: { _eq: true } }))}`,
    );
  });

  it('content_create, content_update and content_publish send the version and idempotency headers', async () => {
    const { runner, calls } = harness();
    await runner.call('content_create', { siteId: 'site_a', collection: 'posts', data: { title: 'a' }, idempotencyKey: 'key-1' });
    await runner.call('content_update', { siteId: 'site_a', collection: 'posts', id: 'p1', data: { title: 'b' }, expectedVersion: 4 });
    await runner.call('content_publish', { siteId: 'site_a', collection: 'posts', id: 'p1', expectedVersion: 5 });
    expect(calls.map((c) => ({ method: c.request.method, path: c.request.path, json: c.request.json, headers: c.request.headers }))).toEqual([
      {
        method: 'POST',
        path: '/api/v1/items/posts',
        json: { data: { title: 'a' }, status: 'draft' },
        headers: { 'idempotency-key': 'key-1' },
      },
      { method: 'PATCH', path: '/api/v1/items/posts/p1', json: { data: { title: 'b' }, expectedVersion: 4 }, headers: undefined },
      { method: 'PATCH', path: '/api/v1/items/posts/p1', json: { status: 'published', expectedVersion: 5 }, headers: undefined },
    ]);
  });

  it('refuses a create or update whose data is not an object', async () => {
    const { runner, calls } = harness();
    for (const [tool, args] of [
      ['content_create', { siteId: 'site_a', collection: 'posts', data: 'x', idempotencyKey: 'k' }],
      ['content_update', { siteId: 'site_a', collection: 'posts', id: 'p1', data: [], expectedVersion: 1 }],
      ['branch_update', { siteId: 'site_a', collection: 'posts', id: 'p1', branch: 'b1', data: null, expectedVersion: 1 }],
      ['site_update_seo_settings', { siteId: 'site_a', settings: 'x', expectedVersion: 1 }],
    ] as const) {
      const out = await runner.call(tool, args as unknown as Record<string, unknown>);
      expect(out, tool).toMatchObject({ kind: 'result', isError: true, value: { code: 'VALIDATION' } });
    }
    expect(calls).toHaveLength(0);
  });

  it('site_update_seo_settings sends the settings with the version', async () => {
    const { runner, calls } = harness();
    await runner.call('site_update_seo_settings', { siteId: 'site_a', settings: { title: 'x' }, expectedVersion: 2 });
    expect(calls[0]!.request).toMatchObject({ method: 'PUT', path: '/api/v1/site/seo-settings', json: { title: 'x', version: 2 } });
  });

  it('branch tools reach the item’s version endpoints', async () => {
    const { runner, calls } = harness();
    await runner.call('branch_get', { siteId: 'site_a', collection: 'posts', id: 'p1', branch: 'draft-1' });
    await runner.call('branch_diff', { siteId: 'site_a', collection: 'posts', id: 'p1', branch: 'draft-1' });
    await runner.call('branch_update', { siteId: 'site_a', collection: 'posts', id: 'p1', branch: 'draft-1', data: { a: 1 }, expectedVersion: 3 });
    await runner.call('branch_merge', { siteId: 'site_a', collection: 'posts', id: 'p1', branch: 'draft-1', expectedVersion: 3, expectedMainVersion: 9 });
    expect(calls.map((c) => `${c.request.method} ${c.request.path}`)).toEqual([
      'GET /api/v1/items/posts/p1/versions/draft-1',
      'GET /api/v1/items/posts/p1/versions/draft-1/diff',
      'PATCH /api/v1/items/posts/p1/versions/draft-1',
      'POST /api/v1/items/posts/p1/versions/draft-1/merge',
    ]);
    expect(calls[2]!.request.json).toEqual({ set: { a: 1 }, expectedRevision: 3 });
    expect(calls[3]!.request.json).toEqual({ expectedRevision: 3, expectedMainVersion: 9 });
  });

  it('a merge without expectedMainVersion is refused before any call', async () => {
    const { runner, calls } = harness();
    const out = await runner.call('branch_merge', { siteId: 'site_a', collection: 'posts', id: 'p1', branch: 'b', expectedVersion: 3 });
    expect(out).toMatchObject({ kind: 'result', isError: true, value: { code: 'VERSION_REQUIRED' } });
    expect(calls).toHaveLength(0);
  });

  it('translation_status reads the item’s translation state', async () => {
    const { runner, calls } = harness();
    await runner.call('translation_status', { siteId: 'site_a', collection: 'posts', id: 'p1' });
    expect(calls[0]!.request.path).toBe('/api/v1/items/posts/p1/translation-status');
  });

  it('sites_list answers the authorized sites with their names, and nothing without a site', async () => {
    const { runner } = harness();
    const out = await runner.call('sites_list', { scope: { instance: true } });
    expect(out).toEqual({
      kind: 'result',
      isError: false,
      value: { data: [{ id: 'site_a', name: 'A' }, { id: 'site_b', name: 'B' }] },
    });
    const empty = harness({ principal: { siteIds: [] } });
    expect(await empty.runner.call('sites_list', { scope: { instance: true } })).toEqual({ kind: 'result', isError: false, value: { data: [] } });
  });
});

describe('a REST refusal becomes the tool’s answer', () => {
  it('401 and 403 are forbidden, carrying the API’s code when it has one', async () => {
    const { runner } = harness({
      dispatch: async () => ({ status: 403, body: { errors: [{ code: 'FORBIDDEN', message: 'nope' }] } }),
    });
    const out = await runner.call('content_get', { siteId: 'site_a', collection: 'posts', id: 'p1' });
    expect(out).toEqual({ kind: 'forbidden', code: 'FORBIDDEN', message: 'nope' });
    const unauth = harness({ dispatch: async () => ({ status: 401, body: {} }) });
    expect(await unauth.runner.call('content_get', { siteId: 'site_a', collection: 'posts', id: 'p1' })).toEqual({
      kind: 'forbidden',
      code: 'FORBIDDEN',
      message: 'Not permitted.',
    });
  });

  it('any other failure is an error result with the status and the errors', async () => {
    const { runner } = harness({ dispatch: async () => ({ status: 422, body: { errors: [{ code: 'VERSION_CONFLICT', message: 'stale' }] } }) });
    const out = await runner.call('content_update', { siteId: 'site_a', collection: 'posts', id: 'p1', data: {}, expectedVersion: 2 });
    expect(out).toEqual({
      kind: 'result',
      isError: true,
      value: { code: 'VERSION_CONFLICT', message: 'stale', status: 422, errors: [{ code: 'VERSION_CONFLICT', message: 'stale' }] },
    });
    const unnamed = harness({ dispatch: async () => ({ status: 500, body: {} }) });
    expect(await unnamed.runner.call('content_get', { siteId: 'site_a', collection: 'posts', id: 'p1' })).toEqual({
      kind: 'result',
      isError: true,
      value: { code: 'HTTP_500', message: 'Request failed (500).', status: 500, errors: [] },
    });
  });

  it('a success keeps `meta` when the API sends one and wraps a bare body', async () => {
    const withMeta = harness({ dispatch: async () => ({ status: 200, body: { data: [{ id: 'p1' }], meta: { total: 1 } } }) });
    expect(await withMeta.runner.call('content_query', { siteId: 'site_a', collection: 'posts' })).toEqual({
      kind: 'result',
      isError: false,
      value: { data: [{ id: 'p1' }], meta: { total: 1 } },
    });
    const bare = harness({ dispatch: async () => ({ status: 200, body: { id: 'p1' } }) });
    expect(await bare.runner.call('content_get', { siteId: 'site_a', collection: 'posts', id: 'p1' })).toEqual({
      kind: 'result',
      isError: false,
      value: { id: 'p1' },
    });
    const plain = harness({ dispatch: async () => ({ status: 204, body: null }) });
    expect(await plain.runner.call('content_get', { siteId: 'site_a', collection: 'posts', id: 'p1' })).toEqual({
      kind: 'result',
      isError: false,
      value: {},
    });
  });
});

describe('branch_create is idempotent', () => {
  const args = { siteId: 'site_a', collection: 'posts', id: 'p1', name: 'Draft', idempotencyKey: 'k-1' };

  it('derives the branch key from the principal and the idempotency key', async () => {
    const { runner, calls } = harness();
    await runner.call('branch_create', args);
    expect(calls[0]!.request).toMatchObject({ method: 'POST', path: '/api/v1/items/posts/p1/versions' });
    const key = (calls[0]!.request.json as { key: string; name: string }).key;
    expect(key).toMatch(/^agent-[0-9a-f]{16}$/);
    expect(calls[0]!.request.json).toMatchObject({ name: 'Draft' });
    // The same key for another principal is another branch.
    const other = harness({ principal: { userId: 'usr_2' } });
    await other.runner.call('branch_create', args);
    expect((other.calls[0]!.request.json as { key: string }).key).not.toBe(key);
  });

  it('a retry that finds the branch it made returns it, marked as a replay', async () => {
    const { runner } = harness({
      dispatch: async (_siteId, request) =>
        request.method === 'POST'
          ? { status: 409, body: { errors: [{ code: 'VERSION_EXISTS', message: 'exists' }] } }
          : { status: 200, body: { data: { name: 'Draft', revision: 1 } } },
    });
    const out = await runner.call('branch_create', args);
    expect(out).toEqual({ kind: 'result', isError: false, value: { data: { name: 'Draft', revision: 1 }, replayed: true } });
  });

  it('the same idempotency key for another name is refused, and a failed replay read is passed on', async () => {
    const reused = harness({
      dispatch: async (_siteId, request) =>
        request.method === 'POST'
          ? { status: 409, body: { errors: [{ code: 'VERSION_EXISTS' }] } }
          : { status: 200, body: { data: { name: 'Other' } } },
    });
    expect(await reused.runner.call('branch_create', args)).toMatchObject({ value: { code: 'IDEMPOTENCY_KEY_REUSED' } });
    const gone = harness({
      dispatch: async (_siteId, request) =>
        request.method === 'POST'
          ? { status: 409, body: { errors: [{ code: 'VERSION_EXISTS' }] } }
          : { status: 404, body: { errors: [{ code: 'NOT_FOUND', message: 'gone' }] } },
    });
    expect(await gone.runner.call('branch_create', args)).toMatchObject({ kind: 'result', isError: true, value: { code: 'NOT_FOUND' } });
  });

  it('requires a name', async () => {
    const { runner } = harness();
    expect(await runner.call('branch_create', { ...args, name: '  ' })).toMatchObject({ value: { code: 'VALIDATION' } });
    expect(await runner.call('branch_create', { ...args, name: 7 })).toMatchObject({ value: { code: 'VALIDATION' } });
  });
});

describe('media_upload_from_url', () => {
  const base = { siteId: 'site_a', idempotencyKey: 'upload-1' };

  it('refuses anything but an absolute https URL without credentials', async () => {
    const { runner } = harness({ imageHosts: ['cdn.example.test'] });
    for (const url of ['not a url', 'http://cdn.example.test/a.png', 'https://user:pass@cdn.example.test/a.png']) {
      expect(await runner.call('media_upload_from_url', { ...base, url }), url).toMatchObject({
        kind: 'result',
        isError: true,
        value: { code: 'VALIDATION' },
      });
    }
  });

  it('refuses a host outside the site’s allowlist, including its parent domain by suffix only', async () => {
    const { runner, audits } = harness({ imageHosts: ['cdn.example.test'] });
    const out = await runner.call('media_upload_from_url', { ...base, url: 'https://evil.test/a.png' });
    expect(out).toMatchObject({ kind: 'result', isError: true, value: { code: 'HOST_NOT_ALLOWED' } });
    expect(audits[0]).toMatchObject({ event: 'mcp_image_host_denied', metadata: { host: 'evil.test' } });
    // A subdomain of an allowlisted host is allowed; the allowlist entry itself is too.
    const sub = harness({
      imageHosts: ['cdn.example.test'],
      fetchImage: async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    expect(await sub.runner.call('media_upload_from_url', { ...base, url: 'https://img.cdn.example.test/a.png' })).toMatchObject({
      kind: 'result',
      isError: false,
    });
  });

  it('treats an unreadable allowlist setting as no allowed host', async () => {
    for (const imageHosts of [null, 'cdn.example.test', { hosts: 'nope' }]) {
      const { runner } = harness({ imageHosts });
      const out = await runner.call('media_upload_from_url', { ...base, url: 'https://cdn.example.test/a.png' });
      expect(out, JSON.stringify(imageHosts)).toMatchObject({ value: { code: 'HOST_NOT_ALLOWED' } });
    }
  });

  it('fetches through the guarded boundary and reports its failures', async () => {
    const allow = ['cdn.example.test'];
    const blocked = harness({
      imageHosts: allow,
      fetchImage: async () => {
        throw new Error('blocked');
      },
    });
    expect(await blocked.runner.call('media_upload_from_url', { ...base, url: 'https://cdn.example.test/a.png' })).toMatchObject({
      value: { code: 'FETCH_BLOCKED' },
    });
    const status = harness({
      imageHosts: allow,
      fetchImage: async () => new Response('x', { status: 502 }),
    });
    expect(await status.runner.call('media_upload_from_url', { ...base, url: 'https://cdn.example.test/a.png' })).toMatchObject({
      value: { code: 'FETCH_FAILED' },
    });
    const type = harness({
      imageHosts: allow,
      fetchImage: async () => new Response('x', { status: 200, headers: { 'content-type': 'text/html' } }),
    });
    expect(await type.runner.call('media_upload_from_url', { ...base, url: 'https://cdn.example.test/a.png' })).toMatchObject({
      value: { code: 'UNSUPPORTED_MEDIA_TYPE' },
    });
    const big = harness({
      imageHosts: allow,
      fetchImage: async () => new Response(new Uint8Array(10 * 1024 * 1024 + 1), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    expect(await big.runner.call('media_upload_from_url', { ...base, url: 'https://cdn.example.test/a.png' })).toMatchObject({
      value: { code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  it('uploads to a key derived from the principal and the idempotency key', async () => {
    const { runner, calls } = harness({
      imageHosts: ['cdn.example.test'],
      fetchImage: async () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp; charset=binary' } }),
    });
    await runner.call('media_upload_from_url', { ...base, url: 'https://cdn.example.test/a.png' });
    expect(calls[0]!.request.method).toBe('POST');
    expect(calls[0]!.request.path).toMatch(/^\/api\/v1\/media\/agents\/[0-9a-f]{32}\.webp$/);
    expect(calls[0]!.request.raw?.contentType).toBe('image/webp');
    expect(calls[0]!.request.raw?.body.byteLength).toBe(3);
    // Another principal never overwrites the same object.
    const other = harness({
      principal: { userId: 'usr_2' },
      imageHosts: ['cdn.example.test'],
      fetchImage: async () => new Response(new Uint8Array([1]), { status: 200, headers: { 'content-type': 'image/png' } }),
    });
    await other.runner.call('media_upload_from_url', { ...base, url: 'https://cdn.example.test/a.png' });
    expect(other.calls[0]!.request.path).not.toBe(calls[0]!.request.path);
  });
});

describe('sites_create', () => {
  const args = { scope: { instance: true }, id: 'site_new', name: 'New site', idempotencyKey: 'create-1' };

  it('is refused without a person', async () => {
    const { runner } = harness({ principal: { kind: 'api_key', userId: null, apiKeyId: 'key_1' } });
    expect(await runner.call('sites_create', args)).toEqual({
      kind: 'forbidden',
      code: 'INSTANCE_CAPABILITY_REQUIRED',
      message: 'Creating sites needs a person with the instance capability.',
    });
  });

  it('returns the site an earlier call with the same key created', async () => {
    const { runner, calls } = harness({
      idempotencyRows: [{ requestHash: expect.any(String), result: { data: { id: 'site_new' }, note: 'note' } }],
    });
    // The stored hash is computed from these exact arguments; get it from a clean run first.
    const probe = harness();
    provisionSiteMock.mockResolvedValueOnce({ id: 'site_new', name: 'New site' } as never);
    await probe.runner.call('sites_create', { ...args, defaultLanguage: 'en' });
    const requestHash = (probe.inserts[0]!.values as { requestHash: string }).requestHash;

    const replay = harness({ idempotencyRows: [{ requestHash, result: { data: { id: 'site_new' }, note: 'note' } }] });
    const out = await replay.runner.call('sites_create', { ...args, defaultLanguage: 'en' });
    expect(out).toEqual({ kind: 'result', isError: false, value: { data: { id: 'site_new' }, note: 'note', replayed: true } });
    expect(replay.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('refuses a reused key sent with different arguments', async () => {
    const { runner } = harness({ idempotencyRows: [{ requestHash: 'a-different-hash', result: {} }] });
    expect(await runner.call('sites_create', args)).toMatchObject({ value: { code: 'IDEMPOTENCY_KEY_REUSED' } });
  });

  it('provisions the site, records the key and audits the creation', async () => {
    provisionSiteMock.mockResolvedValueOnce({ id: 'site_new', name: 'New site' } as never);
    const { runner, audits, inserts } = harness();
    const out = await runner.call('sites_create', args);
    expect(out).toEqual({
      kind: 'result',
      isError: false,
      value: {
        data: { id: 'site_new', name: 'New site' },
        note: 'The new site is not part of this authorization; authorize it again to act on it.',
      },
    });
    expect(inserts[0]!.table).toBe(agentIdempotency);
    expect(inserts[0]!.values).toMatchObject({ subject: 'user:usr_1', tool: 'sites_create', key: 'create-1' });
    expect(audits[0]).toMatchObject({ siteId: null, event: 'mcp_site_created', metadata: { siteId: 'site_new' } });
  });

  it('maps a provisioning refusal to a tool answer, and a lost race to the winner’s result', async () => {
    provisionSiteMock.mockRejectedValueOnce(new SiteProvisioningError('FORBIDDEN', 'not an instance administrator', 403));
    expect(await harness().runner.call('sites_create', args)).toEqual({
      kind: 'forbidden',
      code: 'INSTANCE_CAPABILITY_REQUIRED',
      message: 'not an instance administrator',
    });

    provisionSiteMock.mockRejectedValueOnce(new SiteProvisioningError('VALIDATION', 'bad id', 400));
    expect(await harness().runner.call('sites_create', args)).toMatchObject({ value: { code: 'VALIDATION', message: 'bad id' } });

    const winner = harness();
    provisionSiteMock.mockResolvedValueOnce({ id: 'site_new', name: 'New site' } as never);
    await winner.runner.call('sites_create', args);
    const requestHash = (winner.inserts[0]!.values as { requestHash: string }).requestHash;
    provisionSiteMock.mockRejectedValueOnce(new SiteProvisioningError('CONFLICT', 'exists', 409));
    const raced = harness({ idempotencyRows: [{ requestHash, result: { data: { id: 'site_new' } } }] });
    expect(await raced.runner.call('sites_create', args)).toMatchObject({ value: { data: { id: 'site_new' }, replayed: true } });

    provisionSiteMock.mockRejectedValueOnce(new SiteProvisioningError('CONFLICT', 'exists', 409));
    expect(await harness().runner.call('sites_create', args)).toMatchObject({ value: { code: 'CONFLICT', message: 'exists' } });
  });
});

describe('plans through the MCP endpoint', () => {
  const scope = { siteIds: ['site_a'] };

  it('an API key cannot draft a plan', async () => {
    const { runner } = harness({ principal: { kind: 'api_key', userId: null, apiKeyId: 'key_1' } });
    const out = await runner.call('plans_submit', { operation: 'content_update', scope, arguments: { id: 'p1' } });
    expect(out).toMatchObject({ kind: 'forbidden', code: 'PLAN_REQUIRES_PERSON' });
  });

  it('resolves instance scope to the sites the drafter can reach now, sorted', async () => {
    const submit = vi.fn(async () => planView());
    const { runner } = harness({ plans: { submit }, liveSites: async () => ['site_b', 'site_a'] });
    const out = await runner.call('plans_submit', { operation: 'content_update', scope: { instance: true } });
    expect(submit).toHaveBeenCalledWith(
      { userId: 'usr_1', grantId: 'grant_1', via: 'pat' },
      { operation: 'content_update', arguments: {}, perSite: {}, siteIds: ['site_a', 'site_b'], scopeKind: 'instance' },
      expect.stringContaining('Every site of this authorization'),
    );
    expect(out).toMatchObject({ kind: 'result', isError: false, value: { data: { id: 'plan_1', status: 'pending_approval' } } });
  });

  it('refuses a site the authorization does not cover, and validates arguments and perSite', async () => {
    const submit = vi.fn(async () => planView());
    const { runner } = harness({ plans: { submit } });
    expect(await runner.call('plans_submit', { operation: 'content_update', scope: { siteIds: ['site_a', 'site_z'] } })).toMatchObject({
      kind: 'forbidden',
      code: 'SITE_NOT_AUTHORIZED',
    });
    expect(await runner.call('plans_submit', { operation: 'content_update', scope, arguments: 'x' })).toMatchObject({
      value: { code: 'VALIDATION' },
    });
    expect(await runner.call('plans_submit', { operation: 'content_update', scope, perSite: [] })).toMatchObject({
      value: { code: 'VALIDATION' },
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('maps a PlanError to an error result with its details', async () => {
    const submit = vi.fn(async () => {
      throw new PlanError('INVALID_ARGUMENTS', 'missing versions', 422, { problems: { site_a: ['expectedVersion'] } });
    });
    const { runner } = harness({ plans: { submit } });
    expect(await runner.call('plans_submit', { operation: 'content_update', scope })).toEqual({
      kind: 'result',
      isError: true,
      value: { code: 'INVALID_ARGUMENTS', message: 'missing versions', problems: { site_a: ['expectedVersion'] } },
    });
  });

  it('reads only the caller’s own plan', async () => {
    const { runner } = harness({ plans: { view: async () => planView() } });
    const out = await runner.call('plans_get', { scope: { planId: 'plan_1' } });
    expect(out).toMatchObject({ kind: 'result', isError: false, value: { data: { id: 'plan_1', scope: { kind: 'siteIds', count: 1 } } } });

    const foreign = harness({ plans: { view: async () => planView({ plan: { draftedBy: 'usr_2' } }) } });
    expect(await foreign.runner.call('plans_get', { scope: { planId: 'plan_1' } })).toMatchObject({ value: { code: 'PLAN_NOT_FOUND' } });

    const missing = harness({
      plans: {
        view: async () => {
          throw new PlanError('PLAN_NOT_FOUND', 'gone', 404);
        },
      },
    });
    expect(await missing.runner.call('plans_get', { scope: { planId: 'plan_1' } })).toMatchObject({ value: { code: 'PLAN_NOT_FOUND' } });

    const broken = harness({
      plans: {
        view: async () => {
          throw new PlanError('PLAN_TAMPERED', 'no', 409);
        },
      },
    });
    await expect(broken.runner.call('plans_get', { scope: { planId: 'plan_1' } })).rejects.toThrow('no');
  });

  it('an API key cannot read a plan either', async () => {
    const { runner } = harness({ principal: { kind: 'api_key', userId: null, apiKeyId: 'key_1' } });
    expect(await runner.call('plans_get', { scope: { planId: 'plan_1' } })).toMatchObject({ value: { code: 'PLAN_NOT_FOUND' } });
  });

  it('revises a plan it drafted: scope, arguments and perSite are validated first', async () => {
    const revise = vi.fn(async () => planView({ plan: { revision: 2 } }));
    const { runner } = harness({ plans: { view: async () => planView(), revise } });
    expect(await runner.call('plans_revise', { scope: { planId: 'plan_1' }, siteIds: [] })).toMatchObject({
      value: { code: 'VALIDATION' },
    });
    expect(await runner.call('plans_revise', { scope: { planId: 'plan_1' }, siteIds: ['site_a', 'site_z'] })).toMatchObject({
      kind: 'forbidden',
      code: 'SITE_NOT_AUTHORIZED',
    });
    expect(await runner.call('plans_revise', { scope: { planId: 'plan_1' }, arguments: 'x' })).toMatchObject({
      value: { code: 'VALIDATION' },
    });
    expect(await runner.call('plans_revise', { scope: { planId: 'plan_1' }, perSite: 'x' })).toMatchObject({
      value: { code: 'VALIDATION' },
    });
    expect(revise).not.toHaveBeenCalled();
  });

  it('revises with the normalized site list, and refuses an operation group it lost', async () => {
    const revise = vi.fn(async () => planView({ plan: { revision: 2 } }));
    const { runner } = harness({ plans: { view: async () => planView(), revise } });
    const out = await runner.call('plans_revise', {
      scope: { planId: 'plan_1' },
      siteIds: ['site_b', 'site_a', 'site_b'],
      arguments: { id: 'p1' },
      perSite: { site_a: { expectedVersion: 3 } },
    });
    expect(revise).toHaveBeenCalledWith(
      { userId: 'usr_1', grantId: 'grant_1', via: 'pat' },
      'plan_1',
      { siteIds: ['site_a', 'site_b'], arguments: { id: 'p1' }, perSite: { site_a: { expectedVersion: 3 } } },
    );
    expect(out).toMatchObject({ kind: 'result', isError: false, value: { note: expect.stringContaining('Earlier approvals') } });

    const lost = harness({ principal: { toolGroups: ['read'] }, plans: { view: async () => planView(), revise } });
    expect(await lost.runner.call('plans_revise', { scope: { planId: 'plan_1' } })).toMatchObject({
      kind: 'forbidden',
      code: 'TOOL_GROUP_NOT_GRANTED',
    });
  });
});
