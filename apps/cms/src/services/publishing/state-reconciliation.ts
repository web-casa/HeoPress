/**
 * Unified state reconciliation (HeoPress P11 task 1.2; spec publishing/event-consumers "权威状态对账").
 *
 * Every consumer's downstream state is compared with the database — the authority — on a schedule, so drift left by
 * an event that was never written (the content committed, the outbox write failed) or never consumed is repaired or
 * reported even though no event will ever arrive. One pass runs every reconciler in turn and produces one report:
 *
 *   - `render-cache`: rendered pages of a superseded render version are deleted (what the invalidation consumer does);
 *   - `translation-freshness`: every source is judged again and drifted targets marked (`reconcileFreshness`);
 *   - `indexnow`: every site with IndexNow on is queued for its comparison pass (pushes what changed unseen);
 *   - `search-index`: items changed since the previous pass get their search documents rewritten (when search is on);
 *   - `link-graph`: sites whose graph has not been fully scanned for a day are asked for a scan;
 *   - `git-snapshots`: every site with snapshots on is queued for its daily comparison pass (`reconcileGitSnapshots`);
 *   - `astro-builds`: the Astro engine's pass (stuck builds failed, lagging sites rebuilt, `current` links restored),
 *     when the worker registered it (`setAstroStateReconciliation`); otherwise the report says `not_configured`.
 *   A reconciler passed in `hooks` takes the slot of the same name (tests, other processes).
 *
 * A reconciler that throws is reported `failed`; the others still run. The report is recorded as a system event
 * (`consumer_reconciliation`, warn when anything drifted or failed), with one `consumer_backlog_alert` per consumer
 * whose backlog is over the threshold (spec "积压与死信").
 */
import { and, asc, eq, gte, lt, sql } from 'drizzle-orm';
import { collections, items, renderCache, siteRenderVersions, sites, systemEvents, type Database } from '@heopress/database';
import type { KeyProvider, SearchProvider } from '@heopress/runtime';
import { listConsumers } from '../../modules/events/consumer-ops';
import type { AstroReconcileReport, ReconciliationHook } from '../astro/astro-engine';
import { reconcileGitSnapshots } from '../git-snapshots/exporter';
import { syncSearchItem } from '../content-indexing-worker';
import { recordSystemEvent } from '../ops/system-events';
import { runSiteTransaction } from '../rls-transaction';
import { reconcileFreshness } from '../site-network/freshness';
import { scheduleIndexNowReconciliation } from '../site-network/indexnow';
import { scheduleLinkScans } from '../site-network/link-graph';

type ReconcileStatus = 'ok' | 'repaired' | 'drift' | 'failed' | 'not_configured';

interface ReconcileOutcome {
  /** ok: nothing to do; repaired: drift found and fixed; drift: found, not fixable here (needs a person). */
  status: ReconcileStatus;
  checked: number;
  repaired: number;
  drift: number;
  detail?: string;
}

interface ReconcileContext {
  db: Database;
  siteIds: string[];
  /** Start of the previous completed pass (null: none) — reconcilers that look at recent changes start there. */
  since: Date | null;
  now: Date;
}

export interface StateReconciler {
  name: string;
  /** The event consumer whose downstream state this reconciles. */
  consumer: string;
  reconcile(ctx: ReconcileContext): Promise<ReconcileOutcome>;
}

export interface ReconciliationReport {
  trigger: 'scheduled' | 'manual';
  startedAt: string;
  finishedAt: string;
  sites: number;
  results: Array<ReconcileOutcome & { name: string; consumer: string }>;
  backlog: Array<{ consumer: string; backlogSeconds: number; overThreshold: boolean; dead: number }>;
}

/** Slots for the P11 consumers (Git snapshots 2.4, Astro 3.5): a hook of the same name in `deps.hooks` replaces one. */
const HOOK_SLOTS = [
  { name: 'git-snapshots', consumer: 'git-snapshots' },
  { name: 'astro-builds', consumer: 'astro-build' },
] as const;

const DEFAULT_LOOKBACK_MS = 24 * 3600_000;
const SEARCH_BATCH = 500;
const REPORT_EVENT = 'consumer_reconciliation';

const outcome = (checked: number, repaired: number, detail?: string): ReconcileOutcome => ({
  status: repaired > 0 ? 'repaired' : 'ok',
  checked,
  repaired,
  drift: repaired,
  ...(detail ? { detail } : {}),
});

