import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { and, asc, eq, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import {
  collections,
  gitSnapshotFiles,
  items,
  gitSnapshotQueue,
  gitSnapshotRepos,
  publicHosts,
  publicItems,
  publicSites,
  sites,
  siteThemes,
  themes,
  themeVersions,
  translationGroupMembers,
  type Database,
} from '@heopress/database';
import { htmlToMarkdown, textToMarkdown } from '@heopress/public-site';
import { pageTypeOfCollection } from '@heopress/seo-geo';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { runSiteTransaction } from '../rls-transaction';
import { fileRemotesAllowed, openCredential, validateRemoteUrl } from './config';
import { GitCommandError, redact, runGit, type GitAuth, type GitRunOptions } from './git';
import { safeDomain, sha256, siteFiles, type ExportItem, type SiteSnapshotInput, type SnapshotFile } from './format';

/**
 * Git snapshots of published content (HeoPress P11 tasks 2.2–2.4, 2.6; spec publishing/git-snapshots).
 *
 *   - The `git-snapshots` event consumer only queues the site (one row per change event, due after a 30-second
 *     window) and acknowledges the event: publishing never waits on Git.
 *   - The worker takes a site whose rows are due, holds its lease and makes one pass: the working copy is reset to the
 *     remote branch, the site's files are written from the public projection (what is published, nothing else), files
 *     no longer published (unpublished items, an old domain, an old slug or date) are deleted, and the change becomes
 *     one commit, pushed. Rows are deleted only after the push: a remote that is down keeps them and they come due
 *     again with a growing delay; the next pass regenerates the same tree, so a commit already pushed is never made
 *     twice (an unchanged tree commits nothing).
 *   - Every pass compares content hashes with what the last pushed commit held (`lumibase_git_snapshot_files`): a file
 *     deleted or changed by hand in the repository is a repair, restored and reported. The daily reconciliation
 *     (`reconcileGitSnapshots`) queues every enabled site for such a pass and records the report.
 */

/** The window a burst of changes is gathered in (one commit). */
const GIT_SNAPSHOT_WINDOW_MS = 30_000;
const LEASE_MS = 10 * 60_000;
const retryDelayMs = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

/** Change events that can change what a site's snapshot holds. */
const RESOURCES = new Set(['item', 'page', 'content_route', 'redirect', 'site_content_settings', 'site_seo_settings', 'site_identity', 'translation_group', 'collection', 'field', 'theme']);

type Tx = Parameters<Parameters<typeof runSiteTransaction>[2]>[0];

/** Where working copies live (one directory per site). */
function snapshotWorkRoot(): string {
  return resolve(process.env.HEOPRESS_GIT_SNAPSHOT_DIR || join(process.cwd(), 'data', 'git-snapshots'));
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** Keys never exported from the public site configuration, at any depth (defence in depth: it is public data already). */
const SECRET_KEY_RE = /(secret|token|password|passwd|apikey|api_key|private|credential|key$)/i;
function withoutSecrets(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutSecrets);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => !SECRET_KEY_RE.test(k)).map(([k, x]) => [k, withoutSecrets(x)]));
  }
  return v;
}

/** The site's primary public host: the primary one without an entry language first, then by name. */
async function primaryDomainOf(db: Database | Tx, siteId: string): Promise<string | null> {
  const rows = await db.select().from(publicHosts).where(eq(publicHosts.siteId, siteId));
  rows.sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || Number(a.entryLocale !== null) - Number(b.entryLocale !== null) || a.hostname.localeCompare(b.hostname));
  return rows[0]?.hostname ?? null;
}

/**
 * What a site's snapshot holds, read from the public projection in the site's scope: published items only (the
 * projection has no drafts), their public fields through the front matter whitelist, the public site configuration
 * and the active published theme. Null: the site has no public host.
 */
