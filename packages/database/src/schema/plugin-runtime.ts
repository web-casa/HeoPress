import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Plugin runtime (HeoPress P12 tasks 3.1–3.7; spec extensions/runtime-extensions). All rows are keyed by the site and
 * the plugin's name, never by the extension row: uninstalling and installing a plugin again finds its state and data.
 *
 * - `lumibase_plugin_jobs`: one row per (site, plugin, job) — the lease that keeps a job a singleton, the schedule,
 *   retries and the saved progress of a run continued in batches. The scheduler reads it across sites (ids, times and
 *   the plugin's progress cursor only), so it is not under row-level security.
 * - `lumibase_plugin_job_runs`: the history of runs (outcome, duration, outbound requests, error).
 * - `lumibase_plugin_storage`: the plugin's private documents, per site, plugin and declared namespace. Not content:
 *   no versions, no publishing, never in public output; disabling the plugin keeps them.
 * - `lumibase_plugin_endpoint_keys`: the sealed secret a plugin's server callbacks are signed with, per site.
 * - `lumibase_plugin_endpoint_nonces`: callback nonces already seen, until their timestamp window has passed.
 */
export const pluginJobs = pgTable(
  'lumibase_plugin_jobs',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    extensionName: text('extension_name').notNull(),
    jobName: text('job_name').notNull(),
    /** Held while a run is in progress (with `lease_until`): at most one run per site, plugin and job. */
    leaseToken: text('lease_token'),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    /** When the job is due next (schedule, retry or continuation). */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    /** Failed runs in a row since the last success (retries counted against the cap). */
    attempts: integer('attempts').default(0).notNull(),
    /** Progress saved by a run continued in batches (`ctx.checkpoint`); null when the job is not mid-way. */
    progress: jsonb('progress'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    /** `succeeded` | `continued` | `failed` | `timeout` | `limit` | `stopped`. */
    lastStatus: text('last_status'),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.extensionName, t.jobName] }),
    due: index('plugin_jobs_due_idx').on(t.nextRunAt),
  }),
);

export const pluginJobRuns = pgTable(
  'lumibase_plugin_job_runs',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    extensionName: text('extension_name').notNull(),
    jobName: text('job_name').notNull(),
    /** `schedule` | `retry` | `continuation` | `queue` | `manual`. */
    trigger: text('trigger').notNull(),
    /** `running` | `succeeded` | `continued` | `failed` | `timeout` | `limit` | `stopped`. */
    status: text('status').notNull(),
    attempt: integer('attempt').default(1).notNull(),
    requests: integer('requests').default(0).notNull(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    job: index('plugin_job_runs_job_idx').on(t.siteId, t.extensionName, t.jobName, t.startedAt),
  }),
);

export const pluginStorage = pgTable(
  'lumibase_plugin_storage',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    extensionName: text('extension_name').notNull(),
    namespace: text('namespace').notNull(),
    docId: text('doc_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.extensionName, t.namespace, t.docId] }),
    // Queries filter on declared index fields (`data->>'<field>' = …`): jsonb containment answers them.
    data: index('plugin_storage_data_idx').using('gin', t.data),
    recent: index('plugin_storage_recent_idx').on(t.siteId, t.extensionName, t.namespace, t.updatedAt),
  }),
);

export const pluginEndpointKeys = pgTable(
  'lumibase_plugin_endpoint_keys',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    extensionName: text('extension_name').notNull(),
    /** Versioned envelope sealed under the runtime KEK, AAD `plugin-callback|<site>|<plugin>`. */
    secretCiphertext: text('secret_ciphertext').notNull(),
    keyId: text('key_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.extensionName] }),
  }),
);

export const pluginEndpointNonces = pgTable(
  'lumibase_plugin_endpoint_nonces',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    extensionName: text('extension_name').notNull(),
    nonce: text('nonce').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.siteId, t.extensionName, t.nonce] }),
    expires: index('plugin_endpoint_nonces_expires_idx').on(t.expiresAt),
  }),
);
