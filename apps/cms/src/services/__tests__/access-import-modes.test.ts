/**
 * `AccessImportService` modes and reference resolution (HeoPress P07a task 12; P14 task 8.1).
 *
 * The dry-run/diff contract is covered by `access-import.test.ts`. This file pins the part that actually changes a
 * site's access rows: the three modes (merge, replace-managed, replace-all), how a row is matched (system key, key,
 * `id:` ref, API-key prefix), what `replace-managed` refuses to touch, and the reference errors that must block an
 * import before anything is written.
 */
import { describe, expect, it } from 'vitest';
import {
  apiKeyPolicies,
  apiKeyRoles,
  apiKeys,
  permissions,
  policies,
  rolePolicies,
  roles,
  userPolicies,
  userRoles,
  userSites,
  type Database,
} from '@heopress/database';
import { ACCESS_EXPORT_SCHEMA, type AccessExportManifest } from '../access-export';
import { AccessImportService } from '../access-import';

interface Rows {
  roles: Array<Record<string, unknown>>;
  policies: Array<Record<string, unknown>>;
  apiKeys: Array<Record<string, unknown>>;
  permissions: Array<Record<string, unknown>>;
  rolePolicies: Array<Record<string, unknown>>;
  userRoles: Array<Record<string, unknown>>;
  userSites: Array<Record<string, unknown>>;
  userPolicies: Array<Record<string, unknown>>;
  apiKeyRoles: Array<Record<string, unknown>>;
  apiKeyPolicies: Array<Record<string, unknown>>;
  deletes: string[];
  updates: Array<{ table: unknown; set: Record<string, unknown> }>;
}

function rows(overrides: Partial<Rows> = {}): Rows {
  return {
    roles: [],
    policies: [],
    apiKeys: [],
    permissions: [],
    rolePolicies: [],
    userRoles: [],
    userSites: [],
    userPolicies: [],
    apiKeyRoles: [],
    apiKeyPolicies: [],
    deletes: [],
    updates: [],
    ...overrides,
  };
}

const TABLE_NAMES = new Map<unknown, keyof Rows>([
  [roles, 'roles'],
  [policies, 'policies'],
  [apiKeys, 'apiKeys'],
  [permissions, 'permissions'],
  [rolePolicies, 'rolePolicies'],
  [userRoles, 'userRoles'],
  [userSites, 'userSites'],
  [userPolicies, 'userPolicies'],
  [apiKeyRoles, 'apiKeyRoles'],
  [apiKeyPolicies, 'apiKeyPolicies'],
]);

const nameOf = (table: unknown): keyof Rows => TABLE_NAMES.get(table)!;

/** The bound values of a Drizzle predicate: enough to tell "this row" from "every row". */
function predicateParams(predicate: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const chunk = node as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
    if (chunk.constructor?.name === 'Param') {
      out.push(chunk.value);
      return;
    }
    if (Array.isArray(chunk.queryChunks)) chunk.queryChunks.forEach(walk);
  };
  walk(predicate);
  return out;
}

/** The columns a predicate can name a row by (a `siteId` bound in every predicate names no row in particular). */
const IDENTITY_COLUMNS = ['id', 'roleId', 'policyId', 'apiKeyId'] as const;

/** A row matches an update/delete predicate when one of its identity columns carries a bound value. */
function rowMatches(row: Record<string, unknown>, params: unknown[]): boolean {
  return IDENTITY_COLUMNS.some((column) => row[column] !== undefined && params.includes(row[column]));
}

