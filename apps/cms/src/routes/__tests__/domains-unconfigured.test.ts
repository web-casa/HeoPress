import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppEnv } from '../../env';
import { domainsRouter } from '../domains';

/**
 * Domain creation on an instance without operator-provided domains.
 *
 * HeoPress has no hosted free-subdomain suffix (`heopress.example` is a
 * reserved placeholder), so without HEOPRESS_FREE_DOMAIN_SUFFIX a free
 * subdomain is refused instead of being stored as `active`, and custom-domain
 * instructions never name the placeholder.
 */

interface Inserted {
  hostname: string;
  status: string;
  statusReason: string | null;
  verification: { records: Array<{ value: string }> };
}

function app(env: Partial<AppEnv['Bindings']>) {
  const inserted: Inserted[] = [];
  const db: Record<string, unknown> = {
    // The create runs in a site transaction (P05: a live language entry is checked there); none is asked for here.
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    execute: async () => [],
    insert: () => ({
      values: (v: Inserted) => ({
        returning: async () => {
          inserted.push(v);
          const now = new Date();
          return [{ id: 'dom_1', isPrimary: false, sslStatus: null, verifiedAt: null, createdAt: now, updatedAt: now, ...v }];
        },
      }),
    }),
  };
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.env = env as AppEnv['Bindings'];
    c.set('siteId', 'site_1');
    c.set('db', db as never);
    await next();
  });
  a.route('/domains', domainsRouter);
  const post = (body: unknown) =>
    a.request('/domains', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  return { post, inserted };
}

describe('domains without operator configuration', () => {
  it('refuses a free subdomain when no suffix is configured', async () => {
    const { post, inserted } = app({});
    const res = await post({ kind: 'subdomain', hostname: 'blog' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('FREE_SUBDOMAIN_NOT_CONFIGURED');
    expect(inserted).toEqual([]);
  });

  it('uses the operator suffix when it is configured', async () => {
    const { post, inserted } = app({ HEOPRESS_FREE_DOMAIN_SUFFIX: 'sites.example.com' });
    expect((await post({ kind: 'subdomain', hostname: 'blog' })).status).toBe(201);
    expect(inserted[0]).toMatchObject({ hostname: 'blog.sites.example.com', status: 'active' });
  });

  it('gives custom domains no placeholder CNAME target', async () => {
    const { post, inserted } = app({});
    expect((await post({ kind: 'custom', hostname: 'cms.example.com' })).status).toBe(201);
    expect(inserted[0]!.status).toBe('pending'); // HeoPress P04: verified before it serves
    expect(inserted[0]!.verification.records).toEqual([]);
    expect(inserted[0]!.statusReason).toMatch(/HEOPRESS_SAAS_FALLBACK/);
  });

  it('names the operator CNAME target when one is configured', async () => {
    const { post, inserted } = app({ HEOPRESS_SAAS_FALLBACK: 'cname.sites.example.com' });
    await post({ kind: 'custom', hostname: 'cms.example.com' });
    expect(inserted[0]!.verification.records.map((r) => r.value)).toEqual(['cname.sites.example.com']);
  });
});
