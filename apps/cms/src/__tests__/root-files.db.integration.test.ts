import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { apiKeyRoles, apiKeys, auditLog, roles, siteRenderVersions, type Database } from '@heopress/database';
import { createPlaintextToken } from '../services/api-key-token';
import { RootFilesService } from '../services/site-network/root-files';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The root files and crawler settings over HTTP (HeoPress P07 tasks 3.2, 3.8; Codex review of batch 7): only a site's
 * administrators write its root files; a file at the size limit is accepted as plain text whatever its line endings;
 * every write is audited with its request; a malformed body is a 400; a custom crawler cannot take a known one's token.
 */

const JWT_SECRET = 'root-files-secret';

describe.skipIf(!hasDbIntegrationUrl)('root files — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('root-files');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'rootf', jwtSecret: JWT_SECRET });
    for (const id of [fx.sites.a, fx.sites.b]) {
      await upgradeSitePreset(db, id);
      await rebuildSiteProjection(db, id);
    }
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = (path: string, method: string, headers: Record<string, string>, body?: string, type = 'application/json') =>
    app.request(path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': type }) }, ...(body === undefined ? {} : { body }) }, env);
  const codeOf = async (res: Response) => ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;
  const version = async (siteId: string) => (await db.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, siteId)))[0]?.v ?? 0;

  it('administrators only; plain text up to the limit (CRLF included); a bad body is a 400; audited with its request; the render version moves', async () => {
    const admin = { ...fx.headers('a', await fx.session('adminA', 'a')), 'user-agent': 'root-files-test' };
    const path = '/api/v1/site/root-files/ads.txt';
    // At the limit, with CRLF line endings (escaped as JSON it would pass 1 MiB): accepted as plain text.
    const line = 'example.com, pub-0000000000000000, DIRECT\r\n';
    const big = line.repeat(Math.floor((512 * 1024) / line.length));
    const before = await version(fx.sites.a);
    const put = await call(path, 'PUT', admin, big, 'text/plain; charset=utf-8');
    expect(put.status, await put.clone().text()).toBe(200);
    expect(((await put.json()) as { data: { size: number } }).data.size).toBe(Buffer.byteLength(big));
    expect(await version(fx.sites.a)).toBeGreaterThan(before);
    // One byte more: refused.
    const over = await call(path, 'PUT', admin, `${big}${'x'.repeat(512 * 1024 - big.length + 1)}`, 'text/plain');
    expect(over.status).toBe(400);
    expect(await codeOf(over)).toBe('TOO_LARGE');
    // JSON works too; a body that is no object (`null`) or holds no text is a 400, not a 500.
    expect((await call('/api/v1/site/root-files/app-ads.txt', 'PUT', admin, JSON.stringify({ content: 'a' }))).status).toBe(200);
    for (const body of ['null', '[]', '{}', '{"content":5}', 'not json']) {
      const res = await call('/api/v1/site/root-files/x.txt', 'PUT', admin, body);
      expect(res.status, body).toBe(400);
      expect(await codeOf(res), body).toBe('INVALID_CONTENT');
    }
    // A system name.
    const robots = await call('/api/v1/site/root-files/robots.txt', 'PUT', admin, 'x', 'text/plain');
    expect(robots.status).toBe(409);
    expect(await codeOf(robots)).toBe('SYSTEM_FILE');
    // Not an administrator of the site, or of another site: refused, nothing written.
    const member = fx.headers('a', await fx.session('onlyA', 'a'));
    expect((await call('/api/v1/site/root-files/evil.txt', 'PUT', member, 'x', 'text/plain')).status).toBe(403);
    expect((await call('/api/v1/site/root-files', 'GET', member)).status).toBe(403);
    expect((await call('/api/v1/site/root-files/evil.txt', 'PUT', fx.headers('a', await fx.session('adminB', 'b')), 'x', 'text/plain')).status).toBeGreaterThanOrEqual(401);
    const list = (await (await call('/api/v1/site/root-files', 'GET', admin)).json()) as { data: Array<{ filename: string }> };
    expect(list.data.map((f) => f.filename)).toEqual(['ads.txt', 'app-ads.txt']);
    // Site B sees none of A's.
    const listB = (await (await call('/api/v1/site/root-files', 'GET', fx.headers('b', await fx.session('adminB', 'b')))).json()) as { data: unknown[] };
    expect(listB.data).toEqual([]);
    // Deleted; audited with who, how and the request.
    expect((await call(path, 'DELETE', admin)).status).toBe(200);
    expect((await call(path, 'DELETE', admin)).status).toBe(404);
    const rows = await db
      .select({ event: auditLog.event, userAgent: auditLog.userAgent, metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.siteId, fx.sites.a), inArray(auditLog.event, ['root_file_written', 'root_file_deleted'])));
    expect(rows.map((r) => r.event).sort()).toEqual(['root_file_deleted', 'root_file_written', 'root_file_written']);
    for (const r of rows) {
      expect(r.userAgent).toBe('root-files-test');
      expect(r.metadata).toMatchObject({ userId: fx.users.adminA.id, method: expect.any(String) });
    }
  });

  it('the bounds hold however the body comes: JSON at the size limit is accepted, a chunked body past it is refused as it is read', async () => {
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    // Quotes, backslashes and line breaks: each takes two bytes as JSON.
    const big = '"\\\n'.repeat(Math.floor((512 * 1024) / 3));
    // As JSON it is escaped past 1 MiB: still accepted (this route bounds its own body).
    const json = JSON.stringify({ content: big });
    expect(Buffer.byteLength(json)).toBeGreaterThan(1024 * 1024);
    // With its Content-Length, as a client sends it (the global JSON limit reads that header).
    const ok = await call('/api/v1/site/root-files/ads.txt', 'PUT', { ...admin, 'content-length': String(Buffer.byteLength(json)) }, json);
    expect(ok.status, await ok.clone().text()).toBe(200);
    // Chunked, no Content-Length, far past the limit: refused without reading it all.
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        sent += 64 * 1024;
        if (sent > 64 * 1024 * 1024) ctrl.close();
        else ctrl.enqueue(new Uint8Array(64 * 1024).fill(0x61));
      },
    });
    const res = await app.request(
      '/api/v1/site/root-files/huge.txt',
      { method: 'PUT', headers: { ...admin, 'content-type': 'text/plain' }, body: endless, duplex: 'half' } as RequestInit,
      env,
    );
    expect(res.status).toBe(400);
    expect(await codeOf(res)).toBe('TOO_LARGE');
    expect(sent).toBeLessThan(2 * 1024 * 1024);
  });

  it("an administrator's API key: allowed, and the audit names the key (Codex review of batch 7)", async () => {
    const [adminRole] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, fx.sites.a), eq(roles.adminAccess, true))).limit(1);
    const token = await createPlaintextToken();
    const [key] = await db.insert(apiKeys).values({ siteId: fx.sites.a, name: 'rootf admin key', prefix: token.prefix, tokenHash: token.tokenHash }).returning({ id: apiKeys.id });
    await db.insert(apiKeyRoles).values({ apiKeyId: key!.id, siteId: fx.sites.a, roleId: adminRole!.id });
    const res = await call('/api/v1/site/root-files/key.txt', 'PUT', fx.headers('a', token.token), 'by key', 'text/plain');
    expect(res.status, await res.clone().text()).toBe(200);
    const [row] = await db.select({ metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'root_file_written')));
    expect(row!.metadata).toMatchObject({ filename: 'key.txt', apiKeyId: key!.id, userId: null });
  });

  it('at most 100 root files a site, also when two are written at once at the limit', async () => {
    const service = new RootFilesService({ db, siteId: fx.sites.a, actor: { userId: null } });
    for (let i = 0; i < 99; i++) await service.put(`f${i}.txt`, 'x');
    const results = await Promise.allSettled([service.put('last-a.txt', 'x'), service.put('last-b.txt', 'x')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['TOO_MANY']);
    expect(await service.list()).toHaveLength(100);
    // Replacing one is not a new one.
    await service.put('f0.txt', 'y');
  }, 120_000);

  it("task 3.2: a custom crawler cannot take a known crawler's token (a 'training' Bingbot), nor another custom one's", async () => {
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    const update = (custom: unknown[]) =>
      call('/api/v1/site/seo-settings', 'PUT', admin, JSON.stringify({ version: 0, crawlers: { purposes: { training: 'disallow' }, custom } }));
    for (const custom of [
      [{ id: 'acme-search', userAgent: 'Bingbot', purpose: 'training' }],
      [{ id: 'acme-search', userAgent: 'bingbot', purpose: 'training' }],
      [{ id: 'bingbot', userAgent: 'AcmeBot', purpose: 'training' }],
      [{ id: 'one', userAgent: 'AcmeBot', purpose: 'training' }, { id: 'two', userAgent: 'acmebot', purpose: 'search' }],
    ]) {
      const res = await update(custom);
      expect(res.status, JSON.stringify(custom)).toBe(400);
    }
    expect((await update([{ id: 'acme', userAgent: 'AcmeBot', purpose: 'training' }])).status).toBe(200);
  });
});