/** An in-memory database with just enough upsert semantics for the importer. */
function fakeDb(state: Rows, options: { transaction?: boolean } = { transaction: true }): Database {
  const list = (table: unknown): Array<Record<string, unknown>> => state[nameOf(table)] as Array<Record<string, unknown>>;

  const conflictFor = (table: unknown, value: Record<string, unknown>): ((row: Record<string, unknown>) => boolean) => {
    switch (nameOf(table)) {
      case 'roles':
        return (row) => row.key === value.key && row.systemKey === value.systemKey;
      case 'policies':
        return (row) => row.key === value.key;
      case 'rolePolicies':
        return (row) => row.roleId === value.roleId && row.policyId === value.policyId;
      case 'userRoles':
        return (row) => row.userId === value.userId && row.roleId === value.roleId;
      case 'userSites':
        return (row) => row.userId === value.userId && row.siteId === value.siteId;
      case 'userPolicies':
        return (row) => row.userId === value.userId && row.policyId === value.policyId;
      case 'apiKeyRoles':
        return (row) => row.apiKeyId === value.apiKeyId && row.roleId === value.roleId;
      case 'apiKeyPolicies':
        return (row) => row.apiKeyId === value.apiKeyId && row.policyId === value.policyId;
      case 'permissions':
        // Permission rows have no natural key here: every insert adds one.
        return () => false;
      default:
        return () => false;
    }
  };

  const insertBuilder = (table: unknown) => {
    let values: Array<Record<string, unknown>> = [];
    let conflictSet: Record<string, unknown> | null = null;
    let doNothing = false;
    const apply = (): Array<Record<string, unknown>> => {
      const target = list(table);
      const out: Array<Record<string, unknown>> = [];
      for (const value of values) {
        const existing = target.find(conflictFor(table, value));
        if (existing) {
          if (doNothing) continue;
          if (conflictSet) Object.assign(existing, conflictSet);
          out.push({ ...existing });
          continue;
        }
        const row = { id: `${String(nameOf(table))}_${target.length + 1}`, ...value };
        target.push(row);
        out.push({ ...row });
      }
      return out;
    };
    const chain: Record<string, unknown> = {
      values: (input: Record<string, unknown> | Array<Record<string, unknown>>) => {
        values = Array.isArray(input) ? input : [input];
        return chain;
      },
      onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
        conflictSet = set;
        return chain;
      },
      onConflictDoNothing: () => {
        doNothing = true;
        return chain;
      },
      returning: () => Promise.resolve(apply()),
      then: (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) => Promise.resolve(apply()).then(resolve, reject),
    };
    return chain;
  };

  const updateBuilder = (table: unknown) => {
    let set: Record<string, unknown> = {};
    let params: unknown[] = [];
    const apply = (): Array<Record<string, unknown>> => {
      const scoped = params.length ? list(table).filter((row) => rowMatches(row, params)) : list(table);
      for (const row of scoped) Object.assign(row, set);
      return scoped.map((row) => ({ ...row }));
    };
    const chain: Record<string, unknown> = {
      set: (next: Record<string, unknown>) => {
        set = next;
        state.updates.push({ table, set: next });
        return chain;
      },
      where: (predicate: unknown) => {
        params = predicateParams(predicate);
        return chain;
      },
      returning: () => Promise.resolve(apply()),
      then: (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) => Promise.resolve(apply()).then(resolve, reject),
    };
    return chain;
  };

  const db: Record<string, unknown> = {
    select: () => {
      let table: unknown;
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = t;
        return chain;
      };
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(list(table).map((row) => ({ ...row })));
      chain.then = (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) =>
        Promise.resolve(list(table).map((row) => ({ ...row }))).then(resolve, reject);
      return chain;
    },
    insert: (table: unknown) => insertBuilder(table),
    update: (table: unknown) => updateBuilder(table),
    delete: (table: unknown) => {
      const name = nameOf(table);
      const chain: Record<string, unknown> = {};
      chain.where = (predicate: unknown) => {
        const params = predicateParams(predicate);
        const rows = state[name] as Array<Record<string, unknown>>;
        // A predicate that names rows removes those; a site-wide one removes all of them.
        const keep = rows.filter((row) => !rowMatches(row, params));
        rows.length = 0;
        rows.push(...keep);
        state.deletes.push(name);
        return Promise.resolve(undefined);
      };
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
  };
  if (options.transaction !== false) {
    db.transaction = async (cb: (tx: unknown) => Promise<unknown>) => cb(db);
  }
  return db as unknown as Database;
}

function role(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ref: 'role:editor', key: 'editor', systemKey: null, name: 'Editor', description: null, icon: null, parent: null, adminAccess: false, appAccess: true, ...overrides };
}

