import { and, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { astroBuilds, astroSites, siteRenderVersions, type AstroBuildStepRecord, type Database } from '@heopress/database';
import { DEFAULT_BUILD_STEP_MS } from '@heopress/contracts/extensions';
import { pluginBuildSteps, type PluginBuildStepPlan } from '../../extensions/pipeline/declarations';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { exportPageData, servePageData } from '@heopress/site-classic/page-data';
import {
  activate,
  buildDir,
  buildSiteGeneration,
  discard,
  liveGeneration,
  parseThemeRef,
  prune,
  StaleGenerationError,
  verifyBuild,
  type BuildLimits,
  type BuildStep,
  type SiteBuildOptions,
  type SiteBuildOutcome,
} from '@heopress/site-astro';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { runSiteTransaction } from '../rls-transaction';
import { notifySiteAdmins } from '../ingest/source-service';

/**
 * The Astro engine's scheduling, publication and reconciliation (HeoPress P11 tasks 3.2, 3.3, 3.5, 3.6; spec
 * rendering/astro-engine):
 *
 *   - a change event that can alter a site's public output marks the site (`request`): the latest change restarts the
 *     debounce window (default 60 s), and a window never waits past `maxWaitMs` — five publications within a minute are
 *     one build that contains all five;
 *   - `runDue` starts the due sites' builds, at most `concurrency` at a time in this process (default 1);
 *   - a build takes the next generation, pins its snapshot (the site's render version, read and re-read around the
 *     export), builds in an isolated child process into its own new directory, verifies, and only then goes live — a
 *     compare-and-set on the active generation, then the atomic switch: a build that finishes after a newer one went live
 *     is `superseded` and its output removed; a failed build leaves the live version and notifies the site's administrators;
 *   - enabling the engine, switching the theme and rolling back are activations like any other: each runs the output
 *     checks (sponsor disclosure slots included) against the current snapshot;
 *   - `reconcile` (every 5 minutes; the hook the unified reconciliation calls) fails builds past their deadline, asks
 *     for a build when the live revision lags the site's render version with nothing pending (a lost event), and puts the
 *     `current` link back on the active generation when they differ.
 */

export interface AstroEngineOptions {
  /** The CMS's connection (the engine's own tables, the notifications). */
  db: Database;
  /** A connection as the rendering role: the page data are read with it only. */
  renderDb: Database;
  /** Where the sites' builds live (`<root>/<siteId>/builds/<generation>`, `<root>/<siteId>/current`). */
  root: string;
  debounceMs?: number;
  maxWaitMs?: number;
  concurrency?: number;
  limits?: BuildLimits;
  operatorThemesDir?: string;
  approvedIntegrations?: string[];
  user?: { uid: number; gid: number };
  registry?: string;
  now?: () => Date;
  /** Tests: the build and the export. */
  build?: (opts: SiteBuildOptions) => Promise<SiteBuildOutcome>;
  exportSnapshot?: (siteId: string) => Promise<PageDataSnapshot>;
  /** A build went live (P11 task 4.3: its deploy to the site's target is asked for). Errors are logged, not raised. */
  onActivated?: (siteId: string, generation: number, snapshot: PageDataSnapshot) => Promise<unknown>;
}

/** Turn the Astro engine on for a site with a theme (official or operator only); its first build is asked for at once. */
export async function enableAstroSite(db: Database, siteId: string, theme: string, now = new Date()): Promise<void> {
  parseThemeRef(theme);
  await db
    .insert(astroSites)
    .values({ siteId, theme, enabled: true, requestedAt: now, firstRequestedAt: now })
    .onConflictDoUpdate({ target: astroSites.siteId, set: { theme, enabled: true, requestedAt: now, firstRequestedAt: sql`coalesce(${astroSites.firstRequestedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now } });
}

/** Turn it off: the Classic engine answers again; builds and deploy records stay. */
export async function disableAstroSite(db: Database, siteId: string, now = new Date()): Promise<void> {
  await db.update(astroSites).set({ enabled: false, requestedAt: null, firstRequestedAt: null, updatedAt: now }).where(eq(astroSites.siteId, siteId));
}

export type BuildReason = 'event' | 'reconcile' | 'enable' | 'switch';

export interface BuildReport {
  siteId: string;
  generation: number;
  status: 'succeeded' | 'failed' | 'superseded';
  revision: number | null;
  error?: string;
}

export interface AstroReconcileReport {
  checked: number;
  /** Builds past their deadline, failed now. */
  stuck: string[];
  /** Sites whose live revision lagged with nothing pending: a build was asked for. */
  requested: string[];
  /** Sites whose `current` link did not name the active generation: put back. */
  relinked: string[];
}

/** Resources whose changes can alter a site's public output (as for the Classic page cache). */
const RESOURCES = new Set(['item', 'content_route', 'redirect', 'site_content_settings', 'translation_group', 'theme', 'collection', 'field', 'site_seo_settings', 'site_domain']);

export class AstroEngine {
  private readonly running = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly opts: AstroEngineOptions) {
    this.now = opts.now ?? (() => new Date());
  }

  /** Turn the engine on for a site with a theme (official or operator only); its first build is asked for at once. */
  async enable(siteId: string, theme: string): Promise<void> {
    await enableAstroSite(this.opts.db, siteId, theme, this.now());
  }

  async disable(siteId: string): Promise<void> {
    await disableAstroSite(this.opts.db, siteId, this.now());
  }

  /** Switch the theme: built and checked like any build; the live version stays until the new one passes. */
  async switchTheme(siteId: string, theme: string): Promise<BuildReport> {
    parseThemeRef(theme);
    await this.opts.db.update(astroSites).set({ theme, updatedAt: this.now() }).where(eq(astroSites.siteId, siteId));
    return this.buildNow(siteId, 'switch');
  }

  /** A change to the site's public output: (re)start its debounce window. */
  async request(siteId: string): Promise<boolean> {
    const now = this.now();
    const rows = await this.opts.db
      .update(astroSites)
      .set({ requestedAt: now, firstRequestedAt: sql`coalesce(${astroSites.firstRequestedAt}, ${now.toISOString()}::timestamptz)`, updatedAt: now })
      .where(and(eq(astroSites.siteId, siteId), eq(astroSites.enabled, true)))
      .returning({ siteId: astroSites.siteId });
    return rows.length > 0;
  }

  /** Start the builds that are due, within the concurrency limit; resolves when they finish. */
  async runDue(): Promise<BuildReport[]> {
    const free = (this.opts.concurrency ?? 1) - this.running.size;
    if (free <= 0) return [];
    const now = this.now().getTime();
    const quiet = new Date(now - (this.opts.debounceMs ?? 60_000));
    const waited = new Date(now - (this.opts.maxWaitMs ?? 5 * 60_000));
    const due = await this.opts.db
      .select({ siteId: astroSites.siteId })
      .from(astroSites)
      .where(and(eq(astroSites.enabled, true), isNotNull(astroSites.requestedAt), or(lte(astroSites.requestedAt, quiet), lte(astroSites.firstRequestedAt, waited))))
      .orderBy(astroSites.firstRequestedAt)
      .limit(free + this.running.size);
    const picked = due.map((d) => d.siteId).filter((id) => !this.running.has(id)).slice(0, free);
    return Promise.all(picked.map((siteId) => this.buildNow(siteId, 'event')));
  }

  /** Build a site now (its pending request is taken), activating the result when it is still the newest. */
  async buildNow(siteId: string, reason: BuildReason): Promise<BuildReport> {
    if (this.running.has(siteId)) throw new Error(`site ${siteId}: a build is already running`);
    this.running.add(siteId);
    try {
      return await this.build(siteId, reason);
    } finally {
      this.running.delete(siteId);
    }
  }

  private async build(siteId: string, reason: BuildReason): Promise<BuildReport> {
    const db = this.opts.db;
    const timeoutMs = this.opts.limits?.timeoutMs ?? 10 * 60_000;
    // Take the pending request and the next generation in one statement.
    const [claimed] = await db
      .update(astroSites)
      .set({ generation: sql`${astroSites.generation} + 1`, requestedAt: null, firstRequestedAt: null, updatedAt: this.now() })
      .where(eq(astroSites.siteId, siteId))
      .returning({ generation: astroSites.generation, theme: astroSites.theme });
    if (!claimed) throw new Error(`site ${siteId}: the Astro engine is not enabled`);
    const { generation, theme } = claimed;
    // The deadline leaves room for the export and the checks around the build itself.
    const [row] = await db
      .insert(astroBuilds)
      .values({ siteId, generation, theme, reason, deadlineAt: new Date(this.now().getTime() + timeoutMs + 5 * 60_000) })
      .returning({ id: astroBuilds.id });
    // Build steps of the site's plugins (P12 task 4.3): only operator-trusted plugins' run; the others are recorded as
    // skipped with why.
    let plan: PluginBuildStepPlan = { run: [], skipped: [] };
    try {
      plan = await runSiteTransaction(db, siteId, (tx) => pluginBuildSteps(tx, siteId));
    } catch (err) {
      console.error('[astro] plugin build steps not read', { siteId, error: (err as Error).message });
    }
    let steps: AstroBuildStepRecord[] = plan.skipped.map((s) => ({ owner: 'plugin', source: s.plugin, step: s.step, status: 'skipped', reason: s.reason }));
    const finish = async (status: BuildReport['status'], revision: number | null, error?: string): Promise<BuildReport> => {
      await db.update(astroBuilds).set({ status, error: error ?? null, steps, finishedAt: this.now() }).where(eq(astroBuilds.id, row!.id));
      return { siteId, generation, status, revision, ...(error ? { error } : {}) };
    };
    const pluginSteps: BuildStep[] = plan.run.map((p) => ({
      owner: 'plugin',
      source: p.plugin,
      scope: p.namespace,
      id: p.step.id,
      scriptSource: p.step.source,
      timeoutMs: p.step.timeoutMs ?? DEFAULT_BUILD_STEP_MS,
    }));
    let snapshot: PageDataSnapshot;
    try {
      snapshot = await (this.opts.exportSnapshot ?? ((id) => exportPageData({ db: this.opts.renderDb, siteId: id })))(siteId);
    } catch (err) {
      return this.failed(siteId, await finish('failed', null, `export failed: ${(err as Error).message}`.slice(0, 500)));
    }
    await db.update(astroBuilds).set({ revision: snapshot.revision }).where(eq(astroBuilds.id, row!.id));
    const outcome = await (this.opts.build ?? buildSiteGeneration)({
      root: this.opts.root,
      generation,
      theme,
      snapshot,
      serve: servePageData,
      operatorThemesDir: this.opts.operatorThemesDir,
      approvedIntegrations: this.opts.approvedIntegrations,
      limits: this.opts.limits,
      user: this.opts.user,
      registry: this.opts.registry,
      pluginSteps,
    });
    steps = [
      ...steps,
      ...(outcome.steps ?? []).map((r): AstroBuildStepRecord => ({ owner: r.owner, source: r.source, step: r.step, status: r.status, ...(r.reason ? { reason: r.reason } : {}), durationMs: r.durationMs })),
    ];
    if (!outcome.ok) return this.failed(siteId, await finish('failed', snapshot.revision, outcome.error.slice(0, 1000)));
    // Live only when no newer generation already is (compare-and-set), then the atomic switch.
    const [won] = await db
      .update(astroSites)
      .set({ activeGeneration: generation, activeRevision: snapshot.revision, activeTheme: theme, updatedAt: this.now() })
      .where(and(eq(astroSites.siteId, siteId), or(isNull(astroSites.activeGeneration), lt(astroSites.activeGeneration, generation))))
      .returning({ siteId: astroSites.siteId });
    if (!won) {
      await discard(this.opts.root, siteId, generation);
      return finish('superseded', snapshot.revision);
    }
    try {
      await activate(this.opts.root, siteId, generation);
    } catch (err) {
      if (!(err instanceof StaleGenerationError)) throw err;
      await discard(this.opts.root, siteId, generation);
      return finish('superseded', snapshot.revision);
    }
    await prune(this.opts.root, siteId).catch(() => []);
    const report = await finish('succeeded', snapshot.revision);
    if (this.opts.onActivated) {
      await this.opts.onActivated(siteId, generation, snapshot).catch((err: unknown) => console.error('[astro] deploy request failed', { siteId, error: (err as Error).message }));
    }
    return report;
  }

  private async failed(siteId: string, report: BuildReport): Promise<BuildReport> {
    await runSiteTransaction(this.opts.db, siteId, (tx) =>
      notifySiteAdmins(tx, siteId, {
        subject: 'Astro build failed',
        message: `The static build (generation ${report.generation}) failed: ${report.error ?? 'unknown error'}. The previous version is still being served.`,
        item: String(report.generation),
        collection: 'astro_builds',
      }),
    ).catch((err: unknown) => console.error('[astro] failure notice not written', (err as Error).message));
    return report;
  }

  /**
   * Roll back to an earlier successful generation: its output is checked against the current snapshot (sponsor
   * disclosure policy included) first; refused when it no longer passes — rebuild instead.
   */
  async rollback(siteId: string, generation: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const [build] = await this.opts.db
      .select()
      .from(astroBuilds)
      .where(and(eq(astroBuilds.siteId, siteId), eq(astroBuilds.generation, generation), eq(astroBuilds.status, 'succeeded')));
    if (!build) return { ok: false, error: 'no successful build of that generation' };
    const snapshot = await (this.opts.exportSnapshot ?? ((id) => exportPageData({ db: this.opts.renderDb, siteId: id })))(siteId);
    const issues = await verifyBuild(buildDir(this.opts.root, siteId, generation), snapshot);
    if (issues.length) return { ok: false, error: `the old output no longer passes the checks: ${issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ')}` };
    await activate(this.opts.root, siteId, generation, { rollback: true });
    await this.opts.db
      .update(astroSites)
      .set({ activeGeneration: generation, activeRevision: build.revision, activeTheme: build.theme, updatedAt: this.now() })
      .where(eq(astroSites.siteId, siteId));
    return { ok: true };
  }

  /** The 5-minute state reconciliation (task 3.5; the unified reconciliation's `astro` hook). */
  async reconcile(): Promise<AstroReconcileReport> {
    const db = this.opts.db;
    const now = this.now();
    const report: AstroReconcileReport = { checked: 0, stuck: [], requested: [], relinked: [] };
    const stuck = await db
      .update(astroBuilds)
      .set({ status: 'failed', error: 'stuck: past its deadline', finishedAt: now })
      .where(and(eq(astroBuilds.status, 'building'), lt(astroBuilds.deadlineAt, now)))
      .returning({ siteId: astroBuilds.siteId, generation: astroBuilds.generation });
    report.stuck = stuck.map((s) => `${s.siteId}#${s.generation}`);
    const sites = await db.select().from(astroSites).where(eq(astroSites.enabled, true));
    const building = new Set(
      (await db.select({ siteId: astroBuilds.siteId }).from(astroBuilds).where(and(eq(astroBuilds.status, 'building'), inArray(astroBuilds.siteId, sites.length ? sites.map((s) => s.siteId) : ['']))))
        .map((b) => b.siteId),
    );
    for (const site of sites) {
      report.checked++;
      const version = await runSiteTransaction(db, site.siteId, async (tx) => {
        const [v] = await tx.select({ version: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, site.siteId));
        return v ? Number(v.version) : 0;
      });
      if (!site.requestedAt && !building.has(site.siteId) && !this.running.has(site.siteId) && (site.activeRevision === null || site.activeRevision < version)) {
        if (await this.request(site.siteId)) report.requested.push(site.siteId);
      }
      if (site.activeGeneration !== null && !this.running.has(site.siteId)) {
        const live = await liveGeneration(this.opts.root, site.siteId);
        if (live !== site.activeGeneration) {
          try {
            await activate(this.opts.root, site.siteId, site.activeGeneration, { rollback: true });
            report.relinked.push(site.siteId);
          } catch (err) {
            console.error('[astro] relink failed', { siteId: site.siteId, error: (err as Error).message });
          }
        }
      }
    }
    return report;
  }
}

/** The `astro-build` consumer: a change that can alter a site's public output asks for that site's build. */
export function astroBuildConsumer(engine: Pick<AstroEngine, 'request'>): EventConsumerDefinition {
  return {
    name: 'astro-build',
    accepts: (e) => RESOURCES.has(e.resource),
    handle: async (event) => {
      await engine.request(event.siteId);
    },
  };
}

/**
 * The reconciliation hook of the Astro engine (for the unified reconciliation, P11 task 1.2): its name, how often it
 * runs, and one pass returning its report.
 */
export interface ReconciliationHook<R> {
  name: string;
  intervalMs: number;
  run(): Promise<R>;
}

export function astroReconciliation(engine: Pick<AstroEngine, 'reconcile'>): ReconciliationHook<AstroReconcileReport> {
  return { name: 'astro', intervalMs: 5 * 60_000, run: () => engine.reconcile() };
}
