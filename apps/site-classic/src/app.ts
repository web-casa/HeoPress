import { Hono, type Context } from 'hono';
import type { HttpBindings } from '@hono/node-server';
import type { Database } from '@heopress/database';
import { pageTypeOfCollection, type SitemapEntry } from '@heopress/seo-geo';
import {
  assertViewModel,
  BRANCH_PREVIEW_COOKIE,
  BRANCH_PREVIEW_EXCHANGE_PREFIX,
  branchPreviewCookieOf,
  verifyBranchPreviewCookie,
  BUILTIN_THEME,
  BUILTIN_THEME_ID,
  extensionStubs,
  isSystemPathSegment,
  publicUrlOf,
  RenderError,
  RenderPool,
  resolvePublicPathWith,
  type PreviewPolicy,
  type PublicPathResult,
  type RenderPoolOptions,
  type ThemeAsset,
} from '@heopress/public-site';
import { cachedPage, cacheKey, cacheQuery, matchesEtag, isRedirectTarget, PageCache, redirectLocation, type CachedPage } from './cache';
import { clientAddress, parseTarget, requestHost, trustedProxies } from './host';
import { statusPage } from './html';
import { addressHasher, crawlHitOf, TrafficRecorder } from './ai-traffic';
import {
  BRANCH_PREVIEW_HEADERS,
  branchPreviewPort,
  PREVIEW_COOKIE,
  previewConfig,
  previewHeaders,
  previewToken,
  resolveBranch,
  resolvePreview,
  type PreviewOptions,
} from './preview';
import { renderPort, type SiteReads } from './read-port';
import { buildPage, homeCanonical, pageHeadOf, pagedUrl, type PageInput, type SiteInfo } from './view-model';
import { discoveryAnswer, discoveryFileOf, type DiscoveryAnswer } from './discovery-plan';
import { markdownCopyAnswer } from './markdown-copy';
import { markdownUrlOf } from './discovery';
import { classicTemplateName, EMPTY_PUBLIC_EXTENSIONS, itemRouteOf, listRouteAt, type PublicExtensions } from '@heopress/contracts/extensions';

/**
 * The classic rendering service (HeoPress P06 tasks 1.1–1.4, 2.1, 2.2, 4.1; spec rendering/classic-engine):
 * one process for every site, the site from the request's host.
 *
 *   - `/admin`, `/api`, `/internal` → 404 first, on every host and for every method;
 *   - unknown, pending or disabled host → 404 (plain text, no default site); then only GET and HEAD;
 *   - system paths (discovery and site root files, `isSystemPathSegment`; P07 task 1.5) before any content;
 *   - a site waiting for a projection rebuild answers 503 before anything else (no redirect either);
 *   - a plain alias → one 301 to the final address on the primary domain;
 *   - the path resolves (shared resolver, `@heopress/public-site`) to an item (200), a redirect (301), a
 *     deleted once-public item (410) or nothing (404); the site's root of each language is its home
 *     page, `/search` its search page;
 *   - pages are rendered by the site's theme in the rendering pool (worker threads: a runaway template is
 *     terminated, other sites keep being served); a theme failure gives the site's error page, or the
 *     built-in minimal one — never a stack or an internal path;
 *   - the language never comes from `Accept-Language`;
 *   - previews only on the preview origin (`./preview.ts`), never cached.
 */

export interface SiteClassicOptions {
  /** A connection as the rendering role (it can read the public projection only). */
  db: Database;
  /** `HEOPRESS_TRUSTED_PROXIES`: only these peers' `X-Forwarded-Host` counts. */
  trustedProxies?: string;
  /** The rendering pool's limits (one pool per process). */
  pool?: RenderPoolOptions;
  /** This process's page cache size, bytes (level 1; default 64 MB). */
  cacheBytes?: number;
  /** How often expired and superseded level-2 entries are swept, ms (default 60 s; 0: never). */
  sweepIntervalMs?: number;
  /** Previews on their own origin (off without it). */
  preview?: PreviewOptions;
  /** The clock (ms; tests set it): the news sitemap's window and the expiry of answers that depend on the time. */
  now?: () => number;
  /** AI traffic (P07 task 6.1): recorded unless `false`; tests pass their own recorder. */
  traffic?: TrafficRecorder | false;
  /** The connection AI traffic is written on (its own small pool, never one a page needs); the default: `db`. */
  trafficDb?: Database;
  /**
   * Make a page's answer some other way than with the site's theme (P11 task 3.1: the page data interface answers the
   * page data, as JSON, the Astro engine renders). With it, the page cache is neither read nor written.
   */
  renderer?: (siteId: string, page: PageInput) => Promise<string>;
}

export interface SiteClassic {
  app: Hono<{ Bindings: HttpBindings }>;
  close(): Promise<void>;
}

const PAGE_SIZE = 10;
const ADMIN_SEGMENTS = new Set(['admin', 'api', 'internal']);
const HTML = { 'content-type': 'text/html; charset=utf-8' };
/** Revalidate every time (a 304 costs one snapshot read); shared caches may keep it a few seconds (R8: within 10 s). */
const CACHEABLE = 'public, max-age=0, must-revalidate, s-maxage=5';