async function readSiteSnapshot(db: Database, siteId: string): Promise<SiteSnapshotInput | null> {
  return runSiteTransaction(db, siteId, async (tx) => {
    const domain = await primaryDomainOf(tx, siteId);
    if (!domain) return null;
    const [site] = await tx.select().from(publicSites).where(eq(publicSites.siteId, siteId));
    if (!site) return null;
    const rows = await tx.select().from(publicItems).where(eq(publicItems.siteId, siteId)).orderBy(asc(publicItems.itemId));
    const byId = new Map(rows.map((r) => [r.itemId, r]));
    const content = rows.filter((r) => pageTypeOfCollection(r.collection) === 'item');
    const groups = content.length
      ? new Map(
          (
            await tx
              .select({ itemId: translationGroupMembers.itemId, groupId: translationGroupMembers.groupId })
              .from(translationGroupMembers)
              .where(and(eq(translationGroupMembers.siteId, siteId), inArray(translationGroupMembers.itemId, content.map((r) => r.itemId))))
          ).map((r) => [r.itemId, r.groupId]),
        )
      : new Map<string, string>();
    // Authors not on a public page of their own: their display name only, from the item (never another field).
    const missing = [...new Set(content.map((r) => str(r.data.author)).filter((id): id is string => !!id && !byId.has(id)))];
    const authorNames = new Map<string, string>();
    if (missing.length) {
      const rows2 = await tx
        .select({ id: items.id, name: sql<string | null>`${items.data} ->> 'name'` })
        .from(items)
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(and(eq(items.siteId, siteId), eq(collections.siteId, siteId), eq(collections.name, 'authors'), eq(items.status, 'published'), inArray(items.id, missing)));
      for (const r of rows2) if (str(r.name)) authorNames.set(r.id, r.name!);
    }
    const exportItems: ExportItem[] = content.map((r) => {
      const d = r.data;
      const url = str((r.card as { url?: unknown }).url) ?? `https://${domain}/`;
      const body = str(d.body) ?? '';
      const authorRow = str(d.author) ? byId.get(d.author as string) : undefined;
      const author = authorRow ? (authorRow.collection === 'authors' ? str(authorRow.data.name) : null) : (authorNames.get(d.author as string) ?? null);
      const slug = str(d.slug) ?? (r.path.split('/').filter(Boolean).pop() || r.itemId);
      return {
        itemId: r.itemId,
        locale: r.locale,
        slug,
        title: str(d.title) ?? str(d.name) ?? slug,
        translationGroup: groups.get(r.itemId) ?? null,
        publishedAt: r.publishedAt,
        contentModifiedAt: r.contentModifiedAt ?? r.updatedAt,
        author,
        source: { url: str(d.source_url), attribution: str(d.source_attribution), licenseStatus: str(d.source_license) },
        seo: { title: str(d.seo_title), description: str(d.seo_description), canonical: str(d.canonical_url), robots: r.seoRobots },
        body: body ? (r.richFields.includes('body') ? htmlToMarkdown(body, url) : textToMarkdown(body)) : '',
      };
    });
    const [active] = await tx
      .select({ name: themes.name, number: themeVersions.number, contentHash: themeVersions.contentHash, templates: themeVersions.templates, assets: themeVersions.assets })
      .from(siteThemes)
      .innerJoin(themeVersions, and(eq(themeVersions.id, siteThemes.themeVersionId), eq(themeVersions.siteId, siteId)))
      .innerJoin(themes, eq(themes.id, themeVersions.themeId))
      .where(and(eq(siteThemes.siteId, siteId), isNotNull(themeVersions.publishedAt)));
    return {
      domain,
      defaultLanguage: site.defaultLanguage,
      site: withoutSecrets({ name: site.name, defaultLanguage: site.defaultLanguage, domain, settings: site.settings, seo: site.seo, identity: site.identity }) as Record<string, unknown>,
      theme: active ?? null,
      items: exportItems,
    };
  });
}

// ── The queue ────────────────────────────────────────────────────────────────

/** Queue a site's pass for `eventId` (once per id), due after the window. */
async function enqueueGitSnapshot(
  db: Database | Tx,
  siteId: string,
  eventId: string,
  meta: { actorType: string; occurredAt: Date },
  now = new Date(),
  windowMs = GIT_SNAPSHOT_WINDOW_MS,
): Promise<void> {
  await db
    .insert(gitSnapshotQueue)
    .values({ siteId, eventId, actorType: meta.actorType, occurredAt: meta.occurredAt, dueAt: new Date(now.getTime() + windowMs) })
    .onConflictDoNothing({ target: gitSnapshotQueue.eventId });
}

