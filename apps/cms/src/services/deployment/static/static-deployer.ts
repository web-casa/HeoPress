import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { astroSites, deploymentTargets, staticDeploys, type Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { activate, buildDir, siteDir, verifyBuild } from '@heopress/site-astro';
import { runSiteTransaction } from '../../rls-transaction';
import { getProvider, TERMINAL_STATUSES, type DeploymentProvider, type DeploymentRef, type ProviderTarget, type StaticFile } from '../providers';
import { decryptToken } from '../token-vault';
import { renderContract, staticContractOf, type StaticContract, type StaticPlatform } from './contract';
import { scanStaticOutput, type ScanOptions } from './scan';
import type { ReachabilityDeps } from '../../site-network/reachability';

/**
 * Static deployments of an Astro site (HeoPress P11 tasks 4.3–4.5, 5.1, 5.2; spec publishing/frontend-deployments):
 *
 *   - after a build goes live locally (`afterActivate`), a deploy of that generation to the site's target is requested; the
 *     static response contract of its snapshot is kept next to the build (`<site>/contracts/<generation>.json`) so the
 *     deploy answers that revision's redirects and headers;
 *   - `runPending` (worker) takes requested deploys: scan the output (secrets, admin addresses, internal data, bundled
 *     configuration — any finding refuses it), render the contract for the platform, upload as a new production deployment,
 *     poll until the provider says it is live or failed. A failed upload never touches what is live; the record keeps the
 *     error summary. VPS: the `current` link already is the live site (a rollback switches it);
 *   - `publishedRevision` (the site's render version) and `deployedRevision` (what the target confirmed) are kept apart:
 *     `deployed_*` moves only on a provider's confirmation;
 *   - a deploy whose confirmation was lost (an error after the upload, a worker that died mid-way) is looked up at the
 *     provider by its marker before anything is retried: found, its state is taken; not found, a new deploy is requested;
 *   - rollback re-deploys the generation of the previous successful deploy, after checking its output against the current
 *     snapshot: a page or file the site no longer publishes (withdrawn, unpublished, now gone) refuses it — rebuild instead;
 *   - after a successful deploy, the P07 reachability check runs against the site's verified domains, with the advice of the
 *     target platform, and its result is written to the deploy record.
 */

type ReachabilityOutcome = NonNullable<typeof staticDeploys.$inferSelect['reachability']>;

export interface StaticDeployerOptions {
  db: Database;
  keys: KeyProvider;
  /** The Astro build root (`HEOPRESS_ASTRO_ROOT`). */
  root: string;
  /** The current snapshot of a site (rollback check; a deploy whose stored contract is missing). */
  exportSnapshot: (siteId: string) => Promise<PageDataSnapshot>;
  /** The post-deploy reachability check (default: P07 `runReachabilityCheck`). */
  reachability?: (siteId: string, platform: StaticPlatform) => Promise<ReachabilityOutcome>;
  /** The default check's dependencies (tests: an HTTP client that answers in-process). */
  reachabilityDeps?: ReachabilityDeps;
  scan?: ScanOptions;
  providerOf?: (key: string) => DeploymentProvider | undefined;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** An `uploading` deploy older than this lost its confirmation (default 15 minutes). */
  leaseMs?: number;
}

type DeployRow = typeof staticDeploys.$inferSelect;

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json',
  xml: 'application/xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  webmanifest: 'application/manifest+json',
};

export const contentTypeOf = (path: string) => TYPES[/\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? ''] ?? 'application/octet-stream';

async function listFiles(dir: string, root = dir, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) await listFiles(full, root, out);
    else if (e.isFile()) out.push('/' + relative(root, full).split(sep).join('/'));
  }
  return out;
}

/** The page path of an output HTML file (`a/b/index.html` → `/a/b/`), or null for another file. */
function pagePathOf(file: string): string | null {
  if (file === '/404.html') return null;
  if (file === '/index.html') return '/';
  const m = /^(.*\/)index\.html$/.exec(file);
  return m ? decodeURI(m[1]!) : file.endsWith('.html') ? file : null;
}

/**
 * What an output carries that the site no longer publishes (task 4.4: a rollback must not put withdrawn content back
 * online): an HTML page that is not a page of `snapshot`, a machine-readable file (Markdown copy, feed, sitemap, text)
 * that is not one of its files, or anything at a withdrawn (410) address.
 */
