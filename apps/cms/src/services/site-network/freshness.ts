import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  collections,
  fields,
  items,
  translationBlockMap,
  translationGroupMembers,
  translationGroups,
  translationSourceBaselines,
  type Database,
} from '@heopress/database';
import { blockFieldsOf, type BlockFieldKind } from '../block-ids';
import { runSiteTransaction, withSiteScope, type SiteTransaction } from '../rls-transaction';
import { lockContentSettingsShared } from './content-routes';
import { lockMembership, withTransactionRetry } from './translation-groups';
import { itemBlocks, movedKeys, type ItemBlock } from './freshness-blocks';
import type { GroupRow } from './translation-groups';

/**
 * Translation freshness (HeoPress P05 tasks 5.1–5.4; spec i18n/translation-freshness; design E,
 * R7, R9, R17): block maps between a group's source and its translations, kept in step with both.
 *
 * - Source side (`refreshSource`): a mapped source block whose hash changed is `stale/changed`; one
 *   that is gone `stale/deleted`; one that may have moved since the field's baseline order
 *   `stale/moved`. Stale stays until a person accepts the translation again; nothing here clears it.
 *   Run by the `translation-freshness` consumer on the source's change events, and by the periodic
 *   check (`reconcileFreshness`), which also catches changes whose event was lost.
 * - Target side (`recordTargetWrite`, in the target's own write): a mapped target block that changed
 *   takes its new hash; when a person changed it, `human_edited` becomes true — and stays: no later
 *   write, by an agent or anyone, clears it. The periodic check treats a target block that differs
 *   from its recorded hash as a person's edit (it cannot know better).
 * - Maps live in the target's site, baselines in the source's; reads cross sites in each site's scope.
 */

type Tx = SiteTransaction;
type MapRow = typeof translationBlockMap.$inferSelect;

/** How strongly a stale reason asks for a person: a later judgement only ever raises it. */
const REASON_RANK: Record<string, number> = { changed: 1, moved: 2, deleted: 3, source_changed: 4, source_removed: 4 };
const reasonRankSql = sql`(CASE ${translationBlockMap.staleReason} WHEN 'changed' THEN 1 WHEN 'moved' THEN 2 WHEN 'deleted' THEN 3 WHEN 'source_changed' THEN 4 WHEN 'source_removed' THEN 4 ELSE 0 END)`;

/** The block fields of a collection (from its field definitions; read in its site's scope). */
async function blockFieldsFor(tx: Tx, collectionId: string): Promise<Map<string, BlockFieldKind>> {
  const rows = await tx.select({ name: fields.name, interface: fields.interface }).from(fields).where(eq(fields.collectionId, collectionId));
  return blockFieldsOf(rows);
}

/** An item's blocks (and status, collection), read in `siteId`'s scope; null when it is gone. */
export async function blocksOfItem(
  tx: Tx,
  siteId: string,
  itemId: string,
): Promise<{ blocks: ItemBlock[]; collectionId: string; collection: string; deleted: boolean; data: Record<string, unknown> } | null> {
  return withSiteScope(tx, siteId, async () => {
    const [row] = await tx
      .select({ data: items.data, collectionId: items.collectionId, collection: collections.name, deletedAt: items.deletedAt })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(eq(items.siteId, siteId), eq(items.id, itemId)));
    if (!row) return null;
    const data = (row.data ?? {}) as Record<string, unknown>;
    return { blocks: itemBlocks(data, await blockFieldsFor(tx, row.collectionId)), collectionId: row.collectionId, collection: row.collection, deleted: row.deletedAt !== null, data };
  });
}

/** Every map row of a group whose source is `sourceItemId`, site by site. */
async function mapsFromSource(tx: Tx, group: Pick<GroupRow, 'id' | 'siteIds'>, sourceItemId: string): Promise<MapRow[]> {
  const out: MapRow[] = [];
  for (const siteId of [...group.siteIds].sort()) {
    out.push(
      ...(await withSiteScope(tx, siteId, () =>
        tx
          .select()
          .from(translationBlockMap)
          .where(and(eq(translationBlockMap.siteId, siteId), eq(translationBlockMap.groupId, group.id), eq(translationBlockMap.sourceItemId, sourceItemId))),
      )),
    );
  }
  return out;
}