/** `?page=N`: 1 when absent, null when not a page number. */
/**
 * The site's own origin: that of its default language's home, on its primary host under every language strategy —
 * where its one identity hangs in the structured data of every language (P07 task 2.12, Codex review of batch 5a).
 */
function siteOrigin(space: Parameters<typeof publicUrlOf>[0], defaultLanguage: string): string | null {
  const home = publicUrlOf(space, defaultLanguage, '/');
  if (!home || !/^https?:\/\//.test(home)) return null;
  return new URL('/', home).toString();
}

function pageOf(params: URLSearchParams): number | null {
  const raw = params.get('page');
  if (raw === null) return 1;
  return /^[1-9]\d{0,5}$/.test(raw) ? Number(raw) : null;
}

/** The same path with `page` (none on page 1) beside the other parameters. */
function pageUrl(path: string, page: number, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params);
  if (page > 1) q.set('page', String(page));
  const qs = q.toString();
  return qs ? `${path}?${qs}` : path;
}

/** The site's active theme version, or null for the built-in theme. */
type ActiveTheme = { versionId: string; templates: Record<string, string>; assets: ThemeAsset[] } | null;

/** What a request comes to, decided inside the read transaction; rendered after it. */
type Plan =
  | { kind: 'cached'; page: CachedPage; shared: boolean }
  /** `base`: the target without the request's query (appended when served, as the resolver does). */
  | { kind: 'redirect'; base: string }
  /** A system path that names nothing (or a discovery file the site turned off): not found (P07 task 1.5). */
  | { kind: 'system' }
  /** A discovery file (P07 tasks 3.1, 3.3, 3.7), freshly made. */
  | { kind: 'discovery'; answer: DiscoveryAnswer }
  | { kind: 'page'; site: SiteInfo; page: PageInput }
  | { kind: 'status'; status: number; site: SiteInfo | null; locale: string; homeUrl: string };