function policy(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    ref: 'policy:published_read',
    key: 'published_read',
    name: 'Published read',
    icon: null,
    description: null,
    adminAccess: false,
    appAccess: true,
    enforceTfa: false,
    ipAllow: [],
    ipDeny: [],
    validFrom: null,
    validUntil: null,
    rules: {},
    permissions: [{ collection: 'posts', action: 'read', permissions: {}, validation: {}, presets: {}, fields: ['title'] }],
    ...overrides,
  };
}

function apiKey(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ref: 'api_key:lbk_sync', name: 'Sync bot', description: null, prefix: 'lbk_sync', expiresAt: null, revokedAt: null, metadata: {}, ...overrides };
}

function manifest(overrides: Partial<AccessExportManifest> = {}): AccessExportManifest {
  return {
    schema: ACCESS_EXPORT_SCHEMA,
    exportedAt: '2026-06-04T00:00:00.000Z',
    roles: [role() as never],
    policies: [policy() as never],
    apiKeys: [],
    bindings: {
      rolePolicies: [{ role: 'role:editor', policy: 'policy:published_read', priority: 10 }],
      userRoles: [],
      userPolicies: [],
      apiKeyRoles: [],
      apiKeyPolicies: [],
    },
    ...overrides,
  } as AccessExportManifest;
}

const service = (db: Database) => new AccessImportService({ db, siteId: 'site_1' });

