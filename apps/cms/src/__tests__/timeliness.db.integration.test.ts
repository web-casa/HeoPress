import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, cdcChangeEvents, collections, items, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Timeliness marks (HeoPress v1.1; spec content/timeliness-marks).
 *
 * A mark is an explicit, dated, reasoned "needs an update". It needs `update` permission and the item version; a
 * reader sees it in the item but cannot change it; and — the point of storing it in columns rather than in `data` — a
 * normal content write (PATCH, replace, status change) keeps it.
 */

const JWT_SECRET = 'timeliness-marks-secret';

interface Mark {
  itemId: string;
  needsUpdateSince: string | null;
  reason: string | null;
  dueAt: string | null;
  version: number;
}

describe.skipIf(!hasDbIntegrationUrl)('timeliness marks — DB integration', () => {
  let fixtures: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let articles = '';

  beforeAll(async () => {
    await connectDbIntegration('timeliness');
    fixtures = await connectDbFixtures('timeliness');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    setRuntimeFactory(() => createRuntime(env));
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'tly', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    articles = (
      await fixtures
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.siteId, fx.sites.a), eq(collections.name, SHARED.collection)))
    )[0]!.id;
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const editor = async () => fx.headers('a', await fx.session('onlyA', 'a'));
  const articlePath = () => `/api/v1/items/${SHARED.collection}/${fx.items.a}`;
  const markPath = () => `${articlePath()}/timeliness`;
  const detail = async (headers: Record<string, string>) =>
    (await (await call('GET', articlePath(), headers)).json()) as { data: Record<string, unknown> };
  const stored = async () => (await fixtures.select().from(items).where(eq(items.id, fx.items.a)))[0]!;

  it('marks an item with a trimmed reason and a deadline, audit included, then clears it', async () => {
    const marked = await call('PUT', markPath(), await editor(), {
      reason: '  Prices changed  ',
      dueAt: '2026-12-01T00:00:00Z',
      expectedVersion: 1,
    });
    expect(marked.status, await marked.clone().text()).toBe(200);
    const body = (await marked.json()) as { data: Mark };
    expect(body.data.itemId).toBe(fx.items.a);
    expect(body.data.reason).toBe('Prices changed');
    expect(body.data.dueAt).toBe('2026-12-01T00:00:00.000Z');
    expect(body.data.version).toBe(2);
    expect(Date.parse(body.data.needsUpdateSince!)).toBeGreaterThan(Date.now() - 120_000);

    // The mark is part of the item: a reader of the item sees it without a second endpoint.
    const row = await detail(await editor());
    expect(row.data.needsUpdateReason).toBe('Prices changed');
    expect(row.data.needsUpdateDueAt).toBe('2026-12-01T00:00:00.000Z');

    const [audit] = await fixtures
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'item_timeliness_marked')));
    expect(audit?.metadata).toMatchObject({ itemId: fx.items.a, after: { reason: 'Prices changed' } });
    const [event] = await fixtures
      .select()
      .from(cdcChangeEvents)
      .where(and(eq(cdcChangeEvents.siteId, fx.sites.a), eq(cdcChangeEvents.itemId, fx.items.a)));
    expect(event?.changedFields).toContain('needs_update');

    const cleared = await call('DELETE', markPath(), { ...(await editor()), 'if-match': '"2"' });
    expect(cleared.status, await cleared.clone().text()).toBe(200);
    const clearedBody = (await cleared.json()) as { data: Mark };
    expect(clearedBody.data).toMatchObject({ itemId: fx.items.a, needsUpdateSince: null, reason: null, dueAt: null, version: 3 });
    expect(await detail(await editor()).then((d) => d.data.needsUpdateSince)).toBeNull();
    const [clearedAudit] = await fixtures
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'item_timeliness_cleared')));
    expect(clearedAudit?.metadata).toMatchObject({ itemId: fx.items.a, before: { reason: 'Prices changed' }, after: { reason: null } });
  });

  it('a reader sees the mark but cannot set or clear it', async () => {
    expect((await call('PUT', markPath(), await editor(), { reason: 'Stale stat', expectedVersion: 1 })).status).toBe(200);
    const reader = fx.headers('a', fx.apiKeys.aReader.token);

    const seen = await detail(reader);
    expect(seen.data.needsUpdateReason).toBe('Stale stat');

    const refused = await call('PUT', markPath(), reader, { reason: 'Mine now', expectedVersion: 2 });
    expect(refused.status, await refused.clone().text()).toBe(403);
    const clearRefused = await call('DELETE', markPath(), { ...reader, 'if-match': '"2"' });
    expect(clearRefused.status).toBe(403);
    // Nothing changed.
    expect((await stored()).needsUpdateReason).toBe('Stale stat');
    expect((await stored()).version).toBe(2);
  });

  it('a normal content update keeps the mark: PATCH, replace and a status change', async () => {
    expect(
      (await call('PUT', markPath(), await editor(), { reason: 'Needs refresh', dueAt: '2027-01-01T00:00:00Z', expectedVersion: 1 })).status,
    ).toBe(200);
    const since = (await stored()).needsUpdateSince!.toISOString();

    const patched = await call('PATCH', articlePath(), await editor(), {
      data: { title: 'Hello, updated', slug: SHARED.slug, path: SHARED.path },
      expectedVersion: 2,
    });
    expect(patched.status, await patched.clone().text()).toBe(200);

    const replaced = await call('PUT', articlePath(), await editor(), {
      data: { title: 'Replaced', slug: SHARED.slug, path: SHARED.path },
      expectedVersion: 3,
    });
    expect(replaced.status, await replaced.clone().text()).toBe(200);

    const archived = await call('PATCH', articlePath(), await editor(), { status: 'archived', expectedVersion: 4 });
    expect(archived.status, await archived.clone().text()).toBe(200);

    const row = await stored();
    expect((row.data as Record<string, unknown>).title).toBe('Replaced');
    expect(row.status).toBe('archived');
    expect(row.needsUpdateReason).toBe('Needs refresh');
    expect(row.needsUpdateSince!.toISOString()).toBe(since);
    expect(row.needsUpdateDueAt!.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('refuses a missing reason, a bad deadline, a missing version and a stale one', async () => {
    const headers = await editor();
    const noReason = await call('PUT', markPath(), headers, { expectedVersion: 1 });
    expect(noReason.status).toBe(400);
    const blank = await call('PUT', markPath(), headers, { reason: '   ', expectedVersion: 1 });
    expect(blank.status).toBe(400);
    const badDue = await call('PUT', markPath(), headers, { reason: 'x', dueAt: 'tomorrow', expectedVersion: 1 });
    expect(badDue.status).toBe(400);
    const noVersion = await call('PUT', markPath(), headers, { reason: 'Older data' });
    expect(noVersion.status, await noVersion.clone().text()).toBe(428);
    expect((await stored()).needsUpdateSince).toBeNull();

    expect((await call('PUT', markPath(), headers, { reason: 'Older data', expectedVersion: 1 })).status).toBe(200);
    const stale = await call('PUT', markPath(), headers, { reason: 'Other reason', expectedVersion: 1 });
    expect(stale.status, await stale.clone().text()).toBe(409);
    expect(((await stale.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VERSION_CONFLICT');
    const staleClear = await call('DELETE', markPath(), { ...headers, 'if-match': '"1"' });
    expect(staleClear.status).toBe(409);
    expect((await stored()).needsUpdateReason).toBe('Older data');
  });

  it('lists only the marked items with ?needs_update=true, stacked with status', async () => {
    const [plain] = await fixtures
      .insert(items)
      .values({ siteId: fx.sites.a, collectionId: articles, status: 'draft', data: { title: 'Unmarked' } })
      .returning({ id: items.id });
    expect((await call('PUT', markPath(), await editor(), { reason: 'Old data', expectedVersion: 1 })).status).toBe(200);

    const list = async (query: string) =>
      (await (await call('GET', `/api/v1/items/${SHARED.collection}${query}`, await editor())).json()) as {
        data: Array<{ id: string; needsUpdateReason: string | null; needsUpdateSince: string | null }>;
      };

    const all = await list('');
    expect(all.data.map((r) => r.id).sort()).toEqual([fx.items.a, plain!.id].sort());

    const markedOnly = await list('?needs_update=true');
    expect(markedOnly.data.map((r) => r.id)).toEqual([fx.items.a]);
    expect(markedOnly.data[0]!.needsUpdateReason).toBe('Old data');

    // The filter stacks with the other conditions instead of replacing them.
    expect((await list('?needs_update=true&status=published')).data).toEqual([]);
    expect((await list('?needs_update=false')).data.map((r) => r.id).sort()).toEqual([fx.items.a, plain!.id].sort());
  });
});
