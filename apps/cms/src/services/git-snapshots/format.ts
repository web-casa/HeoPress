import { createHash } from 'node:crypto';

/**
 * The Git snapshot format (HeoPress P11 tasks 2.2, 2.6, 2.7; docs/zh-CN/publishing/git-snapshots.md). Pure functions:
 * safe paths, the language collision suffix, the front matter whitelist and the files of a site.
 *
 * Front matter is a closed list of keys (`FRONT_MATTER_KEYS`): nothing from an item's data is copied by name, so a new
 * field — an e-mail, a user id, a member flag — can never reach the repository by accident (ADR-0013). The author is
 * a display name only.
 */

const FRONT_MATTER_KEYS = ['id', 'title', 'slug', 'locale', 'translationGroup', 'publishedAt', 'contentModifiedAt', 'author', 'source', 'seo'] as const;
const SOURCE_KEYS = ['url', 'attribution', 'licenseStatus'] as const;
const SEO_KEYS = ['title', 'description', 'canonical', 'robots'] as const;

export interface ExportItem {
  itemId: string;
  locale: string;
  slug: string;
  title: string;
  translationGroup: string | null;
  publishedAt: Date | null;
  contentModifiedAt: Date | null;
  author: string | null;
  source: { url: string | null; attribution: string | null; licenseStatus: string | null };
  seo: { title: string | null; description: string | null; canonical: string | null; robots: string | null };
  /** The body as Markdown (rich text converted; images stay URL references). */
  body: string;
}

export interface SiteSnapshotInput {
  domain: string;
  defaultLanguage: string;
  /** Public site configuration (name, languages, public SEO and identity, content settings). */
  site: Record<string, unknown>;
  /** The active, published theme version; null: the built-in theme. */
  theme: { name: string; number: number; contentHash: string | null; templates: Record<string, string>; assets: Array<{ path: string; sha256: string; contentType: string; size: number }> } | null;
  items: ExportItem[];
}

export interface SnapshotFile {
  path: string;
  content: string;
  itemId: string | null;
}

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** A host name as a directory: lower case, letters, digits, dots and hyphens only. */
export function safeDomain(domain: string): string {
  const d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (!HOST_RE.test(d)) throw new UnsafePathError(`unsafe domain: ${JSON.stringify(domain).slice(0, 80)}`);
  return d;
}

/**
 * One path segment from a slug: Unicode NFC, no separators, no control or reserved characters, no leading dot, at most
 * 120 characters. Never `.` or `..`; empty becomes `untitled`.
 */
export function safeSegment(raw: string): string {
  let s = raw.normalize('NFC').toLowerCase();
  s = s.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-');
  s = s.replace(/\s+/g, '-').replace(/-{2,}/g, '-');
  s = s.replace(/^[.-]+/, '').replace(/[.-]+$/, '');
  s = [...s].slice(0, 120).join('');
  if (!s || s === '.' || s === '..') return 'untitled';
  return s;
}

/** A path inside the repository: relative, `/`-separated, no empty, `.` or `..` segment, no `.git`. */
export function assertSafeRepoPath(path: string): string {
  const parts = path.split('/');
  if (path.startsWith('/') || parts.some((p) => !p || p === '.' || p === '..' || p.toLowerCase() === '.git' || /[\u0000-\u001f\\]/.test(p))) {
    throw new UnsafePathError(`unsafe path: ${JSON.stringify(path).slice(0, 120)}`);
  }
  if (!path.startsWith('websites/')) throw new UnsafePathError('snapshot paths live under websites/');
  return path;
}

const localeSuffix = (locale: string) => safeSegment(locale.replace(/_/g, '-'));

/**
 * Every item's path, `websites/<domain>/YYYY/MM/<slug>/index.md` (UTC month of publication). Items that would share a
 * path: those in the site's default language keep it; the others take `<slug>--<locale>`; items still sharing one
 * (same language) take `--<item id>` as well — the same inputs always give the same paths.
 */