describe('merge keeps everything it does not name', () => {
  it('upserts the named rows and adds the bindings', async () => {
    const state = rows();
    const result = await service(fakeDb(state)).apply(manifest(), 'merge');
    expect(result.applied).toBe(true);
    expect(state.roles).toHaveLength(1);
    expect(state.policies).toHaveLength(1);
    expect(state.permissions).toHaveLength(1);
    expect(state.rolePolicies).toHaveLength(1);
    expect(state.deletes).toEqual(['permissions']);
  });

  it('updates an existing role and policy in place rather than adding a second row', async () => {
    const state = rows({
      roles: [{ id: 'role_1', siteId: 'site_1', key: 'editor', systemKey: null, name: 'Old' }],
      policies: [{ id: 'pol_1', siteId: 'site_1', key: 'published_read', name: 'Old', enforceTfa: false }],
    });
    await service(fakeDb(state)).apply(manifest(), 'merge');
    expect(state.roles).toHaveLength(1);
    expect(state.roles[0]).toMatchObject({ id: 'role_1', name: 'Editor' });
    expect(state.policies).toHaveLength(1);
    expect(state.policies[0]).toMatchObject({ id: 'pol_1', name: 'Published read' });
  });

  it('walks to a parent role through the manifest and clears an absent one', async () => {
    const state = rows();
    await service(fakeDb(state)).apply(
      manifest({
        roles: [
          role({ ref: 'role:parent', key: 'parent', name: 'Parent' }) as never,
          role({ ref: 'role:child', key: 'child', name: 'Child', parent: 'role:parent' }) as never,
          role({ ref: 'role:orphan', key: 'orphan', name: 'Orphan', parent: null }) as never,
        ],
        bindings: { rolePolicies: [], userRoles: [], userPolicies: [], apiKeyRoles: [], apiKeyPolicies: [] },
      }),
      'merge',
    );
    const byKey = Object.fromEntries(state.roles.map((row) => [row.key, row]));
    expect(byKey.child!.parentId).toBe(byKey.parent!.id);
    expect(byKey.orphan!.parentId).toBeNull();
  });

  it('keeps an `id:` ref as the row id and a dated API key that already exists, updating it by prefix', async () => {
    const state = rows({ apiKeys: [{ id: 'key_1', siteId: 'site_1', prefix: 'lbk_sync', name: 'Old', tokenHash: 'hash' }] });
    await service(fakeDb(state)).apply(
      manifest({
        apiKeys: [apiKey({ ref: 'api_key:lbk_sync', name: 'Renamed', expiresAt: '2027-01-01T00:00:00.000Z' }) as never],
        roles: [role({ ref: 'id:role_fixed', key: null, name: 'Fixed' }) as never],
        bindings: { rolePolicies: [], userRoles: [], userPolicies: [], apiKeyRoles: [], apiKeyPolicies: [] },
      }),
      'merge',
    );
    expect(state.roles[0]!.id).toBe('role_fixed');
    expect(state.apiKeys).toHaveLength(1);
    expect(state.apiKeys[0]).toMatchObject({ id: 'key_1', name: 'Renamed', tokenHash: 'hash' });
    expect(state.apiKeys[0]!.expiresAt).toEqual(new Date('2027-01-01T00:00:00.000Z'));
  });

  it('inserts a new API key with a derived token hash, and an unparseable date becomes null', async () => {
    const state = rows();
    await service(fakeDb(state)).apply(
      manifest({
        apiKeys: [apiKey({ expiresAt: 'not-a-date', revokedAt: 'also-not' }) as never],
        bindings: { rolePolicies: [], userRoles: [], userPolicies: [], apiKeyRoles: [], apiKeyPolicies: [] },
      }),
      'merge',
    );
    expect(state.apiKeys[0]).toMatchObject({ prefix: 'lbk_sync', tokenHash: 'imported:site_1:lbk_sync', expiresAt: null, revokedAt: null });
  });

  it('writes every binding kind', async () => {
    const state = rows();
    await service(fakeDb(state)).apply(
      manifest({
        apiKeys: [apiKey() as never],
        bindings: {
          rolePolicies: [{ role: 'role:editor', policy: 'policy:published_read', priority: 10 }],
          userRoles: [
            { userId: 'usr_primary', role: 'role:editor', primary: true },
            { userId: 'usr_extra', role: 'role:editor', primary: false },
          ],
          userPolicies: [{ userId: 'usr_extra', policy: 'policy:published_read', priority: 3 }],
          apiKeyRoles: [{ apiKey: 'api_key:lbk_sync', role: 'role:editor', priority: 5 }],
          apiKeyPolicies: [{ apiKey: 'api_key:lbk_sync', policy: 'policy:published_read', priority: 6 }],
        },
      }),
      'merge',
    );
    expect(state.userSites).toEqual([{ id: 'userSites_1', userId: 'usr_primary', siteId: 'site_1', roleId: 'roles_1' }]);
    expect(state.userRoles).toHaveLength(1);
    expect(state.userPolicies).toHaveLength(1);
    expect(state.apiKeyRoles).toHaveLength(1);
    expect(state.apiKeyPolicies).toHaveLength(1);
  });

  it('skips a binding whose ref does not resolve (the dry-run is the gate that refuses it)', async () => {
    const state = rows();
    await service(fakeDb(state)).apply(
      manifest({
        bindings: {
          rolePolicies: [{ role: 'role:missing', policy: 'policy:published_read', priority: 1 }],
          userRoles: [{ userId: 'usr_1', role: 'role:missing', primary: false }],
          userPolicies: [{ userId: 'usr_1', policy: 'policy:missing', priority: 1 }],
          apiKeyRoles: [{ apiKey: 'api_key:missing', role: 'role:editor', priority: 1 }],
          apiKeyPolicies: [{ apiKey: 'api_key:missing', policy: 'policy:published_read', priority: 1 }],
        },
      }),
      'merge',
    );
    expect(state.rolePolicies).toEqual([]);
    expect(state.userRoles).toEqual([]);
    expect(state.userPolicies).toEqual([]);
    expect(state.apiKeyRoles).toEqual([]);
    expect(state.apiKeyPolicies).toEqual([]);
  });

  it('applies without a transaction-capable handle too', async () => {
    const state = rows();
    const result = await service(fakeDb(state, { transaction: false })).apply(manifest(), 'merge');
    expect(result.applied).toBe(true);
    expect(state.roles).toHaveLength(1);
  });
});

