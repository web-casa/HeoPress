import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

/**
 * URL comparison before a cutover (HeoPress P12 task 7.3; spec migration/astro-content-import "URL 对照").
 *
 * Every URL of the old site (its sitemap, or a list) is requested on the old site and on the new site's preview, and
 * the answers compared: the status (a redirect on the new side is followed — an old page that now answers through a
 * 301 is fine, a 404 is not), the canonical URL, the hreflang alternates and the title (canonical and alternates
 * compared by path, since the preview runs on another host). Each difference can be explained by the operator
 * (`explanations`: `<path>` for every difference of a URL, `<path>#<kind>` for one). The site is **switchable** only
 * when every difference is explained.
 *
 * Requests go through the `fetch` the caller gives — the command line uses the platform's outbound guard
 * (`guardedProbe`): no redirect is followed by it, the comparison follows them itself (at most five hops, same host).
 */

export interface FetchAnswer {
  status: number;
  location?: string | null;
  body: string;
}
export type PageFetcher = (url: string) => Promise<FetchAnswer>;

export interface PageFacts {
  status: number;
  /** The URL that answered in the end (after redirects). */
  finalUrl: string;
  redirects: string[];
  canonical: string | null;
  hreflang: Record<string, string>;
  title: string | null;
}

type DifferenceKind = 'status' | 'canonical' | 'hreflang' | 'title';

interface UrlDifference {
  path: string;
  kind: DifferenceKind;
  old: string;
  new: string;
  explained: string | null;
}

export interface UrlComparisonReport {
  checked: number;
  differences: UrlDifference[];
  unexplained: number;
  /** True only when there is no unexplained difference. */
  switchable: boolean;
  pages: Array<{ path: string; old: PageFacts; new: PageFacts }>;
}

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['node'];

const MAX_HOPS = 5;
const MAX_URLS = 50_000;

/** The URLs of a sitemap (or sitemap index: `children` true) or a plain list (one per line). */
export function parseUrlList(text: string): { urls: string[]; sitemaps: string[] } {
  if (/<(urlset|sitemapindex)\b/.test(text)) {
    const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]!.replace(/&amp;/g, '&'));
    return /<sitemapindex\b/.test(text) ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
  }
  return {
    urls: text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
    sitemaps: [],
  };
}

/** Title, canonical and hreflang alternates of an HTML page. */
export function pageFacts(html: string): Pick<PageFacts, 'canonical' | 'hreflang' | 'title'> {
  const doc = parse(html);
  let title: string | null = null;
  let canonical: string | null = null;
  const hreflang: Record<string, string> = {};
  const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value ?? null;
  const textOf = (el: Element): string =>
    el.childNodes.map((c: Node) => ('value' in c && c.nodeName === '#text' ? (c as { value: string }).value : 'childNodes' in c ? textOf(c as Element) : '')).join('');
  const walk = (n: Node) => {
    if ('tagName' in n) {
      const el = n as Element;
      if (el.tagName === 'title' && title === null) title = textOf(el).trim().replace(/\s+/g, ' ');
      if (el.tagName === 'link') {
        const rel = (attr(el, 'rel') ?? '').toLowerCase().split(/\s+/);
        const href = attr(el, 'href');
        if (href && rel.includes('canonical') && canonical === null) canonical = href;
        const lang = attr(el, 'hreflang');
        if (href && lang && rel.includes('alternate')) hreflang[lang.toLowerCase()] = href;
      }
      if (el.tagName === 'body') return;
    }
    if ('childNodes' in n) for (const c of (n as Element).childNodes) walk(c);
  };
  walk(doc as unknown as Node);
  return { title, canonical, hreflang };
}

/** Request `url`, following redirects on the same host (at most five). */
async function facts(fetchPage: PageFetcher, url: string): Promise<PageFacts> {
  const redirects: string[] = [];
  let current = url;
  for (let hop = 0; ; hop++) {
    let answer: FetchAnswer;
    try {
      answer = await fetchPage(current);
    } catch (err) {
      return { status: 0, finalUrl: current, redirects, canonical: null, hreflang: {}, title: `(request failed: ${err instanceof Error ? err.message : String(err)})` };
    }
    if (answer.status >= 300 && answer.status < 400 && answer.location && hop < MAX_HOPS) {
      const next = new URL(answer.location, current);
      if (next.host !== new URL(current).host) return { status: answer.status, finalUrl: next.toString(), redirects: [...redirects, next.toString()], canonical: null, hreflang: {}, title: null };
      redirects.push(next.toString());
      current = next.toString();
      continue;
    }
    const f = answer.status >= 200 && answer.status < 300 ? pageFacts(answer.body) : { canonical: null, hreflang: {}, title: null };
    return { status: answer.status, finalUrl: current, redirects, ...f };
  }
}

