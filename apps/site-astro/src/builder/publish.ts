import { mkdir, readlink, readdir, rename, rm, symlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

/**
 * Atomic publication of a site's static output (HeoPress P11 tasks 3.3, 3.5; spec rendering/astro-engine
 * "构建失败保留旧版本", "构建隔离与版本一致"):
 *
 *     <root>/<siteId>/builds/<generation>/   one directory per build, never written again once verified
 *     <root>/<siteId>/current -> builds/<generation>
 *
 * A build writes only its own new directory. Going live is one `rename` of a fresh symlink over `current` (atomic on
 * POSIX): a reader sees the old version or the new, never a mix. A failed build never touches `current`. Activation
 * refuses an older generation than the live one (a build that finishes late), unless it is an explicit rollback.
 */

const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function siteDir(root: string, siteId: string): string {
  if (!SITE_ID.test(siteId)) throw new Error('invalid site id');
  const dir = resolve(root, siteId);
  if (!dir.startsWith(resolve(root) + sep)) throw new Error('site directory outside the root');
  return dir;
}

export function buildDir(root: string, siteId: string, generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('invalid generation');
  return join(siteDir(root, siteId), 'builds', String(generation));
}

/** The live generation of a site, from its `current` link (null when none). */
export async function liveGeneration(root: string, siteId: string): Promise<number | null> {
  try {
    const target = await readlink(join(siteDir(root, siteId), 'current'));
    const m = /(?:^|\/)builds\/(\d+)$/.exec(target);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

export class StaleGenerationError extends Error {
  readonly code = 'ASTRO_STALE_GENERATION';
}

/** Switch `current` to `generation`'s directory atomically. */
export async function activate(root: string, siteId: string, generation: number, opts: { rollback?: boolean } = {}): Promise<void> {
  const dir = siteDir(root, siteId);
  const live = await liveGeneration(root, siteId);
  if (!opts.rollback && live !== null && live >= generation) {
    throw new StaleGenerationError(`generation ${generation} is not newer than the live ${live}`);
  }
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.current-${randomBytes(6).toString('hex')}`);
  await symlink(join('builds', String(generation)), tmp);
  try {
    await rename(tmp, join(dir, 'current'));
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Remove a build's directory (a failed or superseded build). Never the live one. */
export async function discard(root: string, siteId: string, generation: number): Promise<void> {
  if ((await liveGeneration(root, siteId)) === generation) return;
  await rm(buildDir(root, siteId, generation), { recursive: true, force: true });
}

/** Keep the live build and the newest `keep` others (rollback targets); remove the rest. */
export async function prune(root: string, siteId: string, keep = 3): Promise<number[]> {
  const live = await liveGeneration(root, siteId);
  const names = await readdir(join(siteDir(root, siteId), 'builds')).catch(() => [] as string[]);
  const gens = names.filter((n) => /^\d+$/.test(n)).map(Number).sort((a, b) => b - a);
  const removed: number[] = [];
  for (const g of gens.filter((g) => g !== live).slice(keep)) {
    await rm(buildDir(root, siteId, g), { recursive: true, force: true });
    removed.push(g);
  }
  return removed;
}
