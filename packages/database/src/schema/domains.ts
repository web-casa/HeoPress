// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Custom domains & free `*.heopress.example` subdomains (Enterprise feature).
 *
 * Each site can be reached through one or more hostnames:
 *   - `subdomain` — a free `<slug>.heopress.example` address, served immediately
 *     via the wildcard Worker route (no certificate provisioning needed).
 *   - `custom` — the operator's own domain (e.g. `cms.acme.com`), provisioned
 *     through Cloudflare for SaaS Custom Hostnames. The operator points a CNAME
 *     at the SaaS fallback origin and adds a TXT (DCV) record; Cloudflare issues
 *     and renews the TLS certificate automatically.
 *
 * The legacy `sites.domain` column is kept for backward-compat, but this table
 * is the source of truth for hostname → site resolution. The tenant middleware
 * resolves a request host via the KV map `site-host:<fqdn>` which is written
 * once a row reaches `status = 'active'`.
 *
 * All access is `siteId`-scoped (RLS + application filter), same as every other
 * domain table. ID convention: `nanoid()` (domain table).
 */

const id = () => text('id').$defaultFn(() => nanoid()).primaryKey();
const createdAt = () => timestamp('created_at').defaultNow().notNull();
const updatedAt = () => timestamp('updated_at').defaultNow().notNull();

export const siteDomains = pgTable(
  'lumibase_site_domains',
  {
    id: id(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Fully-qualified hostname, lowercased (e.g. `cms.acme.com`). Unique among active domains. */
    hostname: text('hostname').notNull(),
    /** `subdomain` (free `*.heopress.example`) | `custom` (operator-owned). */
    kind: text('kind').notNull(),
    /** Exactly one primary hostname per site is used as the canonical URL. */
    isPrimary: boolean('is_primary').default(false).notNull(),
    /**
     * Lifecycle (HeoPress P04, spec sites/domain-routing):
     *   `pending`  — claimed; serves nothing until verified.
     *   `active`   — verified; serves the site, and only active domains get
     *                certificates (the TLS ask endpoint).
     *   `disabled` — switched off by the site; serves nothing.
     *   `failed`   — kept for rows from before P04.
     * Free subdomains are active at once.
     */
    status: text('status').default('pending').notNull(),
    /** `dns_txt` (TXT `_heopress-challenge.<hostname>`) or `http_file` (`/.well-known/heopress-verification.txt`). */
    verificationMethod: text('verification_method').default('dns_txt').notNull(),
    /** The claim's own token: another site's claim has a different one. */
    verificationToken: text('verification_token'),
    verificationExpiresAt: timestamp('verification_expires_at', { withTimezone: true }),
    /**
     * A language entry (P05 configures the routing): an active domain that
     * enters the site in this locale. It keeps its own host — never 301'd to
     * the primary domain.
     */
    entryLocale: text('entry_locale'),
    /** Human-readable reason when `status = 'failed'` (or last CF error). */
    statusReason: text('status_reason'),
    /** Cloudflare for SaaS Custom Hostname id; null for free subdomains. */
    cfHostnameId: text('cf_hostname_id'),
    /** Mirror of Cloudflare `ssl.status` (`initializing` | `pending_validation` | `active` | …). */
    sslStatus: text('ssl_status'),
    /**
     * DNS records the operator must create, surfaced in the UI:
     * `{ records: [{ type: 'CNAME' | 'TXT', name, value, purpose }] }`.
     */
    verification: jsonb('verification').default({}).notNull(),
    /** When the hostname first reached `active`. */
    verifiedAt: timestamp('verified_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => ({
    /**
     * One site per domain — among active domains. Several sites may claim a
     * hostname while pending (nobody can block a domain by claiming it
     * first); whoever verifies it owns it.
     */
    activeHostnameUnique: uniqueIndex('site_domains_active_hostname_unique')
      .on(t.hostname)
      .where(sql`${t.status} = 'active'`),
    siteHostnameUnique: uniqueIndex('site_domains_site_hostname_unique').on(t.siteId, t.hostname),
    /** One language entry domain per language and site (tags compare case-insensitively), among domains not switched off (HeoPress P05). */
    siteEntryLocaleUnique: uniqueIndex('site_domains_site_entry_locale_unique')
      .on(t.siteId, sql`lower(${t.entryLocale})`)
      .where(sql`${t.entryLocale} IS NOT NULL AND ${t.status} <> 'disabled'`),
    siteIdx: index('site_domains_site_idx').on(t.siteId),
  }),
);