const renderCacheReconciler: StateReconciler = {
  name: 'render-cache',
  consumer: 'render-cache-invalidation',
  async reconcile({ db, siteIds }) {
    let deleted = 0;
    for (const siteId of siteIds) {
      const rows = await runSiteTransaction(db, siteId, (tx) =>
        tx
          .delete(renderCache)
          .where(
            and(
              eq(renderCache.siteId, siteId),
              lt(renderCache.siteVersion, sql`coalesce((SELECT ${siteRenderVersions.version} FROM ${siteRenderVersions} WHERE ${siteRenderVersions.siteId} = ${siteId}), 0)`),
            ),
          )
          .returning({ key: renderCache.key }),
      );
      deleted += rows.length;
    }
    return outcome(siteIds.length, deleted);
  },
};

const freshnessReconciler: StateReconciler = {
  name: 'translation-freshness',
  consumer: 'translation-freshness',
  async reconcile({ db, siteIds }) {
    let sources = 0;
    let marked = 0;
    for (const siteId of siteIds) {
      const r = await reconcileFreshness(db, siteId);
      sources += r.sources;
      marked += r.stale + r.humanEdited;
    }
    return outcome(sources, marked);
  },
};

const indexNowReconciler: StateReconciler = {
  name: 'indexnow',
  consumer: 'indexnow',
  async reconcile({ db, siteIds, now }) {
    const queued = await scheduleIndexNowReconciliation(db, now);
    return { status: 'ok', checked: siteIds.length, repaired: 0, drift: 0, detail: `queued ${queued} site(s) for a comparison pass` };
  },
};

const linkGraphReconciler: StateReconciler = {
  name: 'link-graph',
  consumer: 'link-graph',
  async reconcile({ db, siteIds }) {
    const asked = await scheduleLinkScans(db);
    return { status: 'ok', checked: siteIds.length, repaired: 0, drift: 0, detail: `asked ${asked} site(s) for a full scan` };
  },
};

function searchReconciler(deps: { search?: SearchProvider; keyProvider?: KeyProvider }): StateReconciler {
  return {
    name: 'search-index',
    consumer: 'search-index',
    async reconcile({ db, siteIds, since, now }) {
      if (!deps.search) return { status: 'not_configured', checked: 0, repaired: 0, drift: 0 };
      const from = since ?? new Date(now.getTime() - DEFAULT_LOOKBACK_MS);
      const configured = new Set<string>();
      let synced = 0;
      for (const siteId of siteIds) {
        for (let offset = 0; ; offset += SEARCH_BATCH) {
          const page = await runSiteTransaction(db, siteId, (tx) =>
            tx
              .select({ id: items.id, collection: collections.name })
              .from(items)
              .innerJoin(collections, and(eq(collections.id, items.collectionId), eq(collections.siteId, siteId)))
              .where(and(eq(items.siteId, siteId), gte(items.updatedAt, from)))
              .orderBy(asc(items.id))
              .limit(SEARCH_BATCH)
              .offset(offset),
          );
          for (const row of page) {
            await syncSearchItem({ db, search: deps.search, keyProvider: deps.keyProvider }, { siteId, collection: row.collection, itemId: row.id }, configured);
            synced++;
          }
          if (page.length < SEARCH_BATCH) break;
        }
      }
      return { status: 'ok', checked: synced, repaired: 0, drift: 0, detail: `rewrote ${synced} search document(s) changed since ${from.toISOString()}` };
    },
  };
}

/** Git snapshots (task 2.4): queue every enabled site's comparison pass (once a day per site); the 10 s pass runs it. */
const gitSnapshotsReconciler: StateReconciler = {
  name: 'git-snapshots',
  consumer: 'git-snapshots',
  async reconcile({ db, siteIds, now }) {
    const { queued } = await reconcileGitSnapshots(db, { siteIds, now: () => now });
    return { status: 'ok', checked: siteIds.length, repaired: 0, drift: 0, detail: `queued ${queued.length} site(s) for a comparison pass` };
  },
};

/** The Astro engine's reconciliation hook (task 3.5) as the `astro-builds` slot's reconciler. */
function astroStateReconciler(hook: Pick<ReconciliationHook<AstroReconcileReport>, 'run'>): StateReconciler {
  return {
    name: 'astro-builds',
    consumer: 'astro-build',
    async reconcile() {
      const r = await hook.run();
      const repaired = r.stuck.length + r.requested.length + r.relinked.length;
      const parts = [
        r.stuck.length ? `failed ${r.stuck.length} stuck build(s)` : '',
        r.requested.length ? `asked ${r.requested.length} lagging site(s) for a build` : '',
        r.relinked.length ? `relinked ${r.relinked.length} site(s)` : '',
      ].filter(Boolean);
      return outcome(r.checked, repaired, parts.length ? parts.join('; ') : undefined);
    },
  };
}

