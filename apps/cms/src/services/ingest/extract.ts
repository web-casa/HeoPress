import { createHash } from 'node:crypto';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import sanitizeHtml from 'sanitize-html';
import type { HiddenContentEvidence } from '@heopress/database';
import { IngestFetchError } from './failure';
import { reservesAgainstAi, tdmReserved } from './fetcher';
import { stripHiddenContent, stripInvisible } from './hidden-content';

/**
 * Extraction (HeoPress P08 tasks 2.3, 2.4, 2.6; spec ingest/crawling "正文抽取与清洗", design decision 2).
 *
 * linkedom (ISC) parses the page; hidden content is found and removed first (`hidden-content.ts`); Mozilla
 * Readability (Apache-2.0) picks the article; the result goes through an allow-list sanitiser before it is stored or
 * shown. Metadata: title, author, published time, language and the canonical URL — recorded as a candidate only.
 * A page that does not look like an article (too little text, mostly links, no title) fails as `extraction`, a
 * technical failure the fallback chain may hand to the next crawl service.
 *
 * `EXTRACTION_RULE_VERSION` names these rules; a source document keeps the version that produced it.
 */

export const EXTRACTION_RULE_VERSION = 'native-1';

const QUALITY = {
  /** Characters of article text; a CJK character counts twice (it carries about a word). */
  minTextLength: 280,
  /** Share of the text inside links above which the page is navigation. */
  maxLinkDensity: 0.5,
} as const;

export interface ExtractedDocument {
  title: string;
  author: string | null;
  publishedAt: Date | null;
  language: string | null;
  canonicalCandidate: string | null;
  bodyHtml: string;
  bodyText: string;
  contentHash: string;
  hiddenContent: HiddenContentEvidence[];
  linkDensity: number;
  ruleVersion: string;
}

/** The allow-list for stored article HTML: structure, links and images with http(s) URLs; no scripts, styles or handlers. */
export function sanitizeArticleHtml(html: string): string {
  return sanitizeHtml(html, {
    allowedTags: [
      'p', 'br', 'hr', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'mark', 'small',
      'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'img', 'figure', 'figcaption', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
      th: ['colspan', 'rowspan', 'scope'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https'],
    allowedSchemesAppliedToAttributes: ['href', 'src'],
    allowProtocolRelative: false,
    // Readability wraps the article in divs: keep the content, drop the wrapper.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'template', 'iframe', 'object', 'embed', 'svg', 'math'],
    transformTags: {
      h1: 'h2',
      a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'nofollow noopener noreferrer' } }),
    },
    exclusiveFilter: (frame) => frame.tag === 'a' && !frame.attribs.href && !frame.text.trim(),
  });
}

function htmlToText(html: string): string {
  const text = sanitizeHtml(html.replace(/<\/(p|li|h[1-6]|blockquote|pre|tr|figcaption|dd|dt)>/gi, '$&\n').replace(/<br\s*\/?>/gi, '\n'), {
    allowedTags: [],
    allowedAttributes: {},
  });
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&amp;/g, '&');
}

/** SHA-256 of the body text with whitespace normalised (exact duplicate detection, task 4.1). */
function contentHashOf(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim().normalize('NFC')).digest('hex');
}

interface MetaDoc {
  querySelector(sel: string): { getAttribute(n: string): string | null; textContent: string | null } | null;
  querySelectorAll(sel: string): ArrayLike<{ getAttribute(n: string): string | null; textContent: string | null }>;
  documentElement: { getAttribute(n: string): string | null };
}

const meta = (doc: MetaDoc, ...selectors: string[]): string | null => {
  for (const sel of selectors) {
    const v = doc.querySelector(sel)?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return null;
};

function jsonLd(doc: MetaDoc): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))) {
    try {
      const v: unknown = JSON.parse(s.textContent ?? '');
      const list = Array.isArray(v) ? v : [v];
      for (const x of list) {
        if (x && typeof x === 'object') {
          out.push(x as Record<string, unknown>);
          const graph = (x as { '@graph'?: unknown })['@graph'];
          if (Array.isArray(graph)) for (const g of graph) if (g && typeof g === 'object') out.push(g as Record<string, unknown>);
        }
      }
    } catch {
      // malformed JSON-LD is ignored
    }
  }
  return out;
}

function ldAuthor(nodes: Array<Record<string, unknown>>): string | null {
  for (const n of nodes) {
    const a = n.author;
    const first = Array.isArray(a) ? a[0] : a;
    if (typeof first === 'string' && first.trim()) return first.trim();
    if (first && typeof first === 'object' && typeof (first as { name?: unknown }).name === 'string') return ((first as { name: string }).name).trim();
  }
  return null;
}

