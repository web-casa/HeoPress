import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { collections, items, notifications, sharedFieldSyncs, translationGroupMembers, translationGroups, userSites, type Database } from '@heopress/database';
import type { OutboxActor } from '../../modules/cdc/change-feed/outbox-writer';
import { ItemServiceError } from '../item-service-error';
import type { ItemService } from '../item-service';
import { runSiteTransaction, withSiteScope, type SiteTransaction } from '../rls-transaction';
import { lockContentSettingsShared } from './content-routes';
import { groupMemberItems, lockContentSettingsExclusive, lockMembership, type GroupRow, type HeldMembership } from './translation-groups';

/**
 * Shared fields of a translation group (HeoPress P05 task 4.6; spec i18n/translation-groups
 * "翻译组共享字段"; design D, R3, R4, R14, R18, R24).
 *
 * - A collection declares them in `meta.sharedFields` (field names). They follow the group's source.
 * - A member that is not the source never changes one itself (422 `SHARED_FIELD_FROM_SOURCE`) — also
 *   while the group has no source: they are frozen until a new source is set.
 * - The source's save that changes one leaves, in the same transaction, an intent per other member
 *   with the source's values at that version (newer intents supersede the target's unfinished ones).
 * - The `shared-field-sync` consumer applies each intent as whoever saved the source, with their
 *   permissions on the member's site at that moment, through the member's normal write (new version,
 *   change event, Hold and publish guards). No permission there: `blocked_permission`; a held
 *   published member: `blocked_hold`. A blocked intent notifies the site's editors once; one of them
 *   applies it as themselves. The source's save never depends on any of this.
 */

type Tx = SiteTransaction;
type Intent = typeof sharedFieldSyncs.$inferSelect;

export interface SyncTrigger {
  type: 'user' | 'api_key' | 'agent' | 'system';
  id: string | null;
}

