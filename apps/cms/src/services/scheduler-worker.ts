// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { activity, collections, items, settings, scopeSite, sites, type Database } from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';
import { dispatchRevalidation, parseTargets } from './revalidation';
import { AuditLogger } from '../modules/audit/logger';
import { appendItemEvent } from '../modules/cdc/change-feed/outbox-writer';
import { itemServiceForSystem } from './item-service-factory';
import { sweepDueReleases } from './release-service';
import { runDueScheduledFlows } from './flow-scheduler';
import { ItemServiceError } from './item-service-error';
import { runSiteTransaction, withSiteScope } from './rls-transaction';
import { lockContentSettingsShared, syncContentRoute } from './site-network/content-routes';
import { firstPublishSql } from './site-network/publish-time';
import { reconcileFreshness } from './site-network/freshness';
import { assertNotBoundSingleWrite } from './auto-publish/locale-set';
import { runDueAutoPublish } from './auto-publish/auto-publish';
import { assertMayPublishInGroup, assertMembershipUnchanged, itemLocale, lockMembership, withTransactionRetry } from './site-network/translation-groups';
import { projectedTransaction } from './site-network/public-projection';

/**
 * Content scheduler (regulated-content-readiness task 7; Req 7.3, 7.4, 7.6, 7.7).
 *
 * Mirrors the veto-commit worker model (design §8): the primary path is a
 * periodic tick on the existing QueueProvider / Flows schedule trigger, with a
 * safety-net sweep for items the queue missed (catch-up after downtime).
 *
 * Idempotency (Req 7.6): each transition is a conditional UPDATE guarded by the
 * source state (`status != target`). Only rows actually flipped trigger
 * revalidation, so re-running over the same timestamp is a no-op and never
 * double-fires side-effects.
 */

export const SCHEDULER_QUEUE = 'content-scheduler';

export interface SchedulerDeps {
  db: Database;
  queue?: QueueProvider;
}

export interface SchedulerTickResult {
  published: number;
  unpublished: number;
  /** Scheduled Content Releases published this tick. */
  releasesPublished: number;
  /** Due scheduled flows enqueued this tick (visual-flow-builder Req 2). */
  flowsEnqueued: number;
}

/** Resolve a collection's unpublish target (`archived` default, or `draft`). */
function unpublishTarget(meta: unknown): 'archived' | 'draft' {
  const m = meta as Record<string, unknown> | null;
  return m?.unpublishTarget === 'draft' ? 'draft' : 'archived';
}

/** Best-effort revalidation of collection tags for a site (Req 7.3, 7.4). */
async function revalidate(db: Database, siteId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  try {
    const [row] = await db
      .select()
      .from(settings)
      .where(and(eq(settings.siteId, siteId), eq(settings.key, 'revalidation.targets')));
    const targets = parseTargets(row?.value);
    if (targets.length > 0) await dispatchRevalidation(targets, tags);
  } catch {
    // Revalidation is best-effort; the state transition has already committed.
  }
}

/** Map collectionId → name for revalidation tags. */
async function collectionNames(db: Database, siteId: string, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const rows = await db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(scopeSite(collections.siteId, siteId));
  for (const r of rows) if (ids.includes(r.id)) map.set(r.id, r.name);
  return map;
}