async function unpublishedIn(outDir: string, snapshot: PageDataSnapshot): Promise<string[]> {
  const pages = new Set(snapshot.pages.map((p) => p.path));
  const files = new Set(snapshot.files.map((f) => f.path));
  const gone = new Set((snapshot.routes ?? []).filter((r) => r.status === 410).map((r) => r.path));
  const out: string[] = [];
  for (const f of await listFiles(outDir)) {
    const page = pagePathOf(f);
    if (page !== null) {
      if (!pages.has(page) || gone.has(page)) out.push(page);
    } else if (/\.(md|xml|txt|rss|atom)$/i.test(f) && !files.has(f)) {
      out.push(f);
    } else if (gone.has(f)) {
      out.push(f);
    }
  }
  return out;
}

const marker = (siteId: string, id: string) => `heopress-${siteId}-${id}`;
const short = (s: string, n = 1000) => (s.length > n ? `${s.slice(0, n)}…` : s);
const mask = (s: string) => s.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***').replace(/((?:token|secret|jwt|api[_-]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]+/gi, '$1***');

/** The contract of a generation, kept next to its build. */
const contractFile = (root: string, siteId: string, generation: number) => join(siteDir(root, siteId), 'contracts', `${generation}.json`);

export class StaticDeployer {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly providerOf: (key: string) => DeploymentProvider | undefined;

  constructor(private readonly opts: StaticDeployerOptions) {
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.providerOf = opts.providerOf ?? getProvider;
  }

