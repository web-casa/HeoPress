import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { collections, fields, items, relations, scopedDatabase, sites, type Database } from '@heopress/database';
import { ItemService, VersionConflictError } from '../item-service';
import { DependentsService } from '../dependents-service';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Deletes name the version they are based on (HeoPress P14 task 6.1; spec
 * content/write-concurrency "基于版本的条件删除", design D6): a stale version is
 * a 409 with the current version and nothing is deleted, no version is a 428,
 * a bulk delete answers per entry, and the system's own cascade with its
 * parent still deletes (at the version its transaction reads).
 *
 * The code under test runs as the application role on the site's scoped handle; the data is prepared and the stored
 * rows are checked through the owner's fixtures connection (HeoPress P14 task 1.4).
 */

const SITE = 'site_delete_version_it';

describe.skipIf(!hasDbIntegrationUrl)('version-checked deletes — DB integration', () => {
  let db: Database;
  /** A second pool: another person's session. */
  let other: Database;
  let fixtures: Database;

  beforeAll(async () => {
    db = scopedDatabase(await connectDbIntegration('delete-version'), { site: SITE });
    other = scopedDatabase(await connectDbIntegration('delete-version-other'), { site: SITE });
    fixtures = await connectDbFixtures('delete-version');
  });
  afterAll(async () => {
    await fixtures?.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  const svc = (on: Database = db) => new ItemService({ db: on, siteId: SITE });
  const row = async (id: string) => (await fixtures.select().from(items).where(and(eq(items.siteId, SITE), eq(items.id, id))))[0]!;
  const create = async (title: string, extra: Record<string, unknown> = {}, collection = 'articles') =>
    (await svc().create(collection, { data: { title, ...extra } })) as { id: string; version: number };

  beforeEach(async () => {
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.insert(sites).values({ id: SITE, name: 'Delete version IT' });
    const [articles] = await fixtures.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
    const [comments] = await fixtures.insert(collections).values({ siteId: SITE, name: 'comments', label: 'Comments' }).returning({ id: collections.id });
    await fixtures.insert(fields).values([
      { siteId: SITE, collectionId: articles!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: comments!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: comments!.id, name: 'article', type: 'string', interface: 'input' },
    ]);
  });

  it('a delete based on the version before an edit is a 409 with the current version; the edit stands', async () => {
    const { id, version } = await create('v1');
    // A and B both read version 1; B saves (version 2), then A deletes at 1.
    await svc(other).patch('articles', id, { data: { title: "B's edit" }, expectedVersion: version });
    const err = await svc().softDelete('articles', id, { expectedVersion: version }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VersionConflictError);
    expect(err).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, currentVersion: 2, changedFields: ['title'] });
    expect(await row(id)).toMatchObject({ version: 2, deletedAt: null, data: { title: "B's edit" } });
    // At the version it now has, the delete goes through.
    await expect(svc().softDelete('articles', id, { expectedVersion: 2 })).resolves.toEqual({ ok: true });
    expect((await row(id)).deletedAt).not.toBeNull();
    expect((await row(id)).version).toBe(3);
  });

  it('an edit committing while the delete waits for the row wins: the delete matches no row and is a 409', async () => {
    const { id, version } = await create('v1');
    let editHoldsRow!: () => void;
    const held = new Promise<void>((resolve) => (editHoldsRow = resolve));
    let releaseEdit!: () => void;
    const release = new Promise<void>((resolve) => (releaseEdit = resolve));
    // B's edit, on its own connection, holds the item row (version 1 → 2) until released.
    const edit = other.transaction(async (tx) => {
      await tx.update(items).set({ version: version + 1, data: { title: "B's edit" } }).where(and(eq(items.siteId, SITE), eq(items.id, id)));
      editHoldsRow();
      await release;
    });
    await held;
    // A read version 1 before B's commit; its delete passes the early check and waits on the row.
    const del = svc().softDelete('articles', id, { expectedVersion: version }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 300));
    releaseEdit();
    await edit;
    expect(await del).toMatchObject({ code: 'VERSION_CONFLICT', status: 409, currentVersion: 2 });
    expect(await row(id)).toMatchObject({ version: 2, deletedAt: null, data: { title: "B's edit" } });
  });

  it('a delete without a version is a 428 and changes nothing', async () => {
    const { id } = await create('v1');
    await expect(svc().softDelete('articles', id, { expectedVersion: undefined })).rejects.toMatchObject({ code: 'VERSION_REQUIRED', status: 428 });
    expect(await row(id)).toMatchObject({ version: 1, deletedAt: null });
  });

  it('a delete of a missing item stays a 404, whatever the version', async () => {
    await expect(svc().softDelete('articles', 'no-such-item', { expectedVersion: 1 })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('a bulk delete answers per entry: deleted, conflict, version required', async () => {
    const fresh = await create('fresh');
    const stale = await create('stale');
    const bare = await create('bare');
    await svc().patch('articles', stale.id, { data: { title: 'moved on' }, expectedVersion: stale.version });
    const results = await svc().bulk('articles', 'delete', [
      { id: fresh.id, expectedVersion: fresh.version },
      { id: stale.id, expectedVersion: stale.version },
      { id: bare.id },
    ]);
    expect(results).toEqual([
      { index: 0, id: fresh.id, status: 'succeeded' },
      expect.objectContaining({ index: 1, id: stale.id, status: 'conflict', code: 'VERSION_CONFLICT' }),
      expect.objectContaining({ index: 2, id: bare.id, status: 'failed', code: 'VERSION_REQUIRED' }),
    ]);
    expect((await row(fresh.id)).deletedAt).not.toBeNull();
    expect(await row(stale.id)).toMatchObject({ version: 2, deletedAt: null });
    expect(await row(bare.id)).toMatchObject({ version: 1, deletedAt: null });
  });

  it('the cascade with a parent still deletes its dependents, at the versions its transaction reads', async () => {
    await fixtures.insert(relations).values({ siteId: SITE, manyCollection: 'comments', manyField: 'article', oneCollection: 'articles', type: 'm2o', onDelete: 'cascade' });
    const article = await create('parent');
    const first = await create('c1', { article: article.id }, 'comments');
    const second = await create('c2', { article: article.id }, 'comments');
    // A dependent edited since anyone listed it: the cascade still takes it, at its version now.
    await svc().patch('comments', second.id, { data: { title: 'c2 edited' }, expectedVersion: second.version });
    const [rel] = await fixtures.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE));
    const res = await new DependentsService({ db, siteId: SITE }).applyResolution('articles', article.id, 'delete', rel!.id);
    expect(res.affected).toBe(2);
    expect(await row(first.id)).toMatchObject({ version: 2 });
    expect(await row(second.id)).toMatchObject({ version: 3 });
    expect((await row(first.id)).deletedAt).not.toBeNull();
    expect((await row(second.id)).deletedAt).not.toBeNull();
  });
});
