// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * PreviewEnvManager — ephemeral preview sites for pull requests.
 *
 * Each open PR gets a derived site (`${baseSiteId}__pr-${number}`) seeded with a
 * copy of the base site's collections/fields/items/pages. The preview is served
 * by the existing public delivery route `GET /api/v1/deliver/page/:site_id/:slug`.
 * Teardown is a cascade-delete of the ephemeral `sites` row.
 *
 * RLS note: provisioning is a *cross-site* system operation — it reads the base
 * site then writes a different (ephemeral) site, which the per-request
 * `site_isolation` RLS policy would reject. Reads run in the base site's scope and
 * writes in the ephemeral site's scope, inside one transaction (HeoPress P06: the
 * public projection is flushed before it commits; the scope was previously set on
 * a separate pooled connection, where it did not apply). See
 * `docs/legacy/kiro-specs/git-integration/design.md` §11.
 */
import type { Database } from '@heopress/database';
import {
  collections as collectionsTable,
  fields as fieldsTable,
  items as itemsTable,
  pages as pagesTable,
  sites as sitesTable,
  siteContentSettings,
  gitPreviewEnvs,
  gitPullRequests,
} from '@heopress/database';
import type { RuntimeContext } from '@heopress/runtime';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { runSiteTransaction, withSiteScope, type SiteTransaction } from '../../services/rls-transaction';
import { ensureContentSettings } from '../../services/site-network/preset-installer';
import { projectedTransaction } from '../../services/site-network/public-projection';

/** Default lifetime of a preview environment. */
const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COPY_BATCH = 500;

/** Deterministic ephemeral site id for a PR (pure). */
export function ephemeralSiteId(baseSiteId: string, prNumber: number): string {
  return `${baseSiteId}__pr-${prNumber}`;
}

/** Build an old-id → new-id remap from a list of source rows (pure). */
export function remapIds(rows: { id: string }[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) map.set(r.id, nanoid());
  return map;
}

export interface PreviewEnvDeps {
  db: Database;
  runtime: RuntimeContext;
  siteId: string;
  integrationId: string;
  publicBaseUrl: string;
  isDev: boolean;
}

export interface PreviewPrInput {
  prId: string;
  number: number;
  state: string;
}

export class PreviewEnvManager {
  constructor(private readonly deps: PreviewEnvDeps) {}

  private previewUrl(ephemeralId: string): string {
    const base = this.deps.publicBaseUrl.replace(/\/+$/, '');
    return `${base}/api/v1/deliver/page/${ephemeralId}/home`;
  }

  /** Create (or refresh) the preview environment for an opened/updated PR. */
  async ensureForPullRequest(pr: PreviewPrInput): Promise<void> {
    const ephemeralId = ephemeralSiteId(this.deps.siteId, pr.number);

    // Upsert lifecycle row (status pending/updating).
    const [existing] = await this.deps.db
      .select()
      .from(gitPreviewEnvs)
      .where(eq(gitPreviewEnvs.prId, pr.prId))
      .limit(1);

    if (existing) {
      await this.deps.db
        .update(gitPreviewEnvs)
        .set({ status: 'updating', updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.id, existing.id));
      // Clear prior ephemeral content before re-seeding.
      await this.purgeEphemeral(ephemeralId);
    } else {
      await this.deps.db.insert(gitPreviewEnvs).values({
        siteId: this.deps.siteId,
        integrationId: this.deps.integrationId,
        prId: pr.prId,
        ephemeralSiteId: ephemeralId,
        status: 'pending',
        expiresAt: new Date(Date.now() + PREVIEW_TTL_MS),
      });
    }

    try {
      await this.provision(ephemeralId, pr.number);
      const url = this.previewUrl(ephemeralId);
      await this.deps.db
        .update(gitPreviewEnvs)
        .set({ status: 'ready', url, updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.prId, pr.prId));
      await this.deps.db
        .update(gitPullRequests)
        .set({ previewUrl: url, updatedAt: new Date() })
        .where(eq(gitPullRequests.id, pr.prId));
    } catch (err) {
      await this.deps.db
        .update(gitPreviewEnvs)
        .set({ status: 'error', updatedAt: new Date() })
        .where(eq(gitPreviewEnvs.prId, pr.prId));
      throw err;
    }
  }

  /** Tear down a preview when its PR closes or merges (idempotent). */
  async destroy(prId: string): Promise<void> {
    const [row] = await this.deps.db
      .select()
      .from(gitPreviewEnvs)
      .where(eq(gitPreviewEnvs.prId, prId))
      .limit(1);
    if (!row) return;
    // Its content, then the ephemeral site row itself, in one transaction.
    await projectedTransaction(this.deps.db, async (tx) => {
      await withSiteScope(tx, row.ephemeralSiteId, () => this.purgeIn(tx, row.ephemeralSiteId));
      await tx.delete(sitesTable).where(eq(sitesTable.id, row.ephemeralSiteId));
    });
    await this.deps.db
      .update(gitPreviewEnvs)
      .set({ status: 'destroyed', updatedAt: new Date() })
      .where(eq(gitPreviewEnvs.id, row.id));
  }

