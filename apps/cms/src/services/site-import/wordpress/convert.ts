import { createHash } from 'node:crypto';
import type { ImportItem, ImportMedia, ImportRecord, ImportRedirect } from '@heopress/contracts/schemas';
import { IMPORT_BUNDLE_FORMAT, IMPORT_BUNDLE_VERSION } from '@heopress/contracts/schemas';
import { child, childNamed, children, type WxrDocument, type WxrItem } from './wxr';

/**
 * WXR → import bundle (v1.1 WordPress import; spec migration/wordpress-import). The converter is pure: it takes the
 * parsed document, the operator's choices and (optionally) the media bytes, and returns the bundle's records and a
 * dry-run report. The import service owns the preview, idempotency and batch activation.
 */

export interface WordPressConvertOptions {
  /** The source site as the operator names it (the external-ID namespace). */
  sourceSite: string;
  /** The site's default language (a BCP 47 tag). */
  defaultLocale: string;
  /** All languages the site has (default: just `defaultLocale`). */
  locales?: string[];
  /** `wp:post_type` → HeoPress collection (default: post → articles, page → pages). */
  collections?: Record<string, string>;
  /** The WordPress permalink structure, e.g. `/%postname%/` (default: plain `?p=<id>`). */
  permalinkStructure?: string;
  /** The target collection's permalink pattern, for the redirects of plain links (default: `/:slug`). */
  targetPermalinks?: Record<string, string>;
  /** Reads a media file by its `_wp_attached_file` path; absent means the media is reported missing. */
  readMedia?: (attachedFile: string) => Uint8Array | undefined;
  generatedAt?: string;
}

interface WordPressReport {
  sourceSite: string;
  items: { total: number; byType: Record<string, number>; published: number; draft: number };
  media: { total: number; missing: string[] };
  /** Meta keys the converter does not map, with how often they appeared. */
  unmappedMeta: Array<{ key: string; count: number }>;
  /** SEO fields per item: where they came from, and which the source did not have. */
  seo: { items: number; fromYoast: number; fromRankMath: number; fromAioseo: number; missing: string[] };
  /** Unknown Gutenberg block names, with where they were seen. */
  unknownBlocks: Array<{ block: string; item: string }>;
  /** Items whose old path could not be determined (the report never guesses). */
  legacyPathUnknown: string[];
  redirects: number;
}

export interface WordPressConvertResult {
  records: ImportRecord[];
  report: WordPressReport;
}

const DEFAULT_COLLECTIONS: Record<string, string> = { post: 'articles', page: 'pages' };

/** The WordPress meta keys of the three SEO plugins the import understands. */
const SEO_KEYS = {
  yoast: { title: '_yoast_wpseo_title', description: '_yoast_wpseo_metadesc', canonical: '_yoast_wpseo_canonical', noindex: '_yoast_wpseo_meta-robots-noindex' },
  rankMath: { title: 'rank_math_title', description: 'rank_math_description', canonical: 'rank_math_canonical_url', noindex: 'rank_math_robots' },
  aioseo: { title: '_aioseo_title', description: '_aioseo_description', canonical: '_aioseo_canonical_url', noindex: '_aioseo_robots_noindex' },
} as const;

/** The Gutenberg block names the converter recognises as plain HTML content. */
const KNOWN_BLOCKS = new Set([
  'paragraph', 'heading', 'list', 'list-item', 'quote', 'image', 'gallery', 'video', 'audio', 'file', 'embed',
  'table', 'separator', 'spacer', 'columns', 'column', 'group', 'buttons', 'button', 'cover', 'media-text',
  'code', 'preformatted', 'verse', 'pullquote', 'html', 'freeform', 'details', 'social-links', 'archives',
  'categories', 'latest-posts', 'page-list', 'shortcode', 'blockquote', 'classic',
]);

const slugOf = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);

/** The path of an absolute URL, or undefined when it is not one. */
function pathOf(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return undefined;
  }
}

function metaValue(item: WxrItem, key: string): string | undefined {
  const found = item.meta.find((m) => m.key === key);
  const value = found?.value?.trim();
  return value ? value : undefined;
}

