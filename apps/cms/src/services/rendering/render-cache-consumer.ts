import { and, eq, lt, sql } from 'drizzle-orm';
import { renderCache, siteRenderVersions, type Database } from '@heopress/database';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { runSiteTransaction } from '../rls-transaction';

/**
 * The `render-cache-invalidation` consumer (HeoPress P06 task 3.2; design §4, R8): on a change event that
 * can alter a site's public pages — items, routes, redirects, content settings, translation groups,
 * themes — delete that site's rendered pages of an older render version.
 *
 * Correctness does not depend on it: the version is raised in the same transaction as the change and is
 * part of every cache key, so the renderer never answers from an older version's entry even when this
 * consumer stops (spec "消费者停摆"). What it does is free the superseded rows promptly (the renderer's
 * sweep catches the rest).
 */
const RESOURCES = new Set(['item', 'content_route', 'redirect', 'site_content_settings', 'translation_group', 'theme', 'collection', 'field']);

export function renderCacheInvalidationConsumer(deps: { db: Database }): EventConsumerDefinition {
  return {
    name: 'render-cache-invalidation',
    accepts: (e) => RESOURCES.has(e.resource),
    handle: async (event) => {
      // In the site's scope: its render version is readable under the optional row-level security.
      await runSiteTransaction(deps.db, event.siteId, (tx) =>
        tx
        .delete(renderCache)
        .where(
          and(
            eq(renderCache.siteId, event.siteId),
            lt(renderCache.siteVersion, sql`coalesce((SELECT ${siteRenderVersions.version} FROM ${siteRenderVersions} WHERE ${siteRenderVersions.siteId} = ${event.siteId}), 0)`),
          ),
        ),
      );
    },
  };
}
