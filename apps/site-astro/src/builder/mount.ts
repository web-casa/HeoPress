import { copyFile, mkdir, lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * The static directory mount in a build's artifact (v1.5, spec `publishing/static-directory-mount`).
 *
 * A site may keep old static pages that will never become entries (`docs/backlog/static-directory-mount.md`); the Astro
 * build copies that directory into its output so a deployment ships it. The copy is deliberately conservative:
 *
 *   - **HeoPress's output wins**: a file that already exists in the artifact (a page, `robots.txt`, `sitemap*.xml`) is
 *     skipped, so the mount can never shadow what the engine produced — the same rule the Classic engine enforces at
 *     request time;
 *   - **symbolic links are not followed**: a link is skipped and counted (recursion into symbolic links is not followed);
 *   - **`static-urls.txt` is metadata**, not a public file: it is not copied (the sitemap already carries its URLs);
 *   - **hidden files are not copied** except under `.well-known` (an archive's `.git`, `.env` or editor files must not
 *     reach a deployment).
 *
 * Nothing is executed or interpreted: bytes are copied, mode 0644.
 */

export interface StaticMountCopyReport {
  /** Files copied into the artifact. */
  copied: number;
  /** Files left out because the artifact already had that path (HeoPress's output). */
  kept: number;
  /** Symbolic links and hidden entries not copied, and the metadata file. */
  skipped: number;
}

export interface StaticMountCopyOptions {
  /** Files never copied, as archive-relative paths (default `static-urls.txt`). */
  exclude?: Iterable<string>;
  /** Where the report goes (a build log line; silent when absent). */
  log?: (report: StaticMountCopyReport) => void;
}

const HIDDEN_OK = new Set(['.well-known']);

/** Whether an archive-relative path is copied: no metadata, no hidden entries outside `.well-known`. */
function copyable(rel: string, exclude: Set<string>): boolean {
  if (exclude.has(rel)) return false;
  const top = rel.split('/')[0]!;
  return !top.startsWith('.') || HIDDEN_OK.has(top);
}

/**
 * Copy `directory` into `outDir` without overwriting anything the build produced. Returns what happened; a directory
 * that cannot be read throws (the caller decides whether that fails the build).
 */
export async function copyStaticMount(outDir: string, directory: string, opts: StaticMountCopyOptions = {}): Promise<StaticMountCopyReport> {
  const exclude = new Set(opts.exclude ?? ['static-urls.txt']);
  const report: StaticMountCopyReport = { copied: 0, kept: 0, skipped: 0 };
  const walk = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const source = join(dir, name);
      const rel = relative(directory, source).split(sep).join('/');
      if (!copyable(rel, exclude)) {
        report.skipped++;
        continue;
      }
      const st = await lstat(source);
      if (st.isSymbolicLink()) {
        report.skipped++;
        continue;
      }
      if (st.isDirectory()) {
        await walk(source);
        continue;
      }
      if (!st.isFile()) {
        report.skipped++;
        continue;
      }
      const target = join(outDir, ...rel.split('/'));
      const existing = await lstat(target).catch(() => null);
      if (existing) {
        report.kept++;
        continue;
      }
      await mkdir(join(target, '..'), { recursive: true });
      await copyFile(source, target);
      report.copied++;
    }
  };
  await walk(directory);
  opts.log?.(report);
  return report;
}
