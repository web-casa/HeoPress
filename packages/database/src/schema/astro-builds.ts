import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';
import { deploymentTargets } from './deployments';

/**
 * The Astro engine's per-site state (HeoPress P11 tasks 3.2, 3.3, 3.5; spec rendering/astro-engine).
 *
 * `lumibase_astro_sites`: whether a site is built by the Astro engine, with which theme, what was asked for and what is
 * live. A change event marks the site dirty (`requested_at`, the latest one: the debounce window starts again); the
 * scheduler builds a site once nothing new arrived for the debounce window. Generations only grow: a build takes the
 * next one when it starts, and activation is a compare-and-set on `active_generation`, so an older build that finishes
 * late never replaces a newer deployment.
 *
 * `lumibase_astro_builds`: one row per build: its generation, the revision (render version) its snapshot was pinned
 * at, the theme, the outcome. Ids are nanoids, as the rest of the schema's.
 */
export const astroSites = pgTable('lumibase_astro_sites', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(true).notNull(),
  /** `official:<name>` or `operator:<name>` (v1 accepts nothing else). */
  theme: text('theme').notNull(),
  /** The last change asking for a build; null when nothing is pending. */
  requestedAt: timestamp('requested_at', { withTimezone: true }),
  /** The first change of the pending window (a window never grows past the maximum wait). */
  firstRequestedAt: timestamp('first_requested_at', { withTimezone: true }),
  /** The last generation handed out. */
  generation: integer('generation').default(0).notNull(),
  /** The live build: its generation, revision and theme (null before the first success). */
  activeGeneration: integer('active_generation'),
  activeRevision: bigint('active_revision', { mode: 'number' }),
  activeTheme: text('active_theme'),
  /**
   * The site's deployment target (HeoPress P11 task 4.3): a `lumibase_deployment_targets` row (Cloudflare Pages, Vercel,
   * Netlify) or null for the operator's own server (VPS: the `current` link is the live site).
   */
  deployTargetId: text('deploy_target_id').references(() => deploymentTargets.id, { onDelete: 'set null' }),
  /** What the target confirmed it serves (`deployedRevision`), apart from what was built (`activeRevision`). */
  deployedGeneration: integer('deployed_generation'),
  deployedRevision: bigint('deployed_revision', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const astroBuilds = pgTable(
  'lumibase_astro_builds',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    /** The site's render version the snapshot was pinned at (null until exported). */
    revision: bigint('revision', { mode: 'number' }),
    theme: text('theme').notNull(),
    /** `building` | `succeeded` | `failed` | `superseded` (finished after a newer deployment: not activated). */
    status: text('status').default('building').notNull(),
    /** Why it was built: `event`, `reconcile`, `enable`, `switch`, `rollback`. */
    reason: text('reason').notNull(),
    /** A failure's short, secret-free reason. */
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    /** A build still `building` past this is stuck (its process died with the worker): reconciliation fails it. */
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
  },
  (t) => ({
    siteGeneration: uniqueIndex('astro_builds_site_generation_unique').on(t.siteId, t.generation),
    status: index('astro_builds_status_idx').on(t.status, t.deadlineAt),
  }),
);

/**
 * `lumibase_static_deploys` (HeoPress P11 tasks 4.3–4.5, 5.1; spec publishing/frontend-deployments): one row per deployment
 * of a site's static output to its target — a deploy after a build, an operator's redeploy, or a rollback — with the
 * generation and revision it carried, its state, the provider's deployment id, a short secret-free log, the static
 * response contract's warnings and the post-deploy reachability check. The worker finds requested rows across sites
 * (as `lumibase_astro_builds`), so the table is not under row-level security; every API read filters by site.
 *
 * `status`: `requested` → `uploading` → `succeeded` | `failed` | `refused` (the output scan or the rollback check said no);
 * `uploading` past its lease is a deployment whose confirmation was lost: the provider is asked (by `marker`) before any
 * retry.
 */
export const staticDeploys = pgTable(
  'lumibase_static_deploys',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** Null: the operator's own server. */
    targetId: text('target_id').references(() => deploymentTargets.id, { onDelete: 'set null' }),
    /** `vps` | `cloudflare-pages` | `vercel` | `netlify`. */
    provider: text('provider').notNull(),
    /** `deploy` | `rollback`. */
    kind: text('kind').notNull(),
    generation: integer('generation').notNull(),
    revision: bigint('revision', { mode: 'number' }),
    status: text('status').default('requested').notNull(),
    /** Written into the provider's deployment (message / title / meta) so a lost confirmation can be looked up. */
    marker: text('marker').notNull(),
    providerDeploymentId: text('provider_deployment_id'),
    url: text('url'),
    error: text('error'),
    log: text('log'),
    warnings: jsonb('warnings').$type<string[]>(),
    reachability: jsonb('reachability').$type<Record<string, unknown>>(),
    /** A rollback: the deploy it put back. */
    rollbackOf: text('rollback_of'),
    requestedBy: text('requested_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    siteCreated: index('static_deploys_site_created_idx').on(t.siteId, t.createdAt),
    status: index('static_deploys_status_idx').on(t.status),
  }),
);