async function markStale(tx: Tx, rows: Array<{ row: MapRow; reason: string }>): Promise<void> {
  const bySite = new Map<string, Map<string, string[]>>();
  for (const { row, reason } of rows) {
    const reasons = bySite.get(row.siteId) ?? new Map<string, string[]>();
    reasons.set(reason, [...(reasons.get(reason) ?? []), row.id]);
    bySite.set(row.siteId, reasons);
  }
  for (const [siteId, reasons] of bySite) {
    await withSiteScope(tx, siteId, async () => {
      for (const [reason, ids] of reasons) {
        // Only ever raised, in the statement itself: an older judgement never overwrites a stronger newer one.
        await tx
          .update(translationBlockMap)
          .set({ stale: true, staleReason: reason, updatedAt: new Date() })
          .where(and(inArray(translationBlockMap.id, ids), sql`(NOT ${translationBlockMap.stale} OR ${reasonRankSql} < ${REASON_RANK[reason]!})`));
      }
    });
  }
}

/**
 * Judge the maps of a source item against its current blocks (design E, R7). Returns the number of
 * maps that became stale. `sourceSiteId` is the source's site; the group is found from it.
 */
export async function refreshSource(tx: Tx, sourceSiteId: string, sourceItemId: string): Promise<number> {
  const groupId = await withSiteScope(tx, sourceSiteId, async () => {
    const [m] = await tx
      .select({ groupId: translationGroupMembers.groupId })
      .from(translationGroupMembers)
      .where(and(eq(translationGroupMembers.siteId, sourceSiteId), eq(translationGroupMembers.itemId, sourceItemId)));
    return m?.groupId ?? null;
  });
  if (!groupId) return 0;
  // The group's lock (design §0; the caller holds the source site's settings row first): judgements and
  // lifecycle changes (a new source, a member leaving) do not interleave.
  const [group] = await withSiteScope(tx, sourceSiteId, () => tx.select().from(translationGroups).where(eq(translationGroups.id, groupId)).for('update'));
  if (!group) return 0;
  // A stale map is judged again only to escalate: changed → moved → deleted (review needs the worst).
  const maps = (await mapsFromSource(tx, group, sourceItemId)).filter((m) => !m.stale || (REASON_RANK[m.staleReason ?? ''] ?? 9) < REASON_RANK.deleted!);
  if (maps.length === 0) return 0;
  const source = await blocksOfItem(tx, sourceSiteId, sourceItemId);
  if (!source) return 0;
  const current = new Map(source.blocks.map((b) => [b.key, b]));
  const baselines = await withSiteScope(tx, sourceSiteId, () =>
    tx.select().from(translationSourceBaselines).where(and(eq(translationSourceBaselines.siteId, sourceSiteId), eq(translationSourceBaselines.sourceItemId, sourceItemId))),
  );
  const mappedKeys = new Set(maps.map((m) => m.sourceKey));
  const moved = new Set<string>();
  for (const b of baselines) {
    const now = source.blocks.filter((x) => x.field === b.field).sort((x, y) => x.order - y.order).map((x) => x.key);
    for (const k of movedKeys(b.blockOrder, now, mappedKeys)) moved.add(k);
  }
  const stale: Array<{ row: MapRow; reason: string }> = [];
  for (const row of maps) {
    const now = current.get(row.sourceKey);
    const reason = !now ? 'deleted' : moved.has(row.sourceKey) ? 'moved' : now.hash !== row.sourceHash ? 'changed' : null;
    if (!reason) continue;
    if (row.stale && REASON_RANK[reason]! <= (REASON_RANK[row.staleReason ?? ''] ?? 0)) continue;
    stale.push({ row, reason });
  }
  await markStale(tx, stale);
  return stale.length;
}

