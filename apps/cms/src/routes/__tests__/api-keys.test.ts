/**
 * `/api/v1/api-keys`: the management surface for keys, their origin allowlists, their MCP tool groups and their
 * attachments (HeoPress P07a task 11.3, P10 task 1.3; P14 task 8.1).
 *
 * Two rules run through every path here:
 * - only a person manages keys (an API key principal is refused before any handler);
 * - a publishable key (`lbk_pub_…`) is public by construction, so an attachment that grants admin/app access is
 *   refused — on roles and on policies alike, because `PermissionService.compile()` grants admin either way.
 *
 * The database is a small state object: these tests assert the decision the route makes (status, code, audit row,
 * token, metadata), while the SQL itself has its own integration suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { apiKeyPolicies, apiKeyRoles, apiKeys, policies, roles } from '@heopress/database';

vi.mock('../../services/access-conflict-report', () => ({ buildAccessConflictReport: vi.fn() }));
vi.mock('../../services/permission-invalidation', () => ({ bumpPermissionVersion: vi.fn(async () => undefined) }));

const { buildAccessConflictReport } = await import('../../services/access-conflict-report');
const { bumpPermissionVersion } = await import('../../services/permission-invalidation');
const conflictReport = vi.mocked(buildAccessConflictReport);
const bump = vi.mocked(bumpPermissionVersion);
const { apiKeysRouter } = await import('../api-keys');

interface State {
  keys: Array<Record<string, unknown>>;
  roles: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  keyRoles: Array<Record<string, unknown>>;
  keyPolicies: Array<Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
  deletes: unknown[];
}

function state(overrides: Partial<State> = {}): State {
  return { keys: [], roles: [], policies: [], keyRoles: [], keyPolicies: [], audits: [], deletes: [], ...overrides };
}

function fakeDb(s: State) {
  const rowsFor = (table: unknown): Array<Record<string, unknown>> => {
    if (table === apiKeys) return s.keys;
    if (table === roles) return s.roles;
    if (table === policies) return s.policies;
    if (table === apiKeyRoles) return s.keyRoles;
    if (table === apiKeyPolicies) return s.keyPolicies;
    return [];
  };
  const db = {
    select: () => {
      let table: unknown;
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = t;
        return chain;
      };
      chain.where = () => chain;
      // A read is a snapshot: the route must not see a row it wrote through another object.
      const snapshot = () => rowsFor(table).map((row) => ({ ...row }));
      chain.limit = () => Promise.resolve(snapshot());
      chain.then = (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) => Promise.resolve(snapshot()).then(resolve, reject);
      return chain;
    },
    insert: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      let values: Record<string, unknown> = {};
      chain.values = (v: Record<string, unknown>) => {
        values = v;
        return chain;
      };
      chain.returning = () => {
        if (table === apiKeys) {
          const row = { id: `ak_${s.keys.length + 1}`, siteId: 'site_a', createdAt: new Date(), ...values };
          s.keys.push(row);
          return Promise.resolve([row]);
        }
        if (table === apiKeyRoles) return Promise.resolve([{ apiKeyId: values.apiKeyId, roleId: values.roleId, priority: values.priority }]);
        if (table === apiKeyPolicies) return Promise.resolve([{ apiKeyId: values.apiKeyId, policyId: values.policyId, priority: values.priority }]);
        return Promise.resolve([values]);
      };
      chain.then = (resolve: (v: unknown) => void) => {
        s.audits.push(values);
        return Promise.resolve(undefined).then(resolve);
      };
      return chain;
    },
    update: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      let set: Record<string, unknown> = {};
      chain.set = (v: Record<string, unknown>) => {
        set = v;
        return chain;
      };
      chain.where = () => chain;
      chain.returning = () => {
        const target = rowsFor(table)[0];
        if (!target) return Promise.resolve([]);
        // Drizzle drops undefined values from an update; an omitted field stays as it was.
        Object.assign(target, Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)));
        return Promise.resolve([{ ...target }]);
      };
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    delete: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.where = () => {
        s.deletes.push(table);
        return Promise.resolve(undefined);
      };
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
  };
  return db;
}

interface Options {
  s?: State;
  auth?: Record<string, unknown> | null;
}

function app({ s = state(), auth }: Options = {}) {
  const hono = new Hono<AppEnv>();
  hono.use('*', async (c, next) => {
    c.set('db', fakeDb(s) as never);
    c.set('siteId', 'site_a');
    c.set('ip', '203.0.113.9');
    c.set('userAgent', 'vitest');
    c.set('requestId', 'req_1');
    c.set('runtime', { cache: {} } as never);
    if (auth !== null) {
      c.set('auth', (auth ?? { type: 'user', userId: 'usr_1', email: 'admin@example.test', roles: [] }) as never);
    }
    await next();
  });
  hono.route('/api-keys', apiKeysRouter);
  return { app: hono, s };
}

const request = (options: Options, path: string, method: string, body?: unknown) =>
  app(options).app.request(path, {
    method,
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

const keyRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'ak_1',
  siteId: 'site_a',
  name: 'Deploy',
  description: null,
  prefix: 'lbk_abcdefghijkl',
  last4: 'wxyz',
  createdBy: 'usr_1',
  rotatedAt: null,
  rotatedBy: null,
  expiresAt: null,
  revokedAt: null,
  revokedBy: null,
  lastUsedAt: null,
  lastUsedIp: null,
  lastUsedUserAgent: null,
  metadata: {},
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  conflictReport.mockReset();
  bump.mockReset().mockResolvedValue(undefined);
});

describe('who may manage keys', () => {
  it('refuses an API-key principal before the handler runs', async () => {
    const res = await request({ auth: { type: 'api_key', userId: null, apiKeyId: 'ak_1' } }, '/api-keys', 'GET');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'FORBIDDEN', message: 'API keys can only be managed by user principals.' }] });
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request({ auth: null }, '/api-keys', 'GET');
    expect(res.status).toBe(403);
  });
});

describe('GET /api-keys', () => {
  it('lists the site’s keys with derived publishable, origins, tool groups and attachments', async () => {
    const s = state({
      keys: [
        keyRow({
          metadata: { allowedOrigins: ['https://example.com'], mcpToolGroups: ['content', 'bogus'] },
          prefix: 'lbk_pub_abcdefgh',
        }),
      ],
      keyRoles: [{ roleId: 'role_1', priority: 100 }],
      keyPolicies: [{ policyId: 'pol_1', priority: 50 }],
    });
    const res = await request({ s }, '/api-keys', 'GET');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      id: 'ak_1',
      publishable: true,
      allowedOrigins: ['https://example.com'],
      mcpToolGroups: ['content'],
      roles: [{ roleId: 'role_1', priority: 100 }],
      policies: [{ policyId: 'pol_1', priority: 50 }],
    });
    expect(body.data[0]).not.toHaveProperty('token');
    expect(body.data[0]).not.toHaveProperty('tokenHash');
  });
});

describe('POST /api-keys', () => {
  it('validates the body', async () => {
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(97) }, { name: 'ok', expiresAt: 'not a date' }]) {
      const res = await request({}, '/api-keys', 'POST', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const json = (await res.json()) as { errors: Array<{ code: string }> };
      expect(json.errors[0]!.code).toBe('VALIDATION');
    }
  });

  it('refuses an origin it cannot parse, naming every one', async () => {
    const res = await request({}, '/api-keys', 'POST', { name: 'Deploy', allowedOrigins: ['https://example.com', 'not-an-origin', 'http://[bad'] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: Array<{ message: string }> };
    expect(body.errors[0]!.message).toContain('not-an-origin');
    expect(body.errors[0]!.message).toContain('http://[bad');
  });

  it('creates a secret key, normalises and dedupes its origins, and audits without the token', async () => {
    const s = state();
    const res = await request({ s }, '/api-keys', 'POST', {
      name: 'Deploy',
      allowedOrigins: ['https://Example.com', 'https://example.com/', 'http://localhost:3000'],
      metadata: { owner: 'ops' },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(String(body.data.token)).toMatch(/^lbk_/);
    expect(body.data).toMatchObject({ name: 'Deploy', publishable: false, allowedOrigins: ['https://example.com', 'http://localhost:3000'] });
    expect(s.keys[0]!.metadata).toEqual({ owner: 'ops', allowedOrigins: ['https://example.com', 'http://localhost:3000'] });
    const audit = s.audits.find((entry) => entry.event === 'api_key_created');
    expect(audit).toMatchObject({ siteId: 'site_a', actorEmail: 'admin@example.test', ip: '203.0.113.9' });
    expect(JSON.stringify(audit!.metadata)).not.toContain(String(body.data.token));
    expect((audit!.metadata as { last4: string }).last4).toBe(String(body.data.token).slice(-4));
  });

  it('creates a publishable key and stores no origin list when none is given', async () => {
    const s = state();
    const res = await request({ s }, '/api-keys', 'POST', { name: 'Embed', publishable: true });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(String(body.data.token)).toMatch(/^lbk_pub_/);
    expect(body.data).toMatchObject({ publishable: true, allowedOrigins: [] });
    expect(s.keys[0]!.metadata).toEqual({});
  });
});

describe('GET /api-keys/:id', () => {
  it('answers 404 for an unknown key and the key otherwise', async () => {
    expect((await request({}, '/api-keys/ak_missing', 'GET')).status).toBe(404);
    const s = state({ keys: [keyRow()] });
    const res = await request({ s }, '/api-keys/ak_1', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { id: 'ak_1', name: 'Deploy' } });
  });
});

describe('PATCH /api-keys/:id/allowed-origins', () => {
  it('validates, refuses unparseable origins and an unknown key', async () => {
    expect((await request({}, '/api-keys/ak_1/allowed-origins', 'PATCH', { allowedOrigins: 'x' })).status).toBe(400);
    expect((await request({}, '/api-keys/ak_1/allowed-origins', 'PATCH', { allowedOrigins: ['nope'] })).status).toBe(400);
    expect((await request({}, '/api-keys/ak_missing/allowed-origins', 'PATCH', { allowedOrigins: [] })).status).toBe(404);
  });

  it('replaces the list, audits before and after, and removes the key when emptied', async () => {
    const s = state({ keys: [keyRow({ metadata: { allowedOrigins: ['https://old.example.com'] } })] });
    const res = await request({ s }, '/api-keys/ak_1/allowed-origins', 'PATCH', { allowedOrigins: ['https://new.example.com'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { allowedOrigins: ['https://new.example.com'] } });
    const audit = s.audits.find((entry) => entry.event === 'api_key_origins_updated');
    expect(audit!.metadata).toMatchObject({ previous: ['https://old.example.com'], next: ['https://new.example.com'] });

    const cleared = state({ keys: [keyRow({ metadata: { allowedOrigins: ['https://old.example.com'], owner: 'ops' } })] });
    const empty = await request({ s: cleared }, '/api-keys/ak_1/allowed-origins', 'PATCH', { allowedOrigins: [] });
    expect(empty.status).toBe(200);
    expect(cleared.keys[0]!.metadata).toEqual({ owner: 'ops' });
  });
});

describe('PATCH /api-keys/:id/mcp-tool-groups', () => {
  it('rejects a body that is not JSON, an empty list and an unknown group', async () => {
    expect((await request({}, '/api-keys/ak_1/mcp-tool-groups', 'PATCH', '{oops')).status).toBe(400);
    for (const mcpToolGroups of [[], ['bogus'], 'content']) {
      const res = await request({}, '/api-keys/ak_1/mcp-tool-groups', 'PATCH', { mcpToolGroups });
      expect(res.status, JSON.stringify(mcpToolGroups)).toBe(400);
      expect((await res.json()) as { errors: Array<{ message: string }> }).toMatchObject({
        errors: [{ code: 'VALIDATION' }],
      });
    }
  });

  it('answers 404 for an unknown key', async () => {
    expect((await request({}, '/api-keys/ak_missing/mcp-tool-groups', 'PATCH', { mcpToolGroups: ['read'] })).status).toBe(404);
  });

  it('stores the groups in catalogue order and audits the change', async () => {
    const s = state({ keys: [keyRow({ metadata: { owner: 'ops' } })] });
    const res = await request({ s }, '/api-keys/ak_1/mcp-tool-groups', 'PATCH', { mcpToolGroups: ['content', 'read'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { mcpToolGroups: ['read', 'content'] } });
    expect(s.keys[0]!.metadata).toEqual({ owner: 'ops', mcpToolGroups: ['read', 'content'] });
    const audit = s.audits.find((entry) => entry.event === 'api_key_mcp_tool_groups_updated');
    expect(audit!.metadata).toMatchObject({ previous: ['read'], next: ['read', 'content'] });
  });
});

describe('POST /api-keys/:id/rotate', () => {
  it('validates the body and answers 404 for an unknown key', async () => {
    expect((await request({}, '/api-keys/ak_1/rotate', 'POST', { expiresAt: 'nope' })).status).toBe(400);
    expect((await request({}, '/api-keys/ak_missing/rotate', 'POST', {})).status).toBe(404);
  });

  it('keeps a publishable key publishable, clears previous revocation and audits both prefixes', async () => {
    const s = state({
      keys: [keyRow({ prefix: 'lbk_pub_oldprefix', revokedAt: new Date(), revokedBy: 'usr_2' })],
    });
    const res = await request({ s }, '/api-keys/ak_1/rotate', 'POST', { expiresAt: '2027-01-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(String(body.data.token)).toMatch(/^lbk_pub_/);
    expect(body.data).toMatchObject({ publishable: true, revokedAt: null, revokedBy: null });
    expect(body.data.rotatedBy).toBe('usr_1');
    expect(body.data.expiresAt).toBe('2027-01-01T00:00:00.000Z');
    const audit = s.audits.find((entry) => entry.event === 'api_key_rotated');
    expect(audit!.metadata).toMatchObject({ previousPrefix: 'lbk_pub_oldprefix' });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('leaves an omitted expiry untouched and stores an explicit null', async () => {
    const kept = state({ keys: [keyRow({ expiresAt: new Date('2027-05-05T00:00:00.000Z') })] });
    await request({ s: kept }, '/api-keys/ak_1/rotate', 'POST', {});
    expect(kept.keys[0]!.expiresAt).toEqual(new Date('2027-05-05T00:00:00.000Z'));

    const cleared = state({ keys: [keyRow({ expiresAt: new Date('2027-05-05T00:00:00.000Z') })] });
    await request({ s: cleared }, '/api-keys/ak_1/rotate', 'POST', { expiresAt: null });
    expect(cleared.keys[0]!.expiresAt).toBeNull();
  });
});

describe('POST /api-keys/:id/revoke', () => {
  it('answers 404 for an unknown key and revokes the known one', async () => {
    expect((await request({}, '/api-keys/ak_missing/revoke', 'POST')).status).toBe(404);
    const s = state({ keys: [keyRow()] });
    const res = await request({ s }, '/api-keys/ak_1/revoke', 'POST');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: { id: 'ak_1', revokedBy: 'usr_1' } });
    expect(s.audits.some((entry) => entry.event === 'api_key_revoked')).toBe(true);
    expect(bump).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api-keys/:id/roles', () => {
  const body = { roleId: 'role_1' };

  it('validates the body', async () => {
    expect((await request({}, '/api-keys/ak_1/roles', 'POST', {})).status).toBe(400);
  });

  it('answers 404 for an unknown key and for an unknown role', async () => {
    expect((await request({}, '/api-keys/ak_missing/roles', 'POST', body)).status).toBe(404);
    const s = state({ keys: [keyRow()] });
    const res = await request({ s }, '/api-keys/ak_1/roles', 'POST', body);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ errors: [{ message: 'Role not found.' }] });
  });

  it('refuses admin access through a publishable key, whether the role or a bound policy carries it', async () => {
    const viaRole = state({ keys: [keyRow({ prefix: 'lbk_pub_x' })], roles: [{ id: 'role_1', name: 'Admin', adminAccess: true, appAccess: true }] });
    const res = await request({ s: viaRole }, '/api-keys/ak_1/roles', 'POST', body);
    expect(res.status).toBe(400);
    const json = (await res.json()) as { errors: Array<{ code: string; message: string }> };
    expect(json.errors[0]!.code).toBe('PUBLISHABLE_KEY_ELEVATION');
    expect(json.errors[0]!.message).toContain('Admin');

    const viaPolicy = state({
      keys: [keyRow({ prefix: 'lbk_pub_x' })],
      roles: [{ id: 'role_1', name: 'Editor', adminAccess: false, appAccess: true }],
      policies: [{ id: 'pol_1', name: 'Dangerous', adminAccess: true, appAccess: true }],
    });
    const second = await request({ s: viaPolicy }, '/api-keys/ak_1/roles', 'POST', body);
    expect(second.status).toBe(400);
    expect((await second.json()) as { errors: Array<{ code: string }> }).toMatchObject({ errors: [{ code: 'PUBLISHABLE_KEY_ELEVATION' }] });
  });

  it('a secret key may carry the same role', async () => {
    conflictReport.mockResolvedValue({ ok: true, conflicts: [], warnings: [] });
    const s = state({ keys: [keyRow()], roles: [{ id: 'role_1', name: 'Admin', adminAccess: true, appAccess: true }] });
    const res = await request({ s }, '/api-keys/ak_1/roles', 'POST', body);
    expect(res.status).toBe(201);
  });

  it('refuses conflicting and warning attachments until the warning is overridden, and audits the override', async () => {
    const s = state({ keys: [keyRow()], roles: [{ id: 'role_1', name: 'Editor', adminAccess: false, appAccess: true }] });
    conflictReport.mockResolvedValueOnce({ ok: false, conflicts: [{ reason: 'x' } as never], warnings: [] });
    const conflict = await request({ s }, '/api-keys/ak_1/roles', 'POST', body);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()) as { errors: Array<{ code: string }> }).toMatchObject({ errors: [{ code: 'ACCESS_POLICY_CONFLICT' }] });

    conflictReport.mockResolvedValueOnce({ ok: true, conflicts: [], warnings: [{ reason: 'y' } as never] });
    const warned = await request({ s }, '/api-keys/ak_1/roles', 'POST', body);
    expect(warned.status).toBe(409);
    expect((await warned.json()) as { errors: Array<{ code: string }> }).toMatchObject({ errors: [{ code: 'ACCESS_POLICY_WARNING' }] });

    conflictReport.mockResolvedValueOnce({ ok: true, conflicts: [], warnings: [{ reason: 'y' } as never] });
    const override = await request({ s }, '/api-keys/ak_1/roles', 'POST', { ...body, overrideWarnings: true, priority: 7 });
    expect(override.status).toBe(201);
    expect(await override.json()).toMatchObject({ data: { roleId: 'role_1', priority: 7 } });
    expect(s.audits.some((entry) => entry.event === 'access_policy_warning_overridden')).toBe(true);
    expect(bump).toHaveBeenCalled();
  });
});

describe('POST /api-keys/:id/policies', () => {
  const body = { policyId: 'pol_1' };

  it('validates the body, then answers 404 for an unknown key and policy', async () => {
    expect((await request({}, '/api-keys/ak_1/policies', 'POST', {})).status).toBe(400);
    expect((await request({}, '/api-keys/ak_missing/policies', 'POST', body)).status).toBe(404);
    const s = state({ keys: [keyRow()] });
    expect((await request({ s }, '/api-keys/ak_1/policies', 'POST', body)).status).toBe(404);
  });

  it('refuses an elevated policy on a publishable key', async () => {
    const s = state({
      keys: [keyRow({ prefix: 'lbk_pub_x' })],
      policies: [{ id: 'pol_1', name: 'Admin', adminAccess: true, appAccess: true }],
    });
    const res = await request({ s }, '/api-keys/ak_1/policies', 'POST', body);
    expect(res.status).toBe(400);
    expect((await res.json()) as { errors: Array<{ code: string }> }).toMatchObject({ errors: [{ code: 'PUBLISHABLE_KEY_ELEVATION' }] });
  });

  it('refuses conflicts and warnings without an override, then attaches with one', async () => {
    const s = state({ keys: [keyRow()], policies: [{ id: 'pol_1', name: 'Editor', adminAccess: false, appAccess: true }] });
    conflictReport.mockResolvedValueOnce({ ok: false, conflicts: [{ reason: 'x' } as never], warnings: [] });
    expect((await request({ s }, '/api-keys/ak_1/policies', 'POST', body)).status).toBe(409);
    conflictReport.mockResolvedValueOnce({ ok: true, conflicts: [], warnings: [{ reason: 'y' } as never] });
    expect((await request({ s }, '/api-keys/ak_1/policies', 'POST', body)).status).toBe(409);
    conflictReport.mockResolvedValueOnce({ ok: true, conflicts: [], warnings: [{ reason: 'y' } as never] });
    const res = await request({ s }, '/api-keys/ak_1/policies', 'POST', { ...body, overrideWarnings: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { policyId: 'pol_1', priority: 100 } });
    expect(s.audits.some((entry) => entry.event === 'access_policy_warning_overridden')).toBe(true);
  });

  it('attaches a plain policy', async () => {
    conflictReport.mockResolvedValue({ ok: true, conflicts: [], warnings: [] });
    const s = state({ keys: [keyRow()], policies: [{ id: 'pol_1', name: 'Editor', adminAccess: false, appAccess: true }] });
    const res = await request({ s }, '/api-keys/ak_1/policies', 'POST', { ...body, priority: 3 });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ data: { policyId: 'pol_1', priority: 3 } });
  });
});

describe('DELETE attachments', () => {
  it('removes a role and a policy binding and bumps the permission version', async () => {
    const s = state({ keys: [keyRow()] });
    const role = await request({ s }, '/api-keys/ak_1/roles/role_1', 'DELETE');
    expect(role.status).toBe(204);
    const policy = await request({ s }, '/api-keys/ak_1/policies/pol_1', 'DELETE');
    expect(policy.status).toBe(204);
    expect(s.deletes).toEqual([apiKeyRoles, apiKeyPolicies]);
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it('refuses an API-key principal on the delete paths too', async () => {
    const res = await request({ auth: { type: 'api_key', userId: null, apiKeyId: 'ak_1' } }, '/api-keys/ak_1/roles/role_1', 'DELETE');
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'FORBIDDEN' }] });
  });
});
