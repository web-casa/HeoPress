import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  IMPORT_BUNDLE_FORMAT,
  IMPORT_BUNDLE_MEDIA_DIR,
  IMPORT_BUNDLE_RECORDS_FILE,
  IMPORT_BUNDLE_VERSION,
  IMPORT_MEDIA_REF_PREFIX,
  ImportRecordSchema,
  type ImportItem,
  type ImportMedia,
  type ImportRecord,
  type ImportRedirect,
} from '@heopress/contracts/schemas';
import { convertBody } from './mdx';

/**
 * The Astro content-collection importer (HeoPress P12 tasks 7.1, 7.2; spec migration/astro-content-import
 * "映射配置", "MDX 与媒体转换").
 *
 * It reads an Astro site's content directory with a mapping (`AstroMappingSchema`): which source collection becomes
 * which HeoPress collection, which frontmatter field becomes which field, how the language is found (the first
 * directory, a file name suffix `post.zh.mdx`, or a field), what makes a translation group (the file's slug without
 * the language, or a field), the old permalink pattern and trailing slash, and where old redirects are (`_redirects`,
 * `vercel.json`, the `redirects` of the Astro config, the mapping's own). It writes an import bundle, and a report of
 * what the dry run should look at: mapped fields missing from entries, unknown components with their place, images
 * not found, redirects it could not read. Files are only read inside the site's root.
 */

const Target = z.string().min(1).max(64);

const AstroCollectionMappingSchema = z.strictObject({
  /** The directory under the content directory. */
  source: z.string().min(1).max(200).regex(/^[\w.-]+$/),
  /** The HeoPress collection. */
  collection: z.string().regex(/^[a-z][a-z0-9_]*$/),
  /**
   * Frontmatter field → HeoPress field, or a special target: `@publishedAt`, `@updatedAt`, `@tags`, `@categories`,
   * `@author`, `@draft`, `@sponsored`, `@sponsorName`, `@internalOnly`, `@slug`, `@translationKey`, `@locale`.
   */
  fields: z.record(z.string().min(1).max(200), Target).default({}),
  locale: z.discriminatedUnion('from', [
    z.strictObject({ from: z.literal('directory') }),
    z.strictObject({ from: z.literal('suffix') }),
    z.strictObject({ from: z.literal('field'), field: z.string().min(1) }),
  ]),
  translationKey: z
    .discriminatedUnion('from', [z.strictObject({ from: z.literal('slug') }), z.strictObject({ from: z.literal('field'), field: z.string().min(1) })])
    .default({ from: 'slug' }),
  /** The old site's URL pattern for this collection (`/blog/:slug`); the language prefix is added for other languages. */
  permalink: z.string().startsWith('/').max(200),
  /** The HeoPress permalink pattern to propose (default: the same as the old one). */
  targetPermalink: z.string().startsWith('/').max(200).optional(),
  bodyField: Target.default('body'),
});

const AstroMappingSchema = z.strictObject({
  sourceSite: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  contentDir: z.string().default('src/content'),
  publicDir: z.string().default('public'),
  defaultLocale: z.string().min(2),
  locales: z.array(z.string().min(2)).min(1),
  /** A language as the old site writes it → the BCP 47 tag (`zh` → `zh-CN`). */
  localeAliases: z.record(z.string(), z.string()).default({}),
  /** The old site's path prefix per language (default: the language as written); the default language is at the root. */
  localePrefixes: z.record(z.string(), z.string()).default({}),
  trailingSlash: z.enum(['always', 'never', 'ignore']).default('ignore'),
  collections: z.array(AstroCollectionMappingSchema).min(1),
  components: z.record(z.string(), z.strictObject({ as: z.enum(['blockquote', 'section', 'div', 'figure', 'p']) })).default({}),
  redirects: z
    .strictObject({
      files: z.array(z.string()).default(['public/_redirects', 'vercel.json']),
      astroConfig: z.array(z.string()).default(['astro.config.mjs', 'astro.config.ts', 'astro.config.js']),
      rules: z.record(z.string().startsWith('/'), z.string()).default({}),
    })
    .default({ files: ['public/_redirects', 'vercel.json'], astroConfig: ['astro.config.mjs', 'astro.config.ts', 'astro.config.js'], rules: {} }),
});
type AstroMapping = z.infer<typeof AstroMappingSchema>;

