import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, sites, systemState, users, type Database } from '@heopress/database';

import app from '../index';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';

/**
 * GraphQL switched on (P02 spec platform/feature-surface, scenario
 * "管理员开启 GraphQL"): through the real app on PostgreSQL, with
 * HEOPRESS_ENABLE_GRAPHQL=true in the request bindings,
 *   - an admin's query returns the collection's items;
 *   - an anonymous caller gets none of them (the public role has no read);
 *   - the depth limit and the cost limit reject abusive queries.
 * The default-off 404 is covered in config/__tests__/features.test.ts.
 * Needs DATABASE_URL (disposable), HEOPRESS_ENV=development and JWT_SECRET.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL?.trim() || undefined;
const SITE = '__default__';
const ADMIN_EMAIL = 'graphql-admin@example.test';
const ADMIN_PASSWORD = 'GraphQL-Enabled-E2E-1!';
const ENV = { ...process.env, HEOPRESS_ENABLE_GRAPHQL: 'true' } as unknown as Record<string, unknown>;

let bearer = '';
const request = (path: string, init?: RequestInit) => app.request(path, init, ENV);
const gql = async (query: string, auth = true) => {
  const res = await request('/api/v1/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-heopress-site': SITE, ...(auth ? { authorization: bearer } : {}) },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown> | null; errors?: Array<{ message: string }> } };
};

describe.skipIf(!TEST_DATABASE_URL)('GraphQL enabled (PostgreSQL)', () => {
  let db: Database;

  async function resetFixture(): Promise<void> {
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.isBootstrap, true)).catch(() => undefined);
    await db.delete(systemState).catch(() => undefined);
  }

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL!);
    await db.execute(sql`SELECT 1`);
    await resetFixture();

    const setup = await request('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, firstName: 'GraphQL', lastName: 'Admin' },
        adminPath: '/graphql-e2e-admin',
        policy: STANDARD_LOCKOUT_POLICY,
        project: { defaultLanguage: 'en', siteUrl: 'https://graphql.example.test', displayTitle: 'GraphQL E2E' },
      }),
    });
    expect(setup.status, await setup.clone().text()).toBe(201);
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-heopress-site': SITE },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    bearer = `Bearer ${((await login.json()) as { data: { token: string } }).data.token}`;

    const post = (path: string, body: unknown) =>
      request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-heopress-site': SITE, authorization: bearer },
        body: JSON.stringify(body),
      });
    expect((await post('/api/v1/collections', { name: 'notes' })).status).toBe(201);
    for (const title of ['first note', 'second note']) {
      expect((await post('/api/v1/items/notes', { data: { title }, status: 'published' })).status).toBe(201);
    }
  });

  afterAll(async () => {
    if (db) await resetFixture();
  });

  it('returns the items to an admin', async () => {
    const { status, body } = await gql('{ notes { id _data } }');
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.errors).toBeUndefined();
    const titles = (body.data!.notes as Array<{ _data: { title: string } }>).map((n) => n._data.title).sort();
    expect(titles).toEqual(['first note', 'second note']);
  });

  it('returns none of them to an anonymous caller', async () => {
    const { body } = await gql('{ notes { id _data } }', false);
    expect(JSON.stringify(body)).not.toContain('first note');
    expect((body.data?.notes as unknown[] | undefined)?.length ?? 0).toBe(0);
  });

  it('rejects a query deeper than the depth limit', async () => {
    const deep = `{ __schema { types { fields { type ${'{ ofType '.repeat(12)}{ name }${' }'.repeat(12)} } } } }`;
    const { body } = await gql(deep);
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.map((e) => e.message).join('\n')).toMatch(/maximum depth/);
  });

  it('rejects a query over the cost limit', async () => {
    const wide = `{ ${Array.from({ length: 60 }, (_, i) => `a${i}: notes { id }`).join(' ')} }`;
    const { body } = await gql(wide);
    expect(body.data ?? null).toBeNull();
    expect(body.errors?.map((e) => e.message).join('\n')).toMatch(/cost/i);
  });
});
