import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites, users } from './core';

/**
 * Preview links (HeoPress P06 tasks 4.2, 4.3; design R7, R17, R29, R43): a signed, time-limited link to
 * one draft item or one theme version of one site. The token is 256 random bits shown once; only its
 * SHA-256 is stored. Every use checks the site, the expiry, the revocation and the creator's **current**
 * permission (through the CMS's internal preview endpoint — the rendering role cannot read this table,
 * nor drafts).
 */
export const previewLinks = pgTable(
  'lumibase_preview_links',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `item` (a draft item, `collection` + `targetId`) or `theme` (a theme version, `targetId`). */
    kind: text('kind', { enum: ['item', 'theme'] }).notNull(),
    collection: text('collection'),
    targetId: text('target_id').notNull(),
    createdBy: text('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    tokenHash: uniqueIndex('preview_links_token_hash_unique').on(t.tokenHash),
    siteExpiry: index('preview_links_site_expiry_idx').on(t.siteId, t.expiresAt),
  }),
);
