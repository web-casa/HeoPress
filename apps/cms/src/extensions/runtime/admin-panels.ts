/**
 * Plugin admin panels (HeoPress P12 tasks 3.5, 3.6; spec extensions/runtime-extensions "插件后台面板").
 *
 * Two tiers. Every plugin with `ext:admin-panels` gets the declarative tier: the pages, widgets and settings its manifest
 * declares, rendered by Studio from data the host reads — a table page lists one of the plugin's own storage namespaces,
 * a widget counts one, the settings page edits the declared settings. A page with the plugin's own frontend (`custom`) is
 * only offered for a plugin the operator marked as trusted; otherwise it is reported as `untrusted` and nothing of it is
 * loaded.
 *
 * Everything is read for the active site only, which the route has already checked the person may see (site membership);
 * a panel cannot reach anything outside the plugin's declared storage and settings.
 */
import { and, eq } from 'drizzle-orm';
import { extensions, type Database } from '@heopress/database';
import type { ExtensionAdmin, ExtensionConfigOption } from '@heopress/contracts/schemas';
import { runSiteTransaction } from '../../services/rls-transaction';
import { PluginStorage, declaredStorageOf, type StoredDocument } from './storage';
import { adminOf, grantsPoint, isRunnable, settingValuesOf, type ExtensionRow } from './plugin-host';

export class PluginPanelError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'PluginPanelError';
  }
}

type FrontendStatus = 'trusted' | 'untrusted';

export interface PanelPage {
  id: string;
  title: string;
  type: 'table' | 'settings' | 'custom';
  /** `custom`: whether its frontend may load. */
  frontend?: { status: FrontendStatus; url: string | null };
}

export interface PluginPanel {
  name: string;
  displayName: string;
  version: string;
  trusted: boolean;
  pages: PanelPage[];
  widgets: Array<{ id: string; title: string; count: number }>;
  hasSettings: boolean;
}

function displayNameOf(row: ExtensionRow): string {
  const m = row.manifest as { displayName?: unknown } | null;
  return typeof m?.displayName === 'string' && m.displayName ? m.displayName : row.name;
}

function frontendOf(row: ExtensionRow, page: ExtensionAdmin['pages'][number]): PanelPage['frontend'] {
  if (page.type !== 'custom') return undefined;
  // Only an operator-trusted plugin's own frontend is offered; an untrusted one is never handed to Studio.
  return row.trusted ? { status: 'trusted', url: page.frontend ?? null } : { status: 'untrusted', url: null };
}

export class PluginPanels {
  constructor(
    private readonly db: Database,
    private readonly siteId: string,
  ) {}

  private async rows(): Promise<ExtensionRow[]> {
    const rows = await this.db.select().from(extensions).where(and(eq(extensions.siteId, this.siteId), eq(extensions.enabled, true)));
    return rows.filter((r) => isRunnable(r) && grantsPoint(r, 'admin-panels'));
  }

  private async panelRow(name: string): Promise<ExtensionRow> {
    const row = (await this.rows()).find((r) => r.name === name);
    if (!row) throw new PluginPanelError('NOT_FOUND', 'No admin panel of that plugin on this site.', 404);
    return row;
  }

  /** The panels of the site's enabled plugins with `ext:admin-panels`. */
  async list(): Promise<PluginPanel[]> {
    const out: PluginPanel[] = [];
    for (const row of await this.rows()) {
      const admin = adminOf(row);
      const storage = new PluginStorage(this.db, this.siteId, row.name, declaredStorageOf(row.manifest));
      const widgets = [];
      for (const w of admin.widgets) {
        const count = storage.namespaces.includes(w.storage) ? await storage.collection(w.storage).count() : 0;
        widgets.push({ id: w.id, title: w.title, count });
      }
      out.push({
        name: row.name,
        displayName: displayNameOf(row),
        version: row.version,
        trusted: row.trusted,
        pages: admin.pages.map((p) => ({ id: p.id, title: p.title, type: p.type, ...(p.type === 'custom' ? { frontend: frontendOf(row, p) } : {}) })),
        widgets,
        hasSettings: admin.settings.length > 0,
      });
    }
    return out;
  }

  /** One page's content. */
  async page(
    name: string,
    pageId: string,
    opts: { after?: string } = {},
  ): Promise<
    | { type: 'table'; id: string; title: string; columns: string[]; documents: StoredDocument[]; next: string | null }
    | { type: 'settings'; id: string; title: string; settings: ExtensionConfigOption[]; values: Record<string, unknown> }
    | { type: 'custom'; id: string; title: string; frontend: NonNullable<PanelPage['frontend']> }
  > {
    const row = await this.panelRow(name);
    const admin = adminOf(row);
    const page = admin.pages.find((p) => p.id === pageId);
    if (!page) throw new PluginPanelError('NOT_FOUND', 'No such page.', 404);
    if (page.type === 'settings') return { type: 'settings', id: page.id, title: page.title, settings: admin.settings, values: settingValuesOf(row) };
    if (page.type === 'custom') return { type: 'custom', id: page.id, title: page.title, frontend: frontendOf(row, page)! };
    const storage = new PluginStorage(this.db, this.siteId, row.name, declaredStorageOf(row.manifest));
    const result = await storage.collection(page.storage!).query({ after: opts.after, limit: 50 });
    return { type: 'table', id: page.id, title: page.title, columns: page.columns ?? [], documents: result.documents, next: result.next };
  }

  /** The declared settings and their values on this site. */
  async settings(name: string): Promise<{ settings: ExtensionConfigOption[]; values: Record<string, unknown> }> {
    const row = await this.panelRow(name);
    const admin = adminOf(row);
    return { settings: admin.settings, values: settingValuesOf(row) };
  }

  /** Save setting values; only declared keys, each of its declared type. */
  async saveSettings(name: string, input: unknown): Promise<Record<string, unknown>> {
    const row = await this.panelRow(name);
    const admin = adminOf(row);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PluginPanelError('INVALID_SETTINGS', 'Send an object of setting values.', 400);
    const declared = new Map(admin.settings.map((s) => [s.key, s]));
    const next: Record<string, unknown> = { ...((row.settings as Record<string, unknown>) ?? {}) };
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const d = declared.get(key);
      if (!d) throw new PluginPanelError('UNKNOWN_SETTING', `"${key}" is not a setting this plugin declares.`, 400);
      const ok =
        value === null ||
        (d.type === 'string' && typeof value === 'string' && value.length <= 2000) ||
        (d.type === 'integer' && Number.isInteger(value)) ||
        (d.type === 'boolean' && typeof value === 'boolean') ||
        (d.type === 'json' && JSON.stringify(value).length <= 8000);
      if (!ok) throw new PluginPanelError('INVALID_SETTING', `"${key}" must be ${d.type}.`, 400);
      next[key] = value;
    }
    await runSiteTransaction(this.db, this.siteId, (tx) =>
      tx.update(extensions).set({ settings: next }).where(and(eq(extensions.siteId, this.siteId), eq(extensions.id, row.id))),
    );
    return settingValuesOf({ ...row, settings: next });
  }
}

/** The private storage of a plugin on a site, installed or not (export and purge outlive the installation). */
export async function pluginStorageFor(db: Database, siteId: string, name: string): Promise<{ storage: PluginStorage; row: ExtensionRow | null }> {
  const [row] = await db.select().from(extensions).where(and(eq(extensions.siteId, siteId), eq(extensions.name, name))).limit(1);
  return { storage: new PluginStorage(db, siteId, name, declaredStorageOf(row?.manifest)), row: row ?? null };
}