/** collectionId → name, for change events. */
async function collectionNamesById(db: Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: collections.id, name: collections.name })
    .from(collections)
    .where(inArray(collections.id, [...new Set(ids)]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

/**
 * Publish items whose `publishAt` is due (Req 7.3). Flips not-yet-published
 * items in their Publish_Window to `published` and revalidates per collection.
 */
export async function sweepDuePublish(deps: SchedulerDeps, now = new Date()): Promise<number> {
  const due = await deps.db
    .select({ id: items.id, siteId: items.siteId, collectionId: items.collectionId, version: items.version })
    .from(items)
    .where(
      and(
        ne(items.status, 'published'),
        isNull(items.deletedAt),
        isNotNull(items.publishAt),
        lte(items.publishAt, now),
        // Respect any unpublish bound that has not yet elapsed.
        or(isNull(items.unpublishAt), gt(items.unpublishAt, now)),
        // The publish guard (P04): held items are not due. They are recorded
        // below, and published by a later sweep once the hold is released.
        eq(items.hold, false),
      ),
    )
    .orderBy(asc(items.publishAt))
    .limit(200);

  await recordHeldSkips(deps, now);
  if (due.length === 0) return 0;

  // Conditional flip — only rows still not published and still not held are
  // affected (idempotent; a hold set after the query above wins).
  const flipped: typeof due = [];
  const names = await collectionNamesById(deps.db, due.map((d) => d.collectionId));
  for (const row of due) {
    // Plugins' pre-publish hooks (P12 task 3.4) first, outside the transaction: a veto leaves the item as it is.
    try {
      await prePublishScheduled(deps.db, row.siteId, names.get(row.collectionId) ?? '', row.id);
    } catch (err) {
      await recordPublishFailure(deps, row, err);
      continue;
    }
    // The publish, its route and its change event commit together (P04, P05), in the item's site scope. One item that
    // cannot be published (its path is taken, …) is rolled back alone and recorded; the others are still published.
    const done = await withTransactionRetry(deps.db, () => runSiteTransaction(deps.db, row.siteId, async (tx) => {
      await lockContentSettingsShared(tx, row.siteId);
      // A translation group member: internal-only, or its language already published in the group → not published (P05).
      const group = await lockMembership(tx, row.siteId, row.id);
      if (group) {
        const [current] = await tx.select({ data: items.data }).from(items).where(eq(items.id, row.id));
        await assertMayPublishInGroup(tx, group, await itemLocale(tx, row.siteId, current?.data));
        // A required language set publishes together (P09 task 3.7): not by one item's schedule.
        await assertNotBoundSingleWrite(tx, row.siteId, row.id, 'draft', 'published');
      }
      const changed = await tx
        .update(items)
        .set({
          status: 'published',
          editorialState: 'published',
          updatedAt: new Date(),
          version: sql`${items.version} + 1`,
          publishedAt: firstPublishSql.publishedAt as unknown as Date,
          publishedAtSource: firstPublishSql.publishedAtSource as unknown as string,
        })
        // Still the row that was found due: a reschedule, cancellation or any
        // other change since (all bump the version) wins (Codex review P04-1).
        .where(and(eq(items.id, row.id), ne(items.status, 'published'), eq(items.hold, false), eq(items.version, row.version)))
        .returning({ id: items.id, version: items.version });
      if (changed[0]) {
        await assertMembershipUnchanged(tx, row.siteId, row.id, group);
        await syncContentRoute(tx, row.siteId, row.id, { wasPublished: false });
        await appendItemEvent(tx, {
          siteId: row.siteId,
          collection: names.get(row.collectionId) ?? '',
          itemId: row.id,
          itemVersion: changed[0].version,
          changedFields: ['status'],
        });
      }
      return changed;
    })).catch(async (err: unknown) => {
      await recordPublishFailure(deps, row, err);
      return [];
    });
    if (done.length > 0) flipped.push(row);
  }

  // Revalidate affected collections once.
  const bySite = new Map<string, Set<string>>();
  for (const row of flipped) {
    if (!bySite.has(row.siteId)) bySite.set(row.siteId, new Set());
    bySite.get(row.siteId)!.add(row.collectionId);
  }
  for (const [siteId, collIds] of bySite) {
    const names = await collectionNames(deps.db, siteId, [...collIds]);
    await revalidate(deps.db, siteId, [...names.values()]);
  }
  return flipped.length;
}

/**
 * "Skipped because of a hold" (spec content/write-concurrency): one activity
 * entry per held item whose publish time has come, written once — not on
 * every sweep — until the item changes again (a new hold or edit updates
 * `updated_at`).
 */
async function recordHeldSkips(deps: SchedulerDeps, now: Date): Promise<void> {
  const held = await deps.db
    .select({ id: items.id, siteId: items.siteId, collection: collections.name, publishAt: items.publishAt })
    .from(items)
    .innerJoin(collections, eq(collections.id, items.collectionId))
    .where(
      and(
        eq(items.hold, true),
        ne(items.status, 'published'),
        isNull(items.deletedAt),
        isNotNull(items.publishAt),
        lte(items.publishAt, now),
        sql`NOT EXISTS (SELECT 1 FROM ${activity} a
                         WHERE a.site_id = ${items.siteId} AND a.item_id = ${items.id}
                           AND a.action = 'publish.skipped_hold' AND a.created_at >= ${items.updatedAt})`,
      ),
    )
    .limit(200);
  for (const row of held) {
    await deps.db.insert(activity).values({
      siteId: row.siteId,
      action: 'publish.skipped_hold',
      collection: row.collection,
      itemId: row.id,
      payload: { reason: 'hold', publishAt: row.publishAt?.toISOString() ?? null },
    });
  }
}

/**
 * Unpublish items whose `unpublishAt` has elapsed (Req 7.4). Moves published
 * items to the collection's unpublish target (archived|draft).
 */
export async function sweepDueUnpublish(deps: SchedulerDeps, now = new Date()): Promise<number> {
  const due = await deps.db
    .select({ id: items.id, siteId: items.siteId, collectionId: items.collectionId, version: items.version })
    .from(items)
    .where(
      and(
        eq(items.status, 'published'),
        isNull(items.deletedAt),
        isNotNull(items.unpublishAt),
        lte(items.unpublishAt, now),
      ),
    )
    .orderBy(asc(items.unpublishAt))
    .limit(200);

  if (due.length === 0) return 0;

  const collIdsBySite = new Map<string, Set<string>>();
  for (const row of due) {
    // Resolve target per collection meta.
    const [coll] = await deps.db
      .select({ meta: collections.meta, name: collections.name })
      .from(collections)
      .where(eq(collections.id, row.collectionId))
      .limit(1);
    const target = unpublishTarget(coll?.meta);
    await projectedTransaction(deps.db, async (tx) => {
      // The site's settings row before the item row (the order of site and collection deletions; P07, Codex review of batch 4b).
      await withSiteScope(tx, row.siteId, () => lockContentSettingsShared(tx as never, row.siteId));
      const changed = await tx
        .update(items)
        .set({
          status: target,
          editorialState: target === 'draft' ? 'draft' : null,
          updatedAt: new Date(),
          version: sql`${items.version} + 1`,
        })
        .where(and(eq(items.id, row.id), eq(items.status, 'published'), eq(items.version, row.version)))
        .returning({ version: items.version });
      if (changed[0]) {
        await syncContentRoute(tx, row.siteId, row.id, { wasPublished: false });
        await appendItemEvent(tx, {
          siteId: row.siteId,
          collection: coll?.name ?? '',
          itemId: row.id,
          itemVersion: changed[0].version,
          changedFields: ['status'],
        });
      }
    });
    if (!collIdsBySite.has(row.siteId)) collIdsBySite.set(row.siteId, new Set());
    collIdsBySite.get(row.siteId)!.add(row.collectionId);
  }

  for (const [siteId, collIds] of collIdsBySite) {
    const names = await collectionNames(deps.db, siteId, [...collIds]);
    await revalidate(deps.db, siteId, [...names.values()]);
  }
  return due.length;
}

/** One scheduler tick: apply due publishes then due unpublishes (Req 7.6). */
export async function runSchedulerTick(deps: SchedulerDeps, now = new Date()): Promise<SchedulerTickResult> {
  const published = await sweepDuePublish(deps, now);
  const unpublished = await sweepDueUnpublish(deps, now);
  // Content Releases: publish due scheduled releases on the same tick (shares
  // the content-scheduler queue). Idempotent + batch-bounded like the sweeps
  // above. See docs/legacy/kiro-specs/content-releases design §6.
  const releasesPublished = await sweepDueReleases(deps, now);
  // Scheduled flows: enqueue due cron flows on the same tick (executed by the
  // flow-events consumer). Idempotent — next_run_at advances before enqueue.
  // See docs/legacy/kiro-specs/visual-flow-builder Req 2.
  const flowsEnqueued = await runDueScheduledFlows({ db: deps.db, queue: deps.queue }, now);
  // Auto-publish (P09): veto windows that ended and queued candidates whose cadence slot came.
  await runDueAutoPublish(deps.db, now).catch((err: unknown) => console.warn('[auto-publish] tick failed', { err: String(err) }));
  // Translation freshness, checked periodically besides the change events (P05 task 5.4): every 15 minutes.
  if (now.getUTCMinutes() % FRESHNESS_CHECK_EVERY_MINUTES === 0) await runFreshnessCheck(deps);
  return { published, unpublished, releasesPublished, flowsEnqueued };
}

const FRESHNESS_CHECK_EVERY_MINUTES = 15;

/**
 * The periodic translation freshness check of every site (P05 task 5.4; design E): source blocks
 * judged again, targets that drifted from their recorded hash taken for a person's edit. One site's
 * failure is logged and does not stop the others.
 */
async function runFreshnessCheck(deps: SchedulerDeps): Promise<void> {
  const siteRows = await deps.db.select({ id: sites.id }).from(sites);
  for (const { id } of siteRows) {
    await reconcileFreshness(deps.db, id).catch((err: unknown) => console.warn('[freshness] periodic check failed', { siteId: id, err: String(err) }));
  }
}

export type RetentionAction = 'archive' | 'hard_delete' | 'crypto_shred';

export interface RetentionPolicy {
  collection: string;
  maxAgeDays: number;
  action: RetentionAction;
  /** Age anchor column; defaults to createdAt. */
  anchor?: 'createdAt' | 'updatedAt';
}

function parsePolicies(value: unknown): RetentionPolicy[] {
  const arr = Array.isArray(value)
    ? value
    : Array.isArray((value as { policies?: unknown })?.policies)
      ? (value as { policies: unknown[] }).policies
      : [];
  return arr.filter(
    (p): p is RetentionPolicy =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as RetentionPolicy).collection === 'string' &&
      typeof (p as RetentionPolicy).maxAgeDays === 'number' &&
      ['archive', 'hard_delete', 'crypto_shred'].includes((p as RetentionPolicy).action),
  );
}

/**
 * Apply per-collection retention policies across all sites (Req 12). For each
 * policy, items older than `maxAgeDays` from the anchor are archived,
 * hard-deleted, or crypto-shredded; each run audits `retention_applied`.
 * Idempotent — re-running re-selects only still-matching rows.
 */
export async function sweepRetention(deps: SchedulerDeps, now = new Date()): Promise<number> {
  const rows = await deps.db
    .select({ siteId: settings.siteId, value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'retention.policies'));

  let applied = 0;
  for (const row of rows) {
    const policies = parsePolicies(row.value);
    if (policies.length === 0) continue;
    // System context: retention sweep is a scheduled flow with no user
    // principal; it runs with system privileges over the whole site.
    const svc = itemServiceForSystem({ db: deps.db, siteId: row.siteId }, 'scheduler');

    for (const policy of policies) {
      const [coll] = await deps.db
        .select({ id: collections.id, name: collections.name })
        .from(collections)
        .where(and(scopeSite(collections.siteId, row.siteId), eq(collections.name, policy.collection)))
        .limit(1);
      if (!coll) continue;

      const cutoff = new Date(now.getTime() - policy.maxAgeDays * 86_400_000);
      const anchorCol = policy.anchor === 'updatedAt' ? items.updatedAt : items.createdAt;
      const due = await deps.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            scopeSite(items.siteId, row.siteId),
            eq(items.collectionId, coll.id),
            isNull(items.deletedAt),
            lte(anchorCol, cutoff),
          ),
        )
        .limit(500);
      if (due.length === 0) continue;

      let count = 0;
      for (const it of due) {
        if (policy.action === 'archive') {
          const r = await projectedTransaction(deps.db, async (tx) => {
            await withSiteScope(tx, row.siteId, () => lockContentSettingsShared(tx as never, row.siteId));
            const changed = await tx
              .update(items)
              .set({ status: 'archived', updatedAt: new Date(), version: sql`${items.version} + 1` })
              .where(and(eq(items.id, it.id), ne(items.status, 'archived')))
              .returning({ id: items.id, version: items.version });
            if (changed[0]) {
              await appendItemEvent(tx, {
                siteId: row.siteId,
                collection: policy.collection,
                itemId: it.id,
                itemVersion: changed[0].version,
                changedFields: ['status'],
              });
            }
            return changed;
          });
          if (r.length > 0) count += 1;
        } else if (policy.action === 'crypto_shred') {
          if (await svc.cryptoShred(policy.collection, it.id)) count += 1;
        } else {
          if (await svc.hardDelete(policy.collection, it.id)) count += 1;
        }
      }

      if (count > 0) {
        await new AuditLogger({ db: deps.db, siteId: row.siteId }).write({
          event: 'retention_applied',
          requestId: null,
          metadata: { siteId: row.siteId, collection: policy.collection, action: policy.action, recordCount: count },
        });
        applied += count;
      }
    }
  }
  return applied;
}