/** Record the source's current block order for the fields given (after judging against the old one, R7). */
export async function recordBaselines(tx: Tx, sourceSiteId: string, sourceItemId: string, blocks: ItemBlock[], fieldsToRecord: string[]): Promise<void> {
  await withSiteScope(tx, sourceSiteId, async () => {
    for (const field of [...new Set(fieldsToRecord)]) {
      const order = blocks.filter((b) => b.field === field).sort((a, b) => a.order - b.order).map((b) => b.key);
      await tx
        .insert(translationSourceBaselines)
        .values({ siteId: sourceSiteId, sourceItemId, field, blockOrder: order })
        .onConflictDoUpdate({ target: [translationSourceBaselines.sourceItemId, translationSourceBaselines.field], set: { blockOrder: order, recordedAt: new Date() } });
    }
  });
}

/**
 * A write of an item that is a translation target (its own write transaction; the item's site scope):
 * each mapped block that changed takes its new hash; a person's change marks it `human_edited`.
 */
export async function recordTargetWrite(
  tx: Tx,
  siteId: string,
  itemId: string,
  blockFields: Map<string, BlockFieldKind>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  byPerson: boolean,
): Promise<void> {
  const maps = await tx
    .select()
    .from(translationBlockMap)
    .where(and(eq(translationBlockMap.siteId, siteId), eq(translationBlockMap.targetItemId, itemId)));
  if (maps.length === 0) return;
  const was = new Map(itemBlocks(before, blockFields).map((b) => [b.key, b.hash]));
  const now = new Map(itemBlocks(after, blockFields).map((b) => [b.key, b.hash]));
  for (const m of maps) {
    const next = now.get(m.targetKey) ?? 'gone';
    if (next === (was.get(m.targetKey) ?? 'gone')) continue;
    await tx
      .update(translationBlockMap)
      .set({ targetHash: next, ...(byPerson ? { humanEdited: true } : {}), updatedAt: new Date() })
      .where(eq(translationBlockMap.id, m.id));
  }
}

/** The lifecycle of design R9 on maps. A source that stops being the source: its maps go stale. */
export async function staleMapsOfSource(tx: Tx, group: Pick<GroupRow, 'id' | 'siteIds'>, sourceItemId: string, reason: 'source_changed' | 'source_removed'): Promise<void> {
  const rows = (await mapsFromSource(tx, group, sourceItemId)).filter((m) => !(m.stale && m.staleReason === reason));
  await markStale(tx, rows.map((row) => ({ row, reason })));
}

/** A translation deleted (soft): only the maps that target it go; maps it is the source of stay for review. */
export async function dropTargetMapsOf(tx: Tx, siteId: string, itemId: string): Promise<void> {
  await withSiteScope(tx, siteId, () =>
    tx.delete(translationBlockMap).where(and(eq(translationBlockMap.siteId, siteId), eq(translationBlockMap.targetItemId, itemId))),
  );
}

/** Members leaving: maps that target them go (review records of a target that left mean nothing). */
export async function dropMapsOf(tx: Tx, siteIds: string[], itemIds: string[]): Promise<void> {
  if (itemIds.length === 0) return;
  for (const siteId of [...new Set(siteIds)].sort()) {
    await withSiteScope(tx, siteId, async () => {
      await tx.delete(translationBlockMap).where(and(eq(translationBlockMap.siteId, siteId), inArray(translationBlockMap.targetItemId, itemIds)));
      await tx.delete(translationBlockMap).where(and(eq(translationBlockMap.siteId, siteId), inArray(translationBlockMap.sourceItemId, itemIds)));
      await tx.delete(translationSourceBaselines).where(and(eq(translationSourceBaselines.siteId, siteId), inArray(translationSourceBaselines.sourceItemId, itemIds)));
    });
  }
}

