// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
// Node-only entry: `@heopress/runtime/node` carries `createRuntime` (which
// branches between adapters) and the PostgreSQL scheduled-job helper, and
// `@heopress/runtime/docker` the Docker adapters. Neither is exported from the
// package root, because doing so put them in the Cloudflare Worker bundle and
// broke Worker startup — see the note atop `packages/runtime/src/index.ts`.
import { createRuntime, scheduledJob, trustedEndpointsFromEnv, type ScheduledJobOptions } from '@heopress/runtime/node';
import type postgres from 'postgres';
import { getSharedRealtimeHub } from '@heopress/runtime/docker';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { Sql } from 'postgres';
import { capabilityRequirementsFromEnv, schema, type MigrationStatusQuery } from '@heopress/database';
import cron, { type ScheduledTask } from 'node-cron';
import { loadSecretFiles, validateProductionConfig } from './config/production';
import { assertSupportedPostgres, runStartupPreflight, type PreflightQuery } from './config/preflight';
import { isFeatureEnabled } from './config/features';
import { assertNoRemovedServices } from './config/removed-services';
import { runScheduledRotation } from './modules/audit/scheduled';
import { runScheduledRefreshTokenPrune } from './services/auth/refresh-token';
import { bootstrapNodeObservability } from './observability/node';
import { formatSafeError } from '@heopress/contracts/utils';
import { createPressureLimiter } from './pressure-limiter';
import { databaseReadinessProbe, startWorkerHealthServer } from './worker-health';
import { setRuntimeFactory } from './middleware/runtime';
import { mountStudio } from './serve-studio';
import { runSetupTokenStartup } from './modules/setup/startup';
import type { Bindings } from './env';

type ProcessRole = 'web' | 'worker' | 'all';

function parseProcessRole(): ProcessRole {
  const raw = (process.env.HEOPRESS_PROCESS_ROLE || 'all').toLowerCase();
  if (raw === 'web' || raw === 'worker' || raw === 'all') {
    return raw;
  }
  console.warn(
    `[heopress-cms] Invalid HEOPRESS_PROCESS_ROLE="${raw}" — expected web|worker|all; defaulting to "all"`,
  );
  return 'all';
}