/** The `git-snapshots` consumer: a change that may move a site's published content queues the site (when enabled). */
export function gitSnapshotConsumer(deps: { db: Database }): EventConsumerDefinition {
  return {
    name: 'git-snapshots',
    accepts: (e) => RESOURCES.has(e.resource),
    handle: async (event) => {
      await runSiteTransaction(deps.db, event.siteId, async (tx) => {
        const [repo] = await tx.select({ enabled: gitSnapshotRepos.enabled }).from(gitSnapshotRepos).where(eq(gitSnapshotRepos.siteId, event.siteId));
        if (!repo?.enabled) return;
        await enqueueGitSnapshot(tx, event.siteId, `event:${event.id}`, { actorType: event.actorType, occurredAt: event.occurredAt });
      });
    },
  };
}

export interface GitSnapshotReport {
  siteId: string;
  domain: string | null;
  status: 'pushed' | 'nothing' | 'failed' | 'off' | 'no-domain';
  commit: string | null;
  written: string[];
  deleted: string[];
  /** Differences found in the repository against the last pushed commit (hand edits, deletions, stray files), repaired. */
  repairs: Array<{ path: string; kind: 'restored' | 'overwritten' | 'removed-extra' }>;
  error?: string;
}

export interface GitSnapshotDeps {
  encryptionKey?: string | null;
  workRoot?: string;
  now?: () => Date;
  /** Git command timeout (default 60 s). */
  timeoutMs?: number;
}

async function listFiles(dir: string, rel = ''): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listFiles(dir, p)));
    else out.push(p);
  }
  return out;
}

