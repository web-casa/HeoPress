import { and, eq, sql } from 'drizzle-orm';
import { effectiveSiteIdentity, SiteIdentityUpdateSchema, type SiteIdentity } from '@heopress/contracts/schemas';
import { siteContentSettings, siteIdentity, type Database } from '@heopress/database';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { withTransactionRetry } from './translation-groups';

/**
 * Whom a site speaks for (HeoPress P07 task 2.12; spec seo/page-metadata "站点身份"): read as stored (null until set:
 * nothing is made up), updated only against the version it was read at (a stale form is a 409). Each change passes the
 * projection gate in its transaction — the public snapshot (`lumibase_public_sites.identity`) and the site's render
 * version change with it — and appends a change event.
 */

export class SiteIdentityError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'VERSION_CONFLICT',
    message: string,
    readonly status: 400 | 409,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SiteIdentityError';
  }
}

export interface SiteIdentityDeps {
  db: Database;
  siteId: string;
  actor: { userId: string | null; apiKeyId?: string | null };
}

export interface SiteIdentityView {
  identity: SiteIdentity | null;
  version: number;
}

export class SiteIdentityService {
  constructor(private readonly deps: SiteIdentityDeps) {}

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>): Promise<T> {
    // The projection flush locks the other sites of cross-site groups (P06): a deadlock is retried.
    return withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, fn));
  }

  async get(): Promise<SiteIdentityView> {
    return this.tx(async (tx) => {
      const [row] = await tx.select().from(siteIdentity).where(eq(siteIdentity.siteId, this.deps.siteId));
      return { identity: effectiveSiteIdentity(row?.identity), version: row?.version ?? 0 };
    });
  }

  async update(input: unknown): Promise<SiteIdentityView> {
    const parsed = SiteIdentityUpdateSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new SiteIdentityError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || '/'}: ${i.message}`).join('; '), 400);
    }
    const { version, ...next } = parsed.data;
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      // The site-wide refresh this write causes rewrites every item row of the site: the site's settings row first, as
      // every site-wide writer (P07, Codex review of batch 4b). It also serialises the updates of a site, the first included.
      await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`heopress:site-identity:${siteId}`}, 0))`);
      const [current] = await tx.select().from(siteIdentity).where(eq(siteIdentity.siteId, siteId)).for('update');
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== version) {
        throw new SiteIdentityError('VERSION_CONFLICT', 'The identity changed since it was read; reload it.', 409, { version: currentVersion });
      }
      const identity = next as unknown as Record<string, unknown>;
      const [row] = current
        ? await tx
            .update(siteIdentity)
            .set({ identity, version: sql`${siteIdentity.version} + 1`, updatedAt: new Date() })
            .where(and(eq(siteIdentity.siteId, siteId), eq(siteIdentity.version, currentVersion)))
            .returning()
        : await tx.insert(siteIdentity).values({ siteId, identity, version: 1 }).returning();
      const before = effectiveSiteIdentity(current?.identity);
      const changedFields = (Object.keys(next) as Array<keyof SiteIdentity>).filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(next[k]));
      if (changedFields.length > 0) {
        await appendItemEvent(tx, {
          siteId,
          resource: 'site_identity',
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
      return { identity: next, version: row!.version };
    });
  }
}
