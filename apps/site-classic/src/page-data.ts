import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Database } from '@heopress/database';
import { PAGE_DATA_VERSION, STATIC_UNSUPPORTED, assertPageDataSnapshot, isSafeSitePath, type PageDataFile, type PageDataPage, type PageDataSnapshot } from '@heopress/contracts/page-data';
import { assertViewModel, publicUrlOf, seoHeadHtml } from '@heopress/public-site';
import { sameLocale } from '@heopress/contracts/schemas';
import { createSiteClassic } from './app';
import { renderPort } from './read-port';
import { buildPage, type PageInput } from './view-model';
import { feedPath } from './discovery-plan';

/**
 * The page data interface of the Astro engine (HeoPress P11 tasks 3.1, 3.5; spec rendering/astro-engine; ADR-0005 §3):
 * one site's pages and machine-readable files, of one pinned published revision, as the page data contract
 * (`@heopress/contracts/page-data`) describes them.
 *
 * Made by the Classic engine itself — the same request handling, path resolution, indexing decision, head, sanitised
 * body, `rel="sponsored"` and discovery files — with the theme render swapped for the page data (`renderer`) and the page
 * cache off: the two engines cannot drift apart. It reads as the rendering role (the public projection only).
 *
 * The snapshot is pinned: the site's render version is read before and after the export, and an export that saw a
 * publication land in between is made again (at most `attempts` times), so every page and file is of one revision.
 *
 * `servePageData` serves a made snapshot read-only on the loopback interface to one build, with a one-time bearer token:
 * the build process gets that address and token, never a database URL or a CMS credential.
 */

const NOT_FOUND_PROBE = '/__heopress-not-found__/';
const KEPT_HEADERS = ['x-robots-tag', 'link', 'x-content-type-options', 'content-security-policy'];

export class StaleSnapshotError extends Error {
  readonly code = 'PAGE_DATA_STALE';
}

export interface ExportPageDataOptions {
  /** A connection as the rendering role. */
  db: Database;
  siteId: string;
  /** The clock (the news sitemap's window). */
  now?: () => number;
  /** Exports tried before giving up when publications keep landing (default 3). */
  attempts?: number;
}

/** The page data of one page, as the renderer swap answers it (JSON in place of the theme's HTML). */
function pageDataJson(page: PageInput): Promise<string> {
  const { vm, system } = buildPage(page);
  assertViewModel(vm);
  return Promise.resolve(
    JSON.stringify({
      vm,
      headHtml: seoHeadHtml(system.head!, vm.site.name),
      bodies: system.bodies,
      disclosureRequired: system.disclosureRequired,
      disclosures: system.disclosures,
    }),
  );
}

interface Planned {
  revision: number;
  host: string;
  name: string;
  defaultLanguage: string;
  pagePaths: string[];
  filePaths: string[];
}

export async function exportPageData(opts: ExportPageDataOptions): Promise<PageDataSnapshot> {
  const now = opts.now ?? Date.now;
  const port = renderPort(opts.db, now);
  const classic = createSiteClassic({ db: opts.db, now, traffic: false, sweepIntervalMs: 0, renderer: (_siteId, page) => pageDataJson(page) });
  try {
    for (let attempt = 1; attempt <= (opts.attempts ?? 3); attempt++) {
      const plan = await planOf(port, opts.siteId);
      const snapshot = await collect(classic.app, opts.siteId, plan);
      const after = await port.request(opts.siteId, (_p, reads) => reads.renderVersion());
      if (after === plan.revision) {
        assertPageDataSnapshot(snapshot);
        return snapshot;
      }
    }
    throw new StaleSnapshotError(`site ${opts.siteId}: publications kept landing during the export`);
  } finally {
    await classic.close();
  }
}

async function planOf(port: ReturnType<typeof renderPort>, siteId: string): Promise<Planned> {
  return port.request(siteId, async (_p, reads) => {
    const info = await reads.site();
    const host = await reads.primaryHost();
    if (!info || !host) throw new Error(`site ${siteId}: no public site or no primary host`);
    const revision = await reads.renderVersion();
    const space = await reads.space(host);
    const locales = Array.isArray(info.settings.availableLocales) ? (info.settings.availableLocales as string[]) : [info.defaultLanguage];
    const onHost = (url: string | null | undefined): string | null => {
      if (!url) return null;
      try {
        const u = new URL(url);
        return u.host.toLowerCase() === host.toLowerCase() && u.protocol === 'https:' ? u.pathname : null;
      } catch {
        return null;
      }
    };
    const pages = new Set<string>();
    for (const l of locales) {
      const home = onHost(publicUrlOf(space, l, '/'));
      if (home) pages.add(home);
    }
    for (const row of await reads.sitemapItems()) {
      const path = onHost((row.card as { url?: string }).url);
      if (path) pages.add(path);
    }
    const files = new Set(['/robots.txt', '/sitemap.xml', '/sitemap.txt', '/news-sitemap.xml', '/llms.txt', '/llms-full.txt']);
    for (const l of locales) {
      const suffix = sameLocale(l, info.defaultLanguage) ? null : l;
      for (const format of ['rss', 'atom'] as const) for (const collection of [null, 'pages']) files.add(feedPath(format, collection, suffix));
    }
    for (const name of await reads.rootFileNames()) files.add(`/${name}`);
    const key = info.seo.discovery.indexNow ? info.seo.discovery.indexNowKey : null;
    if (key) files.add(`/${key}.txt`);
    return { revision, host, name: info.name, defaultLanguage: info.defaultLanguage, pagePaths: [...pages].filter(isSafeSitePath).sort(), filePaths: [...files] };
  });
}