/** Long-lived runtime consumer (Docker/Node). Mirrors the veto worker. */
export function registerSchedulerWorker(deps: SchedulerDeps): void {
  deps.queue?.process(SCHEDULER_QUEUE, async () => {
    await runSchedulerTick(deps);
  });
}

/** A scheduled publish asks the site's plugins' pre-publish hooks, with the item as it is now (P12 task 3.4). */
async function prePublishScheduled(db: Database, siteId: string, collection: string, itemId: string): Promise<void> {
  const { PluginHost } = await import('../extensions/runtime/plugin-host');
  const host = new PluginHost({ db });
  if ((await host.enabledRows(siteId, 'events')).length === 0) return;
  const { runPrePublishHooks } = await import('../extensions/runtime/events');
  const item = (await itemServiceForSystem({ db, siteId, suppressExtensionHooks: true }, 'scheduler').detail(collection, itemId)) as { data?: Record<string, unknown> } | null;
  await runPrePublishHooks({ db, host, siteId }, { collection, itemId, status: 'published', data: item?.data ?? {} });
}

/** A due item that could not be published: recorded for its site, the sweep goes on (HeoPress P05). */
async function recordPublishFailure(deps: SchedulerDeps, row: { id: string; siteId: string }, err: unknown): Promise<void> {
  const code = err instanceof ItemServiceError ? err.code : 'PUBLISH_FAILED';
  const message = err instanceof Error ? err.message : String(err);
  await new AuditLogger({ db: deps.db, siteId: row.siteId })
    .write({ siteId: row.siteId, event: 'scheduled_publish_failed', metadata: { itemId: row.id, code, message } })
    .catch(() => undefined);
}