/** Set by the worker when the Astro engine is on (null when it stops); the hourly and manual passes use it. */
let astroReconciler: StateReconciler | null = null;
export function setAstroStateReconciliation(hook: Pick<ReconciliationHook<AstroReconcileReport>, 'run'> | null): void {
  astroReconciler = hook ? astroStateReconciler(hook) : null;
}

export interface ReconciliationDeps {
  search?: SearchProvider;
  keyProvider?: KeyProvider;
  /** Reconcilers that take the slot of the same name (Git snapshots, Astro builds) in place of the built-in ones. */
  hooks?: StateReconciler[];
}

function stateReconcilers(deps: ReconciliationDeps = {}): StateReconciler[] {
  const hooks = deps.hooks ?? [];
  const builtIn: Record<(typeof HOOK_SLOTS)[number]['name'], StateReconciler | null> = {
    'git-snapshots': gitSnapshotsReconciler,
    'astro-builds': astroReconciler,
  };
  const slots: StateReconciler[] = HOOK_SLOTS.filter((s) => !hooks.some((h) => h.name === s.name)).map(
    (s) =>
      builtIn[s.name] ?? {
        ...s,
        reconcile: async () => ({ status: 'not_configured' as const, checked: 0, repaired: 0, drift: 0 }),
      },
  );
  return [renderCacheReconciler, freshnessReconciler, indexNowReconciler, searchReconciler(deps), linkGraphReconciler, ...hooks, ...slots];
}

/** The last recorded report (bootstrap administrator's read: system events need `app.platform_reader`). */
export async function latestReconciliationReport(db: Database): Promise<(ReconciliationReport & { recordedAt: string }) | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.platform_reader', 'on', true)`);
    const [row] = await tx
      .select({ data: systemEvents.data, occurredAt: systemEvents.occurredAt })
      .from(systemEvents)
      .where(eq(systemEvents.event, REPORT_EVENT))
      .orderBy(sql`${systemEvents.occurredAt} DESC`)
      .limit(1);
    if (!row) return null;
    return { ...(row.data as unknown as ReconciliationReport), recordedAt: row.occurredAt.toISOString() };
  });
}

export async function runStateReconciliation(
  db: Database,
  deps: ReconciliationDeps = {},
  opts: { trigger?: 'scheduled' | 'manual'; actor?: string | null; now?: Date } = {},
): Promise<ReconciliationReport> {
  const now = opts.now ?? new Date();
  const previous = await latestReconciliationReport(db).catch(() => null);
  const siteIds = (await db.select({ id: sites.id }).from(sites).orderBy(asc(sites.id))).map((r) => r.id);
  const ctx: ReconcileContext = { db, siteIds, since: previous ? new Date(previous.startedAt) : null, now };
  const results: ReconciliationReport['results'] = [];
  for (const r of stateReconcilers(deps)) {
    try {
      results.push({ name: r.name, consumer: r.consumer, ...(await r.reconcile(ctx)) });
    } catch (err) {
      results.push({ name: r.name, consumer: r.consumer, status: 'failed', checked: 0, repaired: 0, drift: 0, detail: (err instanceof Error ? err.message : String(err)).slice(0, 500) });
    }
  }
  const consumers = await listConsumers(db, now);
  const report: ReconciliationReport = {
    trigger: opts.trigger ?? 'scheduled',
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
    sites: siteIds.length,
    results,
    backlog: consumers.map((c) => ({ consumer: c.name, backlogSeconds: c.backlogSeconds, overThreshold: c.overThreshold, dead: c.failures.dead })),
  };
  const troubled = results.filter((r) => r.status === 'drift' || r.status === 'failed');
  const repaired = results.reduce((n, r) => n + r.repaired, 0);
  await recordSystemEvent(db, {
    level: troubled.length ? 'warn' : 'info',
    source: 'events',
    event: REPORT_EVENT,
    message: `state reconciliation: ${repaired} repaired, ${troubled.length} reconciler(s) with drift or failure`,
    actor: opts.actor ?? null,
    data: report as unknown as Record<string, unknown>,
  });
  for (const c of consumers.filter((x) => x.overThreshold)) {
    await recordSystemEvent(db, {
      level: 'warn',
      source: 'events',
      event: 'consumer_backlog_alert',
      message: `${c.name}: backlog ${Math.round(c.backlogSeconds / 60)} min`,
      data: { consumer: c.name, backlogSeconds: c.backlogSeconds, pending: c.pending },
    });
  }
  return report;
}