export function createSiteClassic(opts: SiteClassicOptions): SiteClassic {
  const now = opts.now ?? Date.now;
  const port = renderPort(opts.db, now);
  const trusted = trustedProxies(opts.trustedProxies);
  const pool = new RenderPool(opts.pool);
  const useCache = !opts.renderer;
  const cache = new PageCache(opts.db, { maxBytes: opts.cacheBytes ?? 64 * 1024 * 1024, now });
  /**
   * The sitemap entries of the last few (site, host, render version)s (P07 task 3.1, Codex review of batch 6): the
   * index, every shard and `sitemap.txt` of one version are cut from one list, made once in this process — within a
   * byte budget of their own (a list larger than half of it is not kept); and each version's item count.
   */
  const sitemapMemo = new Map<string, { entries: Promise<SitemapEntry[]>; bytes: number }>();
  const MEMO_BYTES = Math.max(1, Math.floor((opts.cacheBytes ?? 64 * 1024 * 1024) / 2));
  let memoBytes = 0;
  const forget = (k: string) => {
    const old = sitemapMemo.get(k);
    if (!old) return;
    sitemapMemo.delete(k);
    memoBytes -= old.bytes;
  };
  const memoFor = (k: string) => ({
    get: () => {
      const hit = sitemapMemo.get(k);
      if (!hit) return undefined;
      sitemapMemo.delete(k);
      sitemapMemo.set(k, hit);
      return hit.entries;
    },
    set: (entries: Promise<SitemapEntry[]>) => {
      forget(k);
      const slot = { entries, bytes: 0 };
      sitemapMemo.set(k, slot);
      entries.then(
        (list) => {
          if (sitemapMemo.get(k) !== slot) return;
          // UTF-16 strings: two bytes a character, and some for each entry.
          // A slot costs something even when its list is empty (the slot, the promise, the key).
          const bytes = 512 + k.length * 2 + list.reduce((n, e) => n + 64 + 2 * (e.loc.length + (e.lastmod?.length ?? 0) + e.alternates.reduce((m, a) => m + 32 + 2 * (a.locale.length + a.url.length), 0)), 0);
          if (bytes > MEMO_BYTES / 2) {
            forget(k);
            return;
          }
          slot.bytes = bytes;
          memoBytes += bytes;
          for (const old of [...sitemapMemo.keys()]) {
            if (memoBytes <= MEMO_BYTES && sitemapMemo.size <= 32) break;
            if (old !== k) forget(old);
          }
        },
        // A failed read is not kept.
        () => forget(k),
      );
    },
  });
  const countMemo = new Map<string, Promise<number>>();
  const countFor = (k: string, read: () => Promise<number>) => {
    let hit = countMemo.get(k);
    if (!hit) {
      hit = read();
      countMemo.set(k, hit);
      hit.catch(() => countMemo.delete(k));
      for (const old of countMemo.keys()) {
        if (countMemo.size <= 64) break;
        countMemo.delete(old);
      }
    }
    return hit;
  };
  const sweepEvery = opts.sweepIntervalMs ?? 60_000;
  const sweeper = sweepEvery > 0 ? setInterval(() => void cache.sweep().catch(() => undefined), sweepEvery) : null;
  sweeper?.unref();
  const app = new Hono<{ Bindings: HttpBindings }>();
  // AI traffic (P07 tasks 6.1, 6.4): every answer of the public site — cache hits too — to a known crawler or an
  // AI-referred visit, after it is made; never on the preview origin, never for an administration path.
  const trafficPort = opts.trafficDb ? renderPort(opts.trafficDb, now) : port;
  const traffic = opts.traffic === false ? null : (opts.traffic ?? new TrafficRecorder((hit) => trafficPort.recordCrawlHit(hit)));
  const hashAddress = addressHasher();
  if (traffic) {
    app.use('*', async (c, next) => {
      await next();
      const target = parseTarget(c.env?.incoming?.url ?? new URL(c.req.url).pathname + new URL(c.req.url).search);
      if (!target || (c.req.method !== 'GET' && c.req.method !== 'HEAD')) return;
      const peer = c.env?.incoming?.socket?.remoteAddress;
      const host = requestHost({ host: target.authority ?? c.req.header('host'), forwardedHost: c.req.header('x-forwarded-host') }, peer, trusted);
      if (!host || (preview && host === preview.host)) return;
      // The administration paths as the handler reads them: percent-escapes decoded (`/%61dmin`; Codex review of batch 11).
      let first = (target.path.split('/')[1] ?? '').toLowerCase();
      try {
        first = decodeURIComponent(first).toLowerCase();
      } catch {
        return;
      }
      if (ADMIN_SEGMENTS.has(first) || target.path === '/healthz') return;
      traffic.record(
        crawlHitOf(
          {
            host,
            path: target.path,
            query: target.query,
            status: c.res.status,
            userAgent: c.req.header('user-agent'),
            referrer: c.req.header('referer'),
            address: clientAddress(c.req.header('x-forwarded-for'), peer, trusted),
          },
          hashAddress,
          undefined,
          now(),
        ),
      );
    });
  }

  /** A cacheable answer, with its validators; 304 when the client already has this 200. */
  /** `x-cache`: `hit` from this process, `hit-shared` from the shared level, `miss` when rendered now. */
  const answer = (c: Context<{ Bindings: HttpBindings }>, page: CachedPage, query: string, state: 'hit' | 'hit-shared' | 'miss') => {
    c.header('etag', page.etag);
    c.header('cache-control', CACHEABLE);
    c.header('x-cache', state);
    // The representation's own headers, the same on 200, HEAD and 304 (RFC 9110 §15.4.5).
    for (const [name, value] of Object.entries(page.headers)) c.header(name, value);
    if (page.status === 301) {
      // The whole header checked; a query that cannot be carried is dropped rather than the redirect.
      const location = redirectLocation(page.location!, query) ?? redirectLocation(page.location!, '');
      return location ? c.redirect(location, 301) : c.text('Not found', 404);
    }
    if (page.status === 200 && matchesEtag(c.req.header('if-none-match'), page.etag)) return c.body(null, 304);
    return c.body(page.body, page.status as 200, { 'content-type': page.contentType });
  };

  /**
   * The templates a site renders with (P12 tasks 2.3, 2.4): its theme version's, its enabled plugins' route templates and
   * components (`ext/<namespace>/…`; a theme template of the same name overrides the plugin's), and an empty template
   * for any plugin template the theme places that no enabled plugin provides. Made once per theme version and plugin set.
   */
  const composed = new Map<string, { versionId: string; templates: Record<string, string> }>();
  const templatesOf = (t: { versionId: string; templates: Record<string, string> }, ext: PublicExtensions) => {
    const key = `${t.versionId}\u0000${ext.hash}`;
    let hit = composed.get(key);
    if (!hit) {
      hit = { versionId: ext.hash ? `${t.versionId}+ext:${ext.hash}` : t.versionId, templates: { ...extensionStubs(t.templates, ext.classic), ...ext.classic, ...t.templates } };
      composed.set(key, hit);
      for (const old of composed.keys()) {
        if (composed.size <= 64) break;
        composed.delete(old);
      }
    }
    return hit;
  };

  /** Render with the site's active theme version (the built-in theme when it has none). */
  const render = (siteId: string, page: PageInput, theme: ActiveTheme, extra: { assetBase?: string; preview?: PreviewPolicy } = {}) => {
    if (opts.renderer) return opts.renderer(siteId, page);
    const { vm, system } = buildPage(page);
    assertViewModel(vm);
    const t = theme ?? { versionId: BUILTIN_THEME_ID, templates: BUILTIN_THEME, assets: [] };
    const set = templatesOf(t, page.site.extensions ?? EMPTY_PUBLIC_EXTENSIONS);
    // A plugin route's page: its template (the theme's own `ext/<namespace>/<template>` when it has one).
    const entry = page.route ? classicTemplateName(page.route.namespace, page.route.template) : vm.page.type;
    return pool.render({ siteId, versionId: set.versionId, templates: set.templates, assets: t.assets, entry, vm, system, ...extra });
  };

  const preview = opts.preview ? previewConfig(opts.preview) : null;
  const branchPort = branchPreviewPort(opts.preview);

  /**
   * A branch preview (P10 tasks 4.2, 4.4) on a public host: the exchange of a one-time link for the signed cookie, or
   * the branch's page for the browser that holds it. Null: not a branch answer — the request is the public site's.
   * Never consults or writes the page cache.
   */
  const serveBranch = async (c: Context<{ Bindings: HttpBindings }>, siteId: string, path: string): Promise<Response | null> => {
    if (!branchPort) return path.startsWith(BRANCH_PREVIEW_EXCHANGE_PREFIX) ? c.text('Not found', 404, BRANCH_PREVIEW_HEADERS) : null;
    if (path.startsWith(BRANCH_PREVIEW_EXCHANGE_PREFIX)) {
      const refuse = (status: 403 | 404 | 503) => c.body(statusPage(status, null), status, { ...HTML, ...BRANCH_PREVIEW_HEADERS });
      const token = path.slice(BRANCH_PREVIEW_EXCHANGE_PREFIX.length);
      if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return refuse(404);
      let res: Response;
      try {
        res = await branchPort.cms('branch-exchange', { site_id: siteId, token });
      } catch {
        return refuse(503);
      }
      if (res.status === 403 || res.status === 400) return refuse(403);
      if (!res.ok) return refuse(503);
      const { data } = (await res.json()) as { data: { cookie: string; expiresAt: string; path: string } };
      if (!/^[A-Za-z0-9_.-]{1,512}$/.test(data.cookie) || !/^\/(?!\/)[^\s]*$/.test(data.path)) return refuse(503);
      const maxAge = Math.max(1, Math.floor((new Date(data.expiresAt).getTime() - now()) / 1000));
      // Lax: the browser arrives here by a top-level navigation from Studio and follows the 303 on this site.
      c.header('set-cookie', `${BRANCH_PREVIEW_COOKIE}=${data.cookie}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`);
      return c.body(null, 303, { ...BRANCH_PREVIEW_HEADERS, location: data.path });
    }
    const cookie = branchPreviewCookieOf(c.req.header('cookie'));
    // A cookie that is not this site's, expired or altered is ignored: the public page.
    if (!cookie || !verifyBranchPreviewCookie(branchPort.secret, cookie, siteId, now())) return null;
    const target = await resolveBranch(branchPort, siteId, cookie);
    if (target === 'denied' || target === 'failed' || target.path !== path) return null;
    if (pageTypeOfCollection(target.item.collection) !== 'item') return null;
    const decided = await port.request(siteId, async (_scoped, reads) => {
      const info = await reads.site();
      if (!info) return null;
      const theme = await reads.theme();
      const primary = await reads.primaryHost();
      const space = primary ? await reads.space(primary) : null;
      const locale = target.item.locale;
      const homeUrl = (space && publicUrlOf(space, locale, '/')) ?? '/';
      const site = { ...info, origin: space ? siteOrigin(space, info.defaultLanguage) : null };
      const canonical = ((target.item.card as { url?: string }).url ?? null) || null;
      const page: PageInput = { type: 'item', site, locale, path, status: 200, homeUrl, item: target.item, alternates: await reads.alternates(target.item.itemId), canonical, ownHosts: await reads.hosts(), route: itemRouteOf(info.extensions, target.item.collection) };
      return { theme, page };
    });
    if (!decided) return null;
    for (const [k, v] of Object.entries(BRANCH_PREVIEW_HEADERS)) c.header(k, v);
    c.header('x-heopress-branch-preview', '1');
    try {
      return c.body(await render(siteId, decided.page, decided.theme), 200, HTML);
    } catch (err) {
      console.error('[site-classic] branch preview render failed', { siteId, code: (err as { code?: string }).code });
      return c.body(statusPage(500, null), 500, HTML);
    }
  };

  /**
   * A request on the preview origin (design R7, R17, R43): nothing here is cached, by this service or
   * anyone else, and the page cache is never consulted or written.
   */
  const servePreview = async (c: Context<{ Bindings: HttpBindings }>, path: string) => {
    const config = preview!;
    const headers = previewHeaders(config);
    for (const [k, v] of Object.entries(headers)) c.header(k, v);
    const refuse = (status: 403 | 404 | 502) => c.body(statusPage(status === 502 ? 503 : status, null), status === 502 ? 503 : status, HTML);
    const m = /^\/([A-Za-z0-9_-]{1,64})\/(.*)$/.exec(path);
    if (!m) return refuse(404);
    const siteId = m[1]!;
    const rest = m[2]!;

    // The exchange: the token leaves the URL at once.
    if (/^[A-Za-z0-9_-]{20,100}$/.test(rest) && rest !== 'view') {
      const target = await resolvePreview(config, siteId, rest);
      if (target === 'failed') return refuse(502);
      if (target === 'denied') return refuse(403);
      const maxAge = Math.max(1, Math.floor((new Date(target.expiresAt).getTime() - Date.now()) / 1000));
      c.header('set-cookie', `${PREVIEW_COOKIE}=${rest}; Max-Age=${maxAge}; Path=/${siteId}/; Secure; HttpOnly; SameSite=Strict`);
      c.header('location', `/${siteId}/view`);
      return c.body(null, 303);
    }
    const token = previewToken(c.req.header('cookie'));
    if (!token) return refuse(403);

    const asset = /^assets\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(rest);
    if (asset) {
      let res: Response;
      try {
        res = await config.cms('asset', { site_id: siteId, token, version_id: asset[1], sha256: asset[2], ext: asset[3] });
      } catch {
        return refuse(502);
      }
      if (res.status === 403) return refuse(403);
      if (!res.ok) return refuse(404);
      return c.body(new Uint8Array(await res.arrayBuffer()), 200, { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream' });
    }
    if (rest !== 'view') return refuse(404);

    const target = await resolvePreview(config, siteId, token);
    if (target === 'failed') return refuse(502);
    if (target === 'denied') return refuse(403);
    const decided = await port.request(siteId, async (_scoped, reads) => {
      const info = await reads.site();
      if (!info) return null;
      const theme = target.kind === 'theme' ? target.theme : await reads.theme();
      const primary = await reads.primaryHost();
      const space = primary ? await reads.space(primary) : null;
      const locale = target.kind === 'item' ? target.item.locale : info.defaultLanguage;
      const homeUrl = (space && publicUrlOf(space, locale, '/')) ?? '/';
      const site = { ...info, origin: space ? siteOrigin(space, info.defaultLanguage) : null };
      const page: PageInput =
        target.kind === 'item'
          ? { type: 'item', site, locale, path: target.item.path || '/', status: 200, homeUrl, item: target.item, alternates: [], canonical: null, ownHosts: await reads.hosts(), route: itemRouteOf(info.extensions, target.item.collection) }
          : { type: 'home', site, locale, path: '/', status: 200, homeUrl, canonical: null, list: await reads.articles(locale, { offset: 0, limit: PAGE_SIZE }), pagination: { page: 1, prevUrl: null, nextUrl: null } };
      return { theme, page, site };
    });
    if (!decided) return refuse(404);
    try {
      const html = await render(siteId, decided.page, decided.theme, {
        assetBase: `/${siteId}/assets/`,
        preview: { origin: config.origin, prefix: `/${siteId}/`, media: config.media },
      });
      return c.body(html, 200, HTML);
    } catch (err) {
      console.error('[site-classic] preview render failed', { siteId, code: (err as { code?: string }).code });
      return c.body(statusPage(500, decided.site.name, decided.page.locale), 500, HTML);
    }
  };

  /** The site's error page; the built-in minimal one when that fails too. */
  const errorPage = async (siteId: string | null, status: number, site: SiteInfo | null, locale: string, homeUrl: string, theme: ActiveTheme) => {
    if (siteId && site) {
      try {
        return await render(siteId, { type: 'error', site, locale, path: '/', status, homeUrl }, theme);
      } catch (err) {
        console.error('[site-classic] error page failed', { siteId, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return statusPage(status, site?.name ?? null, locale);
  };

  app.onError((err, c) => {
    // Never the stack or an internal path in the response (spec "站点之间的错误隔离").
    console.error('[site-classic] request failed', err instanceof Error ? err.message : err);
    return c.body(statusPage(500, null), 500, HTML);
  });

  app.all('*', async (c) => {
    // The container's health check (loopback only: a visitor's /healthz is just a path of the site).
    const peer = c.env?.incoming?.socket?.remoteAddress ?? '';
    if (c.req.path === '/healthz' && /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(peer)) return c.text('ok', 200, { 'cache-control': 'no-store' });
    const target = parseTarget(c.env?.incoming?.url ?? new URL(c.req.url).pathname + new URL(c.req.url).search);
    if (!target) return c.text('Not found', 404);
    // Nothing under these is the public site's, whatever the host or method (not even an alias's 301).
    const raw = target.path.split('/')[1] ?? '';
    // Percent-escapes too (`/%61dmin`): the edge normalises them, this service must not depend on it.
    let first = raw.toLowerCase();
    try {
      first = decodeURIComponent(raw).toLowerCase();
    } catch {
      return c.text('Not found', 404);
    }
    if (ADMIN_SEGMENTS.has(first)) return c.text('Not found', 404);

    const host = requestHost(
      { host: target.authority ?? c.req.header('host'), forwardedHost: c.req.header('x-forwarded-host') },
      c.env?.incoming?.socket?.remoteAddress,
      trusted,
    );
    if (preview && host === preview.host) {
      if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method not allowed', 405, { allow: 'GET, HEAD', ...previewHeaders(preview) });
      try {
        // A preview origin that is also a site's public host would let that site's scripts share the origin.
        if (await port.host(host)) {
          console.error('[site-classic] the preview origin is also a public host: previews refused');
          return c.text('Not found', 404, previewHeaders(preview));
        }
        return await servePreview(c, target.path);
      } catch (err) {
        // Any failure on the preview origin keeps its headers (never stored, never indexed).
        console.error('[site-classic] preview failed', err instanceof Error ? err.name : 'error');
        return c.body(statusPage(500, null), 500, { ...HTML, ...previewHeaders(preview) });
      }
    }
    const hostInfo = host ? await port.host(host) : null;
    if (!host || !hostInfo) return c.text('Not found', 404);
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return c.text('Method not allowed', 405, { allow: 'GET, HEAD' });
    const siteId = hostInfo.siteId;

    // Theme assets: version- and content-addressed, immutable, only of this site's published versions.
    if (first === '_theme') {
      const m = /^\/_theme\/([A-Za-z0-9_-]{1,64})\/([0-9a-f]{64})\.([a-z0-9]{1,8})$/.exec(target.path);
      const asset = m ? await port.request(siteId, (_scoped, reads) => reads.asset(m[1]!, m[2]!, m[3]!)) : null;
      if (!asset) return c.text('Not found', 404);
      return c.body(new Uint8Array(asset.bytes), 200, {
        'content-type': asset.contentType,
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        // An SVG opened on its own is a document: no script, no outside requests.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      });
    }

    // Branch previews (P10): before the page cache, which a branch answer never reads nor writes.
    const branchAnswer = await serveBranch(c, siteId, target.path);
    if (branchAnswer) return branchAnswer;

    // One snapshot: the rebuild check comes before any answer, a cached one or a redirect included; the
    // render version keying the cache is read in the same snapshot as the page data.
    let theme: ActiveTheme = null;
    let key: string | null = null;
    let siteVersion = 0;
    const query = new URLSearchParams(target.query);
    const decided = await port.request(siteId, async (scoped, reads): Promise<Plan> => {
      const info = await reads.site();
      theme = await reads.theme();
      if (!info || (await reads.rebuilding())) return { kind: 'status', status: 503, site: info, locale: info?.defaultLanguage ?? 'en', homeUrl: '/' };
      // System paths (HeoPress P07 task 1.5): discovery files and site root files are the system's, decided
      // after the rebuild check (503) and before any cached answer or content path, by the rule the CMS
      // validates content paths with (content never takes one; the upgrade check reports old ones). A plain
      // alias first goes to the primary domain, as every path does. Each is answered by its handler once the
      // task that makes it lands; until then, not found — never content.
      if (isSystemPathSegment(first)) {
        if (!hostInfo.isPrimary && !hostInfo.entryLocale && hostInfo.primaryHostname) return { kind: 'redirect', base: `https://${hostInfo.primaryHostname}${target.path}` };
        const file = discoveryFileOf(target.path);
        if (!file) return { kind: 'system' };
        // A discovery file is cached as a page is (P07 task 3.5): its key holds the site's render version, which every
        // publication raises — the next request makes it anew. Its query changes nothing.
        siteVersion = await reads.renderVersion();
        key = cacheKey({ mode: 'public', siteId, host, path: target.path, query: new URLSearchParams(), themeVersion: (theme as ActiveTheme)?.versionId ?? BUILTIN_THEME_ID, siteVersion });
        const local = useCache ? cache.local(key) : null;
        if (local) return { kind: 'cached', page: local, shared: false };
        const stored = useCache ? await reads.stored(key) : null;
        if (stored) return { kind: 'cached', page: stored, shared: true };
        const space = await reads.space(hostInfo.primaryHostname ?? host);
        const answer = await discoveryAnswer(file, {
          reads,
          site: { ...info, origin: siteOrigin(space, info.defaultLanguage) },
          host,
          space,
          now: now(),
          memo: memoFor(`${siteId}\u0000${host}\u0000${siteVersion}`),
          itemCount: () => countFor(`${siteId}\u0000${siteVersion}`, () => reads.publicItemCount()),
        });
        return answer ? { kind: 'discovery', answer } : { kind: 'system' };
      }
      siteVersion = await reads.renderVersion();
      key = cacheKey({ mode: 'public', siteId, host, path: target.path, query, themeVersion: (theme as ActiveTheme)?.versionId ?? BUILTIN_THEME_ID, siteVersion });
      const local = useCache ? cache.local(key) : null;
      if (local) return { kind: 'cached', page: local, shared: false };
      const stored = useCache ? await reads.stored(key) : null;
      if (stored) return { kind: 'cached', page: stored, shared: true };
      const result = await resolvePublicPathWith(scoped, { host, path: target.path, query: target.query });
      // A page's Markdown copy (P07 task 4.2): a path ending in `.md` that is nothing itself — a real route wins, also when
      // the path only redirects to it (its trailing slash, an old path), and so does a deleted page's 410.
      if (result.kind === 'not_found' && target.path.endsWith('.md')) {
        const copy = await markdownCopyAnswer(scoped, reads, { ...info, origin: null }, host, target.path);
        if (copy) return { kind: 'discovery', answer: copy };
      }
      if (result.kind === 'redirect') {
        const suffix = target.query ? `?${target.query}` : '';
        return { kind: 'redirect', base: suffix && result.location.endsWith(suffix) ? result.location.slice(0, -suffix.length) : result.location };
      }
      const space = await reads.space(hostInfo.primaryHostname ?? host);
      const locale = result.kind === 'item' ? result.locale : result.kind === 'gone' ? result.at.locale : (result.at?.locale ?? info.defaultLanguage);
      const homeUrl = publicUrlOf(space, locale, '/') ?? '/';
      const decision = await plan(reads, { ...info, origin: siteOrigin(space, info.defaultLanguage) }, result, target.path, new URLSearchParams(target.query), locale, homeUrl);
      if (decision.kind === 'page') decision.page.ownHosts = await reads.hosts();
      // An item page's Markdown copy is declared only when its address is free: a real route there (or one it redirects
      // to, or a 410) answers it instead (P07 task 4.2, Codex review of batch 9).
      if (decision.kind === 'page' && decision.page.type === 'item' && decision.page.canonical && info.seo.discovery.markdownCopies) {
        const copy = markdownUrlOf(decision.page.canonical);
        const at = copy ? new URL(copy) : null;
        if (at && at.host.toLowerCase() === host.toLowerCase()) {
          const there = await resolvePublicPathWith(scoped, { host, path: at.pathname, query: '' });
          if (there.kind !== 'not_found') decision.page.markdownTaken = true;
        }
      }
      return decision;
    });

    if (decided.kind === 'cached') {
      // A shared answer is kept in this process too, no longer than its row (this process's own copy is kept as it is).
      if (key && decided.shared) cache.remember(key, decided.page, decided.page.expiresAt ?? null);
      return answer(c, decided.page, target.query, decided.shared ? 'hit-shared' : 'hit');
    }
    /**
     * Store (in the background) and answer a freshly decided page. Shared (level 2) only when its number is
     * bounded by the site's content: no query that changes the key, or a list page whose page number exists
     * (search results and pages a `?page=` does not apply to stay in this process).
     */
    const keyedByQuery = cacheQuery(target.path, query) !== '';
    const fresh = (status: number, body: string, location: string | null, shared = !keyedByQuery, headers: Record<string, string> = {}) => {
      const page: CachedPage = cachedPage(status, body, location, { headers });
      if (key && useCache) void cache.store(key, siteId, siteVersion, page, { shared });
      return answer(c, page, target.query, 'miss');
    };
    if (decided.kind === 'system') return c.text('Not found', 404);
    if (decided.kind === 'discovery') {
      const page = cachedPage(200, decided.answer.body, null, { contentType: decided.answer.contentType, headers: decided.answer.headers ?? {} });
      // Shared when its key is bounded by the site's content: a system file's key holds no query; a Markdown copy's does
      // when the request carries one (`?page=…`) — then it stays in this process (Codex review of batch 9).
      if (key && useCache) void cache.store(key, siteId, siteVersion, page, { shared: isSystemPathSegment(first) || !keyedByQuery, expiresAt: decided.answer.expiresAt ?? null });
      return answer(c, page, '', 'miss');
    }
    // A target that cannot be a `location` (a malformed escape the request carried to an alias redirect) is not
    // found: never an exception, never a malformed header.
    if (decided.kind === 'redirect') return isRedirectTarget(decided.base) ? fresh(301, '', decided.base) : c.text('Not found', 404, { 'cache-control': 'no-store' });
    if (decided.kind === 'status') {
      const html = await errorPage(decided.site ? siteId : null, decided.status, decided.site, decided.locale, decided.homeUrl, theme);
      if (decided.status === 503) {
        c.header('retry-after', '30');
        c.header('cache-control', 'no-store');
        return c.body(html, 503, HTML);
      }
      return fresh(decided.status, html, null);
    }
    try {
      const listPage = decided.page.type === 'home' || decided.page.type === 'taxonomy';
      // A page not indexed says so in a header too (P07 task 2.3): stored with the answer, replayed on HEAD and 304.
      const { xRobotsTag } = pageHeadOf(decided.page);
      return fresh(200, await render(siteId, decided.page, theme), null, !keyedByQuery || listPage, xRobotsTag ? { 'X-Robots-Tag': xRobotsTag } : {});
    } catch (err) {
      // The theme failed on this page: this site's error page; other sites are not affected.
      const busy = err instanceof RenderError && (err.code === 'RENDER_QUEUE_FULL' || err.code === 'RENDER_CLOSED');
      console.error('[site-classic] render failed', { siteId, code: (err as { code?: string }).code, error: err instanceof Error ? err.message : String(err) });
      c.header('cache-control', 'no-store');
      if (busy) {
        c.header('retry-after', '5');
        return c.body(statusPage(503, decided.site.name, decided.page.locale), 503, HTML);
      }
      return c.body(await errorPage(siteId, 500, decided.site, decided.page.locale, decided.page.homeUrl, theme), 500, HTML);
    }
  });

  return {
    app,
    close: async () => {
      if (sweeper) clearInterval(sweeper);
      await pool.close();
    },
  };
}

async function plan(
  reads: SiteReads,
  site: SiteInfo,
  result: Exclude<PublicPathResult, { kind: 'redirect' }>,
  path: string,
  params: URLSearchParams,
  locale: string,
  homeUrl: string,
): Promise<Plan> {
  const status = (s: number): Plan => ({ kind: 'status', status: s, site, locale, homeUrl });
  const pagination = (pageNo: number, more: boolean, q: Record<string, string> = {}) => ({
    page: pageNo,
    prevUrl: pageNo > 1 ? pageUrl(path, pageNo - 1, q) : null,
    nextUrl: more ? pageUrl(path, pageNo + 1, q) : null,
  });
  if (result.kind === 'gone') return status(410);
  if (result.kind === 'not_found') {
    const at = result.at;
    // A plugin list route (P12 task 2.3): its collection's items of the language, a page at a time.
    const listRoute = at ? listRouteAt(site.extensions ?? EMPTY_PUBLIC_EXTENSIONS, at.contentPath) : null;
    const own = at && (at.contentPath === '/' || at.contentPath === '/search' || listRoute);
    if (!own) return status(404);
    if (!result.canonical) return { kind: 'redirect', base: result.url! };
    const pageNo = pageOf(params);
    if (pageNo === null) return status(404);
    if (listRoute) {
      const size = listRoute.pageSize;
      const rows = await reads.collectionItems(at.locale, listRoute.collection, { offset: (pageNo - 1) * size, limit: size + 1 });
      if (pageNo > 1 && rows.length === 0) return status(404);
      const page: PageInput = {
        type: 'taxonomy', site, locale, path, status: 200, homeUrl, canonical: pagedUrl(result.url, pageNo),
        list: rows.slice(0, size), pagination: pagination(pageNo, rows.length > size), route: listRoute,
      };
      return { kind: 'page', site, page };
    }
    const offset = (pageNo - 1) * PAGE_SIZE;
    if (at.contentPath === '/') {
      const rows = await reads.articles(at.locale, { offset, limit: PAGE_SIZE + 1 });
      if (pageNo > 1 && rows.length === 0) return status(404);
      // The language's home on its canonical host (a language-entry domain answers it, but is not its address).
      const page: PageInput = { type: 'home', site, locale, path, status: 200, homeUrl, canonical: homeCanonical(homeUrl, result.url, pageNo), list: rows.slice(0, PAGE_SIZE), pagination: pagination(pageNo, rows.length > PAGE_SIZE) };
      return { kind: 'page', site, page };
    }
    const term = (params.get('q') ?? '').trim().slice(0, 200);
    const rows = term ? await reads.search(at.locale, term, { offset, limit: PAGE_SIZE + 1 }) : [];
    if (pageNo > 1 && rows.length === 0) return status(404);
    const q: Record<string, string> = term ? { q: term } : {};
    const page: PageInput = { type: 'search', site, locale, path, status: 200, homeUrl, query: term || null, list: rows.slice(0, PAGE_SIZE), pagination: pagination(pageNo, rows.length > PAGE_SIZE, q) };
    return { kind: 'page', site, page };
  }

  const item = await reads.item(result.itemId);
  if (!item) return status(404);
  const alternates = await reads.alternates(item.itemId);
  const canonical = ((item.card as { url?: string }).url ?? result.url) || null;
  if (pageTypeOfCollection(item.collection) === 'item') {
    // Its public category and author (P07 task 2.4): the breadcrumb and the article's author; a private one is not read.
    const idOf = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const [category, author] = await Promise.all([idOf(item.data.primary_category), idOf(item.data.author)].map((id) => (id ? reads.item(id) : Promise.resolve(null))));
    const related = { category: category?.collection === 'categories' ? category : null, author: author?.collection === 'authors' ? author : null };
    // An item of a plugin collection with an item route is that route's page (P12 task 2.3).
    const route = itemRouteOf(site.extensions ?? EMPTY_PUBLIC_EXTENSIONS, item.collection);
    return { kind: 'page', site, page: { type: 'item', site, locale: item.locale, path, status: 200, homeUrl, item, alternates, canonical, related, route } };
  }
  // A category, tag or author: its page lists its articles.
  const pageNo = pageOf(params);
  if (pageNo === null) return status(404);
  const rows = await reads.articles(item.locale, { term: { collection: item.collection, itemId: item.itemId }, offset: (pageNo - 1) * PAGE_SIZE, limit: PAGE_SIZE + 1 });
  if (pageNo > 1 && rows.length === 0) return status(404);
  const page: PageInput = {
    type: 'taxonomy', site, locale: item.locale, path, status: 200, homeUrl, item, alternates, canonical: pagedUrl(canonical, pageNo),
    list: rows.slice(0, PAGE_SIZE),
    pagination: pagination(pageNo, rows.length > PAGE_SIZE),
  };
  return { kind: 'page', site, page };
}