describe('replace-managed removes what it manages and the manifest no longer names', () => {
  it('deletes named managed rows and keeps unmanaged ones', async () => {
    const state = rows({
      roles: [
        { id: 'role_old', siteId: 'site_1', key: 'old', systemKey: null, name: 'Old' },
        { id: 'role_custom', siteId: 'site_1', key: null, systemKey: null, name: 'Custom' },
        { id: 'role_system', siteId: 'site_1', key: null, systemKey: 'system_owner', name: 'Owner' },
      ],
      policies: [
        { id: 'pol_old', siteId: 'site_1', key: 'old', name: 'Old' },
        { id: 'pol_custom', siteId: 'site_1', key: null, name: 'Custom' },
      ],
      apiKeys: [{ id: 'key_old', siteId: 'site_1', prefix: 'lbk_old', name: 'Old' }],
    });
    await service(fakeDb(state)).apply(manifest(), 'replace-managed');
    expect(state.roles.map((row) => row.key)).toEqual([null, 'editor']);
    expect(state.policies.map((row) => row.key)).toEqual([null, 'published_read']);
    expect(state.apiKeys).toHaveLength(0);
    // Every binding that pointed at a removed row goes with it.
    for (const table of ['apiKeyPolicies', 'apiKeyRoles', 'apiKeys', 'userPolicies', 'rolePolicies', 'permissions', 'policies', 'userRoles', 'roles']) {
      expect(state.deletes, table).toContain(table);
    }
  });

  it('drops the incoming targets’ old bindings, so the manifest is the whole truth for them', async () => {
    const state = rows({
      roles: [{ id: 'role_1', siteId: 'site_1', key: 'editor', systemKey: null, name: 'Editor' }],
      policies: [{ id: 'pol_1', siteId: 'site_1', key: 'published_read', name: 'Published read' }],
      rolePolicies: [{ id: 'rp_1', roleId: 'role_1', policyId: 'pol_gone' }],
      userRoles: [{ id: 'ur_1', userId: 'usr_1', siteId: 'site_1', roleId: 'role_1' }],
      userSites: [{ id: 'us_1', userId: 'usr_1', siteId: 'site_1', roleId: 'role_1' }],
      userPolicies: [{ id: 'up_1', userId: 'usr_1', siteId: 'site_1', policyId: 'pol_1' }],
      apiKeyRoles: [{ id: 'akr_1', apiKeyId: 'key_1', siteId: 'site_1', roleId: 'role_1' }],
      apiKeyPolicies: [{ id: 'akp_1', apiKeyId: 'key_1', siteId: 'site_1', policyId: 'pol_1' }],
      apiKeys: [{ id: 'key_1', siteId: 'site_1', prefix: 'lbk_sync', name: 'Sync' }],
    });
    await service(fakeDb(state)).apply(
      manifest({
        apiKeys: [apiKey() as never],
        bindings: {
          rolePolicies: [{ role: 'role:editor', policy: 'policy:published_read', priority: 10 }],
          userRoles: [],
          userPolicies: [],
          apiKeyRoles: [{ apiKey: 'api_key:lbk_sync', role: 'role:editor', priority: 5 }],
          apiKeyPolicies: [],
        },
      }),
      'replace-managed',
    );
    expect(state.deletes).toEqual(
      expect.arrayContaining(['rolePolicies', 'userRoles', 'userPolicies', 'apiKeyRoles', 'apiKeyPolicies']),
    );
    expect(state.updates.some((entry) => entry.set.roleId === null)).toBe(true);
    // The manifest's own bindings are written after the delete.
    expect(state.rolePolicies).toHaveLength(1);
    expect(state.apiKeyRoles).toHaveLength(1);
    expect(state.userRoles).toHaveLength(0);
  });
});

describe('replace-all clears the site first', () => {
  it('deletes every access row of the site, then writes the manifest', async () => {
    const state = rows({
      roles: [{ id: 'role_old', siteId: 'site_1', key: 'old', systemKey: null, name: 'Old' }],
      policies: [{ id: 'pol_old', siteId: 'site_1', key: 'old', name: 'Old' }],
      apiKeys: [{ id: 'key_old', siteId: 'site_1', prefix: 'lbk_old', name: 'Old' }],
    });
    const result = await service(fakeDb(state)).apply(manifest(), 'replace-all');
    expect(result.applied).toBe(true);
    expect(state.roles.map((row) => row.key)).toEqual(['editor']);
    expect(state.policies.map((row) => row.key)).toEqual(['published_read']);
    expect(state.apiKeys).toHaveLength(0);
    for (const table of ['apiKeyPolicies', 'apiKeyRoles', 'userPolicies', 'permissions', 'userRoles', 'rolePolicies', 'roles', 'policies', 'apiKeys']) {
      expect(state.deletes, table).toContain(table);
    }
  });

  it('copes with a site that has no rows at all', async () => {
    const state = rows();
    const result = await service(fakeDb(state)).apply(
      manifest({ roles: [], policies: [], bindings: { rolePolicies: [], userRoles: [], userPolicies: [], apiKeyRoles: [], apiKeyPolicies: [] } }),
      'replace-all',
    );
    expect(result.applied).toBe(true);
    expect(state.deletes).toEqual([]);
  });
});