async function main() {
  runStartupPreflight();
  loadSecretFiles();
  validateProductionConfig();

  // Bootstrap Node observability before importing the Hono app so optional
  // OpenTelemetry auto-instrumentations can patch supported modules early.
  const observability = await bootstrapNodeObservability(process.env);
  const { default: app } = await import('./index');

  const role = parseProcessRole();
  const runHttp = role === 'web' || role === 'all';
  const runWorkers = role === 'worker' || role === 'all';

  const port = parseInt(process.env.PORT || '1989', 10);
  const workerHealthPort = parseInt(
    process.env.HEOPRESS_WORKER_HEALTH_PORT || String(port === 1989 ? 1988 : port + 1),
    10,
  );
  // Refuse to start with settings of removed services (Redis, imgproxy).
  assertNoRemovedServices(process.env as Record<string, string | undefined>);
  const runtime = createRuntime(process.env as unknown as Record<string, unknown>);
  // Refuse to run against an unsupported PostgreSQL before serving or starting workers.
  await assertSupportedPostgres(runtime.database.getConnection() as unknown as PreflightQuery);
  // Parse HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS now so a misconfigured entry
  // (e.g. a metadata address) is reported at startup, not on first use.
  trustedEndpointsFromEnv();
  // Scheduled jobs: each slot runs on exactly one worker (P03 task 3.2).
  const jobOpts: ScheduledJobOptions = { sql: runtime.database.getConnection() as postgres.Sql };
  const pressureLimiter = createPressureLimiter(process.env as Record<string, string | undefined>);

  let server: ReturnType<typeof serve> | undefined;
  let workerHealthServer: HttpServer | undefined;

  // Hand the runtime we just built to `withRuntime` (registered inside
  // `./index`) instead of injecting it with a second middleware. The old
  // approach layered an override *after* `withRuntime` had already constructed
  // its own Docker runtime, so every process ended up with two — two Redis
  // connections, two pg pools — and discarded one on the first request.
  setRuntimeFactory(() => runtime);


  if (runHttp) {
    // ── Setup token (admin-setup-wizard Req 2.6; #470) ─────────────────────
    //
    // With HEOPRESS_REQUIRE_SETUP_TOKEN on, `/setup/complete` demands a token,
    // and this is the only place one is minted and printed. It must finish
    // before `serve()` so no setup request can reach a process that has not
    // issued its token yet. Only HTTP processes run it: they serve `/setup`,
    // and a worker-only process printing the token would put it in logs the
    // operator is not reading. A DB failure here fails the start on purpose —
    // see `runSetupTokenStartup`.
    //
    // `getConnection()` is typed `unknown` so the runtime package does not
    // depend on postgres-js; both adapters return a postgres-js `Sql`.
    await runSetupTokenStartup({
      db: drizzle(runtime.database.getConnection() as Sql, { schema }),
      env: process.env,
    });

    // Serve the Studio SPA from this process when its bundle is present. Node
    // only: Workers has no filesystem, so on Cloudflare the Studio stays a
    // separate Pages deployment. `serve-studio` is imported nowhere else, which
    // is what keeps `@hono/node-server/serve-static` out of the Workers bundle
    // — the same containment `node-cron` relies on.
    //
    // Mounted after every route in `index.ts` (already registered at import)
    // so the API answers for itself; the module's reserved-prefix list is what
    // stops the SPA catch-all from turning API 404s into HTML.
    const studio = mountStudio(app, process.env as Record<string, string | undefined>);
    if (studio.mounted) {
      console.log(`[heopress-cms] Serving Studio from ${studio.root}`);
    } else if (studio.reason === 'disabled') {
      console.log('[heopress-cms] Studio disabled via HEOPRESS_SERVE_STUDIO — running API-only');
    } else if (studio.reason === 'configured-but-missing') {
      // Loud: someone asked for the Studio and named a path that has no
      // index.html. Silently running API-only here is how a broken deployment
      // looks healthy.
      console.warn(
        `[heopress-cms] HEOPRESS_STUDIO_DIST=${studio.root} has no index.html — running API-only`,
      );
    } else {
      console.log('[heopress-cms] Studio bundle not present — running API-only');
    }

    server = serve({
      fetch: (request, nodeBindings) => {
        const pressureResponse = pressureLimiter.handle(request);
        if (pressureResponse) return pressureResponse;

        return app.fetch(
          request,
          { ...process.env, ...nodeBindings } as unknown as Bindings,
        );
      },
      port,
    });
    console.log(`[heopress-cms] Started in ${runtime.runtime} mode on port ${port} (role=${role})`);
  } else {
    console.log(`[heopress-cms] HTTP API disabled (role=${role})`);
    workerHealthServer = startWorkerHealthServer(
      workerHealthPort,
      databaseReadinessProbe(
        runtime.database.getConnection() as unknown as MigrationStatusQuery,
        undefined,
        capabilityRequirementsFromEnv(process.env),
      ),
    );
  }

  // ── Realtime WebSocket server (realtime-audience-channels) ──────────────────
  // On Node/Docker there is no Durable Object, so attach a `ws` server to the
  // HTTP server. It shares the in-process hub with the runtime's realtime
  // provider, so `runtime.realtime.publish()` reaches live WS sessions here.
  const jwtSecret = process.env.JWT_SECRET;
  if (runHttp && jwtSecret) {
    const { attachNodeRealtime } = await import('./realtime/node-hub');
    const maxPerSubject = parseInt(process.env.HEOPRESS_REALTIME_MAX_CONNECTIONS_PER_SUBJECT || '0', 10);
    attachNodeRealtime({
      server: server as unknown as HttpServer,
      hub: getSharedRealtimeHub(),
      jwtSecret,
      maxConnectionsPerSubject: Number.isFinite(maxPerSubject) ? maxPerSubject : 0,
    });
    console.log('[heopress-cms] Realtime WebSocket server attached at /api/v1/realtime');
  } else if (runHttp) {
    console.warn('[heopress-cms] JWT_SECRET unset — realtime WebSocket server disabled');
  }

  // Cron tasks stopped on SIGTERM (optional when role=web).
  let rotationTask: ScheduledTask | undefined;
  let pageviewFlushTask: ScheduledTask | undefined;
  let vetoSweepTask: ScheduledTask | undefined;
  let claimSweepTask: ScheduledTask | undefined;
  let staleRunSweepTask: ScheduledTask | undefined;
  let llmRecoveryTask: ScheduledTask | undefined;
  let schedulerTask: ScheduledTask | undefined;
  let retentionTask: ScheduledTask | undefined;
  let projectionTask: ScheduledTask | undefined;
  let themeRecheckTask: ScheduledTask | undefined;
  let indexNowTask: ScheduledTask | undefined;
  let indexNowReconcileTask: ScheduledTask | undefined;
  let linkScanTask: ScheduledTask | undefined;
  let linkScanScheduleTask: ScheduledTask | undefined;
  let auditTask: ScheduledTask | undefined;
  let crawlPurgeTask: ScheduledTask | undefined;
  let auditTriagePurgeTask: ScheduledTask | undefined;
  let systemEventsPurgeTask: ScheduledTask | undefined;
  let auditScheduleTask: ScheduledTask | undefined;
  let ingestScheduleTask: ScheduledTask | undefined;
  let reachabilityTask: ScheduledTask | undefined;
  let presetUpgradeTask: ScheduledTask | undefined;
  let deploymentPollTask: ScheduledTask | undefined;
  let flowScheduleTask: ScheduledTask | undefined;
  let goalDispatchTask: ScheduledTask | undefined;
  let loadGuardTimer: ReturnType<typeof setInterval> | undefined;

  if (runWorkers) {
  // ── Audit-log retention rotation (admin-setup-wizard task 11.4; Req 15.5;
  //    design §10.2) ─────────────────────────────────────────────────────────
  //
  // The `audit_log` and `login_attempts` tables grow monotonically on the hot
  // path; task 11.3's AuditRotator prunes rows past HEOPRESS_AUDIT_RETENTION_DAYS.
  // This is the SELF-HOSTED NODE half of "actually fire it on a schedule":
  // because this process is long-lived, we drive the prune with `node-cron` on
  // the design's `0 * * * *` cadence (top of every hour).
  //
  // node-cron v4: `schedule()` still auto-starts; `stop()` remains the graceful
  // shutdown hook (see SIGTERM below). Six-field expressions (seconds) stay
  // valid — used by the deployment poll tick. v4 removed
  // `recoverMissedExecutions`: ticks missed while the process was down are
  // not replayed (audit rotation / pageview flush catch up on the next cron).
  //
  // The rotator needs a Drizzle client. We mirror `middleware/db.ts`'s runtime
  // path: `runtime.database.getConnection()` returns the postgres-js `Sql`
  // instance (cast required — the provider types it as `unknown` to avoid
  // coupling to postgres-js), which we wrap with the shared `schema`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rotatorDb = drizzle(runtime.database.getConnection() as any, { schema });
  // One system event per scheduled run (HeoPress P07a task 11.1): succeeded, failed with its reason, incomplete, skipped.
  {
    const { scheduledJobReporter } = await import('./services/ops/system-events');
    jobOpts.report = scheduledJobReporter(rotatorDb);
  }

  // Hourly cron. `runScheduledRotation` is best-effort and never throws, so the
  // callback is safe to fire-and-forget; the returned promise only logs the
  // pruned-row count. We deliberately rely on the hourly cron alone (no boot-time
  // prune) to keep startup side-effect-free — the count-trigger path in the
  // audit-context middleware already handles a backlog that accumulates between
  // ticks.
  rotationTask = cron.schedule(
    '0 * * * *',
    scheduledJob(
      'audit-rotation',
      async () => {
        await runScheduledRotation(rotatorDb);
        void runScheduledRefreshTokenPrune(rotatorDb);
      },
      jobOpts,
    ),
  );

  // Pageview flush — every 5 minutes, roll up raw events and drain hot counters
  // into the daily rollup. Best-effort; never throws (see the module doc).
  const { runScheduledPageviewFlush } = await import('./modules/pageviews/scheduled');
  pageviewFlushTask = cron.schedule(
    '*/5 * * * *',
    scheduledJob(
      'pageview-flush',
      async () => {
        await runScheduledPageviewFlush(rotatorDb, runtime);
      },
      jobOpts,
    ),
  );

  if (runHttp) {
  // ── Load-aware autonomy (content-os task 9; Req 9.4/9.5) ─────────────────
  //
  // Feed event-loop pressure samples into the agent load guard: overload
  // pauses reconciler-origin runs at the tool-call boundary (human work is
  // never auto-paused) and a hold-down of continuous calm auto-resumes them.
  const { getLoadGuard } = await import('./services/load-guard-service');
  const loadGuard = getLoadGuard();
    loadGuardTimer = setInterval(() => {
      const sample = pressureLimiter.getSample();
      loadGuard.signal({ overloaded: sample.overloaded, reason: sample.reason });
    }, 5_000);
    loadGuardTimer.unref();
  }

  // ── Async agent runs (content-os task 3; Req 3.2) ────────────────────────
  //
  // Long-lived Node process consumes the `agent-runs` queue so goals created
  // with `execution: 'async'` run outside the request runtime limit. The
  // worker reuses the same Drizzle client as the audit rotator and executes
  // through the harness codepath (capabilities, risk, budget, audit).
  // Cloudflare Workers wire the same handler via their queue consumer export.
  const { registerAgentRunWorker } = await import('./services/agent-run-worker');
  registerAgentRunWorker({
    db: rotatorDb,
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
    // Same KeyProvider the request path uses, so deployment skills work
    // identically whether a run is executed sync or off the queue.
    keys: runtime.keys,
    env: process.env as Record<string, string | undefined>,
  });

  // ── ISR revalidation dispatch (high-load-cache-readiness task 9.4) ────────
  const { registerRevalidationWorker } = await import('./services/content-invalidation');
  registerRevalidationWorker({ db: rotatorDb, queue: runtime.queue });

  // ── Async audit-log batch writer (high-load-cache-readiness task 12.1) ───
  const { registerAuditLogWorker } = await import('./modules/audit/worker');
  registerAuditLogWorker({ db: rotatorDb, queue: runtime.queue });

  // ── Change Feed dispatch (cdc-extension-integration Req 4.7) ────────────
  //
  // Consumes the `cdc-dispatch` queue (latency path) and runs the 30s sweep
  // (correctness backstop) that delivers outbox events to webhook/extension
  // subscriptions. Without it, push subscriptions never receive events —
  // pull consumers are unaffected.
  const {
    createCdcDispatchPass,
    CdcDispatcher,
    createWebhookEnvelopeSender,
    DrizzleDeliveryLog,
    DrizzleSubscriptionDispatchStore,
  } = await import('./modules/cdc/change-feed/dispatcher');
  const { DrizzleCdcEventStore } = await import('./modules/cdc/change-feed/feed-reader');
  const { ExtensionEnvelopeSender, SandboxCdcSubscriberLoader } = await import(
    './modules/cdc/change-feed/extension-sender'
  );
  const cdcSubscriptionStore = new DrizzleSubscriptionDispatchStore(rotatorDb);
  const { DrizzleRetentionStore, pruneChangeFeed, readRetentionDays } = await import(
    './modules/cdc/change-feed/retention'
  );
  // ── Event consumers (HeoPress P04, ADR-0011) ──────────────────────────────
  //
  // Search sync is a consumer of the change events; push subscriptions are
  // dispatched in the same loop. Writes wake it through the `cdc-dispatch`
  // queue; a 1 s tick is the backstop.
  const { registerEventConsumers } = await import('./modules/events/consumer-worker');
  const { searchSyncConsumer } = await import('./services/content-indexing-worker');
  const { sharedFieldSyncConsumer } = await import('./services/site-network/shared-field-sync-consumer');
  const { translationFreshnessConsumer } = await import('./services/site-network/freshness-consumer');
  const { renderCacheInvalidationConsumer } = await import('./services/rendering/render-cache-consumer');
  const { indexNowConsumer } = await import('./services/site-network/indexnow');
  const { linkGraphConsumer } = await import('./services/site-network/link-graph');
  const consumers = [
    ...(runtime.search ? [searchSyncConsumer({ db: rotatorDb, search: runtime.search, keyProvider: runtime.keys })] : []),
    // Translation groups' shared fields (HeoPress P05 task 4.6).
    sharedFieldSyncConsumer({
      db: rotatorDb,
      itemDeps: { cache: runtime.cache, queue: runtime.queue, realtime: runtime.realtime, keyProvider: runtime.keys, encryptionKey: process.env.ENCRYPTION_KEY },
    }),
    // Translation freshness: block maps judged on the source's changes (HeoPress P05 task 5.2).
    translationFreshnessConsumer({ db: rotatorDb }),
    // Rendered pages of superseded render versions (HeoPress P06 task 3.2).
    renderCacheInvalidationConsumer({ db: rotatorDb }),
    // IndexNow (HeoPress P07 task 3.4): a change queues its site; the pass below tells the search engines.
    indexNowConsumer({ db: rotatorDb }),
    // The internal link graph (HeoPress P07 task 5.3): a changed item's links; a URL policy change asks for a full scan.
    linkGraphConsumer({ db: rotatorDb }),
  ];
  const dispatchPass = createCdcDispatchPass({
    subscriptions: cdcSubscriptionStore,
    listAllSiteIds: async () => (await rotatorDb.select({ id: schema.sites.id }).from(schema.sites)).map((r) => r.id),
    prune: async (siteId) => {
      await pruneChangeFeed(
        {
          store: new DrizzleRetentionStore(rotatorDb),
          retentionDays: await readRetentionDays(rotatorDb, siteId),
        },
        siteId,
      );
    },
    buildDispatcher: () =>
      new CdcDispatcher({
        eventStore: new DrizzleCdcEventStore(rotatorDb),
        subscriptions: cdcSubscriptionStore,
        deliveryLog: new DrizzleDeliveryLog(rotatorDb),
        senders: {
          webhook: createWebhookEnvelopeSender(rotatorDb),
          extension: new ExtensionEnvelopeSender({
            loader: new SandboxCdcSubscriberLoader(
              rotatorDb,
              process.env as Record<string, unknown>,
            ),
          }),
        },
        cache: runtime.cache,
      }),
  });
  registerEventConsumers({ db: rotatorDb, queue: runtime.queue, consumers: () => consumers, alsoOnTick: dispatchPass });

  // ── Flow event trigger (visual-flow-builder Req 1) ───────────────────────
  //
  // Consumes the `flow-events` queue: ItemService enqueues one job per
  // matching active event-flow on create/update/delete; this worker executes
  // the flow and records the run. Without it, event flows never fire.
  const { registerFlowEventWorker } = await import('./services/flow-dispatch');
  registerFlowEventWorker({
    db: rotatorDb,
    queue: runtime.queue,
    keys: runtime.keys,
  });

  // ── Manual flow runs + AI chat async (high-load task 17) ────────────────
  const { registerFlowRunsWorker } = await import('./services/flow-run-service');
  registerFlowRunsWorker({
    cache: runtime.cache,
    db: rotatorDb,
    queue: runtime.queue,
    keys: runtime.keys,
    env: process.env as Record<string, string | undefined>,
  });

  // ── Veto-window commits (content-os task 14; Req 13.3/13.5) ─────────────
  //
  // Primary path: delayed queue jobs fire at each staging's autoCommitAt.
  // Safety net: a 5-minute sweep commits anything the queue missed (lost
  // jobs, queue-less runtimes). Both converge on VetoService.commit, which
  // re-checks status and deadline — no premature or double commits.
  const { registerVetoCommitWorker, sweepDueVetoCommits } = await import(
    './services/veto-commit-worker'
  );
  const vetoWorkerDeps = {
    db: rotatorDb,
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
  };
  registerVetoCommitWorker(vetoWorkerDeps);
  vetoSweepTask = cron.schedule(
    '*/5 * * * *',
    scheduledJob(
      'veto-sweep',
      async () => {
        await sweepDueVetoCommits(vetoWorkerDeps).catch((err) => {
          console.error('[veto-sweep] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );

  // ── Abandoned approval claims (#453) ────────────────────────────────────
  //
  // Deciding an approval claims the row (`pending → deciding`) so exactly one
  // decision executes it. Every in-process failure path settles that claim;
  // what none of them can cover is the process dying mid-execution, which
  // leaves the row `deciding` — stuck, and invisible to Mission Control's
  // `status === 'pending'` inbox. This sweep moves claims older than the
  // staleness window to `failed`, so recovery goes through the same explicit
  // reopen gate an in-process failure does. Guarded conditional updates, so it
  // can never interrupt a live execution.
  const { sweepStaleApprovalClaims } = await import('./services/approval-claim-sweeper');
  claimSweepTask = cron.schedule(
    '*/5 * * * *',
    scheduledJob(
      'approval-claim-sweep',
      async () => {
        await sweepStaleApprovalClaims({ db: rotatorDb })
          .then((released) => {
            for (const claim of released) {
              console.warn(
                '[approval-claim-sweep] quarantined abandoned claim',
                JSON.stringify({
                  approvalId: claim.approvalId,
                  siteId: claim.siteId,
                  heldForMs: claim.heldForMs,
                }),
              );
            }
          })
          .catch((err) => {
            console.error('[approval-claim-sweep] failed', formatSafeError(err));
            throw err;
          });
      },
      jobOpts,
    ),
  );

  // ── Abandoned agent run sweep (#481 R3.1) ──────────────────────────────────
  //
  // A worker that dies mid-run leaves `agent_runs` on `running`. The queue claim
  // deliberately refuses to take such a run over — age cannot prove the first
  // attempt had no side effect, and taking it over wrote the same item twice in a
  // measured probe — so without this sweep the row would stay `running` forever:
  // read as in-flight by the dispatcher, absent from the approvals inbox.
  //
  // Quarantining moves it to `failed` with `stopReason: 'stale_unverified'`, which
  // is a state an operator can act on. Guarded conditional updates, so a run that
  // finishes normally in the meantime is never overwritten.
  const { sweepStaleRuns } = await import('./services/agent-run-service');
  staleRunSweepTask = cron.schedule(
    '*/5 * * * *',
    scheduledJob(
      'agent-run-stale-sweep',
      async () => {
        await sweepStaleRuns({ db: rotatorDb })
          .then((swept) => {
            for (const run of swept) {
              console.warn(
                '[agent-run-stale-sweep] quarantined abandoned run',
                JSON.stringify({ runId: run.runId, siteId: run.siteId, goalId: run.goalId }),
              );
            }
          })
          .catch((err) => {
            console.error('[agent-run-stale-sweep] failed', formatSafeError(err));
            throw err;
          });
      },
      jobOpts,
    ),
  );

  // ── Model ledger recovery (HeoPress P04 task 7.4) ──
  //
  // Attempts whose executor vanished become unknown liabilities (never
  // released without evidence); open calls nobody drives end. Per site, under
  // its row-level security scope and ledger lock.
  const { runScheduledLlmRecovery } = await import('./services/llm/recovery');
  llmRecoveryTask = cron.schedule(
    '* * * * *',
    scheduledJob('llm-ledger-recovery', () => runScheduledLlmRecovery(rotatorDb), jobOpts),
  );

  // ── Content scheduler (regulated-content-readiness task 7; Req 7.3/7.4) ──
  //
  // A 1-minute tick applies due publish/unpublish transitions. Each flip is a
  // guarded conditional update so catch-up runs after downtime never
  // double-fire side-effects (Req 7.6).
  const { registerSchedulerWorker, runSchedulerTick, sweepRetention } = await import(
    './services/scheduler-worker'
  );
  const schedulerDeps = { db: rotatorDb, queue: runtime.queue };
  registerSchedulerWorker(schedulerDeps);
  schedulerTask = cron.schedule(
    '* * * * *',
    scheduledJob(
      'content-scheduler',
      async () => {
        await runSchedulerTick(schedulerDeps).catch((err) => {
          console.error('[content-scheduler] tick failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // Public projection rebuilds (HeoPress P06, design R26): sites marked by writes that did not flush the
  // projection are rebuilt promptly — until then the rendering service shows them in maintenance.
  const { processProjectionRebuilds } = await import('./services/site-network/public-projection');
  projectionTask = cron.schedule(
    '*/5 * * * * *',
    scheduledJob(
      'projection-rebuilds',
      async () => {
        await processProjectionRebuilds(rotatorDb).catch((err) => {
          console.error('[projection-rebuilds] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // IndexNow (HeoPress P07 tasks 3.4, 3.6): the due sites' passes every five seconds (a change waits out its 10-second
  // window first); every site with IndexNow on queued every fifteen minutes (changes whose events were lost).
  const { processIndexNowQueue, scheduleIndexNowReconciliation } = await import('./services/site-network/indexnow');
  indexNowTask = cron.schedule(
    '*/5 * * * * *',
    scheduledJob(
      'indexnow',
      async () => {
        await processIndexNowQueue(rotatorDb).catch((err) => {
          console.error('[indexnow] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  indexNowReconcileTask = cron.schedule(
    '20 */15 * * * *',
    scheduledJob(
      'indexnow-reconcile',
      async () => {
        await scheduleIndexNowReconciliation(rotatorDb).catch((err) => {
          console.error('[indexnow-reconcile] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // The link graph's full scans (HeoPress P07 task 5.3): the running ones go on every thirty seconds (a batch per
  // transaction, the cursor saved with it); every hour, sites never scanned or not for a day are asked for one.
  const { processLinkScans, scheduleLinkScans } = await import('./services/site-network/link-graph');
  const { reportSiteRuns } = await import('./services/ops/site-runs');
  linkScanTask = cron.schedule(
    '*/30 * * * * *',
    scheduledJob(
      'link-scan',
      async () => {
        // Each site's final state is a site run event; the slot's result follows from them (P07a task 11.1).
        const runs = await processLinkScans(rotatorDb).catch((err) => {
          console.error('[link-scan] failed', formatSafeError(err));
          throw err;
        });
        return reportSiteRuns(rotatorDb, 'link-scan', runs);
      },
      jobOpts,
    ),
  );
  linkScanScheduleTask = cron.schedule(
    '40 7 * * * *',
    scheduledJob(
      'link-scan-schedule',
      async () => {
        await scheduleLinkScans(rotatorDb).catch((err) => {
          console.error('[link-scan-schedule] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // The site audit (HeoPress P07 task 5.1): requested runs every minute (one site at a time); every hour, sites never
  // audited or not for a day are asked for one.
  const { processSiteAudits, scheduleSiteAudits } = await import('./services/site-network/site-audit');
  auditTask = cron.schedule(
    '15 * * * * *',
    scheduledJob(
      'site-audit',
      async () => {
        // Each site's final state is a site run event; the slot's result follows from them (P07a task 11.1).
        const runs = await processSiteAudits(rotatorDb).catch((err) => {
          console.error('[site-audit] failed', formatSafeError(err));
          throw err;
        });
        return reportSiteRuns(rotatorDb, 'site-audit', runs);
      },
      jobOpts,
    ),
  );
  auditScheduleTask = cron.schedule(
    '50 23 * * * *',
    scheduledJob(
      'site-audit-schedule',
      async () => {
        await scheduleSiteAudits(rotatorDb).catch((err) => {
          console.error('[site-audit-schedule] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // Content sources (HeoPress P08 task 1.4): every minute, each due source gets one run job (singleton per source); the
  // jobs run on the durable queue.
  const { registerIngestWorker, scheduleDueSources } = await import('./services/ingest/source-worker');
  const ingestDeps = { db: rotatorDb, queue: runtime.queue };
  registerIngestWorker(ingestDeps);
  ingestScheduleTask = cron.schedule(
    '10 * * * * *',
    scheduledJob(
      'ingest-schedule',
      async () => {
        await scheduleDueSources(ingestDeps).catch((err: unknown) => {
          console.error('[ingest-schedule] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // The online reachability check (HeoPress P07 task 3.9): checks an administrator asked for, every thirty seconds (one
  // site at a time; each request to the site's verified domains goes through the SSRF boundary).
  const { processReachabilityChecks } = await import('./services/site-network/reachability');
  reachabilityTask = cron.schedule(
    '5,35 * * * * *',
    scheduledJob(
      'reachability-check',
      async () => {
        // Each site's final state is a site run event; the slot's result follows from them (P07a task 11.1).
        const runs = await processReachabilityChecks(rotatorDb).catch((err) => {
          console.error('[reachability-check] failed', formatSafeError(err));
          throw err;
        });
        return reportSiteRuns(rotatorDb, 'reachability-check', runs);
      },
      jobOpts,
    ),
  );
  // AI traffic details (HeoPress P07 task 6.4): those older than 7 days removed every hour; the day totals stay; recent
  // rows reconciled. A failure is logged and fails the slot (Codex review of batch 11, round 4).
  const { purgeCrawlHits } = await import('./services/site-network/ai-traffic');
  crawlPurgeTask = cron.schedule(
    '25 41 * * * *',
    scheduledJob(
      'crawl-hits-purge',
      async () => {
        await purgeCrawlHits(rotatorDb).catch((err: unknown) => {
          console.error('[crawl-hits-purge] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // Audit triage (HeoPress P07a task 10.3): resolved issues kept 90 days, ignores past their time dropped; daily.
  const { purgeAuditTriage } = await import('./services/site-network/site-audit');
  auditTriagePurgeTask = cron.schedule(
    '35 17 3 * * *',
    scheduledJob(
      'audit-triage-purge',
      async () => {
        await purgeAuditTriage(rotatorDb).catch((err: unknown) => {
          console.error('[audit-triage-purge] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // Instance events kept 90 days (HeoPress P07a task 11.4): removed daily in a transaction that set `app.retention`.
  const { purgeSystemEvents } = await import('./services/ops/event-stream');
  systemEventsPurgeTask = cron.schedule(
    '45 27 3 * * *',
    scheduledJob(
      'system-events-purge',
      async () => {
        await purgeSystemEvents(rotatorDb).catch((err: unknown) => {
          console.error('[system-events-purge] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // Active theme versions checked by an older checker (HeoPress P07 task 2.4): checked again — the rendering view serves
  // only versions the current checker passed — a passing one served again, a failing one switched back to the built-in
  // theme and the site's administrators told. At start and every ten minutes; a run with nothing stale is a read per site.
  const { recheckActiveThemes } = await import('./services/themes/theme-service');
  // Once at start too: after an upgrade that raised the checker, a site's theme is served again as soon as it passes.
  void scheduledJob(
    'theme-recheck',
    async () => {
      await recheckActiveThemes(rotatorDb).catch((err) => {
        console.error('[theme-recheck] failed', formatSafeError(err));
        throw err;
      });
    },
    jobOpts,
  )();
  themeRecheckTask = cron.schedule(
    '30 */10 * * * *',
    scheduledJob(
      'theme-recheck',
      async () => {
        await recheckActiveThemes(rotatorDb).catch((err) => {
          console.error('[theme-recheck] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );
  // The site network preset brought up to date on every site that has it (HeoPress P07 task 2.4: version 3 adds the
  // questions-and-answers field): at start, then hourly; only adds, resumes where a run stopped, skips are kept per site.
  const { upgradeAllSitePresets } = await import('./services/site-network/preset-installer');
  const presetUpgrade = scheduledJob(
    'preset-upgrade',
    async () => {
      // A failed site (or a failed run) fails the slot, so the schedule records it; the next run retries those sites.
      const run = await upgradeAllSitePresets(rotatorDb, runtime.cache);
      if (run.failed.length) throw new Error(`preset upgrade failed for ${run.failed.length} site(s): ${run.failed.join(', ')}`);
    },
    jobOpts,
  );
  presetUpgrade();
  presetUpgradeTask = cron.schedule('45 7 * * * *', presetUpgrade);
  // Retention sweep runs hourly (Req 12.2) — heavier than the publish tick.
  retentionTask = cron.schedule(
    '17 * * * *',
    scheduledJob(
      'retention-sweep',
      async () => {
        await sweepRetention(schedulerDeps).catch((err) => {
          console.error('[retention-sweep] failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );

  // ── Reconciler goal dispatch (#455) ─────────────────────────────────────
  //
  // The reconciler creates goals; this tick is what turns them into runs. Before
  // it existed, a reconciler goal was terminal: it was created, the drift flipped
  // to `assigned` with the goal id, and nothing anywhere executed it — and
  // because `planReconciliation` skips drifts that already carry a goal, the
  // unexecutable goal locked that drift out of every later cycle.
  //
  // One minute is deliberate: each pass advances a goal by at most one step
  // (draft → promote → verify), and the promote step waits on a human approval,
  // so a faster tick would only re-observe the same waiting state. The pass is
  // leader-locked because two processes dispatching the same goal would create
  // two runs for one drift.
  //
  // The callback is `async` and AWAITS the tick. Every cron callback in this file
  // used to be `() => { void work(); }`, which returns `undefined` immediately —
  // so `scheduledJob`'s `await fn()` completed at once and released the
  // lock while the work was still running. Measured with the real helper and a
  // fake Redis: `lockReleased=true` while `workDone=false`. The lock therefore
  // guaranteed nothing, for any of these jobs; `goal-dispatch` is simply the one
  // where the consequence is two runs for one drift. `serve-cron-await.test.ts`
  // keeps the shape from coming back.
  // Content goals / drift detection / auto-repair are off by default (P02 5.1):
  // without HEOPRESS_ENABLE_CONTENT_GOALS the tick is not scheduled at all.
  const contentGoalsEnabled = isFeatureEnabled('contentGoals');
  if (!contentGoalsEnabled) {
    console.log('[heopress-cms] Content goals disabled — goal dispatch tick not scheduled');
  }
  const { runGoalDispatchTick } = await import('./services/goal-dispatch-service');
  const goalDispatchDeps = { db: rotatorDb, queue: runtime.queue };
  goalDispatchTask = !contentGoalsEnabled ? undefined : cron.schedule(
    '* * * * *',
    scheduledJob(
      'goal-dispatch',
      async () => {
        await runGoalDispatchTick(goalDispatchDeps)
          .then((summary) => {
            if (summary.dispatched > 0 || summary.blocked > 0 || summary.completed > 0) {
              console.log('[goal-dispatch] pass', JSON.stringify(summary));
            }
          })
          .catch((err) => {
            console.error('[goal-dispatch] tick failed', formatSafeError(err));
            throw err;
          });
      },
      jobOpts,
    ),
  );

  // ── Deployment status poller (deployment-integrations task 9; Req 3.4) ──
  //
  // A 30-second sweep syncs every non-terminal deployment from its Provider.
  // Each sync is a guarded conditional update (only flips queued/building),
  // and a single provider error never aborts the sweep, so re-running is a
  // no-op (idempotent).
  const { registerStatusPoller, sweepAllSites } = await import('./services/deployment/status-poller');
  const deployPollerDeps = { db: rotatorDb, keys: runtime.keys, queue: runtime.queue };
  registerStatusPoller(deployPollerDeps);
  deploymentPollTask = cron.schedule(
    '*/30 * * * * *',
    scheduledJob(
      'deployment-poll',
      async () => {
        await sweepAllSites(deployPollerDeps).catch((err) => {
          console.error('[deployment-poll] sweep failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );

  // ── Flow schedule tick (visual-flow-builder task 4.x) ───────────────────
  //
  // The event-triggered flow consumer is `registerFlowEventWorker` (above).
  // Schedule flows need a periodic sweep: a 1-minute tick enqueues every flow
  // whose `next_run_at` is due onto the same `flow-events` queue (nextRunAt is
  // advanced before enqueue so a slow job never re-fires the same flow).
  const { runDueScheduledFlows } = await import('./services/flow-scheduler');
  flowScheduleTask = cron.schedule(
    '* * * * *',
    scheduledJob(
      'flow-schedule',
      async () => {
        await runDueScheduledFlows({ db: rotatorDb, queue: runtime.queue }).catch((err) => {
          console.error('[flow-schedule] tick failed', formatSafeError(err));
          throw err;
        });
      },
      jobOpts,
    ),
  );

  // ── Envelope migration consumer (regulated-content-readiness task 3.6) ──
  //
  // Drains background migrations enqueued when an operator toggles
  // `encryption.envelope`. Batched, resumable, idempotent — safe to re-run.
  const { registerEnvelopeMigrationWorker } = await import('./services/envelope-migration-worker');
  registerEnvelopeMigrationWorker({ db: rotatorDb, keyProvider: runtime.keys, queue: runtime.queue });
  } // runWorkers

  const closeServers = (onClosed: () => Promise<void>) => {
    const pending: Promise<void>[] = [];
    if (server) {
      pending.push(
        new Promise((resolve) => {
          server!.close(() => resolve());
        }),
      );
    }
    if (workerHealthServer) {
      pending.push(
        new Promise((resolve) => {
          workerHealthServer!.close(() => resolve());
        }),
      );
    }
    if (pending.length === 0) {
      void onClosed();
      return;
    }
    void Promise.all(pending).then(onClosed);
  };

  // Graceful shutdown with 10s timeout
  process.on('SIGTERM', () => {
    console.log('[heopress-cms] SIGTERM received, shutting down...');

    // node-cron 4 stops asynchronously; settle every stop before the database
    // closes, and never let a failed stop become an unhandled rejection.
    const tasksStopped = Promise.allSettled(
      [
        rotationTask,
        pageviewFlushTask,
        vetoSweepTask,
        claimSweepTask,
        staleRunSweepTask,
        llmRecoveryTask,
        schedulerTask,
        retentionTask,
        projectionTask,
        themeRecheckTask,
        indexNowTask,
        indexNowReconcileTask,
        linkScanTask,
        linkScanScheduleTask,
        auditTask,
        auditScheduleTask,
        ingestScheduleTask,
        reachabilityTask,
        crawlPurgeTask,
        auditTriagePurgeTask,
        systemEventsPurgeTask,
        presetUpgradeTask,
        deploymentPollTask,
        flowScheduleTask,
        goalDispatchTask,
      ].map((task) => task?.stop()),
    );
    if (runHttp) {
      pressureLimiter.stop();
    }
    if (loadGuardTimer) {
      clearInterval(loadGuardTimer);
    }

    // Force exit after 10 seconds if graceful shutdown stalls
    const forceTimeout = setTimeout(() => {
      console.error('[heopress-cms] Graceful shutdown timed out after 10s, forcing exit.');
      process.exit(1);
    }, 10_000);
    forceTimeout.unref();

    closeServers(async () => {
      for (const stopped of await tasksStopped) {
        if (stopped.status === 'rejected') {
          console.error('[heopress-cms] Error stopping a scheduled task:', formatSafeError(stopped.reason));
        }
      }
      try {
        await runtime.queue.close?.();
      } catch (err) {
        console.error('[heopress-cms] Error stopping queue workers:', formatSafeError(err));
      }
      try {
        await observability.shutdown();
      } catch (err) {
        console.error('[heopress-cms] Error shutting down observability:', formatSafeError(err));
      }
      try {
        await runtime.database.close();
      } catch (err) {
        console.error('[heopress-cms] Error closing database connection:', formatSafeError(err));
      }
      clearTimeout(forceTimeout);
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error('[heopress-cms] Failed to start:', formatSafeError(err));
  process.exit(1);
});
