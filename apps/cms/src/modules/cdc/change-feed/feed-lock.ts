import { sql } from 'drizzle-orm';
import type { Database } from '@heopress/database';

/**
 * Serialise what moves a site's change-feed floor against what rewinds
 * a consumer (Codex review P04-3 #2): pruning and a replay of the same site
 * take this transaction-scoped lock, so a replay never rewinds behind events
 * a concurrent prune is deleting, and a prune never deletes what a replay
 * just asked for again. Forward moves (ack, delivery) do not need it: they
 * only make a prune keep less.
 */
export async function lockSiteFeed(tx: Pick<Database, 'execute'>, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cdc-feed:${siteId}`}))`);
}