  /** A build went live locally: keep its contract and ask for its deploy (the engine's activation hook). */
  async afterActivate(siteId: string, generation: number, snapshot: PageDataSnapshot): Promise<DeployRow> {
    const file = contractFile(this.opts.root, siteId, generation);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ revision: snapshot.revision, contract: staticContractOf(snapshot) }));
    return requestStaticDeploy(this.opts.db, siteId, { kind: 'deploy', generation, revision: snapshot.revision });
  }

  /** One worker pass: requested deploys, then those in flight or whose confirmation was lost. */
  async runPending(limit = 5): Promise<DeployRow[]> {
    const db = this.opts.db;
    const done: DeployRow[] = [];
    const requested = await db.select().from(staticDeploys).where(eq(staticDeploys.status, 'requested')).orderBy(asc(staticDeploys.createdAt)).limit(limit);
    for (const row of requested) {
      // Claim it (another worker may have).
      const [claimed] = await db
        .update(staticDeploys)
        .set({ status: 'uploading', startedAt: this.now() })
        .where(and(eq(staticDeploys.id, row.id), eq(staticDeploys.status, 'requested')))
        .returning();
      if (claimed) done.push(await this.deploy(claimed));
    }
    const stale = new Date(this.now().getTime() - (this.opts.leaseMs ?? 15 * 60_000));
    const inFlight = await db.select().from(staticDeploys).where(and(eq(staticDeploys.status, 'uploading'), lt(staticDeploys.startedAt, stale))).limit(limit);
    for (const row of inFlight) done.push(await this.recover(row));
    return done;
  }

  private async finish(row: DeployRow, set: Partial<DeployRow>): Promise<DeployRow> {
    const [r] = await this.opts.db
      .update(staticDeploys)
      .set({ ...set, finishedAt: set.status && set.status !== 'uploading' ? this.now() : null })
      .where(and(eq(staticDeploys.id, row.id), eq(staticDeploys.siteId, row.siteId)))
      .returning();
    return r!;
  }

  /** The target row of a site, read in its own scope: a target of another site is never found. */
  private async targetOf(siteId: string, targetId: string) {
    return runSiteTransaction(this.opts.db, siteId, async (tx) => {
      const [t] = await tx.select().from(deploymentTargets).where(and(eq(deploymentTargets.siteId, siteId), eq(deploymentTargets.id, targetId)));
      return t ?? null;
    });
  }

  private async contractFor(row: DeployRow, outDir: string): Promise<{ contract: StaticContract } | { refused: string }> {
    if (row.kind === 'deploy') {
      const stored = await readFile(contractFile(this.opts.root, row.siteId, row.generation), 'utf8').catch(() => null);
      if (stored) return { contract: (JSON.parse(stored) as { contract: StaticContract }).contract };
    }
    // A rollback (or a deploy whose contract is gone): the output against what the site publishes now.
    const snapshot = await this.opts.exportSnapshot(row.siteId);
    const unpublished = await unpublishedIn(outDir, snapshot);
    if (unpublished.length) return { refused: `The output carries ${unpublished.length} address(es) the site no longer publishes (${unpublished.slice(0, 3).join(', ')}): rebuild instead.` };
    // An older output differs from today's (its lists, sitemap, feeds are of its revision): only the current sponsor
    // disclosure policy must hold on it (as the engine's rollback demands); unpublished addresses were checked above.
    const issues = (await verifyBuild(outDir, snapshot)).filter((i) => /sponsor|disclosure/i.test(i.message));
    if (issues.length) return { refused: `The output no longer passes the checks: ${issues.slice(0, 3).map((i) => `${i.path}: ${i.message}`).join('; ')}` };
    return { contract: staticContractOf(snapshot) };
  }

  async deploy(row: DeployRow): Promise<DeployRow> {
    const { root } = this.opts;
    const outDir = buildDir(root, row.siteId, row.generation);
    const files = await listFiles(outDir).catch(() => null);
    if (!files) return this.finish(row, { status: 'failed', error: `The output of generation ${row.generation} is no longer on the server: rebuild.` });

    const findings = await scanStaticOutput(outDir, this.opts.scan);
    if (findings.length) {
      return this.finish(row, {
        status: 'refused',
        error: `The output scan refused the deploy: ${findings.slice(0, 5).map((f) => `${f.file} (${f.rule})`).join('; ')}`,
        log: findings.map((f) => `${f.rule}\t${f.file}\t${f.excerpt}`).join('\n').slice(0, 16_000),
      });
    }
    const c = await this.contractFor(row, outDir);
    if ('refused' in c) return this.finish(row, { status: 'refused', error: c.refused });
    const platform = row.provider as StaticPlatform;
    const rendered = renderContract(platform, c.contract);
    if (rendered.errors.length) return this.finish(row, { status: 'refused', error: rendered.errors.join(' '), warnings: rendered.warnings });

    if (platform === 'vps') {
      await writeFile(join(siteDir(root, row.siteId), 'Caddyfile.static'), rendered.files[0]?.body ?? '');
      if (row.kind === 'rollback') await activate(root, row.siteId, row.generation, { rollback: true });
      return this.succeeded(row, { url: null, warnings: rendered.warnings });
    }

    const target = row.targetId ? await this.targetOf(row.siteId, row.targetId) : null;
    if (!target || target.provider !== platform) return this.finish(row, { status: 'failed', error: 'The deployment target is not one of this site\'s targets (or changed provider).' });
    const provider = this.providerOf(target.provider);
    if (!provider?.deployStatic) return this.finish(row, { status: 'failed', error: `${target.provider} cannot take a static deployment.` });
    const token = await decryptToken(this.opts.keys, target.tokenCiphertext, row.siteId);
    const pt: ProviderTarget = { provider: target.provider, projectId: target.projectId, defaultBranch: target.defaultBranch };

    const upload: StaticFile[] = [];
    for (const f of files) upload.push({ path: f, bytes: await readFile(join(outDir, f)), contentType: contentTypeOf(f) });
    for (const f of rendered.files) upload.push({ path: `/${f.path}`, bytes: Buffer.from(f.body), contentType: contentTypeOf(f.path) });

    let ref: DeploymentRef | null = null;
    try {
      ref = await provider.deployStatic(token, pt, upload, { marker: row.marker });
    } catch (err) {
      // The provider may have taken it before the error (a lost answer): ask before calling it a failure.
      ref = await provider.findByMarker?.(token, pt, row.marker).catch(() => null) ?? null;
      if (!ref) return this.finish(row, { status: 'failed', error: short(mask((err as Error).message)), warnings: rendered.warnings });
    }
    await this.finish(row, { status: 'uploading', providerDeploymentId: ref.providerDeploymentId, url: ref.url ?? null, warnings: rendered.warnings });
    return this.follow({ ...row, providerDeploymentId: ref.providerDeploymentId, warnings: rendered.warnings }, provider, token, pt, ref);
  }

  /** Poll until terminal (or the timeout: the row stays `uploading` and the next pass goes on). */
  private async follow(row: DeployRow, provider: DeploymentProvider, token: string, pt: ProviderTarget, first: DeploymentRef): Promise<DeployRow> {
    let ref = first;
    const until = Date.now() + (this.opts.pollTimeoutMs ?? 10 * 60_000);
    while (!TERMINAL_STATUSES.has(ref.status) && Date.now() < until) {
      await this.sleep(this.opts.pollIntervalMs ?? 5000);
      ref = await provider.getStatus(token, pt, ref.providerDeploymentId);
    }
    if (ref.status === 'ready') return this.succeeded(row, { url: ref.url ?? row.url, providerDeploymentId: ref.providerDeploymentId });
    if (TERMINAL_STATUSES.has(ref.status)) {
      const log = await provider.getLogs(token, pt, ref.providerDeploymentId).catch(() => '');
      return this.finish(row, { status: 'failed', error: short(mask(ref.errorMessage ?? `The provider reported ${ref.status}.`)), log: mask(log).slice(-16_000) || null });
    }
    const [r] = await this.opts.db.select().from(staticDeploys).where(eq(staticDeploys.id, row.id));
    return r!;
  }

  /** A deploy left `uploading`: its provider deployment is looked up (by id, else by marker) before any retry. */
  async recover(row: DeployRow): Promise<DeployRow> {
    if (row.provider === 'vps') return this.deploy(row);
    const target = row.targetId ? await this.targetOf(row.siteId, row.targetId) : null;
    const provider = target ? this.providerOf(target.provider) : undefined;
    if (!target || !provider) return this.finish(row, { status: 'failed', error: 'The deployment target is gone.' });
    const token = await decryptToken(this.opts.keys, target.tokenCiphertext, row.siteId);
    const pt: ProviderTarget = { provider: target.provider, projectId: target.projectId, defaultBranch: target.defaultBranch };
    let ref: DeploymentRef | null = null;
    try {
      ref = row.providerDeploymentId ? await provider.getStatus(token, pt, row.providerDeploymentId) : ((await provider.findByMarker?.(token, pt, row.marker)) ?? null);
    } catch (err) {
      // Unknown either way: leave it for the next pass rather than deploy twice.
      return this.finish(row, { status: 'uploading', error: short(`Confirmation pending: ${mask((err as Error).message)}`) });
    }
    if (!ref) {
      const failed = await this.finish(row, { status: 'failed', error: 'The confirmation was lost and the provider has no such deployment: deployed again.' });
      await requestStaticDeploy(this.opts.db, row.siteId, { kind: row.kind as 'deploy' | 'rollback', generation: row.generation, revision: row.revision, rollbackOf: row.rollbackOf });
      return failed;
    }
    await this.finish(row, { status: 'uploading', providerDeploymentId: ref.providerDeploymentId, error: null });
    return this.follow({ ...row, providerDeploymentId: ref.providerDeploymentId }, provider, token, pt, ref);
  }

  private async succeeded(row: DeployRow, set: Partial<DeployRow>): Promise<DeployRow> {
    const done = await this.finish(row, { ...set, status: 'succeeded', error: null });
    // What the target serves now: a deploy only moves it forward (a late older one does not), a rollback sets it.
    await this.opts.db
      .update(astroSites)
      .set({ deployedGeneration: row.generation, deployedRevision: row.revision, updatedAt: this.now() })
      .where(
        row.kind === 'rollback'
          ? eq(astroSites.siteId, row.siteId)
          : and(eq(astroSites.siteId, row.siteId), sql`(${astroSites.deployedGeneration} IS NULL OR ${astroSites.deployedGeneration} < ${row.generation})`),
      );
    let reach: ReachabilityOutcome;
    try {
      reach = await (this.opts.reachability ?? defaultReachability(this.opts.db, this.opts.reachabilityDeps))(row.siteId, row.provider as StaticPlatform);
    } catch (err) {
      reach = { status: 'failed', detail: short((err as Error).message, 300) };
    }
    return this.finish(done, { reachability: reach });
  }
}