/** The blocks a body mentions that the converter does not recognise, in order. */
function unknownBlocks(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(/<!--\s+wp:([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?)/g)) {
    const block = match[1]!;
    const name = block.includes('/') ? block : `core/${block}`;
    const base = name.split('/').pop()!;
    if (!KNOWN_BLOCKS.has(base)) out.push(name);
  }
  return out;
}

function seoOf(item: WxrItem): { data: Record<string, unknown>; from?: 'yoast' | 'rankMath' | 'aioseo' } {
  for (const [name, keys] of Object.entries(SEO_KEYS) as Array<[keyof typeof SEO_KEYS, (typeof SEO_KEYS)[keyof typeof SEO_KEYS]]>) {
    const title = metaValue(item, keys.title);
    const description = metaValue(item, keys.description);
    const canonical = metaValue(item, keys.canonical);
    const robots = metaValue(item, keys.noindex);
    if (!title && !description && !canonical && !robots) continue;
    const data: Record<string, unknown> = {};
    if (title) data['seoTitle'] = title;
    if (description) data['seoDescription'] = description;
    if (canonical) data['canonical'] = canonical;
    if (robots) data['noindex'] = /noindex/i.test(robots) && !/^0$/.test(robots);
    return { data, from: name };
  }
  return { data: {} };
}

/** The old path of an item: its link's path, or the plain `?p=<id>` form when the site uses plain permalinks. */
function legacyPathOf(item: WxrItem, permalinkStructure: string | undefined): string | undefined {
  const fromLink = item.link ? pathOf(item.link) : undefined;
  if (fromLink) return fromLink;
  if (!permalinkStructure || permalinkStructure.includes('?p=')) return item.postId ? `/?p=${item.postId}` : undefined;
  return undefined;
}

/** The new path for a redirect, from the target collection's permalink pattern and the item's slug. */
function newPathOf(permalink: string | undefined, slug: string): string {
  const pattern = permalink ?? '/:slug';
  return pattern.replace(':slug', slug).replace(/\/+$/, '') || `/${slug}`;
}

