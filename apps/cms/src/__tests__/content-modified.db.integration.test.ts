import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { collections, fields, items, projectionRebuilds, publicItems, publicPathMemory, publicSites, siteContentSettings, siteDomains, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { renderPort } from '@heopress/site-classic/read-port';
import { setRuntimeFactory } from '../middleware/runtime';
import { runItemWriteTransaction, runSiteTransaction, setBeforeCommitHook } from '../services/rls-transaction';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import { EditorialService } from '../services/editorial-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The real content modification time (HeoPress P07 task 2.5; spec seo/page-metadata "真实修改时间"): the projection
 * moves `content_modified_at` only when the normalised published content — content title, excerpt, rich-text body —
 * changes. Re-rendering, site-wide refreshes, SEO fields, the canonical, unrelated fields, whitespace and drafts never do.
 */

const JWT_SECRET = 'content-modified-secret';
const HOST = 'cm-a.example.com';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const tick = () => new Promise((r) => setTimeout(r, 5));

/** Wait until `n` sessions are blocked by the backend `pid` (never by anything else running meanwhile). */
async function blockedBy(pid: number, n: number): Promise<void> {
  const watcher = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [w] = await watcher`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
      if ((w?.n ?? 0) >= n) return;
      if (Date.now() > deadline) throw new Error(`fewer than ${n} sessions blocked by ${pid}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    await watcher.end({ timeout: 1 });
  }
}

