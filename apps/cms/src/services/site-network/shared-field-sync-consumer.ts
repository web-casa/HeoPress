import type { Database } from '@heopress/database';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import type { ItemServiceDeps } from '../item-service';
import { itemServiceForTrigger } from '../item-service-factory';
import { applyIntent, pendingIntents, type SyncTrigger } from './shared-fields';

/**
 * The `shared-field-sync` consumer (HeoPress P05 task 4.6; design D, R4, R14, R23): on a source
 * item's change event, or a translation group's (a new source, a new member), it applies the
 * pending intents as whoever triggered them, with their permissions at that moment. An intent is
 * applied once whatever the redelivery (its status changes in the same transaction as the write);
 * a blocked one stores its notifications in that transaction. Other failures are retried by the
 * framework.
 */
export function sharedFieldSyncConsumer(deps: { db: Database; itemDeps?: Omit<ItemServiceDeps, 'permissionCtx' | 'siteId' | 'db'> }): EventConsumerDefinition {
  const itemDeps = { rootDb: deps.db, ...(deps.itemDeps ?? {}) };
  return {
    name: 'shared-field-sync',
    accepts: (e) => (e.resource === 'item' && e.operation !== 'delete') || e.resource === 'translation_group',
    handle: async (event) => {
      const intents = await pendingIntents(deps.db, event.siteId, event.resource === 'item' ? { sourceItemId: event.itemId } : { groupId: event.itemId });
      for (const intent of intents) {
        // The trigger's permissions are resolved inside the intent's transaction: as they are now.
        await applyIntent(deps.db, intent.id, intent.siteId, {
          writer: (row, tx) => itemServiceForTrigger(itemDeps, { type: row.triggerType as SyncTrigger['type'], id: row.triggerId }, intent.siteId, tx as never),
          person: (userId, tx) => itemServiceForTrigger(itemDeps, { type: 'user', id: userId }, intent.siteId, tx as never),
        });
      }
    },
  };
}