describe('reference validation blocks an import before any write', () => {
  const invalid = async (patch: Partial<AccessExportManifest>) => {
    const state = rows();
    const result = await service(fakeDb(state)).apply(manifest(patch), 'merge');
    return { result, state };
  };

  it('refuses duplicate refs', async () => {
    const { result, state } = await invalid({ roles: [role() as never, role() as never] });
    expect(result.applied).toBe(false);
    expect(result.errors.filter((issue) => issue.code === 'DUPLICATE_REF')).toHaveLength(1);
    expect(state.roles).toEqual([]);
  });

  it('refuses an unknown parent role and every unknown binding ref', async () => {
    const { result } = await invalid({
      roles: [role({ parent: 'role:missing' }) as never],
      bindings: {
        rolePolicies: [{ role: 'role:missing', policy: 'policy:missing', priority: 1 }],
        userRoles: [{ userId: 'usr_1', role: 'role:missing', primary: true }],
        userPolicies: [{ userId: 'usr_1', policy: 'policy:missing', priority: 1 }],
        apiKeyRoles: [{ apiKey: 'api_key:missing', role: 'role:missing', priority: 1 }],
        apiKeyPolicies: [{ apiKey: 'api_key:missing', policy: 'policy:missing', priority: 1 }],
      },
    });
    expect(result.applied).toBe(false);
    const codes = result.errors.map((issue) => issue.code);
    expect(codes).toContain('UNKNOWN_ROLE_REF');
    expect(codes).toContain('UNKNOWN_POLICY_REF');
    expect(codes).toContain('UNKNOWN_API_KEY_REF');
    expect(result.errors.map((issue) => issue.path)).toEqual(
      expect.arrayContaining([
        'roles.0.parent',
        'bindings.rolePolicies.0.role',
        'bindings.rolePolicies.0.policy',
        'bindings.userRoles.0.role',
        'bindings.userPolicies.0.policy',
        'bindings.apiKeyRoles.0.apiKey',
        'bindings.apiKeyRoles.0.role',
        'bindings.apiKeyPolicies.0.apiKey',
        'bindings.apiKeyPolicies.0.policy',
      ]),
    );
  });

  it('reports conflicts inherited from a role and from an API-key role', async () => {
    const { result } = await invalid({
      policies: [
        policy() as never,
        policy({ ref: 'policy:everything', key: 'everything', name: 'Everything', permissions: [{ collection: 'posts', action: 'read', permissions: {}, validation: {}, presets: {}, fields: ['*'] }] }) as never,
        policy({ ref: 'policy:tfa', key: 'tfa', name: 'TFA', enforceTfa: true, permissions: [] }) as never,
      ],
      apiKeys: [apiKey() as never],
      bindings: {
        rolePolicies: [
          { role: 'role:editor', policy: 'policy:published_read', priority: 10 },
          { role: 'role:editor', policy: 'policy:everything', priority: 20 },
        ],
        userRoles: [{ userId: 'usr_1', role: 'role:editor', primary: true }],
        userPolicies: [],
        apiKeyRoles: [{ apiKey: 'api_key:lbk_sync', role: 'role:editor', priority: 1 }],
        apiKeyPolicies: [{ apiKey: 'api_key:lbk_sync', policy: 'policy:tfa', priority: 2 }],
      },
    });
    const reasons = result.conflicts.conflicts.map((conflict) => conflict.reason);
    // The role's own conflict, plus the same policies seen through the user and the API key that inherit them.
    expect(reasons).toContain('ALL_FIELDS_WIDENS_FIELD_WHITELIST:role:role:editor');
    expect(reasons).toContain('ALL_FIELDS_WIDENS_FIELD_WHITELIST:user:usr_1');
    expect(reasons).toContain('ALL_FIELDS_WIDENS_FIELD_WHITELIST:api_key:api_key:lbk_sync');
    expect(reasons).toContain('TFA_POLICY_CANNOT_ATTACH_TO_API_KEY:api_key:api_key:lbk_sync');
  });
});
