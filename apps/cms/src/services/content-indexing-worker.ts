// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import {
  searchIndexName,
  defaultIndexSettings,
  type SearchProvider,
} from '@heopress/runtime';
import type { KeyProvider } from '@heopress/runtime';
import type { Database } from '@heopress/database';
import { buildSearchDocument } from './search-document';
import { ItemServiceError } from './item-service-error';
import { itemServiceForSystem } from './item-service-factory';
import type { EventConsumerDefinition } from '../modules/events/consumer-runner';

/**
 * Search indexing (HeoPress P04: driven by change events through the event
 * consumption framework, see `searchSyncConsumer` below; the old
 * `content-indexing` queue jobs are gone).
 *
 * Tenant isolation: the physical index name is always `{siteId}__{collection}`
 * (see `searchIndexName`), built from the `siteId` carried in the payload.
 */

export interface SearchIndexJob {
  siteId: string;
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

export interface SearchRemoveJob {
  siteId: string;
  collection: string;
  id: string;
}

/**
 * Tracks index names this process has already configured, so settings
 * (stop words, typo tolerance, …) are applied once per index rather than on
 * every document. `configureIndex` is idempotent, so a missed entry only costs
 * a redundant settings call.
 */
function makeConfiguredSet(): Set<string> {
  return new Set<string>();
}

async function ensureConfigured(
  search: SearchProvider,
  indexName: string,
  configured: Set<string>,
): Promise<void> {
  if (configured.has(indexName)) return;
  await search.configureIndex(indexName, defaultIndexSettings());
  configured.add(indexName);
}

/**
 * Process one `search:index` job: configure the tenant index (once) and upsert
 * the enriched document.
 */
export async function processSearchIndexJob(
  search: SearchProvider,
  payload: SearchIndexJob,
  configured: Set<string>,
): Promise<void> {
  const indexName = searchIndexName(payload.siteId, payload.collection);
  await ensureConfigured(search, indexName, configured);
  await search.index(indexName, [
    buildSearchDocument(payload.collection, payload.id, payload.data),
  ]);
}

/**
 * Process one `search:remove` job: drop the document from the tenant index.
 */
export async function processSearchRemoveJob(
  search: SearchProvider,
  payload: SearchRemoveJob,
): Promise<void> {
  const indexName = searchIndexName(payload.siteId, payload.collection);
  await search.delete(indexName, [payload.id]);
}

/**
 * Search sync as an event consumer (HeoPress P04 task 8.3, spec
 * platform/event-consumption): every item change event — create, edit,
 * publish, hold, delete, scheduled publish — brings the item's search
 * document up to date. The handler reads the item as it is **now**, so an
 * event that arrives late or twice never puts an older version back
 * (task 9.2); a deleted item is removed from the index.
 */
export function searchSyncConsumer(deps: {
  db: Database;
  search: SearchProvider;
  keyProvider?: KeyProvider;
}): EventConsumerDefinition {
  const configured = makeConfiguredSet();
  return {
    name: SEARCH_SYNC_CONSUMER,
    // Every retained event the first time it runs: writes made before the
    // worker first ticked are indexed too (Codex review P04-2 #14). Content
    // from before P04 has no events — `heopress reindex` covers it.
    startFrom: 'start',
    accepts: (event) => event.resource === 'item',
    async handle(event) {
      await syncSearchItem(deps, { siteId: event.siteId, collection: event.collection, itemId: event.itemId }, configured);
    },
  };
}

const SEARCH_SYNC_CONSUMER = 'search-index';

/**
 * Bring one item's search document up to date with the item as it is now (removed when it is gone or unreadable).
 * The consumer's handler, and the state reconciliation's repair for items whose events never reached it (P11 task 1.2).
 */
export async function syncSearchItem(
  deps: { db: Database; search: SearchProvider; keyProvider?: KeyProvider },
  ref: { siteId: string; collection: string; itemId: string },
  configured: Set<string> = makeConfiguredSet(),
): Promise<void> {
  const items = itemServiceForSystem({ db: deps.db, siteId: ref.siteId, keyProvider: deps.keyProvider }, 'background-worker');
  let data: Record<string, unknown> | null = null;
  try {
    const item = (await items.detail(ref.collection, ref.itemId)) as { data?: Record<string, unknown> };
    data = item.data ?? {};
  } catch (err) {
    // Gone, or no longer readable (crypto-shredded): out of the index.
    if (!(err instanceof ItemServiceError && (err.code === 'NOT_FOUND' || err.code === 'DECRYPTION_FAILED'))) throw err;
  }
  if (data) {
    await processSearchIndexJob(deps.search, { siteId: ref.siteId, collection: ref.collection, id: ref.itemId, data }, configured);
  } else {
    await processSearchRemoveJob(deps.search, { siteId: ref.siteId, collection: ref.collection, id: ref.itemId });
  }
}
