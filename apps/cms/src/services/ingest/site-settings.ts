import { eq } from 'drizzle-orm';
import { IngestSiteSettingsSchema, type IngestSiteSettingsResource, type LicenceLapsePolicy } from '@heopress/contracts/schemas';
import { ingestSiteSettings, type Database } from '@heopress/database';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { IngestSourceError } from './source-service';

/**
 * The site's ingestion settings (HeoPress P08 tasks 1.6, 1.7): the licence-lapse policy (`hide` by default) and the
 * primary-source allow-list for research leads (empty by default: no leads). Read by every member, set by
 * administrators.
 */

export interface SiteIngestSettings {
  licenceLapsePolicy: LicenceLapsePolicy;
  primarySourcePatterns: string[];
  updatedAt: Date | null;
}

export async function siteSettingsOf(tx: SiteTransaction, siteId: string): Promise<SiteIngestSettings> {
  const [row] = await tx.select().from(ingestSiteSettings).where(eq(ingestSiteSettings.siteId, siteId));
  return {
    licenceLapsePolicy: row?.licenceLapsePolicy === 'flag' ? 'flag' : 'hide',
    primarySourcePatterns: row?.primarySourcePatterns ?? [],
    updatedAt: row?.updatedAt ?? null,
  };
}

const toResource = (s: SiteIngestSettings): IngestSiteSettingsResource => ({
  licenceLapsePolicy: s.licenceLapsePolicy,
  primarySourcePatterns: s.primarySourcePatterns,
  updatedAt: s.updatedAt?.toISOString() ?? null,
});

export class IngestSiteSettingsService {
  constructor(private readonly deps: { db: Database; siteId: string; userId: string | null; now?: () => Date }) {}

  async get(): Promise<IngestSiteSettingsResource> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => toResource(await siteSettingsOf(tx, this.deps.siteId)));
  }

  async update(body: unknown): Promise<IngestSiteSettingsResource> {
    const parsed = IngestSiteSettingsSchema.safeParse(body);
    if (!parsed.success) throw new IngestSourceError('VALIDATION', 'Invalid ingestion settings.', 400, parsed.error.issues);
    const { siteId } = this.deps;
    const now = this.deps.now?.() ?? new Date();
    const values = { ...parsed.data, updatedBy: this.deps.userId, updatedAt: now };
    return runSiteTransaction(this.deps.db, siteId, async (tx) => {
      await tx.insert(ingestSiteSettings).values({ siteId, ...values }).onConflictDoUpdate({ target: ingestSiteSettings.siteId, set: values });
      return toResource(await siteSettingsOf(tx, siteId));
    });
  }
}