/** The incremental retranslation contract (spec "增量重译保护人工修改"; design E): read only. */
export async function retranslation(tx: Tx, siteId: string, targetItemId: string): Promise<{
  candidates: Array<{ targetKey: string; sourceItemId: string; sourceKey: string }>;
  review: Array<{ targetKey: string; sourceItemId: string; sourceKey: string; reason: string; humanEdited: boolean }>;
}> {
  const maps = await tx
    .select()
    .from(translationBlockMap)
    .where(and(eq(translationBlockMap.siteId, siteId), eq(translationBlockMap.targetItemId, targetItemId), eq(translationBlockMap.stale, true)))
    .orderBy(asc(translationBlockMap.targetKey));
  const candidates = [];
  const review = [];
  for (const m of maps) {
    if (!m.humanEdited && m.staleReason === 'changed') candidates.push({ targetKey: m.targetKey, sourceItemId: m.sourceItemId, sourceKey: m.sourceKey });
    else review.push({ targetKey: m.targetKey, sourceItemId: m.sourceItemId, sourceKey: m.sourceKey, reason: m.staleReason ?? 'changed', humanEdited: m.humanEdited });
  }
  return { candidates, review };
}

/**
 * The periodic check (task 5.4): every source of the site with maps is judged again (events may have
 * been lost); every map of the site whose target block differs from its recorded hash is taken for a
 * person's edit. Never clears a mark. In batches of `batch`, each source and each target in a short
 * transaction of its own (settings row, then the group), walking the whole site every run.
 */
export async function reconcileFreshness(db: Database, siteId: string, opts: { batch?: number } = {}): Promise<{ sources: number; stale: number; humanEdited: number }> {
  const batch = opts.batch ?? 200;
  let sources = 0;
  let stale = 0;
  let human = 0;
  for (let after = ''; ; ) {
    // Sources of this site that have maps (in any site): keyset over the site's source members.
    const page = await runSiteTransaction(db, siteId, (tx) =>
      tx
        .select({ itemId: translationGroupMembers.itemId })
        .from(translationGroupMembers)
        .where(and(eq(translationGroupMembers.siteId, siteId), eq(translationGroupMembers.role, 'source'), gt(translationGroupMembers.itemId, after)))
        .orderBy(asc(translationGroupMembers.itemId))
        .limit(batch),
    );
    for (const m of page) {
      stale += await runSiteTransaction(db, siteId, async (tx) => {
        await lockContentSettingsShared(tx, siteId);
        return refreshSource(tx, siteId, m.itemId);
      });
    }
    sources += page.length;
    if (page.length < batch) break;
    after = page[page.length - 1]!.itemId;
  }
  for (let after = ''; ; ) {
    const targets = await runSiteTransaction(db, siteId, (tx) =>
      tx
        .selectDistinct({ itemId: translationBlockMap.targetItemId })
        .from(translationBlockMap)
        .where(and(eq(translationBlockMap.siteId, siteId), eq(translationBlockMap.humanEdited, false), gt(translationBlockMap.targetItemId, after)))
        .orderBy(asc(translationBlockMap.targetItemId))
        .limit(batch),
    );
    for (const { itemId } of targets) {
      human += await withTransactionRetry(db, () => runSiteTransaction(db, siteId, async (tx) => {
        // Same locks as the target's own writes (settings row, then its group): a write in progress
        // finishes first, and its new hashes are what this compares against.
        await lockContentSettingsShared(tx, siteId);
        await lockMembership(tx, siteId, itemId);
        const rows = await tx
          .select()
          .from(translationBlockMap)
          .where(and(eq(translationBlockMap.siteId, siteId), eq(translationBlockMap.targetItemId, itemId), eq(translationBlockMap.humanEdited, false)));
        const target = await blocksOfItem(tx, siteId, itemId);
        const now = new Map((target?.blocks ?? []).map((b) => [b.key, b.hash]));
        const drifted = rows.filter((r) => (now.get(r.targetKey) ?? 'gone') !== r.targetHash);
        let marked = 0;
        for (const r of drifted) {
          // Only while the map still has the hash compared against (a write recorded since is no drift).
          const res = await tx
            .update(translationBlockMap)
            .set({ humanEdited: true, updatedAt: new Date() })
            .where(and(eq(translationBlockMap.id, r.id), eq(translationBlockMap.targetHash, r.targetHash)))
            .returning({ id: translationBlockMap.id });
          marked += res.length;
        }
        return marked;
      }));
    }
    if (targets.length < batch) break;
    after = targets[targets.length - 1]!.itemId;
  }
  return { sources, stale, humanEdited: human };
}
