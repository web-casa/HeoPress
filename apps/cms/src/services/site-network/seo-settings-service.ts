import { randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { effectiveSeoSettings, SiteSeoSettingsUpdateSchema, type SiteSeoSettings } from '@heopress/contracts/schemas';
import { siteContentSettings, siteSeoSettings, type Database } from '@heopress/database';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { withTransactionRetry } from './translation-groups';
import { customCrawlerError } from '@heopress/seo-geo';
import { seedIndexNowBaseline } from './indexnow';

/**
 * A site's SEO / GEO settings (HeoPress P07 task 1.4): read with their defaults filled in, updated only
 * against the version they were read at (a stale form is a 409, never a silent overwrite). Each change
 * passes the projection gate in its transaction — the public snapshot (`publicSeoSnapshot`, in
 * `lumibase_public_sites.seo`) and the site's render version change with it — and appends a change event.
 */

export class SeoSettingsError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'SYSTEM_LIMIT' | 'VERSION_CONFLICT',
    message: string,
    readonly status: 400 | 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SeoSettingsError';
  }
}

export interface SeoSettingsDeps {
  db: Database;
  siteId: string;
  actor: { userId: string | null; apiKeyId?: string | null };
}

export interface SeoSettingsView {
  settings: SiteSeoSettings;
  version: number;
}

/**
 * What the rendering service may know of the settings: all of them today (none is secret — the IndexNow key
 * is published at the site's root by design), named here so that a private setting added later is left out
 * by default rather than leaked.
 */
export function publicSeoSnapshot(settings: SiteSeoSettings): Record<string, unknown> {
  return {
    titleTemplate: settings.titleTemplate,
    descriptionTemplate: settings.descriptionTemplate,
    index: settings.index,
    snippet: settings.snippet,
    crawlers: settings.crawlers,
    discovery: settings.discovery,
  };
}

export class SeoSettingsService {
  constructor(private readonly deps: SeoSettingsDeps) {}

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>): Promise<T> {
    // The projection flush locks the other sites of cross-site groups (P06): a deadlock is retried.
    return withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, fn));
  }

  async get(): Promise<SeoSettingsView> {
    return this.tx(async (tx) => {
      const [row] = await tx.select().from(siteSeoSettings).where(eq(siteSeoSettings.siteId, this.deps.siteId));
      // No row yet: version 0, the first update creates it.
      return { settings: effectiveSeoSettings(row?.settings), version: row?.version ?? 0 };
    });
  }

  async update(input: unknown): Promise<SeoSettingsView> {
    // Search results and error pages are never indexed (P07 task 2.8; spec seo/page-metadata "搜索结果页设为收录"): asking
    // for it is told so as the system's limit, not as a malformed request.
    const asked = (input as { index?: { pageTypes?: unknown } } | null)?.index?.pageTypes;
    const limited = asked && typeof asked === 'object' ? Object.keys(asked).filter((k) => k === 'search' || k === 'error') : [];
    if (limited.length) {
      throw new SeoSettingsError('SYSTEM_LIMIT', 'Search result and error pages are never indexed: this is a system limit, not a site setting.', 400, { pageTypes: limited });
    }
    const parsed = SiteSeoSettingsUpdateSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new SeoSettingsError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || '/'}: ${i.message}`).join('; '), 400);
    }
    const { version, ...next } = parsed.data;
    // The site's own crawlers do not take a known crawler's id or token, nor share one (P07 task 3.2).
    const crawlerError = customCrawlerError(next.crawlers.custom);
    if (crawlerError) throw new SeoSettingsError('VALIDATION', `crawlers.custom: ${crawlerError}`, 400);
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      // The site-wide refresh this write causes rewrites every item row of the site: it holds the site's settings row
      // first, as every content-settings writer does, so it never runs beside an item write (which holds it shared) and
      // overwrites that write's fresh row with what it read before (Codex review of batch 4b).
      await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`);
      // Serialises the updates of a site, the first one included (no row to lock yet): the loser of a race
      // reads the winner's version and gets the 409, never a unique-key error.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`heopress:seo-settings:${siteId}`}, 0))`);
      const [current] = await tx.select().from(siteSeoSettings).where(eq(siteSeoSettings.siteId, siteId)).for('update');
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== version) {
        throw new SeoSettingsError('VERSION_CONFLICT', 'The settings changed since they were read; reload them.', 409, { version: currentVersion });
      }
      // The IndexNow key (P07 task 3.4): kept once made — a form that leaves it out keeps the stored one — and made when
      // IndexNow is first turned on.
      const storedKey = effectiveSeoSettings(current?.settings).discovery.indexNowKey;
      const indexNowKey = next.discovery.indexNowKey ?? storedKey ?? (next.discovery.indexNow ? randomBytes(16).toString('hex') : null);
      next.discovery = { ...next.discovery, indexNowKey };
      const settings = next as unknown as Record<string, unknown>;
      const [row] = current
        ? await tx
            .update(siteSeoSettings)
            .set({ settings, version: sql`${siteSeoSettings.version} + 1`, updatedAt: new Date() })
            .where(and(eq(siteSeoSettings.siteId, siteId), eq(siteSeoSettings.version, currentVersion)))
            .returning()
        : await tx.insert(siteSeoSettings).values({ siteId, settings, version: 1 }).returning();
      const before = effectiveSeoSettings(current?.settings);
      // IndexNow turned on (P07 task 3.4, Codex review of batch 8): its baseline — what is listable now — is recorded in this
      // transaction, so a page published after this moment is pushed (not taken into the baseline by the first pass).
      if (next.discovery.indexNow && next.discovery.indexNowKey && !(before.discovery.indexNow && before.discovery.indexNowKey)) {
        await seedIndexNowBaseline(tx, siteId, next as SiteSeoSettings);
      }
      const changedFields = (Object.keys(next) as Array<keyof SiteSeoSettings>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(next[k]));
      if (changedFields.length > 0) {
        await appendItemEvent(tx, {
          siteId,
          resource: 'site_seo_settings',
          collection: '$site',
          itemId: siteId,
          itemVersion: row!.version,
          changedFields,
          actor: this.deps.actor.userId
            ? { type: 'user', id: this.deps.actor.userId }
            : this.deps.actor.apiKeyId
              ? { type: 'api_key', id: this.deps.actor.apiKeyId }
              : { type: 'system', id: null },
          source: 'api',
          payload: null,
        });
      }
      return { settings: next, version: row!.version };
    });
  }
}
