import { and, desc, eq, max, sql } from 'drizzle-orm';
import { EditorialProfileContentSchema, type EditorialProfileContent } from '@heopress/contracts/schemas';
import { editorialProfileVersions, siteContentSettings, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { ensureContentSettings } from './preset-installer';

/**
 * A site's editorial profile, versioned (HeoPress P05 tasks 2.1, 2.2; spec
 * content/editorial-profiles; design C).
 *
 * - Every save is a new `draft` version, numbered `max + 1` under the site's
 *   content settings row lock (two saves at once get distinct numbers).
 * - Publishing a version makes it the one in effect; the version in effect
 *   before becomes `superseded` (a partial unique index allows one
 *   `published` version per site). Any earlier version can be published
 *   again. Versions are never changed otherwise: the history stays readable.
 * - `current()` is what AI tasks and external agents follow; runs record its
 *   number (`currentVersionNumber`).
 */

export class EditorialProfileError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 404 | 409,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface EditorialProfileVersion {
  version: number;
  status: 'draft' | 'published' | 'superseded';
  content: EditorialProfileContent;
  createdBy: string | null;
  createdAt: string;
  publishedBy: string | null;
  publishedAt: string | null;
}

type Row = typeof editorialProfileVersions.$inferSelect;

const toVersion = (r: Row): EditorialProfileVersion => ({
  version: r.version,
  status: r.status as EditorialProfileVersion['status'],
  content: EditorialProfileContentSchema.parse(r.content),
  createdBy: r.createdBy,
  createdAt: r.createdAt.toISOString(),
  publishedBy: r.publishedBy,
  publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
});

/** The number of the version in effect for a site (null: none), inside the caller's transaction or on its own. */
export async function currentEditorialProfileVersion(db: Pick<Database, 'select'>, siteId: string): Promise<number | null> {
  const [row] = await db
    .select({ version: editorialProfileVersions.version })
    .from(editorialProfileVersions)
    .where(and(eq(editorialProfileVersions.siteId, siteId), eq(editorialProfileVersions.status, 'published')));
  return row?.version ?? null;
}

export class EditorialProfileService {
  constructor(private readonly deps: { db: Database; siteId: string; actor: { userId: string | null; apiKeyId?: string | null; email?: string | null } }) {}

  private tx<T>(fn: (tx: SiteTransaction) => Promise<T>): Promise<T> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, fn);
  }

  private get actorId(): string | null {
    return this.deps.actor.userId ?? (this.deps.actor.apiKeyId ? `api_key:${this.deps.actor.apiKeyId}` : null);
  }

  /** The version in effect, or null when the site has none published. */
  async current(): Promise<EditorialProfileVersion | null> {
    return this.tx(async (tx) => {
      const [row] = await tx
        .select()
        .from(editorialProfileVersions)
        .where(and(eq(editorialProfileVersions.siteId, this.deps.siteId), eq(editorialProfileVersions.status, 'published')));
      return row ? toVersion(row) : null;
    });
  }

  async list(): Promise<EditorialProfileVersion[]> {
    return this.tx(async (tx) =>
      (
        await tx.select().from(editorialProfileVersions).where(eq(editorialProfileVersions.siteId, this.deps.siteId)).orderBy(desc(editorialProfileVersions.version))
      ).map(toVersion),
    );
  }

  async get(version: number): Promise<EditorialProfileVersion> {
    return this.tx(async (tx) => {
      const [row] = await tx
        .select()
        .from(editorialProfileVersions)
        .where(and(eq(editorialProfileVersions.siteId, this.deps.siteId), eq(editorialProfileVersions.version, version)));
      if (!row) throw new EditorialProfileError('NOT_FOUND', `No version ${version}.`, 404);
      return toVersion(row);
    });
  }

  /** Save a new draft version (content validated). */
  async create(input: unknown): Promise<EditorialProfileVersion> {
    const parsed = EditorialProfileContentSchema.safeParse(input);
    if (!parsed.success) {
      throw new EditorialProfileError('VALIDATION', 'The editorial profile is not valid.', 400, parsed.error.issues.map((i) => ({ path: i.path, message: i.message })));
    }
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      // Numbered under the site's settings row lock: concurrent saves queue and take max + 1 in turn.
      await ensureContentSettings(tx as unknown as Database, siteId);
      await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`);
      const [top] = await tx.select({ n: max(editorialProfileVersions.version) }).from(editorialProfileVersions).where(eq(editorialProfileVersions.siteId, siteId));
      const [row] = await tx
        .insert(editorialProfileVersions)
        .values({ siteId, version: (top?.n ?? 0) + 1, content: parsed.data, status: 'draft', createdBy: this.actorId })
        .returning();
      return toVersion(row!);
    });
  }

  /** Make a version the one in effect; the previous one becomes superseded. Audited. */
  async publish(version: number): Promise<EditorialProfileVersion> {
    const { siteId } = this.deps;
    return this.tx(async (tx) => {
      await ensureContentSettings(tx as unknown as Database, siteId);
      await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`);
      const [target] = await tx
        .select()
        .from(editorialProfileVersions)
        .where(and(eq(editorialProfileVersions.siteId, siteId), eq(editorialProfileVersions.version, version)));
      if (!target) throw new EditorialProfileError('NOT_FOUND', `No version ${version}.`, 404);
      if (target.status === 'published') return toVersion(target);
      const previous = await currentEditorialProfileVersion(tx, siteId);
      await tx
        .update(editorialProfileVersions)
        .set({ status: 'superseded' })
        .where(and(eq(editorialProfileVersions.siteId, siteId), eq(editorialProfileVersions.status, 'published')));
      const [row] = await tx
        .update(editorialProfileVersions)
        .set({ status: 'published', publishedBy: this.actorId, publishedAt: new Date() })
        .where(and(eq(editorialProfileVersions.siteId, siteId), eq(editorialProfileVersions.version, version)))
        .returning();
      await new AuditLogger({ db: this.deps.db, siteId }).writeInTransaction(tx, {
        siteId,
        event: 'editorial_profile_published',
        actorEmail: this.deps.actor.email ?? null,
        metadata: { operator: this.actorId, version, previous },
      });
      return toVersion(row!);
    });
  }
}
