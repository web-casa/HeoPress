import type { ItemService } from '../../services/item-service';

/**
 * Soft-delete an item at the version it has now (HeoPress P14: every delete
 * names a version). For suites whose subject is what a delete causes, not
 * the version check itself — those call `softDelete` with the version they
 * read (item-service-delete-version.db.integration.test.ts).
 */
export async function softDeleteCurrent(svc: ItemService, collection: string, id: string) {
  const { version } = (await svc.detail(collection, id)) as { version: number };
  return svc.softDelete(collection, id, { expectedVersion: version });
}
