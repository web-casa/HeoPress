/**
 * Source for GraphQL item-event subscriptions.
 *
 * Upstream bridged the per-site Cloudflare SiteRoom Durable Object here. That
 * runtime was removed in HeoPress P02 and the Node realtime hub is not bridged
 * yet, so a subscription completes without events (as it already did on
 * Docker). GraphQL is off by default (P02 task 5.1).
 */

export interface ItemEvent {
  collection: string;
  action: 'create' | 'update' | 'delete';
  itemId: string;
  item: unknown;
}

// eslint-disable-next-line require-yield
export async function* createSiteEventSource(
  _siteId: string,
  _userId: string | null,
  _collection: string,
): AsyncGenerator<ItemEvent> {
  return;
}
