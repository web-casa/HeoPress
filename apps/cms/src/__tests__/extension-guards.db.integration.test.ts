/**
 * Plugins do not get around the site and publish guards (HeoPress P12 task 1.4, spec extensions/permissions
 * "插件不绕过站点与发布守卫"): an official plugin with collection write on site A cannot read site B, cannot publish
 * without `items:publish:<collection>`, and even with it cannot publish a held item. Signature and official status
 * do not widen anything.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { collections, fields, items, sites, type Database } from '@heopress/database';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { CapabilityError, ExtensionSandbox, type ExtensionActorDataAccess } from '../extensions/sandbox';
import { ItemService } from '../services/item-service';

const A = 'p12-guard-a';
const B = 'p12-guard-b';

/** The sandbox context as a plugin sees it. */
interface Ctx {
  items: {
    list(collection: string, params?: Record<string, unknown>): Promise<unknown>;
    detail(collection: string, id: string, fields?: string[]): Promise<unknown>;
    create(collection: string, payload: { data: Record<string, unknown>; status?: string }): Promise<unknown>;
    patch(collection: string, id: string, patch: { data?: Record<string, unknown>; status?: string; expectedVersion?: number }): Promise<unknown>;
    delete(collection: string, id: string): Promise<unknown>;
  };
  fetch(url: string): Promise<Response>;
  secrets: { get(name: string): Promise<string | null> };
  extensionPoints: { register(point: string, definition: unknown): void };
  db?: unknown;
  env?: unknown;
}
type Trusted = { isTrustedBundleUrl(url: string): boolean };

declare global {
  // eslint-disable-next-line no-var
  var __p12GuardCtx: Ctx | undefined;
}

function actorFor(db: Database, siteId: string): ExtensionActorDataAccess {
  const svc = () => new ItemService({ db, siteId });
  return {
    list: (c, p) => svc().list(c, p as never),
    detail: (c, id, f) => svc().detail(c, id, f),
    create: (c, payload) => svc().create(c, payload),
    patch: (c, id, patch) => svc().patch(c, id, patch as never),
    delete: (c, id) => svc().softDelete(c, id),
  };
}

describe.skipIf(!hasDbIntegrationUrl)('P12 plugins respect site and publish guards — DB integration', () => {
  let db: Database;
  let itemA = '';
  let itemB = '';

  beforeAll(async () => {
    db = await connectDbIntegration('p12-guards');
  });
  async function clean() {
    for (const id of [A, B]) await db.delete(sites).where(eq(sites.id, id));
  }
  beforeEach(async () => {
    await clean();
    for (const siteId of [A, B]) {
      await db.insert(sites).values({ id: siteId, name: siteId });
      const [coll] = await db.insert(collections).values({ siteId, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
      await db.insert(fields).values({ siteId, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' });
    }
    itemA = ((await new ItemService({ db, siteId: A }).create('articles', { data: { title: 'a' } })) as { id: string }).id;
    itemB = ((await new ItemService({ db, siteId: B }).create('articles', { data: { title: 'b' } })) as { id: string }).id;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (db) await clean();
  });

  async function load(capabilities: string[]) {
    globalThis.__p12GuardCtx = undefined;
    const sandbox = new ExtensionSandbox({}, { actorDataAccess: actorFor(db, A) });
    vi.spyOn(sandbox as unknown as Trusted, 'isTrustedBundleUrl').mockReturnValue(true);
    const src = 'export default (ctx) => { globalThis.__p12GuardCtx = ctx; return {}; }';
    // An "official" plugin: the flag changes nothing about what the context allows.
    await sandbox.load({ name: `heopress-official-${capabilities.length}`, bundleUrl: `data:text/javascript,${encodeURIComponent(src)}`, capabilities, isOfficial: true, verify: async () => true });
    return globalThis.__p12GuardCtx!;
  }
  const status = async (id: string) => (await db.select({ s: items.status, v: items.version }).from(items).where(eq(items.id, id)))[0]!;

  it('cannot read another site\'s item', async () => {
    const ctx = await load(['items:read:articles', 'items:write:articles']);
    await expect(ctx.items.detail('articles', itemA)).resolves.toMatchObject({ id: itemA });
    await expect(ctx.items.detail('articles', itemB)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(ctx.items.patch('articles', itemB, { data: { title: 'x' }, expectedVersion: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await db.select().from(items).where(eq(items.id, itemB)))[0]!.data).toMatchObject({ title: 'b' });
  });

  it('collection write does not publish', async () => {
    const ctx = await load(['items:read:articles', 'items:write:articles']);
    await expect(ctx.items.patch('articles', itemA, { status: 'published', expectedVersion: 1 })).rejects.toBeInstanceOf(CapabilityError);
    expect((await status(itemA)).s).toBe('draft');
    await expect(ctx.items.patch('articles', itemA, { data: { title: 'edited' }, expectedVersion: 1 })).resolves.toBeTruthy();
  });

  it('publish capability still cannot publish a held item', async () => {
    await new ItemService({ db, siteId: A }).setHold('articles', itemA, true, 1);
    const ctx = await load(['items:write:articles', 'items:publish:articles']);
    const { v } = await status(itemA);
    await expect(ctx.items.patch('articles', itemA, { status: 'published', expectedVersion: v })).rejects.toMatchObject({ code: 'ITEM_HELD' });
    expect((await status(itemA)).s).toBe('draft');
  });
});