/** Ask for a deploy (the worker takes it); its marker names it at the provider. */
export async function requestStaticDeploy(
  db: Database,
  siteId: string,
  input: { kind: 'deploy' | 'rollback'; generation: number; revision: number | null; rollbackOf?: string | null; requestedBy?: string | null },
): Promise<DeployRow> {
  const [site] = await db.select({ targetId: astroSites.deployTargetId }).from(astroSites).where(eq(astroSites.siteId, siteId));
  let provider: StaticPlatform = 'vps';
  if (site?.targetId) {
    const t = await runSiteTransaction(db, siteId, (tx) =>
      tx.select({ provider: deploymentTargets.provider }).from(deploymentTargets).where(and(eq(deploymentTargets.siteId, siteId), eq(deploymentTargets.id, site.targetId!))),
    );
    provider = (t[0]?.provider ?? 'vps') as StaticPlatform;
  }
  const id = nanoid();
  const [row] = await db
    .insert(staticDeploys)
    .values({
      id,
      siteId,
      targetId: provider === 'vps' ? null : site!.targetId,
      provider,
      kind: input.kind,
      generation: input.generation,
      revision: input.revision,
      marker: marker(siteId, id),
      rollbackOf: input.rollbackOf ?? null,
      requestedBy: input.requestedBy ?? null,
    })
    .returning();
  return row!;
}

