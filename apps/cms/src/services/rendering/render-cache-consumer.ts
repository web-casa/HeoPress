import { renderCache, staleRenderCacheRows, type Database } from '@heopress/database';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { runSiteTransaction } from '../rls-transaction';

/**
 * The `render-cache-invalidation` consumer (HeoPress P06 task 3.2; design §4, R8): on a change event that
 * can alter a site's public pages — items, routes, redirects, content settings, translation groups,
 * themes — delete that site's rendered pages that can no longer be served (`staleRenderCacheRows`: made
 * under older render versions; since P13 task 3.2 an article's page only when its own item or the site's
 * structure changed).
 *
 * Correctness does not depend on it: the versions are raised in the same transaction as the change and
 * every cached answer is checked against them when read, so the renderer never answers from an older
 * entry even when this consumer stops (spec "消费者停摆"). What it does is free the superseded rows
 * promptly (the renderer's sweep catches the rest).
 */
const RESOURCES = new Set(['item', 'content_route', 'redirect', 'site_content_settings', 'translation_group', 'theme', 'collection', 'field']);

export function renderCacheInvalidationConsumer(deps: { db: Database }): EventConsumerDefinition {
  return {
    name: 'render-cache-invalidation',
    accepts: (e) => RESOURCES.has(e.resource),
    handle: async (event) => {
      // In the site's scope: its render version is readable under the optional row-level security.
      await runSiteTransaction(deps.db, event.siteId, (tx) => tx.delete(renderCache).where(staleRenderCacheRows(event.siteId)));
    },
  };
}
