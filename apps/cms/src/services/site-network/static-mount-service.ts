import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isInsideDirectory } from '@heopress/public-site';
import { siteStaticMounts, type Database } from '@heopress/database';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { withTransactionRetry } from './translation-groups';
import { requireSettingsLock } from './settings-locks';

/**
 * A site's static directory mount (v1.5, spec `rendering/static-directory-mount`): an absolute directory whose files the
 * Classic engine serves for paths no HeoPress route matches, and the Astro build copies into its artifact.
 *
 * - **The operator bounds it.** `HEOPRESS_STATIC_ROOT` is the one root any mount must stay under; the saved value is the
 *   directory's resolved path, so `..` segments and symbolic links that leave the root are refused at save time, not at
 *   request time. Without a configured root no directory is accepted at all.
 * - **The directory is checked, not assumed.** It must exist, be a directory and be readable and traversable by the
 *   service's own user; recursion into symbolic links is never followed (the Classic engine refuses a symbolic link at
 *   any path component, and the build copy skips them).
 * - **Versioned.** A stale form is a 409, never a silent overwrite; each change is a change event (the Astro build and
 *   the page cache follow) and the projection carries the resolved directory to the rendering role.
 */

export class StaticMountError extends Error {
  constructor(
    readonly code: 'VALIDATION' | 'ROOT_NOT_CONFIGURED' | 'OUTSIDE_ROOT' | 'NOT_FOUND' | 'NOT_DIRECTORY' | 'NOT_READABLE' | 'INVALID_PATH' | 'VERSION_CONFLICT',
    message: string,
    readonly status: 400 | 409,
  ) {
    super(message);
    this.name = 'StaticMountError';
  }
}

/** The setting's write: the directory (empty clears it) against the version read. */
export const StaticMountUpdateSchema = z.object({
  directory: z.string().max(1024),
  version: z.number().int().min(0),
});

export type StaticDirectoryCheck =
  | { ok: true; directory: string }
  | { ok: false; code: 'ROOT_NOT_CONFIGURED' | 'OUTSIDE_ROOT' | 'NOT_FOUND' | 'NOT_DIRECTORY' | 'NOT_READABLE' | 'INVALID_PATH'; message: string };

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The directory a mount would serve, or why it may not be saved. Empty means "no mount" and is always accepted.
 * `root` is the operator's `HEOPRESS_STATIC_ROOT`; `null` means the installation has none.
 */
export async function checkStaticDirectory(root: string | null | undefined, requested: string): Promise<StaticDirectoryCheck> {
  const directory = requested.trim();
  if (directory === '') return { ok: true, directory: '' };
  if (!directory.startsWith('/') || CONTROL.test(directory)) {
    return { ok: false, code: 'INVALID_PATH', message: 'A static directory is an absolute path without control characters.' };
  }
  if (!root?.trim()) {
    return {
      ok: false,
      code: 'ROOT_NOT_CONFIGURED',
      message: 'No static root is configured: set HEOPRESS_STATIC_ROOT on the CMS and the rendering service before mounting a directory.',
    };
  }
  let rootReal: string;
  try {
    rootReal = await realpath(root.trim());
    if (!(await stat(rootReal)).isDirectory()) throw new Error('not a directory');
  } catch {
    return { ok: false, code: 'OUTSIDE_ROOT', message: 'HEOPRESS_STATIC_ROOT is not a directory this process can read.' };
  }
  let real: string;
  try {
    real = await realpath(directory);
  } catch {
    return { ok: false, code: 'NOT_FOUND', message: 'The directory does not exist (or a symbolic link on the way does not resolve).' };
  }
  try {
    if (!(await stat(real)).isDirectory()) return { ok: false, code: 'NOT_DIRECTORY', message: 'The path is not a directory.' };
  } catch {
    return { ok: false, code: 'NOT_FOUND', message: 'The directory cannot be read.' };
  }
  try {
    await access(real, constants.R_OK | constants.X_OK);
  } catch {
    return { ok: false, code: 'NOT_READABLE', message: 'The directory is not readable by the service (it needs read and traverse permission).' };
  }
  if (!isInsideDirectory(rootReal, real)) {
    return { ok: false, code: 'OUTSIDE_ROOT', message: `The directory must be inside HEOPRESS_STATIC_ROOT (${rootReal}).` };
  }
  return { ok: true, directory: real };
}