type App = ReturnType<typeof createSiteClassic>['app'];

async function collect(app: App, siteId: string, plan: Planned): Promise<PageDataSnapshot> {
  const get = (path: string) => app.request(`http://${plan.host}${path}`, { headers: { host: plan.host } });
  const keep = (res: Response) => Object.fromEntries(KEPT_HEADERS.flatMap((h) => (res.headers.get(h) ? [[h, res.headers.get(h)!]] : [])));
  const pageOf = async (path: string, res: Response): Promise<PageDataPage> => {
    const data = (await res.json()) as Omit<PageDataPage, 'path' | 'status' | 'xRobotsTag'>;
    return { path, status: res.status, ...data, xRobotsTag: res.headers.get('x-robots-tag') };
  };
  const pages: PageDataPage[] = [];
  const files = new Map<string, PageDataFile>();
  const fileQueue = [...plan.filePaths];
  const sameHost = (url: string): string | null => {
    try {
      const u = new URL(url);
      return u.host.toLowerCase() === plan.host.toLowerCase() ? u.pathname : null;
    } catch {
      return null;
    }
  };
  for (const path of plan.pagePaths) {
    const res = await get(path);
    // A redirect (an old path) or a status page is not a page of the static output.
    if (res.status !== 200) continue;
    const page = await pageOf(path, res);
    pages.push(page);
    // The page's own machine-readable copies and feeds, when they are on this host.
    for (const m of page.headHtml.matchAll(/<link rel="alternate" type="(?:text\/markdown|application\/rss\+xml|application\/atom\+xml)"[^>]*href="([^"]+)"/g)) {
      const at = sameHost(m[1]!.replace(/&amp;/g, '&'));
      if (at) fileQueue.push(at);
    }
  }
  const notFoundRes = await get(NOT_FOUND_PROBE);
  const notFound = notFoundRes.status === 404 && (notFoundRes.headers.get('content-type') ?? '').includes('html') ? await pageOf('/404.html', notFoundRes).catch(() => null) : null;
  for (let i = 0; i < fileQueue.length; i++) {
    const path = fileQueue[i]!;
    if (files.has(path) || !isSafeSitePath(path) || path.endsWith('/')) continue;
    const res = await get(path);
    if (res.status !== 200) continue;
    const body = await res.text();
    files.set(path, { path, contentType: res.headers.get('content-type') ?? 'application/octet-stream', body, headers: keep(res) });
    // The sitemap index names its shards; robots.txt names the sitemaps.
    if (path === '/sitemap.xml') for (const m of body.matchAll(/<loc>([^<]+)<\/loc>/g)) fileQueue.push(sameHost(m[1]!) ?? '');
    if (path === '/robots.txt') for (const m of body.matchAll(/^Sitemap:\s*(\S+)/gim)) fileQueue.push(sameHost(m[1]!) ?? '');
  }
  return {
    version: PAGE_DATA_VERSION,
    siteId,
    revision: plan.revision,
    host: plan.host,
    origin: `https://${plan.host}`,
    name: plan.name,
    defaultLanguage: plan.defaultLanguage,
    pages,
    notFound,
    files: [...files.values()].filter((f) => !pages.some((p) => p.path === f.path)),
    unsupported: [...STATIC_UNSUPPORTED],
  };
}

export interface PageDataServer {
  /** `http://127.0.0.1:<port>/v1/page-data`. */
  url: string;
  /** The bearer token this one build presents. */
  token: string;
  close(): Promise<void>;
}

/**
 * Serve one pinned snapshot, read-only, on the loopback interface: `GET /v1/page-data` with the token answers it; any
 * other method, path or token answers nothing useful. The token is random per build and dies with the server.
 */
export async function servePageData(snapshot: PageDataSnapshot): Promise<PageDataServer> {
  const token = randomBytes(24).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  const body = JSON.stringify(snapshot);
  const server: Server = createServer((req, res) => {
    const given = Buffer.from(req.headers.authorization ?? '');
    const authorised = given.length === expected.length && timingSafeEqual(given, expected);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    if (req.url !== '/v1/page-data' || !authorised) {
      res.writeHead(req.url === '/v1/page-data' ? 401 : 404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/page-data`,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
