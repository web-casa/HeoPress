import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { users, type Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { meRouter } from '../auth';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from '../../__tests__/helpers/cross-site-fixture';

/**
 * `PATCH /api/v1/me/preferences` merges in the database, in one statement: sections the patch omits stay, the sections
 * it sends replace theirs, `studio` merges field by field, and two saves at once (two tabs; the theme and a saved
 * filter) both survive (HeoPress P07a, found by the Studio saved-filter scenario).
 */
describe.skipIf(!hasDbIntegrationUrl)('me preferences — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;

  beforeAll(async () => {
    db = await connectDbIntegration('me-preferences');
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'mpf', jwtSecret: 'me-preferences-secret' });
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  const userId = () => fx.users.both.id;
  const app = () => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.set('db', db);
      c.set('auth', { userId: userId(), email: 'admin@example.com', roles: ['admin'], raw: {} } as never);
      await next();
    });
    a.route('/api/v1/me', meRouter);
    return a;
  };
  const patch = (body: unknown) =>
    app().request('/api/v1/me/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const stored = async () => (await db.select({ p: users.preferences }).from(users).where(eq(users.id, userId())))[0]!.p;
  const set = (preferences: Record<string, unknown>) => db.update(users).set({ preferences }).where(eq(users.id, userId()));

  it('keeps the sections the patch omits and replaces those it sends', async () => {
    await set({ language: 'en', keybindings: { 'editor.save': 'mod+s' } });
    const res = await patch({ keybindings: { 'palette.open': 'mod+k' } });
    expect(res.status).toBe(200);
    const expected = { language: 'en', keybindings: { 'palette.open': 'mod+k' } };
    expect(((await res.json()) as { data: unknown }).data).toEqual(expected);
    expect(await stored()).toEqual(expected);
  });

  it('merges saveAction, and stores null to fall back to the site default', async () => {
    await set({ language: 'vi' });
    expect((await patch({ saveAction: 'return' })).status).toBe(200);
    expect(await stored()).toEqual({ language: 'vi', saveAction: 'return' });
    expect((await patch({ saveAction: null })).status).toBe(200);
    expect(await stored()).toEqual({ language: 'vi', saveAction: null });
  });

  it('merges the studio section field by field', async () => {
    await set({ language: 'en' });
    expect((await patch({ studio: { theme: 'dark', density: 'compact' } })).status).toBe(200);
    const filter = { id: 'f1', name: 'Errors', levels: ['error'] };
    expect((await patch({ studio: { savedFilters: [filter] } })).status).toBe(200);
    expect(await stored()).toEqual({ language: 'en', studio: { theme: 'dark', density: 'compact', savedFilters: [filter] } });
  });

  it('a studio value that is not an object is replaced, not merged into', async () => {
    await set({ studio: 'broken' });
    expect((await patch({ studio: { theme: 'light' } })).status).toBe(200);
    expect(await stored()).toEqual({ studio: { theme: 'light' } });
  });

  it('saves at the same moment do not lose each other', async () => {
    await set({});
    const filters = Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
    const results = await Promise.all([
      patch({ studio: { theme: 'dark' } }),
      patch({ studio: { density: 'compact' } }),
      patch({ studio: { savedFilters: filters } }),
      patch({ language: 'zh-CN' }),
      patch({ saveAction: 'stay' }),
      patch({ studio: { setupChecklistHidden: true } }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await stored()).toEqual({
      language: 'zh-CN',
      saveAction: 'stay',
      studio: { theme: 'dark', density: 'compact', savedFilters: filters, setupChecklistHidden: true },
    });
  });

  it('answers 404 for a user that no longer exists', async () => {
    await db.update(users).set({ preferences: {} }).where(eq(users.id, userId()));
    const res = await new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('db', db);
        c.set('auth', { userId: 'usr_missing_mpf', email: 'x@example.com', roles: [], raw: {} } as never);
        await next();
      })
      .route('/api/v1/me', meRouter)
      .request('/api/v1/me/preferences', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{"language":"en"}' });
    expect(res.status).toBe(404);
  });
});
