import type { Database } from '@heopress/database';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { runSiteTransaction } from '../rls-transaction';
import { lockContentSettingsShared } from './content-routes';
import { refreshSource } from './freshness';

/**
 * The `translation-freshness` consumer (HeoPress P05 task 5.2; design E): on an item's change or
 * deletion, if it is a translation group's source with block maps, judge the maps against its blocks
 * now. Idempotent (marks only rise); a lost event is caught by the periodic check.
 */
export function translationFreshnessConsumer(deps: { db: Database }): EventConsumerDefinition {
  return {
    name: 'translation-freshness',
    accepts: (e) => e.resource === 'item',
    handle: async (event) => {
      await runSiteTransaction(deps.db, event.siteId, async (tx) => {
        // Lock order (design §0): the source site's settings row, then (in refreshSource) the group.
        await lockContentSettingsShared(tx, event.siteId);
        await refreshSource(tx, event.siteId, event.itemId);
      });
    },
  };
}