export class StaticDeployError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Ask for a rollback: the previous successful deploy of the site (the one before what the target serves now) is deployed
 * again — its output checked first by the worker. Refused when there is none.
 */
export async function requestStaticRollback(db: Database, siteId: string, requestedBy: string | null): Promise<DeployRow> {
  const candidate = await rollbackCandidate(db, siteId);
  if (!candidate) throw new StaticDeployError('NO_ROLLBACK_TARGET', 'There is no earlier successful deployment to roll back to.');
  return requestStaticDeploy(db, siteId, { kind: 'rollback', generation: candidate.generation, revision: candidate.revision, rollbackOf: candidate.id, requestedBy });
}

/** The previous successful deploy: the newest succeeded one whose generation is not the one deployed now. */
export async function rollbackCandidate(db: Database, siteId: string): Promise<{ id: string; generation: number; revision: number | null } | null> {
  const [site] = await db.select({ deployed: astroSites.deployedGeneration }).from(astroSites).where(eq(astroSites.siteId, siteId));
  if (!site || site.deployed === null) return null;
  const rows = await db
    .select({ id: staticDeploys.id, generation: staticDeploys.generation, revision: staticDeploys.revision })
    .from(staticDeploys)
    .where(and(eq(staticDeploys.siteId, siteId), eq(staticDeploys.status, 'succeeded'), sql`${staticDeploys.generation} <> ${site.deployed}`))
    .orderBy(desc(staticDeploys.finishedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Ask for a redeploy of the generation live on the server (an operator's "deploy again"). */
export async function requestStaticRedeploy(db: Database, siteId: string, requestedBy: string | null): Promise<DeployRow> {
  const [site] = await db.select().from(astroSites).where(eq(astroSites.siteId, siteId));
  if (!site?.enabled || site.activeGeneration === null) throw new StaticDeployError('NOT_BUILT', 'The site has no static build to deploy yet.');
  return requestStaticDeploy(db, siteId, { kind: 'deploy', generation: site.activeGeneration, revision: site.activeRevision, requestedBy });
}

/**
 * The deploys a site has, newest first, and the sites whose live build was never asked to deploy (a lost activation hook):
 * the reconciliation asks for those.
 */
export async function listStaticDeploys(db: Database, siteId: string, limit = 20): Promise<DeployRow[]> {
  return db.select().from(staticDeploys).where(eq(staticDeploys.siteId, siteId)).orderBy(desc(staticDeploys.createdAt)).limit(limit);
}

export async function reconcileStaticDeploys(db: Database): Promise<string[]> {
  const sites = await db.select().from(astroSites).where(eq(astroSites.enabled, true));
  const asked: string[] = [];
  for (const s of sites) {
    if (s.activeGeneration === null) continue;
    const [any] = await db
      .select({ id: staticDeploys.id })
      .from(staticDeploys)
      .where(and(eq(staticDeploys.siteId, s.siteId), eq(staticDeploys.generation, s.activeGeneration), inArray(staticDeploys.status, ['requested', 'uploading', 'succeeded'])))
      .limit(1);
    if (any) continue;
    // Only forward: a site rolled back (deployed past active) keeps its rollback.
    if (s.deployedGeneration !== null && s.deployedGeneration >= s.activeGeneration) continue;
    await requestStaticDeploy(db, s.siteId, { kind: 'deploy', generation: s.activeGeneration, revision: s.activeRevision });
    asked.push(s.siteId);
  }
  return asked;
}

function defaultReachability(db: Database, deps: ReachabilityDeps = {}) {
  return async (siteId: string, platform: StaticPlatform): Promise<ReachabilityOutcome> => {
    const { runReachabilityCheck } = await import('../../site-network/reachability');
    try {
      const report = await runReachabilityCheck(db, siteId, { platform, hosts: null }, deps);
      if (!report) return { status: 'skipped', detail: 'The check did not run.' };
      const issues = report.checks
        .filter((c) => !c.ok && !c.skipped)
        .slice(0, 50)
        .map((c) => ({ url: c.url, code: c.code, severity: c.severity, detail: c.detail, advice: c.advice }));
      return { status: issues.length ? 'issues' : 'passed', summary: report.summary, issues };
    } catch (err) {
      return { status: 'skipped', detail: short((err as Error).message, 300) };
    }
  };
}
