// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { meRouter } from '../auth';

/**
 * Unit tests for `GET`/`PATCH /api/v1/me/preferences`.
 *
 * Focus on handler behaviour (the DB is a fluent shim, like the
 * `me-admin-path` test): GET returns the stored blob, PATCH validates +
 * writes. The merge itself runs in SQL: `me-preferences.db.integration.test.ts`. The
 * keybindings section is the motivating use case.
 */

interface FakeDbState {
  preferences: Record<string, unknown>;
  lastSet: Record<string, unknown> | null;
  userId: string | null;
}

function makeFakeDb(initial: { preferences: Record<string, unknown> }): {
  db: Database;
  state: FakeDbState;
} {
  const state: FakeDbState = {
    preferences: initial.preferences,
    lastSet: null,
    userId: 'usr_test',
  };

  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () =>
      Promise.resolve(
        state.userId ? [{ preferences: state.preferences }] : [],
      ),
  };

  const db = {
    select: () => selectChain,
    update: () => ({
      set: (vals: Record<string, unknown>) => {
        state.lastSet = vals;
        // The merge itself runs in SQL (me-preferences.db.integration.test.ts); here only the reply's shape matters.
        return { where: () => ({ returning: () => Promise.resolve(state.userId ? [{ preferences: {} }] : []) }) };
      },
    }),
  } as unknown as Database;

  return { db, state };
}

function buildApp(db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    c.set('auth', {
      userId: 'usr_test',
      email: 'admin@example.com',
      roles: ['admin'],
      raw: {},
    } as never);
    await next();
  });
  app.route('/api/v1/me', meRouter);
  return app;
}

describe('GET /api/v1/me/preferences', () => {
  it('returns the stored preferences blob', async () => {
    const { db } = makeFakeDb({
      preferences: { keybindings: { 'editor.save': 'mod+shift+s' } },
    });
    const res = await buildApp(db).request('/api/v1/me/preferences');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { keybindings: { 'editor.save': 'mod+shift+s' } },
    });
  });

  it('returns {} when the row has no preferences', async () => {
    const { db } = makeFakeDb({ preferences: {} });
    const res = await buildApp(db).request('/api/v1/me/preferences');
    expect(await res.json()).toEqual({ data: {} });
  });
});

describe('PATCH /api/v1/me/preferences', () => {
  it('rejects an invalid chord with a 400', async () => {
    const { db } = makeFakeDb({ preferences: {} });
    const res = await buildApp(db).request('/api/v1/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keybindings: { 'editor.save': 'not a chord!!' } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid saveAction enum with 400 (Req 2.2)', async () => {
    const { db } = makeFakeDb({ preferences: {} });
    const res = await buildApp(db).request('/api/v1/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ saveAction: 'bogus' }),
    });
    expect(res.status).toBe(400);
  });

});

// p07a task 1.2: the `studio` section merges field by field.
describe('PATCH /api/v1/me/preferences — studio section', () => {
  async function patch(db: Database, body: unknown) {
    return buildApp(db).request('/api/v1/me/preferences', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('refuses more than 20 saved filters', async () => {
    const { db, state } = makeFakeDb({ preferences: {} });
    const filters = Array.from({ length: 21 }, (_, i) => ({ id: `f${i}`, name: `F${i}` }));
    expect((await patch(db, { studio: { savedFilters: filters } })).status).toBe(400);
    expect(state.lastSet).toBeNull();
    expect((await patch(db, { studio: { savedFilters: filters.slice(0, 20) } })).status).toBe(200);
  });

  it('refuses an unknown theme or density', async () => {
    const { db } = makeFakeDb({ preferences: {} });
    expect((await patch(db, { studio: { theme: 'sepia' } })).status).toBe(400);
    expect((await patch(db, { studio: { density: 'huge' } })).status).toBe(400);
  });
});