/** The collection's shared fields (`meta.sharedFields`). */
export function sharedFieldsOf(meta: unknown): string[] {
  const list = (meta as { sharedFields?: unknown } | null)?.sharedFields;
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string' && f.length > 0) : [];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The shared fields whose value differs between `before` and `after`. */
export function changedSharedFields(fields: string[], before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  return fields.filter((f) => !same(before[f], after[f]));
}

/** Whether the held member is the group's source (a member that is not never writes shared fields). */
export function isGroupSource(held: HeldMembership): boolean {
  return held.member.role === 'source' && held.group.sourceItemId === held.member.itemId;
}

/**
 * Record the intents of a source's new version (same transaction as the save; group held): one per
 * other live member, superseding each target's unfinished intents.
 */
export async function recordSharedSyncs(
  tx: Tx,
  group: GroupRow,
  source: { itemId: string; version: number; data: Record<string, unknown> },
  fields: string[],
  trigger: SyncTrigger,
  onlyTargets?: string[],
): Promise<number> {
  if (fields.length === 0) return 0;
  const values = Object.fromEntries(fields.map((f) => [f, source.data[f] ?? null]));
  let n = 0;
  for (const m of await groupMemberItems(tx, group)) {
    if (m.itemId === source.itemId || m.deleted) continue;
    if (onlyTargets && !onlyTargets.includes(m.itemId)) continue;
    await withSiteScope(tx, m.siteId, async () => {
      await tx
        .update(sharedFieldSyncs)
        .set({ status: 'superseded', resolvedAt: new Date() })
        .where(and(eq(sharedFieldSyncs.targetItemId, m.itemId), inArray(sharedFieldSyncs.status, ['pending', 'blocked_permission', 'blocked_hold'])));
      await tx
        .insert(sharedFieldSyncs)
        .values({
          siteId: m.siteId,
          groupId: group.id,
          sourceItemId: source.itemId,
          sourceEpoch: group.sourceEpoch,
          sourceVersion: source.version,
          targetItemId: m.itemId,
          fields,
          values,
          triggerType: trigger.type,
          triggerId: trigger.id,
        })
        .onConflictDoNothing();
    });
    n++;
  }
  return n;
}

/**
 * The source's current shared values to every member that differs (a source was just set, or a member
 * joined; design R18): intents at the source's current version.
 */
export async function resyncFromSource(tx: Tx, group: GroupRow, trigger: SyncTrigger, onlyTargets?: string[]): Promise<number> {
  if (!group.sourceItemId) return 0;
  const members = await groupMemberItems(tx, group);
  const source = members.find((m) => m.itemId === group.sourceItemId);
  if (!source || source.deleted) return 0;
  const [coll] = await withSiteScope(tx, source.siteId, () => tx.select({ meta: collections.meta }).from(collections).where(eq(collections.id, source.collectionId)));
  const fields = sharedFieldsOf(coll?.meta);
  if (fields.length === 0) return 0;
  const data = (source.data ?? {}) as Record<string, unknown>;
  const differing = members
    .filter((m) => m.itemId !== source.itemId && !m.deleted && (!onlyTargets || onlyTargets.includes(m.itemId)))
    .filter((m) => changedSharedFields(fields, (m.data ?? {}) as Record<string, unknown>, data).length > 0)
    .map((m) => m.itemId);
  if (differing.length === 0) return 0;
  return recordSharedSyncs(tx, group, { itemId: source.itemId, version: source.version, data }, fields, trigger, differing);
}

export type SyncOutcome = 'applied' | 'blocked_permission' | 'blocked_hold' | 'superseded' | 'skipped';

/** How `applyIntent` finds writers: the intent's writer, and — for notifications — a site member's. */
export interface IntentWriters {
  /** The writer of this application (the trigger, or the person confirming); null: cannot write there. */
  writer: (intent: Intent, tx: Tx) => Promise<ItemService | null>;
  /** A member of the target's site as a writer (to tell who could confirm a blocked intent). */
  person: (userId: string, tx: Tx) => Promise<ItemService | null>;
}

/**
 * Apply one intent (design R4, R14, R23): lock order settings → group → target item → intent (the
 * settings row exclusively from the start when the write will need it so: a category's slug), then
 * check it is still the target's only unfinished intent, of the group's current source and epoch,
 * and write the values as the writer — also when they are already equal, the writer must be able
 * to. A blocked intent's notifications are stored in the same transaction (once: `notified_at`).
 * The write's after-commit work (realtime, flows, caches) runs once the transaction committed.
 */
export async function applyIntent(
  db: Database,
  intentId: string,
  siteId: string,
  writers: IntentWriters,
  opts: { accept: Array<Intent['status']>; resolvedBy?: string | null } = { accept: ['pending'] },
): Promise<SyncOutcome> {
  const afterCommit: Array<() => Promise<void>> = [];
  const outcome = await runSiteTransaction(db, siteId, async (tx) => {
    // Work queued by an attempt that was rolled back and started over (a moved membership, a deadlock) never runs.
    afterCommit.length = 0;
    const [seen] = await tx.select().from(sharedFieldSyncs).where(eq(sharedFieldSyncs.id, intentId));
    if (!seen || !opts.accept.includes(seen.status)) return 'skipped' as const;
    const [targetColl] = await tx
      .select({ name: collections.name })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), eq(items.id, seen.targetItemId)));
    // A category's new slug moves paths: ItemService takes the settings row FOR UPDATE then. Any category
    // write may end with a new slug (a before hook can derive it), so a category takes it from the start.
    if (targetColl?.name === 'categories') await lockContentSettingsExclusive(tx, siteId);
    else await lockContentSettingsShared(tx, siteId);
    const held = await lockMembership(tx, siteId, seen.targetItemId);
    const [target] = await tx
      .select({ collection: collections.name, data: items.data, deletedAt: items.deletedAt })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), eq(items.id, seen.targetItemId)))
      .for('update', { of: items });
    const [intent] = await tx.select().from(sharedFieldSyncs).where(eq(sharedFieldSyncs.id, intentId)).for('update');
    if (!intent || !opts.accept.includes(intent.status)) return 'skipped' as const;
    const settle = async (status: 'applied' | 'blocked_permission' | 'blocked_hold' | 'superseded', reason: string | null): Promise<SyncOutcome> => {
      await tx
        .update(sharedFieldSyncs)
        .set({ status, reason, resolvedAt: status === 'applied' || status === 'superseded' ? new Date() : null, resolvedBy: opts.resolvedBy ?? null })
        .where(eq(sharedFieldSyncs.id, intentId));
      if (status === 'blocked_permission' || status === 'blocked_hold') await notifyBlocked(tx, { ...intent, status }, siteId, target!.collection, writers);
      return status;
    };
    // Still the target's only unfinished intent (a newer one supersedes the others when it is written),
    // still in the group, and the group's source and epoch unchanged.
    const [newer] = await tx
      .select({ id: sharedFieldSyncs.id })
      .from(sharedFieldSyncs)
      .where(
        and(
          eq(sharedFieldSyncs.targetItemId, intent.targetItemId),
          ne(sharedFieldSyncs.id, intentId),
          inArray(sharedFieldSyncs.status, ['pending', 'blocked_permission', 'blocked_hold']),
        ),
      )
      .limit(1);
    if (
      newer ||
      !held ||
      !target ||
      target.deletedAt ||
      held.group.id !== intent.groupId ||
      held.group.sourceItemId !== intent.sourceItemId ||
      held.group.sourceEpoch !== intent.sourceEpoch
    ) {
      return settle('superseded', 'no longer current');
    }
    const writer = await writers.writer(intent, tx);
    if (!writer) return settle('blocked_permission', 'The person who saved the source cannot edit this item.');
    try {
      await writer.assertMayUpdate(target.collection, intent.targetItemId, intent.fields);
      const differs = changedSharedFields(intent.fields, (target.data ?? {}) as Record<string, unknown>, intent.values).length > 0;
      if (differs) await writer.applySharedSync(target.collection, intent.targetItemId, intent.values, afterCommit);
    } catch (err) {
      if (err instanceof ItemServiceError && (err.code === 'FORBIDDEN' || err.code === 'NOT_FOUND' || err.status === 403)) {
        return settle('blocked_permission', err.message);
      }
      if (err instanceof ItemServiceError && err.code === 'ITEM_HELD') return settle('blocked_hold', err.message);
      throw err;
    }
    return settle('applied', null);
  });
  for (const fn of afterCommit) await fn().catch((err: unknown) => console.warn('[shared-field-sync] after-commit work failed', { intentId, err: String(err) }));
  return outcome;
}

