import { sql } from 'drizzle-orm';
import { bigint, boolean, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Per-site storage (HeoPress P04, spec platform/storage-profiles).
 *
 * A site binds one storage profile — a bucket and how to reach it — and
 * serves its media from that profile's public base URL. A site without a
 * binding uses the instance default (HEOPRESS_STORAGE / S3_*). Every object
 * lives under `sites/<site id>/media/<key>` whatever the profile, so sites
 * sharing a bucket keep separate namespaces.
 *
 * Profiles belong to one site: only that site's administrators see, use or
 * change them. The secret is stored encrypted under the runtime KEK
 * (`secret_ciphertext`, envelope `{keyId}:{body}`, AAD bound to the profile)
 * and never returned.
 */
export const storageProfiles = pgTable(
  'lumibase_storage_profiles',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `local` (a directory of this instance) | `s3` (any S3-compatible service). */
    driver: text('driver').notNull(),
    bucket: text('bucket'),
    endpoint: text('endpoint'),
    region: text('region'),
    forcePathStyle: boolean('force_path_style'),
    accessKeyId: text('access_key_id'),
    secretCiphertext: text('secret_ciphertext'),
    /** Where the objects are publicly reachable, e.g. `https://img.example.com`. */
    publicBaseUrl: text('public_base_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteNameUnique: uniqueIndex('storage_profiles_site_name_unique').on(t.siteId, t.name),
    // Target of the (site_id, profile id) foreign keys below.
    siteIdUnique: unique('storage_profiles_site_id_unique').on(t.siteId, t.id),
  }),
);

/** The profile a site writes new media to (no row: the instance default). */
export const siteStorage = pgTable(
  'lumibase_site_storage',
  {
    siteId: text('site_id')
      .primaryKey()
      .references(() => sites.id, { onDelete: 'cascade' }),
    storageProfileId: text('storage_profile_id').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // Only a profile of the same site; a bound profile cannot be deleted
    // (NO ACTION: checked at the end of the statement, so deleting the site
    // still cascades through both).
    profileFk: foreignKey({
      columns: [t.siteId, t.storageProfileId],
      foreignColumns: [storageProfiles.siteId, storageProfiles.id],
      name: 'site_storage_profile_fk',
    }),
  }),
);

/**
 * Where each media object was stored. Switching a site's profile only
 * changes where new uploads go; existing objects stay readable from the
 * profile recorded here (null: the instance default), and a profile still
 * holding objects cannot be deleted. `previous_*` keeps the location an
 * explicit migration moved the object from, so the move can be undone.
 */
export const mediaObjects = pgTable(
  'lumibase_media_objects',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** The site's key, as the API names it (`photos/a.jpg`). */
    key: text('key').notNull(),
    storageProfileId: text('storage_profile_id'),
    /** The object's key in its storage; never changes once written. */
    objectKey: text('object_key').notNull(),
    contentType: text('content_type'),
    size: bigint('size', { mode: 'number' }),
    previousStorageProfileId: text('previous_storage_profile_id'),
    previousOnDefault: boolean('previous_on_default').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.key] }),
    // Same site only; a profile still holding objects cannot be deleted.
    profileFk: foreignKey({
      columns: [t.siteId, t.storageProfileId],
      foreignColumns: [storageProfiles.siteId, storageProfiles.id],
      name: 'media_objects_profile_fk',
    }),
    previousProfileFk: foreignKey({
      columns: [t.siteId, t.previousStorageProfileId],
      foreignColumns: [storageProfiles.siteId, storageProfiles.id],
      name: 'media_objects_previous_profile_fk',
    }),
    profileIdx: index('media_objects_profile_idx').on(t.storageProfileId).where(sql`${t.storageProfileId} IS NOT NULL`),
  }),
);