/** The path of a URL (absolute or relative to `base`), without a trailing slash difference mattering. */
function pathOf(u: string | null, base: string): string | null {
  if (!u) return null;
  try {
    const url = new URL(u, base);
    return `${url.pathname}${url.search}`;
  } catch {
    return u;
  }
}

export interface CompareOptions {
  oldUrls: string[];
  /** Where the new site's preview answers (`https://preview.example.com`): each old path is requested there. */
  newBase: string;
  fetchOld: PageFetcher;
  fetchNew: PageFetcher;
  /** `<path>` or `<path>#<kind>` → why the difference is expected. */
  explanations?: Record<string, string>;
  /** Requests at a time (default 4). */
  concurrency?: number;
}

export async function compareUrls(opts: CompareOptions): Promise<UrlComparisonReport> {
  const urls = [...new Set(opts.oldUrls)].slice(0, MAX_URLS);
  const explanations = opts.explanations ?? {};
  const pages: UrlComparisonReport['pages'] = [];
  const differences: UrlDifference[] = [];
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const oldUrl = urls[next++]!;
      const u = new URL(oldUrl);
      const path = `${u.pathname}${u.search}`;
      const newUrl = new URL(path, opts.newBase).toString();
      const [o, n] = await Promise.all([facts(opts.fetchOld, oldUrl), facts(opts.fetchNew, newUrl)]);
      pages.push({ path, old: o, new: n });
      const diff = (kind: DifferenceKind, oldV: string, newV: string) =>
        differences.push({ path, kind, old: oldV, new: newV, explained: explanations[`${path}#${kind}`] ?? explanations[path] ?? null });
      const okOld = o.status >= 200 && o.status < 300;
      const okNew = n.status >= 200 && n.status < 300;
      if (okOld !== okNew || (!okOld && o.status !== n.status)) {
        diff('status', String(o.status), n.redirects.length > 0 ? `${n.status} after redirect to ${pathOf(n.finalUrl, newUrl)}` : n.status === 404 ? '404 (no redirect)' : String(n.status));
        continue;
      }
      if (!okOld) continue;
      // Canonical: by path. On the new side a page reached through a redirect is canonical at its own path.
      const oldCanon = pathOf(o.canonical, oldUrl);
      const newCanon = pathOf(n.canonical, n.finalUrl);
      const expectedNew = n.redirects.length > 0 ? pathOf(n.finalUrl, newUrl) : oldCanon;
      if (newCanon !== expectedNew && !(n.redirects.length > 0 && newCanon === null && oldCanon === null)) diff('canonical', oldCanon ?? '(none)', newCanon ?? '(none)');
      const langs = new Set([...Object.keys(o.hreflang), ...Object.keys(n.hreflang)]);
      const hrefDiffs = [...langs].sort().filter((l) => pathOf(o.hreflang[l] ?? null, oldUrl) !== pathOf(n.hreflang[l] ?? null, n.finalUrl));
      if (hrefDiffs.length > 0) {
        diff(
          'hreflang',
          hrefDiffs.map((l) => `${l}=${pathOf(o.hreflang[l] ?? null, oldUrl) ?? '(none)'}`).join(' '),
          hrefDiffs.map((l) => `${l}=${pathOf(n.hreflang[l] ?? null, n.finalUrl) ?? '(none)'}`).join(' '),
        );
      }
      if ((o.title ?? '') !== (n.title ?? '')) diff('title', o.title ?? '(none)', n.title ?? '(none)');
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, 16)) }, worker));
  pages.sort((a, b) => a.path.localeCompare(b.path));
  differences.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind));
  const unexplained = differences.filter((d) => !d.explained).length;
  return { checked: urls.length, differences, unexplained, switchable: unexplained === 0, pages };
}

/** Read the old site's URLs from a sitemap (index) or list, fetching child sitemaps through `fetchOld`. */
export async function collectOldUrls(text: string, fetchOld: PageFetcher, depth = 0): Promise<string[]> {
  const { urls, sitemaps } = parseUrlList(text);
  const out = [...urls];
  if (depth < 2) {
    for (const s of sitemaps) {
      const answer = await fetchOld(s);
      if (answer.status >= 200 && answer.status < 300) out.push(...(await collectOldUrls(answer.body, fetchOld, depth + 1)));
    }
  }
  return out.slice(0, MAX_URLS);
}
