import { llmsEntry } from '@heopress/seo-geo';
import { MARKDOWN_TYPE, pageMarkdown } from './discovery';
import { markdownBodyOf, type DiscoveryAnswer } from './discovery-plan';
import { discoveryPageOf, type PageInput } from './view-model';

/**
 * Markdown content negotiation (HeoPress v1.2 P07; spec rendering/markdown-negotiation): the page's **own** address
 * answers its Markdown when the site has negotiation on and the request's `Accept` prefers `text/markdown` over
 * `text/html`. The body is the one the page's `.md` copy serves (P07 task 4.2) — same `pageMarkdown` facts and the same
 * `markdownBodyOf` conversion — so the two ways of asking cannot disagree. Only an indexable item page canonical to
 * itself negotiates; every other answer (404, 301, 410, a search page, a feed, a `.md` copy) is decided before this.
 */

/** One media range of an `Accept` header: its type and subtype (lowercase) and its quality value. */
interface MediaRange {
  type: string;
  subtype: string;
  q: number;
}

/** RFC 9110 token (a media type, subtype or parameter name). */
const TOKEN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
/** An RFC 9110 qvalue: `0`, `1`, or either with at most three decimals. */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * The media ranges of an `Accept` value, ignoring the ones RFC 9110 does not allow: a malformed type/subtype, or a
 * `q` that is not a qvalue (a malformed range never counts as a request for Markdown).
 */
function mediaRanges(accept: string | undefined): MediaRange[] {
  if (!accept) return [];
  const out: MediaRange[] = [];
  for (const part of accept.split(',')) {
    const [media, ...params] = part.split(';').map((s) => s.trim());
    if (!media) continue;
    const slash = media.indexOf('/');
    if (slash <= 0 || slash === media.length - 1) continue;
    const type = media.slice(0, slash).toLowerCase();
    const subtype = media.slice(slash + 1).toLowerCase();
    if (!TOKEN.test(type) || !TOKEN.test(subtype)) continue;
    let q = 1;
    let malformed = false;
    for (const param of params) {
      const eq = param.indexOf('=');
      if (eq < 0) continue;
      if (param.slice(0, eq).trim().toLowerCase() !== 'q') continue;
      // A quoted qvalue is legal; the quotes carry no meaning of their own.
      const value = param.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!QVALUE.test(value)) {
        malformed = true;
        break;
      }
      q = Number(value);
    }
    if (!malformed) out.push({ type, subtype, q });
  }
  return out;
}

/** How specific a range is for a concrete type: 2 for `type/subtype`, 1 for `type/…`, 0 for a fully wildcard range. */
function specificity(range: MediaRange): number {
  return range.type === '*' ? 0 : range.subtype === '*' ? 1 : 2;
}

/** The quality of a concrete media type: that of its most specific matching range (the greater `q` on a tie). */
function qualityOf(ranges: MediaRange[], type: string, subtype: string): number {
  let best: MediaRange | null = null;
  for (const range of ranges) {
    const matches = range.type === '*' || (range.type === type && (range.subtype === '*' || range.subtype === subtype));
    if (!matches) continue;
    if (!best || specificity(range) > specificity(best) || (specificity(range) === specificity(best) && range.q > best.q)) best = range;
  }
  return best?.q ?? 0;
}

/**
 * Whether a request's `Accept` asks for Markdown rather than HTML: `text/markdown` is acceptable and its quality is
 * strictly greater than HTML's (RFC 9110 §12.5.1). A missing, empty, wildcard-only, equally weighted or malformed
 * header is HTML — the conservative default, and what a browser sends.
 */
export function prefersMarkdown(accept: string | undefined): boolean {
  const ranges = mediaRanges(accept);
  if (ranges.length === 0) return false;
  const markdown = qualityOf(ranges, 'text', 'markdown');
  if (markdown === 0) return false;
  return markdown > qualityOf(ranges, 'text', 'html');
}

/** The item row and its listable entry, when this page may answer as Markdown at all. */
function listed(page: PageInput): { item: NonNullable<PageInput['item']>; entry: NonNullable<ReturnType<typeof llmsEntry>> } | null {
  if (page.type !== 'item' || !page.item || !page.canonical) return null;
  const entry = llmsEntry(discoveryPageOf(page.site, page.item));
  // The same decision the head, the sitemap and the `.md` copy use: indexable, and canonical to its own address.
  return entry && entry.url === page.canonical ? { item: page.item, entry } : null;
}

/** Whether this page's answer varies by `Accept` (P07 v1.2): an indexable item page canonical to itself. */
export function negotiable(page: PageInput): boolean {
  return listed(page) !== null;
}

/**
 * The page's Markdown answer, or null when the page does not negotiate. Its type and headers are the `.md` copy's, plus
 * `Vary: Accept`: the same address now has two representations, and a shared cache must keep them apart.
 */
export function negotiatedMarkdown(page: PageInput): DiscoveryAnswer | null {
  const found = listed(page);
  if (!found) return null;
  const { item, entry } = found;
  return {
    body: pageMarkdown({
      title: entry.title,
      description: entry.description,
      url: entry.url,
      published: item.publishedAt?.toISOString() ?? null,
      modified: item.contentModifiedAt?.toISOString() ?? null,
      body: markdownBodyOf(item, entry.url),
    }),
    contentType: MARKDOWN_TYPE,
    headers: { 'X-Robots-Tag': 'noindex', Link: `<${entry.url}>; rel="canonical"`, Vary: 'Accept' },
  };
}
