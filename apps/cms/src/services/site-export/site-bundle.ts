import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  IMPORT_BUNDLE_RECORDS_FILE,
  IMPORT_BUNDLE_THEME_DIR,
  type ImportAutoPublish,
  type ImportCollectionSchemaRecord,
  type ImportIngestSource,
  type ImportRecord,
  type ImportRelation,
  type ImportSiteConfig,
  type ImportTheme,
} from '@heopress/contracts/schemas';
import { BundleInvalidError, isSafeRelativePath, loadBundle, parseBundleRecords, type BundleProblem, type LoadedBundle } from '../site-import/bundle-reader';

/**
 * A single-site export bundle, read for "import as new site" (HeoPress P13 tasks 1.2, 1.6).
 *
 * It is a P12 import bundle (`loadBundle` checks it all: schema, credentials, media paths, sizes and hashes) plus the
 * records only a new site takes — schema, relations, theme, settings, sources, auto-publish thresholds — checked
 * here: relations name items of the bundle, theme files are plain relative paths inside `theme/` with the size and
 * SHA-256 the record lists.
 */

export interface SiteBundle {
  base: LoadedBundle;
  schemas: ImportCollectionSchemaRecord[];
  relations: ImportRelation[];
  theme: ImportTheme | null;
  siteConfig: ImportSiteConfig | null;
  sources: ImportIngestSource[];
  autoPublish: ImportAutoPublish | null;
  /** Read a theme file (`templates/<name>` or `assets/<path>`), already checked. */
  readThemeFile(rel: string): Promise<Buffer>;
}

export const themeTemplatePath = (name: string) => `templates/${name}`;
export const themeAssetPath = (p: string) => `assets/${p}`;

export async function loadSiteBundle(dir: string): Promise<SiteBundle> {
  const base = await loadBundle(dir);
  const root = await realpath(dir);
  const { records } = parseBundleRecords((await readFile(path.join(root, IMPORT_BUNDLE_RECORDS_FILE))).toString('utf8'));
  const of = <T extends ImportRecord['type']>(type: T) => records.filter((r) => r.record.type === type) as Array<{ line: number; record: Extract<ImportRecord, { type: T }> }>;
  const problems: BundleProblem[] = [];
  const itemIds = new Set(base.items.map((i) => i.externalId));
  for (const { line, record } of of('relation')) {
    if (!itemIds.has(record.externalId)) problems.push({ line, at: 'externalId', code: 'UNKNOWN_ITEM', message: `Relation names unknown item "${record.externalId}".` });
    for (const t of record.targets) if (!itemIds.has(t)) problems.push({ line, at: 'targets', code: 'UNKNOWN_ITEM', message: `Relation of "${record.externalId}" points to unknown item "${t}".` });
  }
  const themes = of('theme');
  if (themes.length > 1) problems.push({ line: themes[1]!.line, code: 'THEME_DUPLICATE', message: 'More than one theme record.' });
  if (of('siteConfig').length > 1) problems.push({ code: 'SITE_CONFIG_DUPLICATE', message: 'More than one siteConfig record.' });
  if (of('autoPublish').length > 1) problems.push({ code: 'AUTO_PUBLISH_DUPLICATE', message: 'More than one autoPublish record.' });

  const themeRoot = path.join(root, IMPORT_BUNDLE_THEME_DIR);
  const resolveTheme = async (rel: string): Promise<string | null> => {
    if (!isSafeRelativePath(rel)) return null;
    const real = await realpath(path.join(themeRoot, ...rel.split('/'))).catch(() => null);
    return real && real.startsWith(themeRoot + path.sep) ? real : null;
  };
  const theme = themes[0] ?? null;
  if (theme) {
    const files = [
      ...theme.record.templates.map((t) => ({ rel: themeTemplatePath(t.name), size: t.size, sha256: t.sha256 })),
      ...theme.record.assets.map((a) => ({ rel: themeAssetPath(a.path), size: a.size, sha256: a.sha256 })),
    ];
    for (const f of files) {
      const file = await resolveTheme(f.rel);
      const st = file ? await lstat(file).catch(() => null) : null;
      if (!file || !st?.isFile()) {
        problems.push({ line: theme.line, at: f.rel, code: 'THEME_FILE_MISSING', message: `Theme file "${f.rel}" is not a file inside theme/.` });
        continue;
      }
      if (st.size !== f.size || st.size > 2 * 1024 * 1024 + 200_000) {
        problems.push({ line: theme.line, at: f.rel, code: 'THEME_FILE_SIZE', message: `Theme file "${f.rel}" is ${st.size} bytes, not ${f.size}.` });
        continue;
      }
      if (createHash('sha256').update(await readFile(file)).digest('hex') !== f.sha256) problems.push({ line: theme.line, at: f.rel, code: 'THEME_FILE_HASH', message: `Theme file "${f.rel}" does not match its SHA-256.` });
    }
  }
  if (problems.length > 0) throw new BundleInvalidError(problems);
  return {
    base,
    schemas: of('collectionSchema').map((r) => r.record),
    relations: of('relation').map((r) => r.record),
    theme: theme?.record ?? null,
    siteConfig: of('siteConfig')[0]?.record ?? null,
    sources: of('ingestSource').map((r) => r.record),
    autoPublish: of('autoPublish')[0]?.record ?? null,
    async readThemeFile(rel) {
      const file = await resolveTheme(rel);
      if (!file) throw new BundleInvalidError([{ at: rel, code: 'THEME_FILE_MISSING', message: `Theme file "${rel}" is not a file inside theme/.` }]);
      return readFile(file);
    },
  };
}

const BLOCK_ID_ATTR = /\sdata-block-id\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

/**
 * A field value without its block IDs (`data-block-id` in rich text, `_blockId` in repeater rows): the site that
 * stores it assigns its own (HeoPress P13 task 1.6 — block IDs are remapped, never carried over).
 */
export function withoutBlockIds(value: unknown): unknown {
  if (typeof value === 'string') return value.includes('data-block-id') ? value.replace(BLOCK_ID_ATTR, '') : value;
  if (Array.isArray(value)) {
    return value.map((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row) || !('_blockId' in row)) return row;
      const { _blockId: _drop, ...rest } = row as Record<string, unknown>;
      return rest;
    });
  }
  return value;
}