interface AstroReport {
  entries: number;
  /** Mapped frontmatter fields missing from entries (`entries`: how many lack it). */
  missingFields: Array<{ collection: string; field: string; entries: number; of: number }>;
  /** Frontmatter fields no mapping names (not imported). */
  unmappedFields: Array<{ collection: string; field: string }>;
  unknownComponents: Array<{ component: string; file: string; line: number }>;
  notes: Array<{ file: string; note: string }>;
  redirects: { imported: number; skipped: Array<{ origin: string; rule: string; reason: string }> };
}

export interface AstroConversion {
  records: ImportRecord[];
  /** Media path in the bundle → the file it is copied from. */
  mediaFiles: Map<string, string>;
  report: AstroReport;
}

const MIME_BY_EXT: Record<string, ImportMedia['mimeType']> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

const canonical = (tag: string) => {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
};

const slugPart = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';

/** Split `---\nyaml\n---\nbody`. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string; bodyLine: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text, bodyLine: 0 };
  const parsed = parseYaml(m[1]!) as unknown;
  return { data: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}, body: text.slice(m[0].length), bodyLine: m[0].split('\n').length - 1 };
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.name.startsWith('.') || e.name.startsWith('_')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile() && /\.(md|mdx)$/.test(e.name)) out.push(full);
  }
  return out.sort();
}

const asDate = (v: unknown): string | undefined => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
};
const asStrings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : undefined);

/** Convert an Astro site (its root directory) with a mapping. */
export async function convertAstroSite(rootDir: string, mappingInput: unknown): Promise<AstroConversion> {
  const mapping = AstroMappingSchema.parse(mappingInput);
  const root = await realpath(rootDir);
  /** A path inside the root, or null (outside, or missing). */
  const inside = async (p: string): Promise<string | null> => {
    const real = await realpath(p).catch(() => null);
    if (!real || (real !== root && !real.startsWith(root + path.sep))) return null;
    const st = await lstat(real).catch(() => null);
    return st?.isFile() ? real : null;
  };
  const localeOf = (raw: string): string | null => {
    const aliased = mapping.localeAliases[raw] ?? raw;
    if (!mapping.locales.includes(raw) && !mapping.locales.includes(aliased) && !Object.keys(mapping.localeAliases).includes(raw)) return null;
    return canonical(aliased);
  };
  const defaultLocale = canonical(mapping.localeAliases[mapping.defaultLocale] ?? mapping.defaultLocale) ?? mapping.defaultLocale;
  const prefixOf = (locale: string) => {
    const written = Object.entries(mapping.localeAliases).find(([, v]) => canonical(v) === locale)?.[0] ?? locale;
    return mapping.localePrefixes[locale] ?? mapping.localePrefixes[written] ?? written.toLowerCase();
  };
  const withSlash = (p: string) => (mapping.trailingSlash === 'always' ? (p.endsWith('/') ? p : `${p}/`) : mapping.trailingSlash === 'never' && p !== '/' ? p.replace(/\/+$/, '') : p);

  const report: AstroReport = { entries: 0, missingFields: [], unmappedFields: [], unknownComponents: [], notes: [], redirects: { imported: 0, skipped: [] } };
  const media = new Map<string, ImportMedia>();
  const mediaFiles = new Map<string, string>();
  const itemsOut: ImportItem[] = [];

  const addMedia = async (file: string): Promise<string | null> => {
    const ext = path.extname(file).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) return null;
    const bytes = await readFile(file);
    const sha = createHash('sha256').update(bytes).digest('hex');
    const id = `img-${sha.slice(0, 16)}`;
    if (!media.has(id)) {
      const rel = `${sha.slice(0, 2)}/${sha}${ext}`;
      media.set(id, { type: 'media', id, path: rel, size: bytes.length, sha256: sha, mimeType: mime });
      mediaFiles.set(rel, file);
    }
    return `${IMPORT_MEDIA_REF_PREFIX}${id}`;
  };
  /** A local image referenced from `fromFile`: `./a.png`, `../assets/a.png`, `/images/a.png` (public dir). */
  const resolveLocal = async (src: string, fromFile: string): Promise<string | null> => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//') || src.startsWith('#')) return null;
    const clean = decodeURI(src.split(/[?#]/)[0]!);
    const candidate = clean.startsWith('/') ? path.join(root, mapping.publicDir, clean) : path.resolve(path.dirname(fromFile), clean);
    const file = await inside(candidate);
    return file ? addMedia(file) : null;
  };

  for (const coll of mapping.collections) {
    const dir = path.join(root, mapping.contentDir, coll.source);
    const files = await walk(dir);
    const missing = new Map<string, number>();
    const seenFields = new Set<string>();
    for (const file of files) {
      const real = await inside(file);
      if (!real) continue;
      report.entries++;
      const relFile = path.relative(root, real).split(path.sep).join('/');
      const relId = path.relative(dir, file).split(path.sep).join('/').replace(/\.(md|mdx)$/, '');
      const text = await readFile(real, 'utf8');
      let fm: ReturnType<typeof splitFrontmatter>;
      try {
        fm = splitFrontmatter(text);
      } catch (err) {
        report.notes.push({ file: relFile, note: `Frontmatter could not be read: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      for (const k of Object.keys(fm.data)) seenFields.add(k);
      for (const k of Object.keys(coll.fields)) if (!(k in fm.data)) missing.set(k, (missing.get(k) ?? 0) + 1);
      const notes: string[] = [];

      // Language and the slug without it.
      let segments = relId.split('/');
      let locale: string | null = null;
      if (coll.locale.from === 'directory') {
        locale = segments.length > 1 ? localeOf(segments[0]!) : null;
        if (locale) segments = segments.slice(1);
      } else if (coll.locale.from === 'suffix') {
        const last = segments.at(-1)!;
        const m = /^(.*)\.([A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.exec(last);
        if (m && localeOf(m[2]!)) {
          locale = localeOf(m[2]!);
          segments = [...segments.slice(0, -1), m[1]!];
        }
      } else {
        const v = fm.data[coll.locale.field];
        locale = typeof v === 'string' ? localeOf(v) : null;
      }
      if (!locale) {
        locale = defaultLocale;
        notes.push(`Language not found (${coll.locale.from}); the default language ${defaultLocale} is used.`);
      }
      const baseSlug = segments.join('/');

      // Fields.
      const special: Record<string, unknown> = {};
      const data: Record<string, unknown> = {};
      for (const [from, to] of Object.entries(coll.fields)) {
        if (!(from in fm.data)) continue;
        const v = fm.data[from];
        if (to.startsWith('@')) special[to.slice(1)] = v;
        else if (typeof v === 'string' && /\.(png|jpe?g|gif|webp|avif|mp4|webm|pdf)$/i.test(v)) {
          const ref = await resolveLocal(v, real);
          if (ref) data[to] = ref;
          else {
            data[to] = v;
            notes.push(`File ${v} of "${from}" could not be found; left as is.`);
          }
        } else data[to] = v instanceof Date ? v.toISOString() : v;
      }
      const slug = typeof special.slug === 'string' ? special.slug : baseSlug;
      data.slug = slugPart(slug.split('/').at(-1)!);
      if (!data.title && typeof fm.data.title === 'string') data.title = fm.data.title;

      // Body. Images are noted while converting (the converter is synchronous) and resolved after.
      const pending: string[] = [];
      const converted = convertBody(
        fm.body,
        {
          mdx: real.endsWith('.mdx'),
          components: mapping.components,
          resolveImage: (src) => {
            if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith('//')) return null;
            pending.push(src);
            return `heopress-local:${pending.length - 1}`;
          },
        },
        fm.bodyLine,
      );
      const resolved: Array<string | null> = [];
      for (const src of pending) resolved.push(await resolveLocal(src, real));
      const html = converted.html.replace(/heopress-local:(\d+)/g, (_m, n: string) => {
        const i = Number(n);
        if (resolved[i]) return resolved[i]!;
        notes.push(`Image ${pending[i]} could not be found; left as is.`);
        return pending[i]!;
      });
      for (const u of converted.unknownComponents) report.unknownComponents.push({ component: u.component, file: relFile, line: u.line });
      notes.push(...converted.notes);
      data[coll.bodyField] = html;

      // The old URL.
      const isDefault = locale === defaultLocale;
      const pathPart = coll.permalink.replace(':slug', baseSlug);
      const legacyPath = withSlash(`${isDefault ? '' : `/${prefixOf(locale)}`}${pathPart}`);
      const translationKey =
        coll.translationKey.from === 'slug'
          ? `${coll.source}/${typeof special.translationKey === 'string' ? special.translationKey : baseSlug}`
          : typeof fm.data[coll.translationKey.field] === 'string'
            ? String(fm.data[coll.translationKey.field])
            : undefined;

      const item: ImportItem = {
        type: 'item',
        externalId: `${coll.source}/${relId}`.replace(/[^A-Za-z0-9._\-/:@]/g, '-'),
        collection: coll.collection,
        locale,
        ...(translationKey ? { translationKey: translationKey.replace(/[^A-Za-z0-9._\-/:@]/g, '-') } : {}),
        status: special.draft === true ? 'draft' : 'published',
        ...(special.internalOnly === true ? { internalOnly: true } : {}),
        ...(typeof special.sponsored === 'boolean' ? { sponsored: special.sponsored } : {}),
        ...(typeof special.sponsorName === 'string' ? { sponsorName: special.sponsorName } : {}),
        ...(asDate(special.publishedAt) ? { publishedAt: asDate(special.publishedAt) } : {}),
        ...(asDate(special.updatedAt) ? { updatedAt: asDate(special.updatedAt) } : {}),
        ...(typeof special.author === 'string' ? { author: special.author } : {}),
        ...(asStrings(special.categories) ? { categories: asStrings(special.categories) } : {}),
        ...(asStrings(special.tags) ? { tags: asStrings(special.tags) } : {}),
        data,
        legacyPath,
        sourceFile: relFile,
        ...(notes.length > 0 ? { notes: [...new Set(notes)] } : {}),
      };
      for (const n of item.notes ?? []) report.notes.push({ file: relFile, note: n });
      itemsOut.push(item);
    }
    for (const [field, n] of missing) report.missingFields.push({ collection: coll.source, field, entries: n, of: files.length });
    const mapped = new Set(Object.keys(coll.fields));
    if (coll.locale.from === 'field') mapped.add(coll.locale.field);
    if (coll.translationKey.from === 'field') mapped.add(coll.translationKey.field);
    for (const f of seenFields) if (!mapped.has(f) && f !== 'title') report.unmappedFields.push({ collection: coll.source, field: f });
  }

  // Groups with a single member are no groups.
  const counts = new Map<string, number>();
  for (const it of itemsOut) if (it.translationKey) counts.set(it.translationKey, (counts.get(it.translationKey) ?? 0) + 1);
  for (const it of itemsOut) if (it.translationKey && counts.get(it.translationKey) === 1 && !it.internalOnly) delete it.translationKey;

  const redirects = await readRedirects(root, mapping, inside, report);

  const records: ImportRecord[] = [
    { type: 'header', format: IMPORT_BUNDLE_FORMAT, version: IMPORT_BUNDLE_VERSION, source: 'astro', sourceSite: mapping.sourceSite, generator: 'heopress astro importer' },
    {
      type: 'site',
      settings: {
        defaultLocale,
        locales: [...new Set(mapping.locales.map((l) => canonical(mapping.localeAliases[l] ?? l)).filter((l): l is string => !!l))],
        ...(mapping.trailingSlash !== 'ignore' ? { trailingSlash: mapping.trailingSlash } : {}),
        permalinks: permalinksOf(mapping, report),
        localePrefixes: Object.fromEntries(mapping.locales.map((l) => canonical(mapping.localeAliases[l] ?? l)).filter((l): l is string => !!l && l !== defaultLocale).map((l) => [l, prefixOf(l)])),
      },
    },
    ...mapping.collections.map((c): ImportRecord => ({ type: 'collection', source: c.source, collection: c.collection, fields: Object.fromEntries(Object.entries(c.fields).filter(([, t]) => !t.startsWith('@'))) })),
    ...media.values(),
    ...itemsOut,
    ...redirects,
  ];
  // Everything written is what the bundle schema accepts.
  for (const r of records) ImportRecordSchema.parse(r);
  return { records, mediaFiles, report };
}

/** One permalink per HeoPress collection: the first source's; others that differ are noted (their paths change). */
function permalinksOf(mapping: AstroMapping, report: AstroReport): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of mapping.collections) {
    const pattern = c.targetPermalink ?? c.permalink;
    if (out[c.collection] === undefined) out[c.collection] = pattern;
    else if (out[c.collection] !== pattern) report.notes.push({ file: c.source, note: `"${c.source}" goes into ${c.collection} too, whose permalink is ${out[c.collection]}: its paths change (redirects are written on activation).` });
  }
  return out;
}

/** Old redirects: `_redirects` (Netlify), `vercel.json`, the Astro config's `redirects`, the mapping's. */
async function readRedirects(root: string, mapping: AstroMapping, inside: (p: string) => Promise<string | null>, report: AstroReport): Promise<ImportRedirect[]> {
  const out = new Map<string, ImportRedirect>();
  const add = (from: string, to: string, origin: string, status?: number) => {
    if (!from.startsWith('/')) return report.redirects.skipped.push({ origin, rule: `${from} ${to}`, reason: 'The source is not a path.' });
    if (/[[\]*:]/.test(from) && !from.endsWith('/*')) return report.redirects.skipped.push({ origin, rule: `${from} ${to}`, reason: 'Dynamic parameters are not converted; add these by hand.' });
    const s = status === 302 || status === 307 || status === 308 ? status : 301;
    out.set(from, { type: 'redirect', from, to, status: s as 301, origin });
  };
  for (const rel of mapping.redirects.files) {
    const file = await inside(path.join(root, rel));
    if (!file) continue;
    const text = await readFile(file, 'utf8');
    if (rel.endsWith('.json')) {
      try {
        const json = JSON.parse(text) as { redirects?: Array<{ source?: string; destination?: string; permanent?: boolean; statusCode?: number }> };
        for (const r of json.redirects ?? []) if (r.source && r.destination) add(r.source, r.destination, rel, r.statusCode ?? (r.permanent === false ? 307 : 308));
      } catch {
        report.redirects.skipped.push({ origin: rel, rule: '(file)', reason: 'Not JSON.' });
      }
      continue;
    }
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const [from, to, status] = t.split(/\s+/);
      if (!from || !to) continue;
      add(from, to, rel, status ? Number.parseInt(status, 10) : undefined);
    }
  }
  for (const rel of mapping.redirects.astroConfig) {
    const file = await inside(path.join(root, rel));
    if (!file) continue;
    const text = await readFile(file, 'utf8');
    const at = text.search(/\bredirects\s*:\s*\{/);
    if (at === -1) continue;
    const start = text.indexOf('{', at);
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      if (text[end] === '{') depth++;
      else if (text[end] === '}' && --depth === 0) break;
    }
    const body = text.slice(start + 1, end);
    let rest = body;
    const simple = /(['"])(\/[^'"]*)\1\s*:\s*(['"])([^'"]+)\3/g;
    for (const m of body.matchAll(simple)) {
      add(m[2]!, m[4]!, rel);
      rest = rest.replace(m[0], '');
    }
    const objects = /(['"])(\/[^'"]*)\1\s*:\s*\{([^}]*)\}/g;
    for (const m of body.matchAll(objects)) {
      const dest = /destination\s*:\s*(['"])([^'"]+)\1/.exec(m[3]!);
      const status = /status\s*:\s*(\d{3})/.exec(m[3]!);
      if (dest) add(m[2]!, dest[2]!, rel, status ? Number(status[1]) : undefined);
      else report.redirects.skipped.push({ origin: rel, rule: m[0], reason: 'No destination.' });
      rest = rest.replace(m[0], '');
    }
    if (rest.replace(/[\s,]/g, '').length > 0) report.redirects.skipped.push({ origin: rel, rule: rest.trim().slice(0, 200), reason: 'Not a plain rule; check the config by hand.' });
  }
  for (const [from, to] of Object.entries(mapping.redirects.rules)) add(from, to, 'mapping');
  report.redirects.imported = out.size;
  return [...out.values()];
}

/** Write a conversion as a bundle directory (`bundle.ndjson`, `media/`, `astro-report.json`). */
export async function writeBundle(outDir: string, conversion: AstroConversion): Promise<void> {
  await mkdir(path.join(outDir, IMPORT_BUNDLE_MEDIA_DIR), { recursive: true });
  await writeFile(path.join(outDir, IMPORT_BUNDLE_RECORDS_FILE), `${conversion.records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  for (const [rel, from] of conversion.mediaFiles) {
    const to = path.join(outDir, IMPORT_BUNDLE_MEDIA_DIR, ...rel.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  await writeFile(path.join(outDir, 'astro-report.json'), `${JSON.stringify(conversion.report, null, 2)}\n`);
}