export function planItemPaths(domain: string, defaultLanguage: string, items: ExportItem[]): Map<string, string> {
  const root = `websites/${safeDomain(domain)}`;
  const base = (i: ExportItem) => {
    const d = i.publishedAt ?? i.contentModifiedAt ?? new Date(0);
    return `${root}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${safeSegment(i.slug)}`;
  };
  const groups = new Map<string, ExportItem[]>();
  for (const i of items) groups.set(base(i), [...(groups.get(base(i)) ?? []), i]);
  const out = new Map<string, string>();
  for (const [dir, group] of groups) {
    if (group.length === 1) {
      out.set(group[0]!.itemId, `${dir}/index.md`);
      continue;
    }
    const named = group.map((i) => ({ i, dir: i.locale === defaultLanguage ? dir : `${dir}--${localeSuffix(i.locale)}` }));
    const counts = new Map<string, number>();
    for (const n of named) counts.set(n.dir, (counts.get(n.dir) ?? 0) + 1);
    for (const n of named) {
      const d = counts.get(n.dir)! > 1 ? `${n.dir}--${safeSegment(n.i.itemId)}` : n.dir;
      out.set(n.i.itemId, `${d}/index.md`);
    }
  }
  for (const p of out.values()) assertSafeRepoPath(p);
  return out;
}

/** A YAML scalar: JSON strings are valid YAML double-quoted scalars. */
function scalar(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'null';
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

function nested(key: string, keys: readonly string[], obj: Record<string, unknown>): string {
  return `${key}:\n${keys.map((k) => `  ${k}: ${scalar(obj[k])}`).join('\n')}`;
}

/** An item's Markdown file: the whitelisted front matter, then the body. */
export function itemDocument(i: ExportItem): string {
  const fm: Record<(typeof FRONT_MATTER_KEYS)[number], unknown> = {
    id: i.itemId,
    title: i.title,
    slug: i.slug,
    locale: i.locale,
    translationGroup: i.translationGroup,
    publishedAt: i.publishedAt,
    contentModifiedAt: i.contentModifiedAt,
    author: i.author,
    source: i.source,
    seo: i.seo,
  };
  const lines = FRONT_MATTER_KEYS.map((k) => {
    if (k === 'source') return nested(k, SOURCE_KEYS, i.source);
    if (k === 'seo') return nested(k, SEO_KEYS, i.seo);
    return `${k}: ${scalar(fm[k])}`;
  });
  return `---\n${lines.join('\n')}\n---\n\n${i.body.trim()}\n`;
}

const stableJson = (v: unknown): string => JSON.stringify(sortKeys(v), null, 2) + '\n';
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** Every file of a site's snapshot. */
export function siteFiles(input: SiteSnapshotInput): SnapshotFile[] {
  const domain = safeDomain(input.domain);
  const root = `websites/${domain}`;
  const files: SnapshotFile[] = [{ path: `${root}/_site/site.json`, content: stableJson(input.site), itemId: null }];
  if (input.theme) {
    const t = input.theme;
    files.push({
      path: `${root}/_site/theme/theme.json`,
      content: stableJson({ name: t.name, version: t.number, contentHash: t.contentHash, templates: Object.keys(t.templates).sort(), assets: t.assets }),
      itemId: null,
    });
    for (const [name, body] of Object.entries(t.templates)) {
      const segs = name.split('/').map(safeSegment);
      files.push({ path: `${root}/_site/theme/templates/${segs.join('/')}`, content: body, itemId: null });
    }
  }
  const paths = planItemPaths(domain, input.defaultLanguage, input.items);
  for (const i of input.items) files.push({ path: paths.get(i.itemId)!, content: itemDocument(i), itemId: i.itemId });
  const seen = new Set<string>();
  return files.filter((f) => {
    assertSafeRepoPath(f.path);
    if (seen.has(f.path)) return false;
    seen.add(f.path);
    return true;
  });
}

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
