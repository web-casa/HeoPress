import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { contentVersions } from './cms';
import { sites, users } from './core';

/**
 * Branch preview grants (HeoPress P10 task 4.2; spec agents/content-branches "分支预览"): a one-time link that
 * turns one browser into a viewer of one content branch on the site's **public** host. The link token (256
 * random bits, shown once, only its SHA-256 stored) is exchanged once for a signed, HttpOnly cookie bound to the
 * site, the branch and this grant; every request with the cookie re-checks the grant (expiry, revocation), the
 * branch and the creator's current permission through the CMS's internal preview endpoint.
 */
export const branchPreviewGrants = pgTable(
  'lumibase_branch_preview_grants',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** The branch (a content version); deleting it ends its previews. */
    versionId: text('version_id')
      .notNull()
      .references(() => contentVersions.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    itemId: text('item_id').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when a browser exchanged the link for its cookie: the link works once. */
    exchangedAt: timestamp('exchanged_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tokenHash: uniqueIndex('branch_preview_grants_token_hash_unique').on(t.tokenHash),
    siteVersion: index('branch_preview_grants_site_version_idx').on(t.siteId, t.versionId),
  }),
);
