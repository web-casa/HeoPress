import { createHash } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { siteRootFiles, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { runSiteTransaction } from '../rls-transaction';

/**
 * A site's root files (HeoPress P07 task 3.8; spec seo/crawl-discovery "站点根文件"): text files its administrators
 * place at the site's root — search engine verification files, `ads.txt`, `app-ads.txt`, a web app manifest. The name
 * decides everything the file is served as (its type is never the writer's to say); a name the system answers itself
 * (`robots.txt`, the sitemaps, the feeds, `llms.txt`, the IndexNow key file) is refused. Each write passes the
 * projection gate in its transaction (the site's render version rises: no cached answer outlives a change) and is
 * audited.
 */

export class RootFileError extends Error {
  constructor(
    readonly code: 'INVALID_NAME' | 'SYSTEM_FILE' | 'TOO_LARGE' | 'INVALID_CONTENT' | 'NOT_FOUND' | 'TOO_MANY',
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = 'RootFileError';
  }
}

/** The types a root file is served as, by its extension. */
const ROOT_FILE_TYPES: Readonly<Record<string, string>> = {
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
};

/** At most this many bytes (UTF-8) in one file (a large publisher's `ads.txt` stays well under it). */
export const ROOT_FILE_MAX_BYTES = 512 * 1024;
/** At most this many root files on one site. */
const ROOT_FILES_PER_SITE = 100;

/** A name: one path segment of letters, digits, `.`, `_`, `-` (not starting with a dot: no `.env`, `.git`), with a known extension. */
const NAME = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\\.(${Object.keys(ROOT_FILE_TYPES).join('|')})$`, 'i');

/**
 * Names the system answers itself (whatever their case): the crawler policy, the sitemaps, the feeds, `llms.txt`, and
 * IndexNow key files (32 hexadecimal digits, `.txt`).
 */
const SYSTEM_NAMES: readonly RegExp[] = [
  /^robots\.txt$/,
  /^sitemap(-[^.]*)?\.(xml|txt)$/,
  /^news-sitemap(-[^.]*)?\.xml$/,
  /^llms(-[^.]*)?\.txt$/,
  /^(feed|rss|atom)([-_.][a-z0-9-]+)*$/,
  /^[0-9a-f]{32}\.txt$/,
];

/** Why a name cannot be a root file, or null. */
function rootFileNameError(filename: string): RootFileError | null {
  if (typeof filename !== 'string' || !NAME.test(filename)) {
    return new RootFileError('INVALID_NAME', `A root file's name is one name with an extension (${Object.keys(ROOT_FILE_TYPES).join(', ')}): letters, digits, ".", "_", "-", not starting with a dot.`, 400);
  }
  const lower = filename.toLowerCase();
  if (SYSTEM_NAMES.some((p) => p.test(lower))) return new RootFileError('SYSTEM_FILE', `${filename} is made by the system; it cannot be replaced.`, 409);
  return null;
}

export interface RootFileView {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  updatedAt: Date;
}

export interface RootFilesDeps {
  db: Database;
  siteId: string;
  /** Who writes, as the audit records it: the user, or the API key, and the request it came by. */
  actor: { userId: string | null; email?: string | null; apiKeyId?: string | null; method?: string | null; ip?: string | null; userAgent?: string | null; requestId?: string | null };
}

export class RootFilesService {
  constructor(private readonly deps: RootFilesDeps) {}

  /** The audit record's actor and request (Codex review of batch 7: an API key's change is attributed too). */
  private audit(tx: unknown, event: 'root_file_written' | 'root_file_deleted', metadata: Record<string, unknown>) {
    const a = this.deps.actor;
    return new AuditLogger({ db: tx as Database, siteId: this.deps.siteId }).writeInTransaction(tx as Database, {
      siteId: this.deps.siteId,
      event,
      actorEmail: a.email ?? null,
      ip: a.ip ?? null,
      userAgent: a.userAgent ?? null,
      requestId: a.requestId ?? null,
      metadata: { ...metadata, userId: a.userId, apiKeyId: a.apiKeyId ?? null, method: a.method ?? null },
    });
  }

  async list(): Promise<RootFileView[]> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .select({ filename: siteRootFiles.filename, contentType: siteRootFiles.contentType, size: siteRootFiles.size, sha256: siteRootFiles.sha256, updatedAt: siteRootFiles.updatedAt })
        .from(siteRootFiles)
        .where(eq(siteRootFiles.siteId, this.deps.siteId))
        .orderBy(asc(siteRootFiles.filename)),
    );
  }

  async get(filename: string): Promise<(RootFileView & { content: string }) | null> {
    const [row] = await runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx.select().from(siteRootFiles).where(and(eq(siteRootFiles.siteId, this.deps.siteId), eq(siteRootFiles.filename, filename))),
    );
    return row ? { filename: row.filename, contentType: row.contentType, size: row.size, sha256: row.sha256, updatedAt: row.updatedAt, content: row.content } : null;
  }

  /** Create or replace a root file. */
  async put(filename: string, content: unknown): Promise<RootFileView> {
    const nameError = rootFileNameError(filename);
    if (nameError) throw nameError;
    if (typeof content !== 'string') throw new RootFileError('INVALID_CONTENT', 'A root file is text.', 400);
    // Text only: no control characters but tab, line feed and carriage return.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(content)) throw new RootFileError('INVALID_CONTENT', 'A root file is text: no control characters.', 400);
    const size = Buffer.byteLength(content, 'utf8');
    if (size > ROOT_FILE_MAX_BYTES) throw new RootFileError('TOO_LARGE', `A root file is at most ${ROOT_FILE_MAX_BYTES} bytes.`, 400);
    const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
    const contentType = ROOT_FILE_TYPES[ext]!;
    const sha256 = createHash('sha256').update(content).digest('hex');
    const { siteId } = this.deps;
    return runSiteTransaction(this.deps.db, siteId, async (tx) => {
      // One writer of a site's root files at a time: the count is read and kept under the limit (no two writers both
      // seeing room for one more).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`heopress:root-files:${siteId}`}, 0))`);
      const existing = await tx.select({ filename: siteRootFiles.filename }).from(siteRootFiles).where(eq(siteRootFiles.siteId, siteId));
      if (!existing.some((r) => r.filename === filename) && existing.length >= ROOT_FILES_PER_SITE) {
        throw new RootFileError('TOO_MANY', `A site has at most ${ROOT_FILES_PER_SITE} root files.`, 409);
      }
      const now = new Date();
      const [row] = await tx
        .insert(siteRootFiles)
        .values({ siteId, filename, contentType, content, sha256, size })
        .onConflictDoUpdate({ target: [siteRootFiles.siteId, siteRootFiles.filename], set: { contentType, content, sha256, size, updatedAt: now } })
        .returning();
      await this.audit(tx, 'root_file_written', { filename, size, sha256 });
      return { filename: row!.filename, contentType: row!.contentType, size: row!.size, sha256: row!.sha256, updatedAt: row!.updatedAt };
    });
  }

  async remove(filename: string): Promise<void> {
    const { siteId } = this.deps;
    await runSiteTransaction(this.deps.db, siteId, async (tx) => {
      const [row] = await tx.delete(siteRootFiles).where(and(eq(siteRootFiles.siteId, siteId), eq(siteRootFiles.filename, filename))).returning();
      if (!row) throw new RootFileError('NOT_FOUND', `${filename} is not a root file of this site.`, 404);
      await this.audit(tx, 'root_file_deleted', { filename, sha256: row.sha256 });
    });
  }
}