/** The backend of a paused transaction (its before-commit hook records it). */
const backendOf = async (tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }): Promise<number> =>
  ((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as Array<{ pid: number }>)[0]!.pid;

describe.skipIf(!hasDbIntegrationUrl)('real content modification time — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let siteId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('content-modified');
    const runtime = createRuntime({ ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' });
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'cmod', jwtSecret: JWT_SECRET });
    siteId = fx.sites.a;
    await db.transaction((tx) => ensureContentSettings(tx as never, siteId));
    const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
    await db.insert(fields).values([
      { siteId, collectionId: coll!.id, name: 'excerpt', type: 'text', interface: 'textarea' },
      { siteId, collectionId: coll!.id, name: 'body', type: 'text', interface: 'wysiwyg' },
      { siteId, collectionId: coll!.id, name: 'seo_title', type: 'string', interface: 'input' },
      { siteId, collectionId: coll!.id, name: 'seo_description', type: 'text', interface: 'textarea' },
      { siteId, collectionId: coll!.id, name: 'canonical_url', type: 'string', interface: 'input' },
      { siteId, collectionId: coll!.id, name: 'seo_robots', type: 'string', interface: 'select-dropdown' },
      { siteId, collectionId: coll!.id, name: 'note', type: 'string', interface: 'input' },
    ]);
    await db.insert(siteDomains).values({ siteId, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    await db.update(siteContentSettings).set({ permalinks: { articles: '/:slug' } }).where(eq(siteContentSettings.siteId, r!.siteId));
    // The fixture wrote past the services: rebuild both sites, as a deployment does first.
    for (const s of [fx.sites.a, fx.sites.b]) await rebuildSiteProjection(db, s);
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const service = () => new ItemService({ db, siteId });
  const versionOf = async (id: string) => (await db.select({ v: items.version }).from(items).where(eq(items.id, id)))[0]!.v;
  const patch = async (id: string, body: Record<string, unknown>) => {
    await tick();
    await service().patch('articles', id, { ...body, expectedVersion: await versionOf(id) });
  };
  const row = async (id: string) => (await db.select().from(publicItems).where(and(eq(publicItems.siteId, siteId), eq(publicItems.itemId, id))))[0];
  const modified = async (id: string) => (await row(id))?.contentModifiedAt?.toISOString() ?? null;
  const BODY = '<p>First block.</p><p>Second block with a <a href="https://example.com/x">link</a>.</p>';
  const create = async (data: Record<string, unknown> = {}, status = 'published') =>
    (await service().create('articles', { data: { title: 'A title', slug: 'a-post', excerpt: 'An excerpt', body: BODY, ...data }, status })) as { id: string };

  it('first publication: the publication time; re-renders, site-wide refreshes and the site SEO settings keep it', async () => {
    const { id } = await create();
    const r = (await row(id))!;
    expect(r.contentModifiedAt?.toISOString()).toBe(r.publishedAt?.toISOString());
    expect(r.contentHash).toMatch(/^c2\.s1:[0-9a-f]{64}$/);
    const t0 = await modified(id);
    await tick();
    await rebuildSiteProjection(db, siteId);
    const [s] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    await new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
      availableLocales: s!.availableLocales,
      timezone: s!.timezone,
      siteType: 'blog',
      trailingSlash: 'never',
      localeStrategy: s!.localeStrategy,
      localePrefixMode: s!.localePrefixMode,
      localePrefixes: s!.localePrefixes,
      permalinks: s!.permalinks,
      allowCrossSiteTranslations: false,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: s!.version,
    } as never);
    await new SeoSettingsService({ db, siteId, actor: { userId: null } }).update({ version: 0, titleTemplate: '{title} | {site}' });
    expect((await row(id))!.card).toMatchObject({ url: `https://${HOST}/a-post` });
    expect(await modified(id)).toBe(t0);
  });

  it('SEO fields, the canonical, the slug, unrelated fields and whitespace-only edits keep it', async () => {
    const { id } = await create();
    const t0 = await modified(id);
    await patch(id, { data: { seo_title: 'An SEO title', seo_description: 'An SEO description' } });
    await patch(id, { data: { canonical_url: 'https://example.com/elsewhere' } });
    await patch(id, { data: { seo_robots: 'noindex,follow' } });
    await patch(id, { data: { note: 'internal note', slug: 'a-moved-post' } });
    await patch(id, { data: { title: '  A   title ', excerpt: 'An\nexcerpt', body: `<p>First   block.</p>\n\n<p>Second block with a <a href="https://example.com/x" target="_blank"><strong>link</strong></a>.</p>` } });
    const r = (await row(id))!;
    expect(r.path).toContain('a-moved-post');
    expect(r.contentModifiedAt?.toISOString()).toBe(t0);
  });

  it('the content title, the excerpt, the body and the block order each move it to the time of the change', async () => {
    const { id } = await create();
    let last = (await row(id))!.contentModifiedAt!.getTime();
    const moved = async (data: Record<string, unknown>) => {
      const before = Date.now();
      await patch(id, { data });
      const t = (await row(id))!.contentModifiedAt!.getTime();
      expect(t, JSON.stringify(data)).toBeGreaterThan(last);
      expect(t).toBeGreaterThanOrEqual(before);
      last = t;
    };
    await moved({ title: 'Another title' });
    await moved({ excerpt: 'Another excerpt' });
    await moved({ body: '<p>First block, edited.</p><p>Second block with a <a href="https://example.com/x">link</a>.</p>' });
    await moved({ body: '<p>Second block with a <a href="https://example.com/x">link</a>.</p><p>First block, edited.</p>' });
    await moved({ body: '<p>Second block with a <a href="https://example.com/y">link</a>.</p><p>First block, edited.</p>' });
  });

  it('a plain-text body is content too: its words and paragraphs move it, its whitespace does not', async () => {
    const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
    await db.update(fields).set({ interface: 'textarea' }).where(and(eq(fields.collectionId, coll!.id), eq(fields.name, 'body')));
    await rebuildSiteProjection(db, siteId);
    const { id } = await create({ body: 'One paragraph.\n\nAnother <one>.' });
    expect((await row(id))!.richFields).toEqual([]);
    const t0 = await modified(id);
    await patch(id, { data: { body: 'One   paragraph.\n\nAnother\n<one>.' } });
    expect(await modified(id)).toBe(t0);
    await patch(id, { data: { body: 'One paragraph.\n\nAnother <two>.' } });
    expect(await modified(id)).not.toBe(t0);
  });

  it('two content changes in the same millisecond (or with the clock set back): the time still moves forward (Codex review of batch 4b)', async () => {
    const { id } = await create();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      await service().patch('articles', id, { data: { title: 'First change' }, expectedVersion: await versionOf(id) });
      const t1 = (await row(id))!.contentModifiedAt!.getTime();
      await service().patch('articles', id, { data: { title: 'Second change' }, expectedVersion: await versionOf(id) });
      const t2 = (await row(id))!.contentModifiedAt!.getTime();
      expect(t2).toBeGreaterThan(t1);
      vi.setSystemTime(new Date(t1 - 30_000));
      await service().patch('articles', id, { data: { title: 'Third change' }, expectedVersion: await versionOf(id) });
      expect((await row(id))!.contentModifiedAt!.getTime()).toBeGreaterThan(t2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an SEO settings write beside an article write: the article\'s fresh row and time survive the site-wide refresh (Codex review of batch 4b)', async () => {
    const { id } = await create();
    const t0 = await modified(id);
    // The article write stops after its projection flush, before its commit, until released.
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let paused!: () => void;
    const pausedAt = new Promise<void>((r) => (paused = r));
    let pauseNext = true;
    let writerPid = 0;
    const flush = setBeforeCommitHook(null);
    setBeforeCommitHook(async (tx) => {
      await flush?.(tx);
      if (pauseNext) {
        pauseNext = false;
        writerPid = await backendOf(tx as never);
        paused();
        await released;
      }
    });
    try {
      await tick();
      const write = service().patch('articles', id, { data: { body: '<p>Fresh body.</p>' }, expectedVersion: await versionOf(id) });
      await pausedAt;
      let seoDone = false;
      const seo = new SeoSettingsService({ db, siteId, actor: { userId: null } }).update({ version: 0, titleTemplate: '{title} — {site}' }).then((v) => {
        seoDone = true;
        return v;
      });
      // It waits for the article write (the site's settings row), instead of reading the items before it commits.
      await blockedBy(writerPid, 1);
      expect(seoDone).toBe(false);
      release();
      await write;
      await seo;
    } finally {
      setBeforeCommitHook(flush);
      release();
    }
    const r = (await row(id))!;
    expect(r.data.body).toContain('Fresh body.');
    expect(r.contentModifiedAt!.getTime()).toBeGreaterThan(new Date(t0!).getTime());
    const [site] = await db.select({ seo: publicSites.seo }).from(publicSites).where(eq(publicSites.siteId, siteId));
    expect(site!.seo).toMatchObject({ titleTemplate: '{title} — {site}' });
  });

  it('drafts never touch it: a draft has no time; an unpublished item edited as a draft keeps its time when republished unchanged', async () => {
    const draft = await create({ slug: 'a-draft' }, 'draft');
    await patch(draft.id, { data: { body: '<p>Draft text.</p>' } });
    expect(await row(draft.id)).toBeUndefined();

    const { id } = await create();
    const t0 = await modified(id);
    await patch(id, { status: 'draft' });
    expect(await row(id)).toBeUndefined();
    const [memory] = await db.select().from(publicPathMemory).where(and(eq(publicPathMemory.siteId, siteId), eq(publicPathMemory.itemId, id)));
    expect(memory!.contentModifiedAt?.toISOString()).toBe(t0);
    // Edited and then reverted while a draft: back online with the same content, the same time.
    await patch(id, { data: { body: '<p>Work in progress.</p>' } });
    await patch(id, { data: { body: BODY } });
    await patch(id, { status: 'published' });
    expect(await modified(id)).toBe(t0);
    // Unpublished, changed, published again: the content changed, the time moves.
    await patch(id, { status: 'draft' });
    await patch(id, { data: { body: '<p>Rewritten.</p>' } });
    await patch(id, { status: 'published' });
    expect(new Date((await modified(id))!).getTime()).toBeGreaterThan(new Date(t0!).getTime());
  });

  it('an item unpublished before the hashes were recorded: a draft edit then a republish moves the time; unchanged keeps it (Codex review of batch 4b)', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const changed = await create();
    const same = await create({ slug: 'same-post' });
    const gone = await create({ slug: 'gone-post' });
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.site_id', ${siteId}, true)`;
        // As migration 0060 leaves them before the background refresh: times, no hashes.
        await tx`UPDATE lumibase_public_items SET content_hash = NULL WHERE site_id = ${siteId}`;
        await tx`UPDATE lumibase_public_path_memory SET content_hash = NULL WHERE site_id = ${siteId}`;
        // Unpublished before task 2.5 at all: a memory with neither.
        await tx`UPDATE lumibase_public_path_memory SET content_modified_at = NULL WHERE item_id = ${gone.id}`;
        await tx`DELETE FROM lumibase_public_items WHERE item_id = ${gone.id}`;
      });
    } finally {
      await owner.end({ timeout: 1 });
    }
    const t0 = await modified(changed.id);
    const s0 = await modified(same.id);
    for (const id of [changed.id, same.id]) await patch(id, { status: 'draft' });
    await patch(changed.id, { data: { body: '<p>Rewritten while a draft.</p>' } });
    for (const id of [changed.id, same.id]) await patch(id, { status: 'published' });
    expect(new Date((await modified(changed.id))!).getTime()).toBeGreaterThan(new Date(t0!).getTime());
    expect(await modified(same.id)).toBe(s0);
    // Its last public content unknown: coming back is a change.
    const before = Date.now();
    await patch(gone.id, { status: 'draft' });
    await patch(gone.id, { status: 'published' });
    expect(new Date((await modified(gone.id))!).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('a hash of an older normalisation or sanitiser is adopted without moving the time; a later content change moves it (Codex review of batch 4b)', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const { id } = await create();
    const t0 = await modified(id);
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.site_id', ${siteId}, true)`;
        await tx`UPDATE lumibase_public_items SET content_hash = 'c0.s1:0000' WHERE item_id = ${id}`;
      });
    } finally {
      await owner.end({ timeout: 1 });
    }
    await rebuildSiteProjection(db, siteId);
    expect((await row(id))!.contentHash).toMatch(/^c2\.s1:[0-9a-f]{64}$/);
    expect(await modified(id)).toBe(t0);
    await patch(id, { data: { excerpt: 'Changed.' } });
    expect(await modified(id)).not.toBe(t0);
  });

  it('a bare item write that takes no settings lock of its own still excludes a site-wide refresh: no unpublished row comes back (migration 0061; Codex review of batch 4b)', async () => {
    const { id } = await create();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let paused!: () => void;
    const pausedAt = new Promise<void>((r) => (paused = r));
    let pauseNext = true;
    let writerPid = 0;
    const flush = setBeforeCommitHook(null);
    setBeforeCommitHook(async (tx) => {
      await flush?.(tx);
      if (pauseNext) {
        pauseNext = false;
        writerPid = await backendOf(tx as never);
        paused();
        await released;
      }
    });
    try {
      // A bare status change in a site transaction: no lock taken first (the trigger takes it after the statement).
      const unpublish = runSiteTransaction(db, siteId, (tx) => tx.update(items).set({ status: 'draft' }).where(eq(items.id, id)));
      await pausedAt;
      expect(await row(id)).toBeDefined();
      const seo = new SeoSettingsService({ db, siteId, actor: { userId: null } }).update({ version: 0, titleTemplate: '{title} / {site}' });
      // The refresh is blocked by the unpublishing write (the settings row its trigger holds) before it is released.
      await blockedBy(writerPid, 1);
      release();
      await unpublish;
      await seo;
    } finally {
      setBeforeCommitHook(flush);
      release();
    }
    expect(await row(id)).toBeUndefined();
  });

  it('a row sanitised by an older sanitiser keeps its own label when it is unpublished: republishing it under the current one moves nothing (Codex review of batch 4b)', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const { id } = await create();
    const t0 = await modified(id);
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.site_id', ${siteId}, true)`;
        // As an older sanitiser left it: its version, its hash label.
        await tx`UPDATE lumibase_public_items SET sanitizer = 0, content_hash = ${`c2.s0:${'0'.repeat(64)}`} WHERE item_id = ${id}`;
        await tx`UPDATE lumibase_public_path_memory SET content_hash = ${`c2.s0:${'0'.repeat(64)}`} WHERE item_id = ${id}`;
      });
    } finally {
      await owner.end({ timeout: 1 });
    }
    await patch(id, { status: 'draft' });
    const [memory] = await db.select().from(publicPathMemory).where(and(eq(publicPathMemory.siteId, siteId), eq(publicPathMemory.itemId, id)));
    expect(memory!.contentHash).toMatch(/^c2\.s0:[0-9a-f]{64}$/);
    expect(memory!.contentModifiedAt?.toISOString()).toBe(t0);
    await patch(id, { status: 'published' });
    expect((await row(id))!.contentHash).toMatch(/^c2\.s1:[0-9a-f]{64}$/);
    expect(await modified(id)).toBe(t0);
  });

  it('an item write holds its site\'s settings row until it commits, whatever wrote it (migration 0061 trigger, app role under row-level security)', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const { id } = await create();
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let paused!: () => void;
    const pausedAt = new Promise<void>((r) => (paused = r));
    let pauseNext = true;
    let writerPid = 0;
    const flush = setBeforeCommitHook(null);
    setBeforeCommitHook(async (tx) => {
      await flush?.(tx);
      if (pauseNext) {
        pauseNext = false;
        writerPid = await backendOf(tx as never);
        paused();
        await released;
      }
    });
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      const write = runSiteTransaction(db, siteId, (tx) => tx.update(items).set({ updatedAt: new Date() }).where(eq(items.id, id)));
      await pausedAt;
      const code = await owner
        .begin(async (tx) => {
          await tx`SELECT set_config('app.site_id', ${siteId}, true)`;
          await tx`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${siteId} FOR UPDATE NOWAIT`;
        })
        .then(() => 'free', (e: { code?: string }) => e.code);
      expect(code).toBe('55P03');
      release();
      await write;
    } finally {
      setBeforeCommitHook(flush);
      release();
      await owner.end({ timeout: 1 });
    }
  });

  it.each([
    ['an editorial transition', 'editorial'],
    ['a worker\'s item write (runItemWriteTransaction: key rewrap, envelope migration)', 'worker'],
    ['a hold change', 'hold'],
    ['a pin release', 'pin'],
    ['a crypto-shred', 'shred'],
  ] as const)('%s takes the settings row before the item row — the order of a site or collection deletion (Codex review of batch 4b)', async (_label, kind) => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const draft = await create({ slug: 'in-review' }, 'draft');
    if (kind === 'pin') await runItemWriteTransaction(db, siteId, (tx) => tx.update(items).set({ pinnedFields: ['title'] }).where(eq(items.id, draft.id)));
    const holder = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    let itemFree: boolean | null = null;
    let holderPid = 0;
    try {
      const hold = holder.begin(async (tx) => {
        holderPid = (await tx`SELECT pg_backend_pid() AS pid`)[0]!.pid as number;
        await tx`SELECT set_config('app.site_id', ${siteId}, true)`;
        await tx`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${siteId} FOR UPDATE`;
        held();
        await released;
        // The transition waits for the settings row: it has not locked the item row.
        itemFree = (await tx`SELECT 1 FROM lumibase_items WHERE id = ${draft.id} FOR UPDATE NOWAIT`).length === 1;
      });
      await holding;
      const version = await versionOf(draft.id);
      const submit = {
        editorial: () => new EditorialService({ db, siteId, userId: null }).submitReview('articles', draft.id),
        worker: () => runItemWriteTransaction(db, siteId, (tx) => tx.update(items).set({ updatedAt: new Date() }).where(eq(items.id, draft.id))),
        hold: () => service().setHold('articles', draft.id, true, version),
        pin: () => service().releasePin('articles', draft.id, 'title'),
        shred: () => service().cryptoShred('articles', draft.id),
      }[kind]();
      // The write is blocked by the holder (on the settings row) before the probe looks at the item row.
      await blockedBy(holderPid, 1);
      release();
      await hold;
      await submit;
    } finally {
      release();
      await holder.end({ timeout: 1 });
    }
    expect(itemFree).toBe(true);
  });

  it('migration 0060: existing rows take their publication time (or the migration time), a background refresh records the hashes without moving it', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required').toBeDefined();
    const a = await create();
    const b = await create({ slug: 'b-post' });
    const published = (await row(a.id))!.publishedAt!.toISOString();
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const migration = readFileSync(path.resolve(__dirname, '../../../../packages/database/drizzle/0060_content_modified_backfill.sql'), 'utf8');
    const ours = () => db.select().from(projectionRebuilds).where(inArray(projectionRebuilds.siteId, [fx.sites.a, fx.sites.b]));
    const beforeMigration = Date.now();
    try {
      // The state before task 2.5: no hash, no time; and a row without a publication time.
      await owner.begin(async (tx) => {
        await tx`SELECT set_config('app.site_id', ${siteId}, true)`;
        await tx`UPDATE lumibase_public_items SET content_hash = NULL, content_modified_at = NULL WHERE site_id = ${siteId}`;
        await tx`UPDATE lumibase_public_items SET published_at = NULL WHERE item_id = ${b.id}`;
        await tx`UPDATE lumibase_public_path_memory SET content_hash = NULL, content_modified_at = NULL WHERE site_id = ${siteId}`;
      });
      await owner.unsafe(migration);
      await owner.unsafe(migration);
    } finally {
      await owner.end({ timeout: 1 });
    }
    expect(await modified(a.id)).toBe(published);
    const tb = (await row(b.id))!.contentModifiedAt!.getTime();
    expect(tb).toBeGreaterThanOrEqual(beforeMigration - 1000);
    const [memory] = await db.select().from(publicPathMemory).where(eq(publicPathMemory.itemId, a.id));
    expect(memory!.contentModifiedAt?.toISOString()).toBe(published);
    expect((await row(a.id))!.contentHash).toBeNull();
    // One background mark for the site with public items (none for the empty one); not maintenance.
    expect((await ours()).map((m) => [m.siteId, m.reason])).toEqual([[siteId, 'refresh: content modified time']]);
    expect(await renderPort(db).request(siteId, (_p, reads) => reads.rebuilding())).toBe(false);
    // The worker's refresh records the hashes; the times stay.
    await rebuildSiteProjection(db, siteId);
    expect(await ours()).toEqual([]);
    expect((await row(a.id))!.contentHash).toMatch(/^c2\.s1:[0-9a-f]{64}$/);
    expect(await modified(a.id)).toBe(published);
    // The row without a publication time gets it back from the base table; its time (later) stays.
    const rb = (await row(b.id))!;
    expect(rb.publishedAt).not.toBeNull();
    expect(rb.contentModifiedAt!.getTime()).toBe(tb);
  });
});
