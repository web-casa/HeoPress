import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { apiKeys, files, items, settings, type Database } from '@heopress/database';
import app from '../index';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Cross-site writes are refused (HeoPress P04 task 10.2), through the whole
 * app with real credentials, on the cross-site fixture (task 9.3): site A's
 * session or API key cannot write site B's content — whether it names site B
 * or reaches for B's item id from site A — and nothing in B changes. The
 * same holds for a person who belongs to both sites but only reads B, and
 * for an API key used as an MCP token.
 */

const JWT_SECRET = 'cross-site-writes-test-secret';
const ENV = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' } as unknown as Record<string, unknown>;

describe.skipIf(!hasDbIntegrationUrl)('cross-site writes — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;

  const send = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, ENV);
  const itemB = async () => (await db.select().from(items).where(eq(items.id, fx.items.b)))[0]!;
  const patchBody = { data: { title: 'written from A' }, expectedVersion: 1 };

  beforeAll(async () => {
    db = await connectDbIntegration('cross-site-writes');
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'xsw', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  it('the fixture: two sites with the same names, each principal working on its own site', async () => {
    const [a, b] = [await db.select().from(items).where(eq(items.id, fx.items.a)), await db.select().from(items).where(eq(items.id, fx.items.b))];
    expect((a[0]!.data as { slug: string }).slug).toBe(SHARED.slug);
    expect((b[0]!.data as { path: string }).path).toBe(SHARED.path);
    const names = await db.select({ name: files.filenameDownload }).from(files).where(eq(files.id, fx.files.b));
    expect(names[0]!.name).toBe(SHARED.fileName);
    expect(await db.select().from(settings).where(eq(settings.siteId, fx.sites.b))).toEqual([
      expect.objectContaining({ key: 'theme', value: { name: SHARED.theme } }),
    ]);

    // Positive controls: without these, every refusal below could be a broken setup.
    const own = await send(`/api/v1/items/${SHARED.collection}/${fx.items.a}`, 'PATCH', fx.headers('a', await fx.session('onlyA', 'a')), patchBody);
    expect(own.status, await own.clone().text()).toBe(200);
    const ownKey = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'PATCH', fx.headers('b', fx.apiKeys.bEditor.token), patchBody);
    expect(ownKey.status, await ownKey.clone().text()).toBe(200);
  });

  it("A's session cannot write B: not by naming site B, not by B's item id from site A", async () => {
    const tokenA = await fx.session('onlyA', 'a');
    const before = await itemB();
    const viaB = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'PATCH', fx.headers('b', tokenA), patchBody);
    expect([401, 403, 404]).toContain(viaB.status);
    const viaA = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'PATCH', fx.headers('a', tokenA), patchBody);
    expect(viaA.status).toBe(404);
    const create = await send(`/api/v1/items/${SHARED.collection}`, 'POST', fx.headers('b', tokenA), { data: { title: 'x' } });
    expect([401, 403, 404]).toContain(create.status);
    const del = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'DELETE', fx.headers('a', tokenA));
    expect(del.status).toBe(404);
    expect(await itemB()).toEqual(before);
  });

  it("A's API keys cannot write B, by either route", async () => {
    const before = await itemB();
    for (const key of [fx.apiKeys.aEditor, fx.apiKeys.aReader]) {
      const viaB = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'PATCH', fx.headers('b', key.token), patchBody);
      expect([401, 403, 404]).toContain(viaB.status);
    }
    const viaA = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'PATCH', fx.headers('a', fx.apiKeys.aEditor.token), patchBody);
    expect(viaA.status).toBe(404);
    // One bulk request naming B's item and A's own: A's entry is written,
    // B's is not found (Codex P04-3 #12 — not merely "not a 200").
    const bulk = await send(`/api/v1/items/${SHARED.collection}/bulk`, 'POST', fx.headers('a', fx.apiKeys.aEditor.token), {
      op: 'update',
      items: [
        { id: fx.items.b, title: 'bulk from A', expectedVersion: 1 },
        { id: fx.items.a, title: 'bulk on A', expectedVersion: 1 },
      ],
    });
    expect(bulk.status).toBe(207);
    const results = ((await bulk.json()) as { data: Array<{ id: string; status: string; code?: string }> }).data;
    expect(results.map((r) => [r.id, r.status, r.code])).toEqual([
      [fx.items.b, 'failed', 'NOT_FOUND'],
      [fx.items.a, 'succeeded', undefined],
    ]);
    expect(((await db.select().from(items).where(eq(items.id, fx.items.a)))[0]!.data as { title: string }).title).toBe('bulk on A');
    expect(await itemB()).toEqual(before);
  });

  it('a person in both sites writes A as an editor but only reads B', async () => {
    const before = await itemB();
    const read = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'GET', fx.headers('b', await fx.session('both', 'b')));
    expect(read.status, await read.clone().text()).toBe(200);
    const write = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'PATCH', fx.headers('b', await fx.session('both', 'b')), patchBody);
    expect(write.status).toBe(403);
    // Their site-A session does not carry the editor role over to B.
    const crossed = await send(`/api/v1/items/${SHARED.collection}/${fx.items.b}`, 'PATCH', fx.headers('b', await fx.session('both', 'a')), patchBody);
    expect([401, 403, 404]).toContain(crossed.status);
    const own = await send(`/api/v1/items/${SHARED.collection}/${fx.items.a}`, 'PATCH', fx.headers('a', await fx.session('both', 'a')), patchBody);
    expect(own.status).toBe(200);
    expect(await itemB()).toEqual(before);
  });

  it("an MCP token of A cannot reach B's content", async () => {
    for (const siteId of Object.values(fx.sites)) {
      await db.insert(settings).values({ siteId, key: 'contentOs', value: { mcp: true } });
    }
    // P10: an API key reaches write tools only with the content tool group (none set means read only).
    await db.update(apiKeys).set({ metadata: { mcpToolGroups: ['read', 'content'] } }).where(eq(apiKeys.id, fx.apiKeys.aEditor.id));
    const before = await itemB();
    const rpc = (id: string) => ({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'updateItem', arguments: { collection: SHARED.collection, id, data: { title: 'via MCP' }, expectedVersion: 1 } },
    });
    const viaB = await send('/api/v1/mcp', 'POST', fx.headers('b', fx.apiKeys.aEditor.token), rpc(fx.items.b));
    expect([401, 403, 404]).toContain(viaB.status);
    const viaA = await send('/api/v1/mcp', 'POST', fx.headers('a', fx.apiKeys.aEditor.token), rpc(fx.items.b));
    // From site A, B's item does not exist: the tool call is refused as not found.
    expect(viaA.status).toBe(200);
    const answer = (await viaA.json()) as { result: { isError: boolean; structuredContent: { status: string; message: string } } };
    expect(answer.result.isError).toBe(true);
    expect(answer.result.structuredContent.message).toMatch(/not found/);
    expect(await itemB()).toEqual(before);
  });
});
