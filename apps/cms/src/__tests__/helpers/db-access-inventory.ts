/**
 * Every way the CMS opens a database connection or starts background work, and where its row-level scope comes from
 * (HeoPress P14 task 1.6, design D1.5). `db-access-inventory.wiring.test.ts` scans the source for the constructs below
 * and fails on one that is not registered here, and on an entry that no longer exists.
 *
 * A scope source is a claim about how that entry sets `app.site_id` (or the platform scope):
 *
 * - `request-site`        — a request's own site, through `withDb`/`withTenant` (the scoped handle).
 * - `request-platform`    — an instance-level request, through the platform scope (`/api/v1/instance/*`, health, setup).
 * - `task-site`           — a queue job, consumer or cron pass takes the site from its payload and scopes the work.
 * - `per-site-iteration`  — a cross-site pass lists sites from `lumibase_sites` and runs each site's work in its scope.
 * - `agent-access`        — an Agent/MCP path scoped to the site the caller may act for.
 * - `platform-reader`     — reads only exception tables (no `site_id`) or the platform scope.
 * - `owner-maintenance`   — runs as the owner (migrations, backup, upgrade); row-level security does not bind it.
 *
 * The dynamic proof is the database suites running as the application role without `HEOPRESS_ENV=development`; this
 * inventory is the map those tests are read against.
 */

export const SCOPE_SOURCES = [
  'request-site',
  'request-platform',
  'task-site',
  'per-site-iteration',
  'agent-access',
  'platform-reader',
  'owner-maintenance',
] as const;

type ScopeSource = (typeof SCOPE_SOURCES)[number];

export interface DbAccessEntry {
  /** Stable id the wiring test derives from the source: `<kind>:<key>`. */
  id: string;
  kind: 'connection' | 'cron' | 'worker' | 'route' | 'cli';
  scope: ScopeSource;
  /** Why this entry is safe (or what it would take to make it scoped). */
  note: string;
}

/**
 * Source constructs the wiring test does not treat as a database entry: a regex that recognises connection strings,
 * not a connection.
 */
export const DB_ACCESS_EXEMPTIONS: Record<string, string> = {
  'connection:apps/cms/src/services/deployment/static/scan.ts': 'a connection-string pattern for the secret scanner, not a connection',
};

const entry = (id: string, kind: DbAccessEntry['kind'], scope: ScopeSource, note: string): DbAccessEntry => ({ id, kind, scope, note });

/** Connections (`createDb(`, `postgres(`, `getConnection()`). */
const connections: DbAccessEntry[] = [
  entry('connection:apps/cms/src/middleware/admin-path-guard.ts', 'connection', 'request-site', 'reads the request site’s admin path through the runtime pool in that site’s scope'),
  entry('connection:apps/cms/src/middleware/db.ts', 'connection', 'request-site', 'the request’s scoped handle (`withDb({ scope })`)'),
  entry('connection:apps/cms/src/routes/health.ts', 'connection', 'platform-reader', 'migration/queue status, no site rows'),
  entry('connection:apps/cms/src/serve.ts', 'connection', 'task-site', 'the worker process pool; every task scopes its own work'),
  entry('connection:apps/cms/src/services/astro/astro-worker.ts', 'connection', 'per-site-iteration', 'the render role pool, one site per build'),
  entry('connection:apps/cms/src/services/backup/database-backup.ts', 'connection', 'owner-maintenance', 'pg_dump as the owner'),
  entry('connection:apps/cms/src/services/backup/drill.ts', 'connection', 'owner-maintenance', 'restore drill on a maintenance connection'),
  entry('connection:apps/cms/src/services/backup/ledger-replay.ts', 'connection', 'owner-maintenance', 'ledger replay as the owner'),
  entry('connection:apps/cms/src/services/backup/lock.ts', 'connection', 'owner-maintenance', 'advisory backup lock as the owner'),
  entry('connection:apps/cms/src/services/upgrade/adapters/backup-module.ts', 'connection', 'owner-maintenance', 'upgrade backup as the owner'),
  entry('connection:apps/cms/src/services/upgrade/migrations.ts', 'connection', 'owner-maintenance', 'upgrade migrations as the owner'),
];

