import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IMPORT_BUNDLE_MEDIA_DIR, IMPORT_BUNDLE_RECORDS_FILE, type ImportRecord } from '@heopress/contracts/schemas';

/**
 * Writes an import bundle directory (v1.1): `bundle.ndjson`, the media files under `media/`, and the converter's
 * dry-run report. The Astro and WordPress converters share it, so a bundle's layout is defined once.
 */
export interface ImportBundleWrite {
  records: ImportRecord[];
  /** Bundle-relative media path (`media/` prefix omitted) → the file to copy. */
  mediaFiles?: Map<string, string>;
  report: unknown;
  /** The report's file name, e.g. `astro-report.json`. */
  reportFile: string;
}

export async function writeImportBundle(outDir: string, bundle: ImportBundleWrite): Promise<void> {
  await mkdir(path.join(outDir, IMPORT_BUNDLE_MEDIA_DIR), { recursive: true });
  await writeFile(path.join(outDir, IMPORT_BUNDLE_RECORDS_FILE), `${bundle.records.map((r) => JSON.stringify(r)).join('\n')}\n`);
  for (const [rel, from] of bundle.mediaFiles ?? []) {
    const to = path.join(outDir, IMPORT_BUNDLE_MEDIA_DIR, ...rel.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  await writeFile(path.join(outDir, bundle.reportFile), `${JSON.stringify(bundle.report, null, 2)}\n`);
}
