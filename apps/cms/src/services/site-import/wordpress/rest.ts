import type { WxrDocument, WxrItem, WxrPostMeta } from './wxr';

/**
 * The WordPress REST API as an import source (v1.1; spec migration/wordpress-import "REST 与 WXR 同一中间表示").
 *
 * It reads the public REST API (`/wp-json/wp/v2/…`) into the same `WxrDocument` shape the WXR parser produces, so the
 * converter and its report are shared: no second mapping, no second set of rules. Requests go through the caller's
 * `request` function; the default one uses the platform's outbound guard (every address checked at connect time,
 * redirects re-checked, body and time capped), so a private address cannot be reached.
 *
 * What REST cannot give is reported rather than invented: SEO plugin fields are not registered for the REST API on most
 * sites, and `_wp_attached_file` is not exposed — media are recorded by their URL path instead.
 */

export interface WordPressRestResponse {
  body: unknown;
  /** `X-WP-TotalPages`, when the site sends it. */
  totalPages?: number;
}

export interface WordPressRestOptions {
  /** The site's base URL, e.g. `https://example.test` (no trailing slash needed). */
  baseUrl: string;
  /** Performs one GET; injected in tests. */
  request?: (url: string) => Promise<WordPressRestResponse>;
  /** Items per page (WordPress caps at 100). */
  perPage?: number;
  /** A safety cap on pages per collection (default 50, i.e. 5000 items at 100 per page). */
  maxPages?: number;
  /** The largest response body accepted, in bytes (default 16 MiB). */
  maxBytes?: number;
}

interface WordPressRestReport {
  collections: Record<string, number>;
  /** True when no post carried SEO plugin fields: REST does not expose them, so a mapping file is needed. */
  seoNotExposed: boolean;
  mediaWithoutFile: number;
  truncated: string[];
}

export interface WordPressRestResult {
  document: WxrDocument;
  report: WordPressRestReport;
}

interface RestTerm {
  id?: number;
  name?: string;
  slug?: string;
}

interface RestUser {
  id?: number;
  name?: string;
  slug?: string;
}

interface RestPost {
  id?: number;
  slug?: string;
  status?: string;
  type?: string;
  date_gmt?: string;
  modified_gmt?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
  excerpt?: { rendered?: string };
  author?: number;
  categories?: number[];
  tags?: number[];
  meta?: Record<string, unknown>;
}

interface RestMedia {
  id?: number;
  source_url?: string;
  media_type?: string;
}

/** The text of a rendered HTML field: tags stripped, entities decoded. */
function text(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .trim();
}

const apiRoot = (baseUrl: string): string => `${baseUrl.replace(/\/+$/, '')}/wp-json/wp/v2`;

/** Reads every page of a collection until the last one (or the safety cap). */
async function pages<T>(
  options: Required<Pick<WordPressRestOptions, 'baseUrl' | 'perPage' | 'maxPages' | 'request'>>,
  collection: string,
  query: string,
  report: WordPressRestReport,
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= options.maxPages; page += 1) {
    const url = `${apiRoot(options.baseUrl)}/${collection}?per_page=${options.perPage}&page=${page}${query}`;
    const response = await options.request(url);
    const body = response.body;
    if (!Array.isArray(body)) throw new Error(`the WordPress REST answer for ${collection} is not a list`);
    out.push(...(body as T[]));
    const totalPages = response.totalPages ?? (body.length < options.perPage ? page : undefined);
    if (!totalPages || page >= totalPages || body.length === 0) return out;
  }
  report.truncated.push(collection);
  return out;
}

/** The default request: the platform's outbound guard, with a byte cap and a timeout. */
async function guardedWordPressRequest(url: string, maxBytes = 16 * 1024 * 1024): Promise<WordPressRestResponse> {
  const { guardedFetch } = await import('../../ssrf-guard');
  const response = await guardedFetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`the WordPress REST answer was ${response.status} for ${url}`);
  const raw = await response.text();
  if (Buffer.byteLength(raw) > maxBytes) throw new Error(`the WordPress REST answer for ${url} is larger than ${maxBytes} bytes`);
  const totalPagesHeader = response.headers.get('x-wp-totalpages');
  const totalPages = totalPagesHeader ? Number(totalPagesHeader) : undefined;
  return { body: JSON.parse(raw) as unknown, totalPages: Number.isFinite(totalPages) ? totalPages : undefined };
}