  /** Destroy any preview whose TTL has elapsed. */
  async cleanupExpired(): Promise<number> {
    const stale = await this.deps.db
      .select()
      .from(gitPreviewEnvs)
      .where(
        and(
          eq(gitPreviewEnvs.siteId, this.deps.siteId),
          lt(gitPreviewEnvs.expiresAt, new Date()),
        ),
      );
    let destroyed = 0;
    for (const row of stale) {
      if (row.status === 'destroyed') continue;
      await this.destroy(row.prId);
      destroyed += 1;
    }
    return destroyed;
  }

  /** Create the ephemeral site row + copy base content into it. */
  private async provision(ephemeralId: string, prNumber: number): Promise<void> {
    await projectedTransaction(this.deps.db, async (tx) => {
      const [base] = await tx
        .select()
        .from(sitesTable)
        .where(eq(sitesTable.id, this.deps.siteId))
        .limit(1);

      // sites is excluded from RLS, so this insert is unaffected by context.
      await tx
        .insert(sitesTable)
        .values({
          id: ephemeralId,
          name: `${base?.name ?? this.deps.siteId} (PR #${prNumber})`,
          defaultLanguage: base?.defaultLanguage ?? 'en',
        })
        .onConflictDoNothing();
      // Its content settings row: what every item writer of the site locks first (P07, Codex review of batch 4b).
      await withSiteScope(tx, ephemeralId, () => ensureContentSettings(tx, ephemeralId));

      await this.copyContent(tx, ephemeralId);
    });
  }

  /** Copy collections → fields → items → pages from base into the ephemeral site. */
  private async copyContent(tx: SiteTransaction, toSiteId: string): Promise<void> {
    const from = this.deps.siteId;

    // Read under the base-site context.
    const { cols, flds, its, pgs } = await withSiteScope(tx, from, async () => ({
      cols: await tx.select().from(collectionsTable).where(eq(collectionsTable.siteId, from)),
      flds: await tx.select().from(fieldsTable).where(eq(fieldsTable.siteId, from)),
      its: await tx.select().from(itemsTable).where(and(eq(itemsTable.siteId, from), isNull(itemsTable.deletedAt))),
      pgs: await tx.select().from(pagesTable).where(eq(pagesTable.siteId, from)),
    }));

    const colMap = remapIds(cols);

    // Write under the ephemeral-site context so RLS WITH CHECK passes.
    await withSiteScope(tx, toSiteId, () => this.writeCopy(tx, toSiteId, colMap, { cols, flds, its, pgs }));
  }

  private async writeCopy(
    tx: SiteTransaction,
    toSiteId: string,
    colMap: Map<string, string>,
    { cols, flds, its, pgs }: {
      cols: Array<typeof collectionsTable.$inferSelect>;
      flds: Array<typeof fieldsTable.$inferSelect>;
      its: Array<typeof itemsTable.$inferSelect>;
      pgs: Array<typeof pagesTable.$inferSelect>;
    },
  ): Promise<void> {
    await this.insertBatched(
      tx,
      collectionsTable,
      cols.map((c) => ({ ...c, id: colMap.get(c.id)!, siteId: toSiteId })),
    );
    await this.insertBatched(
      tx,
      fieldsTable,
      flds.map((f) => ({
        ...f,
        id: nanoid(),
        siteId: toSiteId,
        collectionId: colMap.get(f.collectionId) ?? f.collectionId,
      })),
    );
    await this.insertBatched(
      tx,
      itemsTable,
      its.map((i) => ({
        ...i,
        id: nanoid(),
        siteId: toSiteId,
        collectionId: colMap.get(i.collectionId) ?? i.collectionId,
      })),
    );
    await this.insertBatched(
      tx,
      pagesTable,
      pgs.map((p) => ({ ...p, id: nanoid(), siteId: toSiteId })),
    );
  }

  /** Delete all content rows for an ephemeral site (keeps the sites row). */
  private async purgeEphemeral(ephemeralId: string): Promise<void> {
    await runSiteTransaction(this.deps.db, ephemeralId, (tx) => this.purgeIn(tx, ephemeralId));
  }

  private async purgeIn(tx: SiteTransaction, ephemeralId: string): Promise<void> {
    // The site's settings row before its item rows, as every item writer (P07, Codex review of batch 4b); a preview site
    // provisioned before it had one gets it first.
    await ensureContentSettings(tx, ephemeralId);
    await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${ephemeralId} FOR SHARE`);
    await tx.delete(pagesTable).where(eq(pagesTable.siteId, ephemeralId));
    await tx.delete(itemsTable).where(eq(itemsTable.siteId, ephemeralId));
    await tx.delete(fieldsTable).where(eq(fieldsTable.siteId, ephemeralId));
    await tx.delete(collectionsTable).where(eq(collectionsTable.siteId, ephemeralId));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async insertBatched(tx: SiteTransaction, table: any, rows: any[]): Promise<void> {
    for (let i = 0; i < rows.length; i += COPY_BATCH) {
      const chunk = rows.slice(i, i + COPY_BATCH);
      if (chunk.length > 0) await tx.insert(table).values(chunk);
    }
  }
}