async function readMaybe(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** A path under the working copy, refused if it would leave it. */
function inside(work: string, rel: string): string {
  const abs = resolve(work, rel);
  if (!abs.startsWith(work + sep)) throw new Error('path escapes the working copy');
  return abs;
}

function commitMessage(domain: string, events: Array<{ eventId: string; actorType: string; occurredAt: Date }>, report: Pick<GitSnapshotReport, 'written' | 'deleted' | 'repairs'>): string {
  const real = events.filter((e) => e.eventId.startsWith('event:'));
  const actors = new Map<string, number>();
  for (const e of real) actors.set(e.actorType, (actors.get(e.actorType) ?? 0) + 1);
  const times = real.map((e) => e.occurredAt.getTime()).sort((a, b) => a - b);
  const lines = [`snapshot(${domain}): ${report.written.length} written, ${report.deleted.length} deleted`, ''];
  if (real.length) {
    lines.push(`Events: ${real.length}, ${new Date(times[0]!).toISOString()} .. ${new Date(times[times.length - 1]!).toISOString()}`);
    lines.push(`Operators: ${[...actors].map(([k, n]) => `${k} x${n}`).join(', ')}`);
  }
  if (events.some((e) => e.eventId.startsWith('reconcile:'))) lines.push('Reconciliation: daily');
  if (report.repairs.length) lines.push(`Repairs: ${report.repairs.length}`);
  return lines.join('\n');
}

/**
 * One pass for a site (no lease taken: `processGitSnapshotQueue` holds it). Never throws for a Git failure: the report
 * says `failed` with a redacted error.
 */
async function syncSiteSnapshot(
  db: Database,
  siteId: string,
  deps: GitSnapshotDeps = {},
  events: Array<{ eventId: string; actorType: string; occurredAt: Date }> = [],
): Promise<GitSnapshotReport> {
  const now = deps.now ?? (() => new Date());
  const empty = { written: [] as string[], deleted: [] as string[], repairs: [] as GitSnapshotReport['repairs'] };
  const [repo] = await runSiteTransaction(db, siteId, (tx) => tx.select().from(gitSnapshotRepos).where(eq(gitSnapshotRepos.siteId, siteId)));
  if (!repo?.enabled) return { siteId, domain: null, status: 'off', commit: null, ...empty };
  let auth: GitAuth | null = null;
  try {
    if (repo.credentialEncrypted) {
      if (!deps.encryptionKey) throw new Error('ENCRYPTION_KEY is not set: the repository token cannot be opened');
      auth = { username: repo.username || 'x-access-token', token: await openCredential(deps.encryptionKey, siteId, repo.credentialEncrypted) };
    }
  } catch (err) {
    return finish(db, siteId, now(), { siteId, domain: null, status: 'failed', commit: null, ...empty, error: err instanceof Error ? err.message.slice(0, 300) : 'credential' });
  }

  const snapshot = await readSiteSnapshot(db, siteId);
  if (!snapshot) return finish(db, siteId, now(), { siteId, domain: null, status: 'no-domain', commit: null, ...empty });
  const domain = safeDomain(snapshot.domain);
  const files = siteFiles(snapshot);
  const desired = new Map(files.map((f) => [f.path, f]));
  const manifest = await runSiteTransaction(db, siteId, (tx) =>
    tx.select({ path: gitSnapshotFiles.path, contentHash: gitSnapshotFiles.contentHash }).from(gitSnapshotFiles).where(eq(gitSnapshotFiles.siteId, siteId)),
  );
  const known = new Map(manifest.map((m) => [m.path, m.contentHash]));

  const workRoot = deps.workRoot ?? snapshotWorkRoot();
  const work = join(workRoot, /^[A-Za-z0-9_-]{1,100}$/.test(siteId) ? siteId : sha256(siteId).slice(0, 32));
  const report: GitSnapshotReport = { siteId, domain, status: 'nothing', commit: null, ...empty };
  try {
    const remote = await validateRemoteUrl(repo.remoteUrl);
    const port = remote.url.port || '443';
    const opts: GitRunOptions = {
      cwd: work,
      auth,
      allowFile: remote.kind === 'file' && fileRemotesAllowed(),
      // git connects to the addresses vetted above, never to a fresh (rebound) answer.
      resolve: remote.kind === 'https' ? remote.resolvedIps.map((ip) => `${remote.url.hostname}:${port}:${ip.includes(':') ? `[${ip}]` : ip}`) : [],
      timeoutMs: deps.timeoutMs,
      author: { name: repo.authorName, email: repo.authorEmail },
    };
    await mkdir(work, { recursive: true });
    const git = (...args: string[]) => runGit(args, opts);
    if (!(await readMaybe(join(work, '.git', 'HEAD')))) {
      await git('init', '-q');
      await git('remote', 'add', 'origin', repo.remoteUrl);
    } else {
      await git('remote', 'set-url', 'origin', repo.remoteUrl);
    }
    const branch = repo.branch;
    const heads = await git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`);
    if (heads.trim()) {
      await git('fetch', '-q', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
      await git('checkout', '-q', '-f', '-B', branch, `refs/remotes/origin/${branch}`);
      await git('reset', '-q', '--hard', `refs/remotes/origin/${branch}`);
    } else {
      // An empty remote: start the branch from nothing.
      await git('symbolic-ref', 'HEAD', `refs/heads/${branch}`);
      await git('read-tree', '--empty');
    }
    await git('clean', '-q', '-f', '-d', '-x');

    // Write what is published; record what differs from the last pushed commit as a repair.
    for (const f of files) {
      const abs = inside(work, f.path);
      const onDisk = await readMaybe(abs);
      if (onDisk === f.content) continue;
      const hash = sha256(f.content);
      if (known.get(f.path) === hash) report.repairs.push({ path: f.path, kind: onDisk === null ? 'restored' : 'overwritten' });
      else report.written.push(f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, 'utf8');
    }
    // Remove what is no longer published: the site's current directory, and every path the last commit held for the
    // site (an old domain, slug or date). Other sites' directories are never touched.
    const present = (await listFiles(join(work, 'websites', domain))).map((p) => `websites/${domain}/${p}`);
    const stale = new Set([...present, ...known.keys()].filter((p) => !desired.has(p)));
    for (const p of stale) {
      const abs = inside(work, p);
      if ((await readMaybe(abs)) === null) continue;
      await rm(abs, { force: true });
      if (known.has(p)) report.deleted.push(p);
      else report.repairs.push({ path: p, kind: 'removed-extra' });
    }

    await git('add', '-A');
    const changed = (await git('status', '--porcelain')).trim();
    if (changed) {
      const queued = events.length ? events : [{ eventId: 'reconcile:manual', actorType: 'system', occurredAt: now() }];
      await git('commit', '-q', '-m', commitMessage(domain, queued, report));
      await git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
      report.commit = (await git('rev-parse', 'HEAD')).trim();
      report.status = 'pushed';
    }
    await saveManifest(db, siteId, files);
    return finish(db, siteId, now(), report);
  } catch (err) {
    const message = err instanceof GitCommandError ? err.message : redact(err instanceof Error ? err.message : String(err), auth);
    return finish(db, siteId, now(), { ...report, status: 'failed', commit: null, error: message });
  }
}

async function saveManifest(db: Database, siteId: string, files: SnapshotFile[]): Promise<void> {
  await runSiteTransaction(db, siteId, async (tx) => {
    const paths = files.map((f) => f.path);
    await tx.delete(gitSnapshotFiles).where(and(eq(gitSnapshotFiles.siteId, siteId), paths.length ? notInArray(gitSnapshotFiles.path, paths) : undefined));
    for (let i = 0; i < files.length; i += 500) {
      await tx
        .insert(gitSnapshotFiles)
        .values(files.slice(i, i + 500).map((f) => ({ siteId, path: f.path, itemId: f.itemId, contentHash: sha256(f.content), updatedAt: new Date() })))
        .onConflictDoUpdate({ target: [gitSnapshotFiles.siteId, gitSnapshotFiles.path], set: { contentHash: sqlExcluded('content_hash'), itemId: sqlExcluded('item_id'), updatedAt: new Date() } });
    }
  });
}

const sqlExcluded = (col: string) => sql.raw(`excluded.${col}`);

async function finish(db: Database, siteId: string, at: Date, report: GitSnapshotReport): Promise<GitSnapshotReport> {
  await runSiteTransaction(db, siteId, (tx) =>
    tx
      .update(gitSnapshotRepos)
      .set({
        lastRunAt: at,
        lastStatus: report.status,
        lastError: report.error ?? null,
        ...(report.status === 'pushed' ? { lastCommitSha: report.commit, lastPushedAt: at } : {}),
      })
      .where(eq(gitSnapshotRepos.siteId, siteId)),
  );
  return report;
}

/**
 * Work through the due sites, one at a time per site (its lease) and per row (`FOR UPDATE SKIP LOCKED`): each site's
 * due rows are taken, its pass made, and the rows deleted — or put off with a growing delay after a failure (the
 * retry). Returns each site's report.
 */
export async function processGitSnapshotQueue(db: Database, deps: GitSnapshotDeps & { limit?: number } = {}): Promise<GitSnapshotReport[]> {
  const now = deps.now ?? (() => new Date());
  const out: GitSnapshotReport[] = [];
  const tried = new Set<string>();
  while (out.length < (deps.limit ?? 20)) {
    const [pick] = await db
      .select({ siteId: gitSnapshotQueue.siteId })
      .from(gitSnapshotQueue)
      .where(
        and(
          lte(gitSnapshotQueue.dueAt, now()),
          or(isNull(gitSnapshotQueue.leasedUntil), lt(gitSnapshotQueue.leasedUntil, now())),
          tried.size ? notInArray(gitSnapshotQueue.siteId, [...tried]) : undefined,
        ),
      )
      .orderBy(asc(gitSnapshotQueue.dueAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!pick) break;
    const siteId = pick.siteId;
    tried.add(siteId);
    const token = randomUUID();
    const leaseFor = () => new Date(now().getTime() + LEASE_MS);
    const leased = await runSiteTransaction(db, siteId, async (tx) => {
      const [row] = await tx
        .update(gitSnapshotRepos)
        .set({ leasedUntil: leaseFor(), leaseToken: token })
        .where(and(eq(gitSnapshotRepos.siteId, siteId), or(isNull(gitSnapshotRepos.leasedUntil), lt(gitSnapshotRepos.leasedUntil, now()))))
        .returning({ siteId: gitSnapshotRepos.siteId });
      return !!row;
    });
    if (!leased) {
      // No repository row (configuration removed): the rows have nothing to do.
      const [exists] = await runSiteTransaction(db, siteId, (tx) => tx.select({ s: gitSnapshotRepos.siteId }).from(gitSnapshotRepos).where(eq(gitSnapshotRepos.siteId, siteId)));
      if (!exists) await db.delete(gitSnapshotQueue).where(and(eq(gitSnapshotQueue.siteId, siteId), lte(gitSnapshotQueue.dueAt, now())));
      continue;
    }
    try {
      const rows = await db
        .update(gitSnapshotQueue)
        .set({ leasedUntil: leaseFor() })
        .where(and(eq(gitSnapshotQueue.siteId, siteId), lte(gitSnapshotQueue.dueAt, now()), or(isNull(gitSnapshotQueue.leasedUntil), lt(gitSnapshotQueue.leasedUntil, now()))))
        .returning({ id: gitSnapshotQueue.id, attempts: gitSnapshotQueue.attempts, eventId: gitSnapshotQueue.eventId, actorType: gitSnapshotQueue.actorType, occurredAt: gitSnapshotQueue.occurredAt });
      if (rows.length === 0) continue;
      const report = await syncSiteSnapshot(db, siteId, deps, rows);
      out.push(report);
      if (rows.some((r) => r.eventId.startsWith('reconcile:')) && report.status !== 'failed') {
        await runSiteTransaction(db, siteId, (tx) =>
          tx
            .update(gitSnapshotRepos)
            .set({ lastReconciledAt: now(), lastReport: { at: now().toISOString(), status: report.status, commit: report.commit, written: report.written, deleted: report.deleted, repairs: report.repairs } })
            .where(eq(gitSnapshotRepos.siteId, siteId)),
        );
      }
      const ids = rows.map((r) => r.id);
      if (report.status === 'failed') {
        const attempts = Math.max(...rows.map((r) => r.attempts)) + 1;
        await db
          .update(gitSnapshotQueue)
          .set({ attempts, leasedUntil: null, lastError: report.error ?? 'failed', dueAt: new Date(now().getTime() + retryDelayMs(attempts)) })
          .where(inArray(gitSnapshotQueue.id, ids));
      } else {
        await db.delete(gitSnapshotQueue).where(inArray(gitSnapshotQueue.id, ids));
      }
    } finally {
      await runSiteTransaction(db, siteId, (tx) =>
        tx.update(gitSnapshotRepos).set({ leasedUntil: null, leaseToken: null }).where(and(eq(gitSnapshotRepos.siteId, siteId), eq(gitSnapshotRepos.leaseToken, token))),
      );
    }
  }
  return out;
}

export interface GitSnapshotReconcileResult {
  /** Sites queued for a reconciliation pass. */
  queued: string[];
  /** The passes made now (`run: true`), with what they repaired. */
  reports: GitSnapshotReport[];
}

/**
 * The reconciliation hook (task 2.4; for the unified consumer reconciliation, task 1.2): queue every enabled site (or
 * `siteIds`) for a pass due now — one row per site and day, so calling it twice a day queues once — and, with
 * `run: true`, make the due passes at once and return their reports (`repairs` lists what was restored or removed).
 * The comparison is by content hash against the published projection, so changes whose events were lost are found too.
 */
export async function reconcileGitSnapshots(
  db: Database,
  opts: GitSnapshotDeps & { siteIds?: string[]; run?: boolean } = {},
): Promise<GitSnapshotReconcileResult> {
  const now = opts.now ?? (() => new Date());
  const day = now().toISOString().slice(0, 10);
  const ids = opts.siteIds ?? (await db.select({ id: sites.id }).from(sites).orderBy(asc(sites.id))).map((r) => r.id);
  const queued: string[] = [];
  for (const id of ids) {
    await runSiteTransaction(db, id, async (tx) => {
      const [repo] = await tx.select({ enabled: gitSnapshotRepos.enabled }).from(gitSnapshotRepos).where(eq(gitSnapshotRepos.siteId, id));
      if (!repo?.enabled) return;
      await enqueueGitSnapshot(tx, id, `reconcile:${id}:${day}`, { actorType: 'system', occurredAt: now() }, now(), 0);
      queued.push(id);
    });
  }
  const reports = opts.run ? (await processGitSnapshotQueue(db, opts)).filter((r) => queued.includes(r.siteId)) : [];
  return { queued, reports };
}