/** `cron.schedule(…, scheduledJob('<name>', …))` passes. */
const crons: DbAccessEntry[] = ([
  ['audit-rotation', 'owner-maintenance', 'rotates the audit table partitions'],
  ['pageview-flush', 'per-site-iteration', 'flushes pageview rollups per site'],
  ['plugin-jobs', 'per-site-iteration', 'dispatches one plugin job per site'],
  ['veto-sweep', 'per-site-iteration', 'commits due veto commits per site'],
  ['approval-claim-sweep', 'per-site-iteration', 'expires approval claims per site'],
  ['agent-run-stale-sweep', 'per-site-iteration', 'fails stale agent runs per site'],
  ['llm-ledger-recovery', 'per-site-iteration', 'recovers the model ledger per site'],
  ['content-scheduler', 'per-site-iteration', 'publishes due items per site'],
  ['stale-content-sweep', 'per-site-iteration', 'marks and clears stale items per site'],
  ['review-reminders', 'per-site-iteration', 'reminds the people who can resolve due marks, per site'],
  ['projection-rebuilds', 'per-site-iteration', 'rebuilds due projections per site'],
  ['indexnow', 'per-site-iteration', 'notifies search engines per site'],
  ['indexnow-reconcile', 'per-site-iteration', 'reconciles IndexNow state per site'],
  ['git-snapshots', 'per-site-iteration', 'commits due site snapshots per site'],
  ['git-snapshots-reconcile', 'per-site-iteration', 'reconciles site snapshot state per site'],
  ['backup-full', 'owner-maintenance', 'full backup as the owner'],
  ['backup-incremental', 'owner-maintenance', 'incremental backup as the owner'],
  ['backup-drill', 'owner-maintenance', 'restore drill as the owner'],
  ['backup-requests', 'owner-maintenance', 'serves backup requests as the owner'],
  ['site-exports', 'per-site-iteration', 'builds due site exports per site'],
  ['state-reconcile', 'per-site-iteration', 'reconciles per-site state'],
  ['link-scan', 'per-site-iteration', 'scans a site’s links'],
  ['link-scan-schedule', 'per-site-iteration', 'schedules link scans per site'],
  ['site-audit', 'per-site-iteration', 'runs a site’s audit'],
  ['site-audit-schedule', 'per-site-iteration', 'schedules site audits'],
  ['ingest-maintenance', 'per-site-iteration', 'maintains ingest per site'],
  ['ingest-snapshot-sweep', 'per-site-iteration', 'sweeps ingest snapshots per site'],
  ['ingest-licence-lapse', 'per-site-iteration', 'checks source licences per site'],
  ['ingest-schedule', 'per-site-iteration', 'schedules due sources per site'],
  ['ingest-processing-dispatch', 'per-site-iteration', 'hands pending outbox rows to each site\'s processing flows'],
  ['reachability-check', 'per-site-iteration', 'checks site reachability per site'],
  ['crawl-hits-purge', 'per-site-iteration', 'purges crawl hits per site'],
  ['audit-triage-purge', 'per-site-iteration', 'purges audit triage per site'],
  ['system-events-purge', 'per-site-iteration', 'purges system events per site'],
  ['data-retention', 'per-site-iteration', 'applies each site’s retention'],
  ['theme-recheck', 'per-site-iteration', 'rechecks themes per site'],
  ['preset-upgrade', 'per-site-iteration', 'upgrades presets per site'],
  ['retention-sweep', 'per-site-iteration', 'sweeps retention per site'],
  ['goal-dispatch', 'per-site-iteration', 'dispatches goals per site'],
  ['notification-deliveries', 'per-site-iteration', 'delivers notifications per site'],
  ['deployment-poll', 'per-site-iteration', 'polls deployments per site'],
  ['flow-schedule', 'per-site-iteration', 'schedules flows per site'],
] as const).map(([name, scope, note]) => entry(`cron:${name}`, 'cron', scope as ScopeSource, note));

