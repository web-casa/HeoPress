/**
 * Plugin admin panels (HeoPress P12 tasks 3.5, 3.6; spec extensions/runtime-extensions "插件后台面板"): the declarative
 * tier for every plugin with `ext:admin-panels`, read for the active site only; a custom frontend only for a plugin the
 * operator trusts — an untrusted one is reported, its address never handed out; settings only as declared.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { extensions, sites, type Database } from '@heopress/database';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { PluginPanels } from '../extensions/runtime/admin-panels';
import { PluginStorage } from '../extensions/runtime/storage';

const A = 'p12panel-a';
const B = 'p12panel-b';
const manifest = {
  displayName: 'Link checker',
  storage: { results: { indexes: [['status']] } },
  admin: {
    pages: [
      { id: 'results', title: 'Results', storage: 'results', columns: ['url', 'status'] },
      { id: 'settings', title: 'Settings', type: 'settings' },
      { id: 'dashboard', title: 'Dashboard', type: 'custom', frontend: 'https://plugins.example.com/linkcheck/ui' },
    ],
    widgets: [{ id: 'broken', title: 'Broken links', storage: 'results' }],
    settings: [{ key: 'depth', type: 'integer', default: 2 }, { key: 'notify', type: 'boolean' }],
  },
};

describe.skipIf(!hasDbIntegrationUrl)('P12 plugin admin panels — DB integration', () => {
  let db: Database;
  beforeAll(async () => {
    db = await connectDbIntegration('p12-plugin-panels');
  });
  afterAll(async () => {
    if (db) for (const id of [A, B]) await db.delete(sites).where(eq(sites.id, id));
  });
  beforeEach(async () => {
    for (const id of [A, B]) {
      await db.delete(sites).where(eq(sites.id, id));
      await db.insert(sites).values({ id, name: id });
      await db.insert(extensions).values({
        siteId: id, name: 'linkcheck', version: '1.0.0', type: 'hook', enabled: true, bundleUrl: 'https://plugins.example.com/linkcheck.js',
        manifest, capabilities: ['ext:admin-panels'], requestedCapabilities: ['ext:admin-panels'], permissionsStatus: 'approved',
      });
      const storage = new PluginStorage(db, id, 'linkcheck', manifest.storage);
      await storage.collection('results').put('r1', { url: `https://${id}.example.com/gone`, status: 404 });
    }
    await new PluginStorage(db, A, 'linkcheck', manifest.storage).collection('results').put('r2', { url: 'https://p12panel-a.example.com/ok', status: 200 });
  });

  it('lists the declarative pages and widgets of the active site only', async () => {
    const [panel] = await new PluginPanels(db, A).list();
    expect(panel).toMatchObject({ name: 'linkcheck', displayName: 'Link checker', widgets: [{ id: 'broken', count: 2 }], hasSettings: true });
    const table = await new PluginPanels(db, A).page('linkcheck', 'results');
    expect(table).toMatchObject({ type: 'table', columns: ['url', 'status'] });
    expect(JSON.stringify(table)).not.toContain('p12panel-b');
    const tableB = await new PluginPanels(db, B).page('linkcheck', 'results');
    expect(tableB.type === 'table' && tableB.documents.map((d) => d.data.url)).toEqual(['https://p12panel-b.example.com/gone']);
  });

  it('an untrusted plugin\'s own frontend is not offered; a trusted one\'s is', async () => {
    const page = await new PluginPanels(db, A).page('linkcheck', 'dashboard');
    expect(page).toEqual({ type: 'custom', id: 'dashboard', title: 'Dashboard', frontend: { status: 'untrusted', url: null } });
    expect(JSON.stringify(await new PluginPanels(db, A).list())).not.toContain('linkcheck/ui');
    await db.update(extensions).set({ trusted: true }).where(and(eq(extensions.siteId, A), eq(extensions.name, 'linkcheck')));
    expect(await new PluginPanels(db, A).page('linkcheck', 'dashboard')).toMatchObject({ frontend: { status: 'trusted', url: 'https://plugins.example.com/linkcheck/ui' } });
    // Trust is per installation: site B's copy is still untrusted.
    expect(await new PluginPanels(db, B).page('linkcheck', 'dashboard')).toMatchObject({ frontend: { status: 'untrusted', url: null } });
  });

  it('settings: declared keys of the declared type, per site', async () => {
    expect(await new PluginPanels(db, A).settings('linkcheck')).toMatchObject({ values: { depth: 2, notify: null } });
    expect(await new PluginPanels(db, A).saveSettings('linkcheck', { depth: 3, notify: true })).toEqual({ depth: 3, notify: true });
    await expect(new PluginPanels(db, A).saveSettings('linkcheck', { depth: 'deep' })).rejects.toMatchObject({ code: 'INVALID_SETTING' });
    await expect(new PluginPanels(db, A).saveSettings('linkcheck', { secretKey: 'x' })).rejects.toMatchObject({ code: 'UNKNOWN_SETTING' });
    expect((await new PluginPanels(db, B).settings('linkcheck')).values).toEqual({ depth: 2, notify: null });
  });

  it('no panel without ext:admin-panels, while disabled, or awaiting re-confirmation', async () => {
    const where = and(eq(extensions.siteId, A), eq(extensions.name, 'linkcheck'));
    await db.update(extensions).set({ capabilities: [] }).where(where);
    expect(await new PluginPanels(db, A).list()).toEqual([]);
    await expect(new PluginPanels(db, A).page('linkcheck', 'results')).rejects.toMatchObject({ status: 404 });
    await db.update(extensions).set({ capabilities: ['ext:admin-panels'], permissionsStatus: 'reconfirm' }).where(where);
    expect(await new PluginPanels(db, A).list()).toEqual([]);
    await db.update(extensions).set({ permissionsStatus: 'approved', enabled: false }).where(where);
    expect(await new PluginPanels(db, A).list()).toEqual([]);
  });
});
