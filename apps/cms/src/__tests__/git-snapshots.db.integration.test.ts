import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import isoGit from 'isomorphic-git';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { gitSnapshotQueue, items as itemsTable, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { EventConsumerRunner, type EventConsumerDefinition } from '../modules/events/consumer-runner';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { GitSnapshotConfigService } from '../services/git-snapshots/config';
import { gitSnapshotConsumer, processGitSnapshotQueue, reconcileGitSnapshots } from '../services/git-snapshots/exporter';
import { readBlobText, readCommitFiles, writeBlobText, writeFilesTree, writeSnapshotCommit } from '../services/git-snapshots/git';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Git snapshots (HeoPress P11 tasks 2.1–2.4, 2.6, 2.7; spec publishing/git-snapshots): publish, update and unpublish
 * reach a local bare repository (file:// remote, no network; read and edited with isomorphic-git, no git program) in one commit per window; a remote that is down does not
 * stop publishing and is caught up later; the reconciliation restores files deleted or edited by hand; two languages
 * with one slug do not overwrite each other; a domain change cleans the old paths; the author is a display name only.
 */

const A = 'site_p11_gitsnap_a';
const HOST = 'gitsnap-a.example.com';
const HOST2 = 'gitsnap-new.example.com';
const TOKEN = 'tok-fake-9z8y';
const KEY = randomBytes(32).toString('base64');

/** The remote branch's commit, or null. */
const headOf = async (gitdir: string): Promise<string | null> => isoGit.resolveRef({ fs, gitdir, ref: 'refs/heads/main' }).catch(() => null);

describe.skipIf(!hasDbIntegrationUrl)('Git snapshots — DB integration', () => {
  let db: Database;
  let tmp: string;
  let bare: string;
  let work: string;
  let consumer: EventConsumerDefinition;
  let clock: number;
  const month = () => {
    const d = new Date();
    return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  /** The consumer's pass, then the worker's after the 30-second window. */
  const run = async () => {
    await new EventConsumerRunner(db).runOnce(consumer);
    clock = Math.max(clock, Date.now()) + 31_000;
    return processGitSnapshotQueue(db, { encryptionKey: KEY, workRoot: work, now: () => new Date(clock) });
  };
  /** The remote's tree: path → content. */
  const remoteFiles = async () => {
    const out = new Map<string, string>();
    const head = await headOf(bare);
    for (const [p, f] of await readCommitFiles(bare, head)) out.set(p, await readBlobText(bare, f.oid));
    return out;
  };
  const log = async () => {
    const head = await headOf(bare);
    return head ? isoGit.log({ fs, gitdir: bare, ref: 'refs/heads/main' }) : [];
  };
  const commits = async () => (await log()).length;
  /** A commit made by hand on the remote: `fn` edits its files (path → content; delete to remove). */
  const handEdit = async (fn: (files: Map<string, string>) => void) => {
    const head = await headOf(bare);
    const files = await remoteFiles();
    fn(files);
    const tree = new Map<string, { oid: string; mode: string }>();
    for (const [p, c] of files) tree.set(p, { oid: await writeBlobText(bare, c), mode: '100644' });
    const commit = await writeSnapshotCommit(bare, { tree: await writeFilesTree(bare, tree), parent: head, message: 'hand edit', author: { name: 'Hand', email: 'hand@example.com' }, at: new Date() });
    await isoGit.writeRef({ fs, gitdir: bare, ref: 'refs/heads/main', value: commit, force: true });
  };

  beforeAll(async () => {
    process.env.HEOPRESS_GIT_SNAPSHOT_ALLOW_FILE_REMOTES = 'true';
    db = await connectDbIntegration('git-snapshots');
  });
  afterAll(async () => {
    await db?.delete(sites).where(eq(sites.id, A));
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    delete process.env.HEOPRESS_GIT_SNAPSHOT_ALLOW_FILE_REMOTES;
  });
  beforeEach(async () => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = mkdtempSync(join(tmpdir(), 'heopress-gitsnap-'));
    bare = join(tmp, 'remote.git');
    work = join(tmp, 'work');
    await isoGit.init({ fs, gitdir: bare, bare: true, defaultBranch: 'main' });
    await db.delete(sites).where(eq(sites.id, A));
    await db.insert(sites).values({ id: A, name: 'Git snapshots A', defaultLanguage: 'en' });
    await upgradeSitePreset(db, A);
    await db.insert(siteDomains).values({ siteId: A, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
    await new ContentSettingsService({ db, siteId: A, actor: { userId: null } }).update({
      availableLocales: ['en', 'zh-CN'], timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug' },
      allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version,
    } as never);
    await rebuildSiteProjection(db, A);
    clock = Date.now();
    consumer = { ...gitSnapshotConsumer({ db }), name: `git-snapshots-it-${randomBytes(4).toString('hex')}` };
    await new EventConsumerRunner(db).register(consumer);
    await new GitSnapshotConfigService({ db, siteId: A, encryptionKey: KEY }).update({ enabled: true, remoteUrl: `file://${bare}`, branch: 'main', token: TOKEN });
  });

  const items = () => new ItemService({ db, siteId: A });
  const version = async (id: string) => (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, id)))[0]!.v;
  const patch = async (id: string, p: Record<string, unknown>) => items().patch('articles', id, { ...p, expectedVersion: await version(id) });
  const article = (slug: string, data: Record<string, unknown> = {}) =>
    items().create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', body: '<p>Hello <strong>world</strong>.</p><p><img src="https://cdn.example.com/a.png" alt="A"></p>', ...data }, status: 'published' }) as Promise<{ id: string }>;

  it('the token is sealed: never in the configuration view, the database row as plain text, a report or an error', async () => {
    const view = await new GitSnapshotConfigService({ db, siteId: A, encryptionKey: KEY }).get();
    expect(view).toMatchObject({ enabled: true, hasToken: true, tokenHint: '••••9z8y' });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    const raw = await db.execute(`SELECT credential_encrypted FROM lumibase_git_snapshot_repos WHERE site_id = '${A}'`).catch(() => null);
    if (raw) expect(JSON.stringify(raw)).not.toContain(TOKEN);
    // https only (file:// only when allowed), no credentials in the URL.
    process.env.HEOPRESS_GIT_SNAPSHOT_ALLOW_FILE_REMOTES = 'false';
    await expect(new GitSnapshotConfigService({ db, siteId: A, encryptionKey: KEY }).update({ enabled: true, remoteUrl: `file://${bare}`, version: view.version! })).rejects.toThrow(/https/);
    process.env.HEOPRESS_GIT_SNAPSHOT_ALLOW_FILE_REMOTES = 'true';
    await expect(new GitSnapshotConfigService({ db, siteId: A, encryptionKey: KEY }).update({ enabled: true, remoteUrl: 'https://user:pw@git.example.com/r.git', version: view.version! })).rejects.toThrow(/token field/);
  });

  it('publish, update and unpublish: one file per article, whitelisted front matter, a commit per window, the file deleted on unpublish', async () => {
    const author = (await items().create('authors', { data: { name: 'Ada Writer', slug: 'ada', user: 'usr_internal_42', bio: 'ada@example.com' }, status: 'published' })) as { id: string };
    const a = await article('hello', { author: author.id, source_url: 'https://source.example.com/x', source_attribution: 'Source Ltd', source_license: 'cc-by', seo_title: 'Hello SEO' });
    await article('second');
    const [report] = await run();
    expect(report).toMatchObject({ siteId: A, status: 'pushed' });
    const path = `websites/${HOST}/${month()}/hello/index.md`;
    const files = await remoteFiles();
    expect(files.has(path)).toBe(true);
    expect(files.has(`websites/${HOST}/${month()}/second/index.md`)).toBe(true);
    expect(files.has(`websites/${HOST}/_site/site.json`)).toBe(true);
    expect(await commits()).toBe(1); // both publications in one commit
    const doc = files.get(path)!;
    for (const key of ['id', 'title', 'slug', 'locale', 'translationGroup', 'publishedAt', 'contentModifiedAt', 'author', 'source', 'seo']) expect(doc).toMatch(new RegExp(`^${key}:`, 'm'));
    expect(doc).toContain(`id: "${a.id}"`);
    expect(doc).toContain('author: "Ada Writer"');
    expect(doc).toContain('licenseStatus: "cc-by"');
    expect(doc).toContain('**world**');
    expect(doc).toContain('https://cdn.example.com/a.png');
    // ADR-0013: no user id, e-mail or other personal data anywhere in the repository.
    const all = [...(await remoteFiles()).values()].join('\n') + (await log()).map((c) => `${c.commit.author.name} ${c.commit.author.email} ${c.commit.message}`).join('\n');
    expect(all).not.toContain('usr_internal_42');
    expect(all).not.toContain('ada@example.com');
    expect(all).not.toContain(TOKEN);
    expect((await log())[0]!.commit.message).toMatch(/Events: \d+/);

    await patch(a.id, { data: { body: '<p>Updated text.</p>' } });
    await run();
    expect((await remoteFiles()).get(path)).toContain('Updated text.');
    expect(await commits()).toBe(2);

    await patch(a.id, { status: 'draft' });
    await run();
    expect((await remoteFiles()).has(path)).toBe(false);
    expect(await commits()).toBe(3);
    // Nothing changed: nothing committed.
    await reconcileGitSnapshots(db, { siteIds: [A], run: true, encryptionKey: KEY, workRoot: work, now: () => new Date(clock) });
    expect(await commits()).toBe(3);
  });

  it('a remote that is down does not stop publishing; the snapshot is pushed once it is back, once', async () => {
    const moved = `${bare}.away`;
    renameSync(bare, moved);
    const a = await article('offline');
    expect(a.id).toBeTruthy(); // published
    const [failed] = await run();
    expect(failed!.status).toBe('failed');
    expect(failed!.error ?? '').not.toContain(TOKEN);
    const [row] = await db.select().from(gitSnapshotQueue).where(eq(gitSnapshotQueue.siteId, A));
    expect(row!.attempts).toBe(1);
    renameSync(moved, bare);
    clock += 60 * 60_000;
    const [ok] = await processGitSnapshotQueue(db, { encryptionKey: KEY, workRoot: work, now: () => new Date(clock) });
    expect(ok!.status).toBe('pushed');
    expect((await remoteFiles()).has(`websites/${HOST}/${month()}/offline/index.md`)).toBe(true);
    expect(await commits()).toBe(1);
    expect(await db.select().from(gitSnapshotQueue).where(eq(gitSnapshotQueue.siteId, A))).toHaveLength(0);
  });

  it('the reconciliation restores a file deleted by hand and a body edited by hand, removes stray files, and reports it', async () => {
    await article('keep');
    await run();
    const path = `websites/${HOST}/${month()}/keep/index.md`;
    await handEdit((files) => {
      files.delete(path);
    });
    expect((await remoteFiles()).has(path)).toBe(false);
    const result = await reconcileGitSnapshots(db, { siteIds: [A], run: true, encryptionKey: KEY, workRoot: work, now: () => new Date(clock) });
    expect(result.queued).toEqual([A]);
    expect(result.reports[0]!.repairs).toEqual([{ path, kind: 'restored' }]);
    expect((await remoteFiles()).has(path)).toBe(true);
    const view = await new GitSnapshotConfigService({ db, siteId: A, encryptionKey: KEY }).get();
    expect(JSON.stringify(view.status.lastReport)).toContain(path);

    await handEdit((files) => {
      files.set(path, `${files.get(path)}tampered\n`);
    });
    clock += 24 * 60 * 60_000;
    const again = await reconcileGitSnapshots(db, { siteIds: [A], run: true, encryptionKey: KEY, workRoot: work, now: () => new Date(clock) });
    expect(again.reports[0]!.repairs).toEqual([{ path, kind: 'overwritten' }]);
    expect((await remoteFiles()).get(path)).not.toContain('tampered');
  });

  it('two languages with one slug in one month keep both files; a domain change writes the new paths and cleans the old ones', async () => {
    await article('same', { locale: 'en' });
    await article('same', { locale: 'zh-CN', title: '同名' });
    await run();
    let files = await remoteFiles();
    expect(files.has(`websites/${HOST}/${month()}/same/index.md`)).toBe(true);
    expect(files.has(`websites/${HOST}/${month()}/same--zh-cn/index.md`)).toBe(true);
    expect(files.get(`websites/${HOST}/${month()}/same--zh-cn/index.md`)).toContain('同名');

    await db.update(siteDomains).set({ hostname: HOST2 }).where(eq(siteDomains.siteId, A));
    await rebuildSiteProjection(db, A);
    clock += 24 * 60 * 60_000;
    await reconcileGitSnapshots(db, { siteIds: [A], run: true, encryptionKey: KEY, workRoot: work, now: () => new Date(clock) });
    files = await remoteFiles();
    expect([...files.keys()].some((p) => p.startsWith(`websites/${HOST}/`))).toBe(false);
    expect(files.has(`websites/${HOST2}/${month()}/same/index.md`)).toBe(true);
    expect(files.has(`websites/${HOST2}/${month()}/same--zh-cn/index.md`)).toBe(true);
    // No secrets or drafts: the site configuration holds no key-like field, and a draft never appears.
    await items().create('articles', { data: { title: 'Draft only', slug: 'draft-only', locale: 'en' }, status: 'draft' });
    await run();
    files = await remoteFiles();
    expect([...files.keys()].some((p) => p.includes('draft-only'))).toBe(false);
    expect(files.get(`websites/${HOST2}/_site/site.json`)).not.toMatch(/"[^"]*(secret|token|password)[^"]*":/i);
    void inArray;
  });
});