/** Worker registrations in `serve.ts`; each consumer takes the site from its job. */
const workers: DbAccessEntry[] = ([
  ['registerAgentRunWorker', 'task-site', 'agent runs take the site from the job'],
  ['registerRevalidationWorker', 'task-site', 'revalidation takes the site from the job'],
  ['registerAuditLogWorker', 'task-site', 'audit writes take the site from the entry'],
  ['registerPluginJobWorker', 'task-site', 'plugin jobs take the site from the job'],
  ['registerEventConsumers', 'task-site', 'each consumer is bound to its site'],
  ['registerFlowEventWorker', 'task-site', 'flow events take the site from the job'],
  ['registerFlowRunsWorker', 'task-site', 'flow runs take the site from the job'],
  ['registerVetoCommitWorker', 'task-site', 'veto commits take the site from the job'],
  ['registerSchedulerWorker', 'task-site', 'scheduled publications take the site from the job'],
  ['registerBackupsPruner', 'owner-maintenance', 'prunes backup artefacts as the owner'],
  ['registerIngestWorker', 'task-site', 'ingest jobs take the site from the job'],
  ['registerStatusPoller', 'task-site', 'deployment status takes the site from the job'],
  ['registerEnvelopeMigrationWorker', 'task-site', 'envelope migrations take the site from the job'],
  ['registerMaterializeRefreshWorker', 'task-site', 'materialize refreshes take the site from the job'],
] as const).map(([name, scope, note]) => entry(`worker:${name}`, 'worker', scope as ScopeSource, note));

/** `app.route('<path>', <router>)` mounts in `index.ts`. */
const routes: DbAccessEntry[] = ([
  ['/api/v1/utils', 'utilsRouter', 'request-site'],
  ['/api/v1/system', 'systemRouter', 'request-platform'],
  ['/metrics', 'metricsRouter', 'platform-reader'],
  ['/health', 'healthRouter', 'platform-reader'],
  ['/internal/tls', 'internalTlsRouter', 'request-platform'],
  ['/internal/preview', 'internalPreviewRouter', 'request-site'],
  ['/test-auth', 'testAuthRouter', 'request-site'],
  ['/api/v1/setup', 'setupRouter', 'request-platform'],
  ['/api/v1', 'api', 'request-site'],
  ['/api/v1/admin/security', 'recoveryRouter', 'request-site'],
  ['/_ext', 'pluginEndpointsRouter', 'request-site'],
  ['/api/v1/deployments/webhook', 'deploymentsWebhookRouter', 'request-site'],
  ['/api/v1/integrations/git', 'gitPublicRouter', 'request-site'],
  ['/api/v1/instance/sites', 'sitesRouter', 'request-platform'],
  ['/', 'oauthPublicRouter', 'request-platform'],
  ['/api/v1/agents/mcp', 'agentsMcpRouter', 'agent-access'],
  ['/api/v1/shares', 'sharePublicRouter', 'request-site'],
  ['/api/v1/email', 'emailPublicRouter', 'request-site'],
  ['/api/v1/deliver', 'deliverRouter', 'request-site'],
  ['/api/v1/pageviews', 'pageviewsPublicRouter', 'request-site'],
] as const).map(([path, router, scope]) => entry(`route:${path}:${router}`, 'route', scope as ScopeSource, `${router} on ${path}`));

/** `apps/cms/scripts/*-cli.ts`: the maintenance ones run as the owner, the content ones take `--site` or iterate. */
const clis: DbAccessEntry[] = ([
  ['access-cli', 'request-site', 'per-site access maintenance'],
  ['backup-cli', 'owner-maintenance', 'backup/restore as the owner'],
  ['config-cli', 'request-platform', 'instance configuration'],
  ['import-cli', 'per-site-iteration', 'requires --site or iterates sites'],
  ['migrations-cli', 'owner-maintenance', 'migrations as the owner'],
  ['preset-cli', 'per-site-iteration', 'requires --site or iterates sites'],
  ['projection-cli', 'per-site-iteration', 'requires --site or iterates sites'],
  ['upgrade-cli', 'owner-maintenance', 'upgrade as the owner'],
  ['vectors-cli', 'per-site-iteration', 'requires --site or iterates sites'],
] as const).map(([name, scope, note]) => entry(`cli:apps/cms/scripts/${name}.ts`, 'cli', scope as ScopeSource, note));

export const DB_ACCESS_ENTRIES: DbAccessEntry[] = [...connections, ...crons, ...workers, ...routes, ...clis];

/** Registered ids (what the wiring test expects to find), without the exemptions. */
export const REGISTERED_DB_ACCESS_IDS = new Set(DB_ACCESS_ENTRIES.map((e) => e.id));
