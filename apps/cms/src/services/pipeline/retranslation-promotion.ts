import { and, eq } from 'drizzle-orm';
import { aiProductions, fields as fieldsTable, items, translationBlockMap, type Database } from '@heopress/database';
import { blockFieldsOf } from '../block-ids';
import { runSiteTransaction } from '../rls-transaction';
import { blocksOfItem } from '../site-network/freshness';
import { itemBlocks } from '../site-network/freshness-blocks';

/** The content version key an incremental retranslation writes (`ContentPipeline.retranslate`). */
const RETRANSLATION_VERSION_PREFIX = 'ai-retranslation-';

/**
 * After a retranslation revision is promoted to the live item (HeoPress P09, completing task 1.4): the block maps of
 * the blocks it wrote become current again — the source hash it translated, the target's new hash, not stale, not a
 * person's edit — but only for a block that is live exactly as the model wrote it and whose source has not changed
 * since. A block a person changed in the revision before promoting stays marked (their edit), as does one whose
 * source moved on (still stale). Returns the number of maps rebuilt.
 */
export async function rebuildRetranslationMaps(db: Database, siteId: string, itemId: string, versionKey: string): Promise<number> {
  if (!versionKey.startsWith(RETRANSLATION_VERSION_PREFIX)) return 0;
  const productionId = versionKey.slice(RETRANSLATION_VERSION_PREFIX.length);
  return runSiteTransaction(db, siteId, async (tx) => {
    const [prod] = await tx.select().from(aiProductions).where(and(eq(aiProductions.siteId, siteId), eq(aiProductions.id, productionId)));
    if (!prod || prod.mode !== 'retranslate' || prod.itemId !== itemId) return 0;
    const [item] = await tx.select({ data: items.data, collectionId: items.collectionId }).from(items).where(and(eq(items.siteId, siteId), eq(items.id, itemId)));
    if (!item) return 0;
    const fr = await tx.select({ name: fieldsTable.name, interface: fieldsTable.interface }).from(fieldsTable).where(eq(fieldsTable.collectionId, item.collectionId));
    const live = new Map(itemBlocks(item.data as Record<string, unknown>, blockFieldsOf(fr)).map((b) => [b.key, b.hash]));
    const src = prod.sources.find((s) => s.kind === 'item');
    const source = src ? await blocksOfItem(tx, String(src.siteId ?? siteId), String(src.id)) : null;
    const srcNow = new Map((source?.blocks ?? []).map((b) => [b.key, b.hash]));
    let rebuilt = 0;
    for (const w of prod.blockMap) {
      const targetKey = String(w.targetKey);
      const hash = live.get(targetKey);
      if (!w.targetHash || hash !== w.targetHash) continue;
      if (srcNow.get(String(w.sourceKey)) !== w.sourceHash) continue;
      const done = await tx
        .update(translationBlockMap)
        .set({ sourceHash: String(w.sourceHash), targetHash: hash, stale: false, staleReason: null, humanEdited: false, updatedAt: new Date() })
        .where(and(eq(translationBlockMap.siteId, siteId), eq(translationBlockMap.targetItemId, itemId), eq(translationBlockMap.targetKey, targetKey)))
        .returning({ id: translationBlockMap.id });
      rebuilt += done.length;
    }
    return rebuilt;
  });
}
