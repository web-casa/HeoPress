/**
 * The page data contract of the Astro engine (HeoPress P11 tasks 3.1, 3.6; spec rendering/astro-engine; ADR-0005 §3):
 * what a static build of one site reads, and the only thing an Astro theme may read. It is served, for one pinned
 * publication snapshot, by the read-only page data interface (`@heopress/site-classic/page-data`) and made by the
 * same code that answers the Classic engine's requests — so both engines say the same thing.
 *
 * As with the Classic engine, markup is never theme data: the page's head (canonical, hreflang, robots, its one
 * JSON-LD graph, feeds, Markdown copy), the item's sanitised body (with `rel="sponsored"` already applied when the
 * site asks for it) and the disclosure texts come from the system; a theme places them with the kit's components
 * (`@heopress/astro-kit`), never writes or rewrites them.
 *
 * Apache-2.0 (ADR-0008): themes written against it may use any licence. Self-contained (no relative imports).
 */
import type { ThemeViewModel } from './index';

export const PAGE_DATA_VERSION = 1 as const;

/** One HTML page of the site, as the Classic engine would answer its path. */
export interface PageDataPage {
  /** The page's path on the site's primary host (`/`, `/2026/10/hello/`). */
  path: string;
  /** 200, or the status of a status page (404). */
  status: number;
  vm: ThemeViewModel;
  /** The page's head as markup, exactly as the Classic engine writes it (`{% seo_head %}`). */
  headHtml: string;
  /** Sanitised bodies by item id (the item page's one). */
  bodies: Record<string, string>;
  /** Explicit sponsor disclosure is on for the site. */
  disclosureRequired: boolean;
  /** Disclosure text of each sponsored item on the page, by item id. */
  disclosures: Record<string, string>;
  /** The page's `X-Robots-Tag`, when it has one. */
  xRobotsTag: string | null;
}

/** A machine-readable file of the site (robots.txt, sitemaps, feeds, llms.txt, Markdown copies, root files). */
export interface PageDataFile {
  path: string;
  contentType: string;
  body: string;
  /** Representation headers the static target must send with it (`X-Robots-Tag`, `Link`). */
  headers: Record<string, string>;
}

/**
 * An address the static target must answer without a page (HeoPress P11 task 4.4, the static response contract): an old
 * path or a redirect rule (`301` to `location`), or a once-public item that was withdrawn (`410`). Made by asking the
 * Classic engine each candidate path, so both engines answer the same.
 */
export interface PageDataRoute {
  path: string;
  status: 301 | 410;
  /** A `301`'s target (absolute, or a path on the host). */
  location?: string;
}

/** What a static build of the site cannot answer, said plainly instead of silently claiming parity. */
export const STATIC_UNSUPPORTED = ['search', 'list-pagination', 'preview', 'ai-traffic'] as const;
export type StaticUnsupported = (typeof STATIC_UNSUPPORTED)[number];

