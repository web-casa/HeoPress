import { bigint, boolean, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';
import { ingestSources } from './ingest';

/**
 * External crawl services (HeoPress P08 tasks 3.1–3.6; spec ingest/crawling "外部采集服务插件",
 * "采集服务预算与熔断").
 *
 * `ingest_provider_settings`: one row per site and service — whether the site uses it, its place in the site's
 * default fallback chain, the administrator's confirmation that target URLs may be sent to that service, the
 * site's credential (sealed with the runtime KEK, the AAD naming the site and the service, so a ciphertext copied
 * to another site does not open), the monthly budget ceiling and the circuit breaker's state.
 *
 * `ingest_provider_usage`: requests, failures and estimated cost per site, service and month (`YYYY-MM`, UTC);
 * `exhausted_at` marks the month the ceiling was reached (the service is off for the site until the month ends or
 * the ceiling is raised).
 *
 * `ingest_source_fetch_chains`: a source's own fallback order (absent: the site's default — native first, then
 * the enabled services in their order).
 *
 * All site-isolated (row-level security, `migrations/rls-policies.sql`).
 */
export const ingestProviderSettings = pgTable(
  'lumibase_ingest_provider_settings',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `tinyfish` | `firecrawl` | `crawl4ai` | `cloudflare`. */
    provider: text('provider').notNull(),
    enabled: boolean('enabled').default(false).notNull(),
    /** Place in the site's default chain (after native), ascending. */
    position: integer('position').default(0).notNull(),
    /** When an administrator confirmed that target URLs may be sent to this service (null: not confirmed). */
    consentAt: timestamp('consent_at', { withTimezone: true }),
    consentBy: text('consent_by'),
    /** Sealed credential (`{keyId}:{body}`); never returned by the API. */
    credentialCiphertext: text('credential_ciphertext'),
    credentialKeyId: text('credential_key_id'),
    /** Last four characters, for recognising which key is set. */
    credentialHint: text('credential_hint'),
    /** Service options that are not secret: `{ endpoint?, accountId? }`. */
    options: jsonb('options').$type<{ endpoint?: string; accountId?: string }>().default({}).notNull(),
    /** Monthly ceiling of the estimated cost in micro-USD (null: no ceiling). */
    monthlyBudgetMicros: bigint('monthly_budget_micros', { mode: 'number' }),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    /** Circuit breaker: not used before this time. */
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteProviderUnique: uniqueIndex('ingest_provider_settings_site_provider_unique').on(t.siteId, t.provider),
  }),
);

export const ingestProviderUsage = pgTable(
  'lumibase_ingest_provider_usage',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    /** `YYYY-MM` (UTC). */
    month: text('month').notNull(),
    requests: integer('requests').default(0).notNull(),
    failures: integer('failures').default(0).notNull(),
    costMicros: bigint('cost_micros', { mode: 'number' }).default(0).notNull(),
    exhaustedAt: timestamp('exhausted_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.provider, t.month] }),
  }),
);

export const ingestSourceFetchChains = pgTable(
  'lumibase_ingest_source_fetch_chains',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull(),
    /** `native` and service names, in the order they are tried. */
    chain: text('chain').array().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.sourceId] }),
    sourceFk: foreignKey({
      columns: [t.siteId, t.sourceId],
      foreignColumns: [ingestSources.siteId, ingestSources.id],
      name: 'ingest_source_fetch_chains_source_fk',
    }).onDelete('cascade'),
  }),
);