/**
 * Store the notifications of a blocked intent (same transaction as the block; once: `notified_at`):
 * to each active member of the site who could apply it — may update this very item (row rule) and
 * write its shared fields.
 */
async function notifyBlocked(tx: Tx, intent: Intent, siteId: string, collection: string, writers: IntentWriters): Promise<void> {
  if (intent.notifiedAt) return;
  const people = await tx.select({ userId: userSites.userId }).from(userSites).where(eq(userSites.siteId, siteId));
  for (const { userId } of people) {
    const svc = await writers.person(userId, tx);
    if (!svc) continue;
    const may = await svc.assertMayUpdate(collection, intent.targetItemId, intent.fields).then(() => true, () => false);
    if (!may) continue;
    await tx.insert(notifications).values({
      siteId,
      recipient: userId,
      subject: 'Shared fields waiting to sync',
      message: `The source of this item's translation group changed ${intent.fields.join(', ')}; it could not be applied here (${intent.status === 'blocked_hold' ? 'the item is on hold' : 'no permission'}). Apply it from the item's translation group panel.`,
      collection,
      item: intent.targetItemId,
    });
  }
  await tx.update(sharedFieldSyncs).set({ notifiedAt: new Date() }).where(eq(sharedFieldSyncs.id, intent.id));
}

/**
 * The unfinished intents of a source's change, or of a group's (design R1): found from the event's
 * site — the source's membership, the group's sites — then read in each site's scope.
 */
export async function pendingIntents(
  db: Database,
  eventSiteId: string,
  filter: { sourceItemId: string } | { groupId: string },
): Promise<Array<{ id: string; siteId: string }>> {
  return runSiteTransaction(db, eventSiteId, async (tx) => {
    let groupId = 'groupId' in filter ? filter.groupId : null;
    if (!groupId) {
      const [m] = await tx
        .select({ groupId: translationGroupMembers.groupId })
        .from(translationGroupMembers)
        .where(and(eq(translationGroupMembers.siteId, eventSiteId), eq(translationGroupMembers.itemId, (filter as { sourceItemId: string }).sourceItemId)));
      groupId = m?.groupId ?? null;
    }
    if (!groupId) return [];
    const [group] = await tx.select({ siteIds: translationGroups.siteIds }).from(translationGroups).where(eq(translationGroups.id, groupId));
    if (!group) return [];
    const out: Array<{ id: string; siteId: string }> = [];
    for (const siteId of [...new Set([...group.siteIds, eventSiteId])].sort()) {
      out.push(
        ...(await withSiteScope(tx, siteId, () =>
          tx
            .select({ id: sharedFieldSyncs.id, siteId: sharedFieldSyncs.siteId })
            .from(sharedFieldSyncs)
            .where(
              and(
                eq(sharedFieldSyncs.siteId, siteId),
                eq(sharedFieldSyncs.groupId, groupId!),
                eq(sharedFieldSyncs.status, 'pending'),
                'sourceItemId' in filter ? eq(sharedFieldSyncs.sourceItemId, filter.sourceItemId) : undefined,
              ),
            )
            .orderBy(sharedFieldSyncs.createdAt),
        )),
      );
    }
    return out;
  });
}

/** The latest unfinished intent of each target of the group (for the group view and confirmation). */
export async function latestOpenIntent(tx: Tx, siteId: string, targetItemId: string): Promise<Intent | undefined> {
  const [row] = await withSiteScope(tx, siteId, () =>
    tx
      .select()
      .from(sharedFieldSyncs)
      .where(and(eq(sharedFieldSyncs.targetItemId, targetItemId), inArray(sharedFieldSyncs.status, ['pending', 'blocked_permission', 'blocked_hold'])))
      .orderBy(desc(sharedFieldSyncs.createdAt))
      .limit(1),
  );
  return row;
}

/** The trigger of a write: its CDC actor, else the user, else the system. */
export function triggerOf(actor: OutboxActor | undefined, userId: string | null | undefined): SyncTrigger {
  if (actor && actor.type !== 'system') return { type: actor.type as SyncTrigger['type'], id: actor.id ?? null };
  return userId ? { type: 'user', id: userId } : { type: 'system', id: null };
}