export function convertWxr(doc: WxrDocument, options: WordPressConvertOptions): WordPressConvertResult {
  const collections = { ...DEFAULT_COLLECTIONS, ...(options.collections ?? {}) };
  const locales = options.locales?.length ? options.locales : [options.defaultLocale];
  const records: ImportRecord[] = [];
  const report: WordPressReport = {
    sourceSite: options.sourceSite,
    items: { total: 0, byType: {}, published: 0, draft: 0 },
    media: { total: 0, missing: [] },
    unmappedMeta: [],
    seo: { items: 0, fromYoast: 0, fromRankMath: 0, fromAioseo: 0, missing: [] },
    unknownBlocks: [],
    legacyPathUnknown: [],
    redirects: 0,
  };
  const metaCounts = new Map<string, number>();
  const mappedMeta = new Set<string>([
    ...Object.values(SEO_KEYS).flatMap((k) => Object.values(k)),
    '_wp_attached_file',
    '_wp_attachment_metadata',
  ]);

  records.push({
    type: 'header',
    format: IMPORT_BUNDLE_FORMAT,
    version: IMPORT_BUNDLE_VERSION,
    source: 'wordpress',
    sourceSite: options.sourceSite,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    generator: 'heopress-wordpress-import',
  } as ImportRecord);
  records.push({
    type: 'site',
    settings: {
      name: doc.title,
      defaultLocale: options.defaultLocale,
      locales,
      permalinks: Object.fromEntries(Object.values(collections).map((c) => [c, options.targetPermalinks?.[c] ?? '/:slug'])),
    },
  } as ImportRecord);

  const collectionsSeen = new Set<string>();
  const attachments: WxrItem[] = [];

  for (const item of doc.items) {
    const type = item.postType ?? 'post';
    if (type === 'attachment') {
      attachments.push(item);
      continue;
    }
    const collection = collections[type];
    if (!collection) {
      report.legacyPathUnknown.push(item.postId);
      continue;
    }
    if (!collectionsSeen.has(collection)) {
      collectionsSeen.add(collection);
      records.push({ type: 'collection', source: type, collection, fields: { title: 'title', content: 'body', excerpt: 'excerpt', slug: 'slug' } } as ImportRecord);
    }
    const title = item.title.trim() || (item.postName ?? item.postId);
    const slug = slugOf(item.postName || title);
    const body = item.content ?? '';
    const seo = seoOf(item);
    if (seo.from) report.seo.items += 1;
    if (seo.from === 'yoast') report.seo.fromYoast += 1;
    if (seo.from === 'rankMath') report.seo.fromRankMath += 1;
    if (seo.from === 'aioseo') report.seo.fromAioseo += 1;
    if (!seo.data['seoTitle'] && !seo.data['seoDescription']) report.seo.missing.push(item.postId);
    for (const block of unknownBlocks(body)) report.unknownBlocks.push({ block, item: item.postId });
    for (const meta of item.meta) {
      if (mappedMeta.has(meta.key)) continue;
      metaCounts.set(meta.key, (metaCounts.get(meta.key) ?? 0) + 1);
    }
    const legacyPath = legacyPathOf(item, options.permalinkStructure);
    if (!legacyPath) report.legacyPathUnknown.push(item.postId);
    const status = item.status === 'publish' ? 'published' : 'draft';
    report.items.total += 1;
    report.items.byType[type] = (report.items.byType[type] ?? 0) + 1;
    if (status === 'published') report.items.published += 1;
    else report.items.draft += 1;

    const data: Record<string, unknown> = {
      title,
      slug,
      body,
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
      ...seo.data,
    };
    const externalId = `wordpress:${options.sourceSite}:${item.postId}`;
    const record: ImportItem = {
      type: 'item',
      externalId,
      collection,
      locale: doc.language ?? options.defaultLocale,
      status,
      ...(item.creator ? { author: item.creator } : {}),
      ...(item.postDateGmt ? { publishedAt: new Date(item.postDateGmt).toISOString() } : {}),
      ...(item.postModifiedGmt ? { updatedAt: new Date(item.postModifiedGmt).toISOString() } : {}),
      categories: item.terms.filter((t) => t.domain === 'category' && t.name).map((t) => t.name),
      tags: item.terms.filter((t) => t.domain === 'post_tag' && t.name).map((t) => t.name),
      data,
      ...(legacyPath ? { legacyPath } : {}),
      notes: unknownBlocks(body).map((block) => `unknown block ${block}`),
    };
    records.push(record);

    // Plain permalinks: the old ?p=<id> link becomes a redirect to the imported path.
    if (legacyPath?.startsWith('/?p=')) {
      const target = newPathOf(options.targetPermalinks?.[collection], slug);
      const redirect: ImportRedirect = { type: 'redirect', from: legacyPath, to: target };
      records.push(redirect);
      report.redirects += 1;
    }
  }

  for (const attachment of attachments) {
    const attachedFile = attachment.attachedFile;
    if (!attachedFile) {
      report.media.missing.push(attachment.attachmentUrl ?? attachment.postId);
      continue;
    }
    const bytes = options.readMedia?.(attachedFile);
    if (!bytes) {
      report.media.missing.push(attachedFile);
      continue;
    }
    const contentType = contentTypeOf(attachedFile);
    if (!contentType) {
      // Outside the bundle's media types (e.g. .svg, which can hold scripts): reported, never mislabelled.
      report.media.missing.push(attachedFile);
      continue;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const media: ImportMedia = {
      type: 'media',
      id: `wordpress:${options.sourceSite}:${attachment.postId}`,
      path: attachedFile,
      size: bytes.byteLength,
      sha256,
      mimeType: contentType,
    };
    records.push(media);
    report.media.total += 1;
  }

  report.unmappedMeta = [...metaCounts.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
  return { records, report };
}

/** The content type of a media file by its extension (the bundle refuses anything outside its list). */
function contentTypeOf(file: string): ImportMedia['mimeType'] | undefined {
  const ext = file.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, ImportMedia['mimeType']> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    mp4: 'video/mp4',
    webm: 'video/webm',
    pdf: 'application/pdf',
  };
  return map[ext];
}