export interface StaticMountDeps {
  db: Database;
  siteId: string;
  /** The operator's `HEOPRESS_STATIC_ROOT`. */
  root: string | null | undefined;
  actor: { userId: string | null; apiKeyId?: string | null };
}

export interface StaticMountView {
  directory: string;
  version: number;
}

export class StaticMountService {
  constructor(private readonly deps: StaticMountDeps) {}

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>): Promise<T> {
    // The projection refresh of this write can reach other sites of cross-site groups: a deadlock is retried.
    return withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, fn));
  }

  async get(): Promise<StaticMountView> {
    return this.tx(async (tx) => {
      const [row] = await tx.select().from(siteStaticMounts).where(eq(siteStaticMounts.siteId, this.deps.siteId));
      // No row yet: nothing mounted, version 0 (the first update creates it).
      return { directory: row?.directory ?? '', version: row?.version ?? 0 };
    });
  }

  async update(input: unknown): Promise<StaticMountView> {
    const parsed = StaticMountUpdateSchema.safeParse(input ?? {});
    if (!parsed.success) {
      throw new StaticMountError('VALIDATION', parsed.error.issues.map((i) => `${i.path.join('.') || '/'}: ${i.message}`).join('; '), 400);
    }
    const { directory, version } = parsed.data;
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      // The site-wide refresh this write causes rewrites every item row of the site: hold the settings row first, the
      // order every writer and the projection take, so the two never deadlock.
      await requireSettingsLock(tx, siteId, 'update');
      // Serialises the setting's own writers, the first one included (no row to lock yet).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`heopress:static-mount:${siteId}`}, 0))`);
      const [current] = await tx.select().from(siteStaticMounts).where(eq(siteStaticMounts.siteId, siteId)).for('update');
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== version) {
        throw new StaticMountError('VERSION_CONFLICT', 'The static directory changed since it was read; reload the setting.', 409);
      }
      const check = await checkStaticDirectory(this.deps.root, directory);
      if (!check.ok) throw new StaticMountError(check.code, check.message, 400);
      const next = check.directory;
      const nextVersion = currentVersion + 1;
      if (next === '' && current) {
        await tx.delete(siteStaticMounts).where(and(eq(siteStaticMounts.siteId, siteId), eq(siteStaticMounts.version, currentVersion)));
      } else if (next !== '') {
        await tx
          .insert(siteStaticMounts)
          .values({ siteId, directory: next, version: nextVersion })
          .onConflictDoUpdate({
            target: siteStaticMounts.siteId,
            set: { directory: next, version: sql`${siteStaticMounts.version} + 1`, updatedAt: new Date() },
          });
      }
      await appendItemEvent(tx, {
        siteId,
        resource: 'site_static_mount',
        collection: '$site',
        itemId: siteId,
        itemVersion: nextVersion,
        changedFields: ['directory'],
        actor: this.deps.actor.userId
          ? { type: 'user', id: this.deps.actor.userId }
          : this.deps.actor.apiKeyId
            ? { type: 'api_key', id: this.deps.actor.apiKeyId }
            : { type: 'system', id: null },
        source: 'api',
        payload: null,
      });
      // Reading the row back is what the projection will carry: the resolved path, never the raw input.
      const [saved] = await tx.select().from(siteStaticMounts).where(eq(siteStaticMounts.siteId, siteId));
      return { directory: saved?.directory ?? '', version: saved?.version ?? 0 };
    });
  }
}