function ldDate(nodes: Array<Record<string, unknown>>): string | null {
  for (const n of nodes) if (typeof n.datePublished === 'string') return n.datePublished;
  return null;
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function normaliseLanguage(v: string | null | undefined): string | null {
  if (!v) return null;
  const tag = v.trim().replace(/_/g, '-').split(/[\s,;]/)[0];
  return tag && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag) ? tag : null;
}

function absoluteHttp(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g;

/** Text length with CJK characters counted twice. */
function textWeight(text: string): number {
  return text.length + (text.match(CJK)?.length ?? 0);
}

/** Share of the text inside links. */
function linkDensityOf(html: string, text: string): number {
  if (!text.length) return 1;
  let linked = 0;
  for (const m of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) linked += htmlToText(m[1]!).length;
  return linked / text.length;
}

/**
 * Extract the article from `html` fetched at `finalUrl`. Throws `IngestFetchError`: `access_denied` for a no-AI / TDM
 * reservation in the page, `extraction` when the result fails the quality check.
 */
export function extractDocument(html: string, finalUrl: string): ExtractedDocument {
  const { document } = parseHTML(html);
  const doc = document as unknown as MetaDoc & Parameters<typeof stripHiddenContent>[0];

  const robotsMeta = Array.from(doc.querySelectorAll('meta[name="robots" i], meta[name="heopressbot" i]')).map((m) => m.getAttribute('content') ?? '');
  if (robotsMeta.some((c) => reservesAgainstAi(c)) || tdmReserved(meta(doc, 'meta[name="tdm-reservation" i]'))) {
    throw new IngestFetchError('access_denied', 'the page reserves itself against AI use (meta robots / tdm-reservation)', { finalUrl });
  }

  const ld = jsonLd(doc);
  const canonicalCandidate = absoluteHttp(doc.querySelector('link[rel="canonical" i]')?.getAttribute('href'), finalUrl);
  const language = normaliseLanguage(doc.documentElement.getAttribute('lang')) ?? normaliseLanguage(meta(doc, 'meta[http-equiv="content-language" i]', 'meta[property="og:locale"]'));
  const author =
    meta(doc, 'meta[name="author" i]', 'meta[property="article:author"]', 'meta[name="byl" i]') ?? ldAuthor(ld) ?? doc.querySelector('[rel="author"]')?.textContent?.trim() ?? null;
  const publishedAt = parseDate(
    meta(doc, 'meta[property="article:published_time"]', 'meta[name="date" i]', 'meta[name="pubdate" i]', 'meta[itemprop="datePublished"]') ??
      ldDate(ld) ??
      doc.querySelector('time[datetime]')?.getAttribute('datetime'),
  );
  const metaTitle = meta(doc, 'meta[property="og:title"]', 'meta[name="twitter:title"]');

  const hiddenContent = stripHiddenContent(doc);

  // Readability resolves relative links against the document's base.
  const head = (document as unknown as { head: { prepend(n: unknown): void } | null }).head;
  if (head && !doc.querySelector('base[href]')) {
    const base = (document as unknown as { createElement(t: string): { setAttribute(n: string, v: string): void } }).createElement('base');
    base.setAttribute('href', finalUrl);
    head.prepend(base);
  }
  const article = new Readability(document as never, { keepClasses: false }).parse();
  if (!article?.content) throw new IngestFetchError('extraction', 'no article content found', { finalUrl });

  const bodyHtml = sanitizeArticleHtml(absolutise(article.content, finalUrl));
  const bodyText = htmlToText(bodyHtml);
  const title = stripInvisible((metaTitle ?? article.title ?? '').replace(/\s+/g, ' ').trim());
  const linkDensity = linkDensityOf(bodyHtml, bodyText);

  if (!title) throw new IngestFetchError('extraction', 'the page has no title', { finalUrl });
  const weighted = textWeight(bodyText);
  if (weighted < QUALITY.minTextLength) {
    throw new IngestFetchError('extraction', `article text too short (${weighted} < ${QUALITY.minTextLength} characters)`, { finalUrl });
  }
  if (linkDensity > QUALITY.maxLinkDensity) {
    throw new IngestFetchError('extraction', `mostly links (link density ${linkDensity.toFixed(2)}): a navigation or listing page`, { finalUrl });
  }

  return {
    title,
    author: author ? stripInvisible(author).slice(0, 300) : null,
    publishedAt,
    language: language ?? normaliseLanguage(article.lang),
    canonicalCandidate,
    bodyHtml,
    bodyText,
    contentHash: contentHashOf(bodyText),
    hiddenContent,
    linkDensity,
    ruleVersion: EXTRACTION_RULE_VERSION,
  };
}

/** Make href/src absolute against the page (linkedom has no base URL of its own). */
function absolutise(html: string, base: string): string {
  return html.replace(/\b(href|src)="([^"]*)"/gi, (m, attr: string, value: string) => {
    const abs = absoluteHttp(decodeEntities(value), base);
    return abs ? `${attr}="${abs.replace(/"/g, '&quot;')}"` : m;
  });
}
