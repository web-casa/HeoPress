import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { MemoryRateLimiter } from '@heopress/runtime';
import { siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { domainsRouter } from '../domains';
import { internalTlsRouter } from '../internal-tls';
import { withPublicSite } from '../../middleware/public-site';
import {
  CHALLENGE_LABEL,
  HTTP_VERIFICATION_PATH,
  defaultDomainProbe,
  domainProbe,
  type DomainProbe,
} from '../../services/domains/domain-verification';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Domain routing (HeoPress P04 tasks 5.1–5.3, 5.5; spec sites/domain-routing):
 * a domain serves nothing until its own token is found (DNS TXT or HTTP
 * file); the certificate gate answers 200 only for active domains, only to
 * internal peers, with a rate limit; aliases redirect to the primary domain
 * and language entries keep their host; a domain belongs to one site;
 * tokens are bound to their claim and expire; unknown hosts and forged
 * forwarded hosts resolve to nothing.
 */

const A = 'site_domains_a_it';
const B = 'site_domains_b_it';
const HOSTS = ['example.com', 'www.example.com', 'en.example.com', 'shop.example.org', 'files.example.net'];

type DomainBody = { data: { id: string; status: string; verification: { records: Array<{ type: string; name: string; value: string }> } } };
type ErrorBody = { errors: Array<{ code: string }> };

describe.skipIf(!hasDbIntegrationUrl)('domain routing — DB integration', () => {
  let db: Database;
  let published: { txt: Map<string, string[]>; http: Map<string, string> };
  const limiter = new MemoryRateLimiter();

  const api = (siteId: string) => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      (c as unknown as { env: Record<string, unknown> }).env = {};
      c.set('db', db);
      c.set('siteId', siteId);
      c.set('runtime', { cache: undefined } as unknown as AppEnv['Variables']['runtime']);
      await next();
    });
    app.route('/api/v1/domains', domainsRouter);
    return app;
  };
  const call = (siteId: string, method: string, path: string, body?: unknown) =>
    api(siteId).request(`/api/v1/domains${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  /** A request arriving over TCP from `peer`. */
  const fromPeer = (peer: string, extra: Record<string, unknown> = {}) => ({ incoming: { socket: { remoteAddress: peer } }, ...extra });

  const tls = new Hono<AppEnv>();
  tls.use('*', async (c, next) => {
    c.set('db', db);
    c.set('runtime', { rateLimiter: limiter } as unknown as AppEnv['Variables']['runtime']);
    await next();
  });
  tls.route('/internal/tls', internalTlsRouter);
  const ask = (domain: string, peer: string, env: Record<string, unknown> = {}) =>
    tls.request(`/internal/tls/ask?domain=${encodeURIComponent(domain)}`, {}, fromPeer(peer, env));

  const site = new Hono<AppEnv>();
  site.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  site.use('*', withPublicSite());
  site.get('*', (c) => c.json({ siteId: c.get('siteId'), locale: c.get('publicHost')?.entryLocale ?? null }));
  const visit = (url: string, headers: Record<string, string>, peer = '203.0.113.9', env: Record<string, unknown> = {}) =>
    site.request(url, { headers }, fromPeer(peer, env));

  beforeAll(async () => {
    db = await connectDbIntegration('domain-routing');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(inArray(sites.id, [A, B])).catch(() => undefined);
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.delete(siteDomains).where(inArray(siteDomains.hostname, HOSTS));
    await db.insert(sites).values([
      { id: A, name: 'Domains A' },
      { id: B, name: 'Domains B' },
    ]);
    published = { txt: new Map(), http: new Map() };
    const probe: DomainProbe = {
      txt: async (name) => published.txt.get(name) ?? [],
      httpFile: async (url) => published.http.get(url) ?? null,
    };
    domainProbe.current = probe;
  });
  afterEach(() => {
    domainProbe.current = defaultDomainProbe;
  });

  async function claim(siteId: string, hostname: string, extra: Record<string, unknown> = {}) {
    const res = await call(siteId, 'POST', '', { kind: 'custom', hostname, ...extra });
    return { res, body: (await res.json()) as DomainBody };
  }
  /** Publish the claim's own record and verify it. */
  async function activate(siteId: string, hostname: string, extra: Record<string, unknown> = {}) {
    const { body } = await claim(siteId, hostname, extra);
    const record = body.data.verification.records[0]!;
    if (record.type === 'TXT') published.txt.set(record.name, [record.value]);
    else published.http.set(record.name, record.value);
    const verified = await call(siteId, 'POST', `/${body.data.id}/verify`);
    expect(verified.status, await verified.clone().text()).toBe(200);
    return body.data.id;
  }

  it('5.1 an unverified domain serves nothing; once its TXT record is found it is active', async () => {
    const { res, body } = await claim(A, 'example.com');
    expect(res.status).toBe(201);
    expect(body.data.status).toBe('pending');
    const record = body.data.verification.records[0]!;
    expect(record).toMatchObject({ type: 'TXT', name: `${CHALLENGE_LABEL}.example.com` });
    expect((await visit('http://example.com/', { host: 'example.com' })).status).toBe(404);

    const early = await call(A, 'POST', `/${body.data.id}/verify`);
    expect(early.status).toBe(422);
    expect(((await early.json()) as ErrorBody).errors[0]!.code).toBe('NOT_FOUND_YET');

    published.txt.set(record.name, ['unrelated', record.value]);
    const ok = await call(A, 'POST', `/${body.data.id}/verify`);
    expect(((await ok.json()) as DomainBody).data.status).toBe('active');
    const page = await visit('http://example.com/', { host: 'example.com' });
    expect(page.status).toBe(200);
    expect(await page.json()).toEqual({ siteId: A, locale: null });
  });

  it('5.1 HTTP-file verification works the same way', async () => {
    const { body } = await claim(A, 'shop.example.org', { verificationMethod: 'http_file' });
    const record = body.data.verification.records[0]!;
    expect(record).toMatchObject({ type: 'HTTP', name: `http://shop.example.org${HTTP_VERIFICATION_PATH}` });
    published.http.set(record.name, record.value);
    const ok = await call(A, 'POST', `/${body.data.id}/verify`);
    expect(((await ok.json()) as DomainBody).data.status).toBe('active');
  });

  it('5.2 the certificate gate: 200 only for active domains, 404 otherwise, internal peers only', async () => {
    await activate(A, 'example.com');
    await claim(A, 'www.example.com'); // pending
    expect((await ask('example.com', '10.0.0.5')).status).toBe(200);
    expect((await ask('EXAMPLE.COM.', '127.0.0.1')).status).toBe(200);
    expect((await ask('www.example.com', '10.0.0.5')).status).toBe(404);
    expect((await ask('never-added.example.net', '10.0.0.5')).status).toBe(404);
    // A public address is refused, whatever headers it sends.
    const outside = await tls.request('/internal/tls/ask?domain=example.com', { headers: { 'x-forwarded-for': '10.0.0.5' } }, fromPeer('198.51.100.7'));
    expect(outside.status).toBe(403);
    // A visitor's request forwarded by the reverse proxy comes from an
    // internal address, but carries the proxy's forwarding headers.
    for (const header of ['x-forwarded-for', 'forwarded', 'x-real-ip']) {
      const proxied = await tls.request('/internal/tls/ask?domain=example.com', { headers: { [header]: '198.51.100.7' } }, fromPeer('172.18.0.3'));
      expect(proxied.status).toBe(403);
    }
  });

  it('the certificate gate also answers for the preview origin (P06 task 5.2), and only for its host', async () => {
    const env = { HEOPRESS_PREVIEW_ORIGIN: 'https://preview.admin.example.com' };
    expect((await ask('preview.admin.example.com', '10.0.0.5', env)).status).toBe(200);
    expect((await ask('admin.example.com', '10.0.0.5', env)).status).toBe(404);
    expect((await ask('preview.admin.example.com', '10.0.0.5')).status).toBe(404);
  });

  it('5.2 the certificate gate is rate-limited', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await ask(`random-${i}.example.net`, '10.9.9.9', { HEOPRESS_TLS_ASK_RATE: '3' })).status);
    expect(statuses).toEqual([404, 404, 404, 429, 429]);
  });

  it('5.3 aliases redirect to the primary domain with path and query; a language entry keeps its host', async () => {
    const primary = await activate(A, 'example.com');
    await call(A, 'POST', `/${primary}/primary`);
    await activate(A, 'www.example.com');
    // A language entry names one of the site's other languages (P05).
    await db.insert(siteContentSettings).values({ siteId: A, availableLocales: ['en', 'fr'] }).onConflictDoNothing();
    await activate(A, 'en.example.com', { entryLocale: 'fr' });

    const alias = await visit('http://www.example.com/a?x=1', { host: 'www.example.com' });
    expect(alias.status).toBe(301);
    // One 301 to the final address (P05): the trailing slash policy (default: always) applied in the same step.
    expect(alias.headers.get('location')).toBe('https://example.com/a/?x=1');
    const entry = await visit('http://en.example.com/a', { host: 'en.example.com:443' });
    expect(entry.status).toBe(200);
    expect(await entry.json()).toEqual({ siteId: A, locale: 'fr' });
    expect((await visit('http://example.com/a', { host: 'example.com' })).status).toBe(200);
  });

  it('5.5 a domain belongs to one site: another site may claim it, but cannot verify it while it is active elsewhere', async () => {
    await activate(A, 'example.com');
    const again = await claim(A, 'example.com');
    expect(again.res.status).toBe(409);
    const other = await claim(B, 'example.com');
    expect(other.res.status).toBe(201);
    const record = other.body.data.verification.records[0]!;
    published.txt.set(record.name, [...(published.txt.get(record.name) ?? []), record.value]);
    const taken = await call(B, 'POST', `/${other.body.data.id}/verify`);
    expect(taken.status).toBe(409);
    expect(((await taken.json()) as ErrorBody).errors[0]!.code).toBe('DOMAIN_TAKEN');
    expect((await visit('http://example.com/', { host: 'example.com' })).status).toBe(200);
  });

  it('5.5 a token is bound to its claim: another site’s published token does not verify it; an expired one verifies nothing', async () => {
    const real = await claim(A, 'example.com');
    const squatter = await claim(B, 'example.com');
    // The domain owner published A's token; B's claim needs B's own.
    const aRecord = real.body.data.verification.records[0]!;
    published.txt.set(aRecord.name, [aRecord.value]);
    const replay = await call(B, 'POST', `/${squatter.body.data.id}/verify`);
    expect(((await replay.json()) as ErrorBody).errors[0]!.code).toBe('NOT_FOUND_YET');

    await db.update(siteDomains).set({ verificationExpiresAt: new Date(Date.now() - 1000) }).where(eq(siteDomains.id, real.body.data.id));
    const expired = await call(A, 'POST', `/${real.body.data.id}/verify`);
    expect(((await expired.json()) as ErrorBody).errors[0]!.code).toBe('TOKEN_EXPIRED');
    const fresh = await call(A, 'POST', `/${real.body.data.id}/token`);
    const freshRecord = ((await fresh.json()) as DomainBody).data.verification.records[0]!;
    expect(freshRecord.value).not.toBe(aRecord.value);
    published.txt.set(freshRecord.name, [freshRecord.value]);
    expect((await call(A, 'POST', `/${real.body.data.id}/verify`)).status).toBe(200);
  });

  it('5.5 unknown and disabled hosts resolve to nothing; a forwarded host counts only from a trusted proxy', async () => {
    const id = await activate(A, 'example.com');
    await activate(B, 'files.example.net');
    expect((await visit('http://unknown.example.net/', { host: 'unknown.example.net' })).status).toBe(404);

    // A client cannot point the request at site B with a header…
    const forged = await visit('http://example.com/', { host: 'example.com', 'x-forwarded-host': 'files.example.net' });
    expect(await forged.json()).toEqual({ siteId: A, locale: null });
    // …a trusted reverse proxy can.
    const proxied = await visit('http://example.com/', { host: 'example.com', 'x-forwarded-host': 'files.example.net' }, '10.0.0.2', {
      HEOPRESS_TRUSTED_PROXIES: '10.0.0.0/8',
    });
    expect(await proxied.json()).toEqual({ siteId: B, locale: null });

    await call(A, 'PATCH', `/${id}`, { status: 'disabled' });
    expect((await visit('http://example.com/', { host: 'example.com' })).status).toBe(404);
    expect((await ask('example.com', '10.0.0.5')).status).toBe(404);
  });

  it('5.5 HTTP-file verification goes through the outbound boundary (no private addresses)', async () => {
    expect(await defaultDomainProbe.httpFile(`http://127.0.0.1${HTTP_VERIFICATION_PATH}`)).toBeNull();
    expect(await defaultDomainProbe.httpFile(`http://169.254.169.254${HTTP_VERIFICATION_PATH}`)).toBeNull();
  });
});