export interface PageDataSnapshot {
  version: typeof PAGE_DATA_VERSION;
  siteId: string;
  /** The site's render version the snapshot was read at (its published revision): every page and file is of it. */
  revision: number;
  /** The site's primary host. */
  host: string;
  /** `https://<host>`. */
  origin: string;
  name: string;
  defaultLanguage: string;
  pages: PageDataPage[];
  /** The site's not-found page. */
  notFound: PageDataPage | null;
  files: PageDataFile[];
  /** Redirects and withdrawn addresses (absent in snapshots made before P11 task 4.4: none). */
  routes?: PageDataRoute[];
  unsupported: StaticUnsupported[];
  /**
   * The Astro sources of the site's enabled plugins (HeoPress P12 tasks 2.3, 2.4): route templates by `<namespace>/<template>`,
   * components by `<namespace>/components/<name>` (absent: none). A page of a plugin route (`vm.route`) is rendered with
   * its template — the theme's own version first — and a theme imports a component as `heopress:ext/<namespace>/<name>`.
   */
  extensions?: { hash: string; astro: Record<string, string> };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';

/** A safe path inside the site: absolute, no `..`, no backslash, no control characters. */
export function isSafeSitePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.length > 2048) return false;
  if (/[\\\u0000-\u001f\u007f?#]/.test(path)) return false;
  return !path.split('/').some((s) => s === '..' || s === '.');
}

/**
 * Check a snapshot's shape before a build trusts it (the build reads it from the network). Throws on the first problem.
 * The View Model is checked for its top-level shape; the renderer that produced it validated it in full.
 */
export function assertPageDataSnapshot(v: unknown): asserts v is PageDataSnapshot {
  const fail = (m: string): never => {
    throw new Error(`page data: ${m}`);
  };
  if (!isObj(v)) fail('not an object');
  const s = v as Record<string, unknown>;
  if (s.version !== PAGE_DATA_VERSION) fail(`unsupported version ${String(s.version)}`);
  for (const k of ['siteId', 'host', 'origin', 'name', 'defaultLanguage']) if (!isStr(s[k])) fail(`${k} missing`);
  if (!Number.isSafeInteger(s.revision)) fail('revision missing');
  if (!/^https:\/\/[^/]+$/.test(s.origin as string)) fail('origin is not an https origin');
  const page = (p: unknown, where: string) => {
    if (!isObj(p)) fail(`${where}: not an object`);
    const o = p as Record<string, unknown>;
    if (!isStr(o.path) || !isSafeSitePath(o.path)) fail(`${where}: unsafe path`);
    if (!Number.isInteger(o.status)) fail(`${where}: status`);
    if (!isObj(o.vm) || !isObj((o.vm as Record<string, unknown>).page)) fail(`${where}: view model`);
    if (!isStr(o.headHtml)) fail(`${where}: head`);
    if (!isObj(o.bodies) || !isObj(o.disclosures)) fail(`${where}: system content`);
    if (typeof o.disclosureRequired !== 'boolean') fail(`${where}: disclosureRequired`);
  };
  if (!Array.isArray(s.pages)) fail('pages missing');
  const seen = new Set<string>();
  (s.pages as unknown[]).forEach((p, i) => {
    page(p, `pages[${i}]`);
    const path = (p as PageDataPage).path;
    if (seen.has(path)) fail(`pages[${i}]: duplicate path ${path}`);
    seen.add(path);
  });
  if (s.notFound !== null) page(s.notFound, 'notFound');
  if (!Array.isArray(s.files)) fail('files missing');
  (s.files as unknown[]).forEach((f, i) => {
    if (!isObj(f) || !isStr(f.path) || !isSafeSitePath(f.path) || f.path.endsWith('/')) fail(`files[${i}]: unsafe path`);
    const o = f as Record<string, unknown>;
    if (!isStr(o.contentType) || !isStr(o.body) || !isObj(o.headers)) fail(`files[${i}]: shape`);
    if (seen.has(o.path as string)) fail(`files[${i}]: path taken by a page`);
    seen.add(o.path as string);
  });
  if (s.routes !== undefined) {
    if (!Array.isArray(s.routes)) fail('routes: not a list');
    (s.routes as unknown[]).forEach((r, i) => {
      if (!isObj(r) || !isStr(r.path) || !isSafeSitePath(r.path)) fail(`routes[${i}]: unsafe path`);
      const o = r as Record<string, unknown>;
      if (o.status !== 301 && o.status !== 410) fail(`routes[${i}]: status`);
      if (o.status === 301 && (!isStr(o.location) || /[\s"'<>]/.test(o.location))) fail(`routes[${i}]: location`);
      if (seen.has(o.path as string)) fail(`routes[${i}]: path taken by a page or file`);
    });
  }
  if (!Array.isArray(s.unsupported)) fail('unsupported missing');
  if (s.extensions !== undefined) {
    const e = s.extensions as Record<string, unknown>;
    if (!isObj(e) || !isStr(e.hash) || !isObj(e.astro)) fail('extensions: shape');
    for (const [k, v] of Object.entries(e.astro as Record<string, unknown>)) {
      if (!/^[a-z][a-z0-9_]*\/(components\/)?[a-z][a-z0-9_-]*$/.test(k) || !isStr(v)) fail(`extensions: ${k}`);
    }
  }
}