export async function fetchWordPressRest(options: WordPressRestOptions): Promise<WordPressRestResult> {
  const request = options.request ?? ((url: string) => guardedWordPressRequest(url, options.maxBytes));
  const settings = { baseUrl: options.baseUrl, perPage: options.perPage ?? 100, maxPages: options.maxPages ?? 50, request };
  const report: WordPressRestReport = { collections: {}, seoNotExposed: false, mediaWithoutFile: 0, truncated: [] };

  const users = await pages<RestUser>(settings, 'users', '', report);
  const categories = await pages<RestTerm>(settings, 'categories', '', report);
  const tags = await pages<RestTerm>(settings, 'tags', '', report);
  const posts = await pages<RestPost>(settings, 'posts', '&status=any', report);
  const pageItems = await pages<RestPost>(settings, 'pages', '&status=any', report);
  const media = await pages<RestMedia>(settings, 'media', '', report);

  const userName = new Map(users.filter((u) => u.id !== undefined).map((u) => [u.id!, u.name ?? u.slug ?? String(u.id)]));
  const categoryName = new Map(categories.filter((c) => c.id !== undefined).map((c) => [c.id!, c.name ?? c.slug ?? String(c.id)]));
  const tagName = new Map(tags.filter((t) => t.id !== undefined).map((t) => [t.id!, t.name ?? t.slug ?? String(t.id)]));

  const items: WxrItem[] = [];
  let sawSeo = false;
  for (const [type, collection] of [
    ['post', posts],
    ['page', pageItems],
  ] as Array<[string, RestPost[]]>) {
    report.collections[type] = collection.length;
    for (const post of collection) {
      if (post.id === undefined) continue;
      const meta: WxrPostMeta[] = Object.entries(post.meta ?? {})
        .filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        .map(([key, value]) => ({ key, value: String(value) }));
      if (meta.some((m) => /yoast|rank_math|aioseo/.test(m.key))) sawSeo = true;
      items.push({
        title: text(post.title?.rendered),
        link: '',
        postId: String(post.id),
        postName: post.slug,
        status: post.status === 'publish' ? 'publish' : 'draft',
        postType: type,
        postDateGmt: post.date_gmt,
        postModifiedGmt: post.modified_gmt,
        creator: post.author !== undefined ? userName.get(post.author) : undefined,
        content: post.content?.rendered,
        excerpt: post.excerpt?.rendered,
        terms: [
          ...(post.categories ?? []).map((id) => ({ domain: 'category', nicename: '', name: categoryName.get(id) ?? '' })),
          ...(post.tags ?? []).map((id) => ({ domain: 'post_tag', nicename: '', name: tagName.get(id) ?? '' })),
        ],
        meta,
      });
    }
  }
  for (const file of media) {
    if (file.id === undefined) continue;
    const sourceUrl = file.source_url ?? '';
    const marker = '/wp-content/uploads/';
    const at = sourceUrl.indexOf(marker);
    if (at < 0) {
      report.mediaWithoutFile += 1;
      continue;
    }
    items.push({
      title: '',
      link: '',
      postId: String(file.id),
      postType: 'attachment',
      status: 'inherit',
      attachmentUrl: sourceUrl,
      attachedFile: sourceUrl.slice(at + marker.length),
      terms: [],
      meta: [],
    });
  }

  report.seoNotExposed = !sawSeo;
  const site = (() => {
    try {
      return new URL(options.baseUrl).host;
    } catch {
      return options.baseUrl;
    }
  })();
  return {
    document: {
      title: site,
      link: options.baseUrl,
      authors: users.map((u) => ({ login: u.slug ?? String(u.id ?? ''), displayName: u.name ?? u.slug ?? '' })),
      categories: categories.map((c) => ({ nicename: c.slug ?? '', name: c.name ?? '' })),
      tags: tags.map((t) => ({ nicename: t.slug ?? '', name: t.name ?? '' })),
      items,
    },
    report,
  };
}
