import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { collections, items, previewLinks, siteThemes, themeAssets, themeVersions, users, type Database } from '@heopress/database';
import type { CacheProvider } from '@heopress/runtime';
import { PermissionService } from '../permission-service';
import { runSiteTransaction } from '../rls-transaction';
import { previewItemRow, type PreviewItemRow } from '../site-network/public-projection';

/**
 * Preview links (HeoPress P06 tasks 4.2, 4.3; spec rendering/preview; design R7, R17, R43).
 *
 *   - `create`: a link to one draft item (the creator can read it) or one sealed theme version (the
 *     creator administers the site). The token — 256 random bits — is returned once; only its SHA-256
 *     is stored. Valid one hour by default, a day at most.
 *   - `resolve`: what the rendering service's internal preview endpoint answers. The link is looked up
 *     in the site the preview URL names only (a token of site A used under site B finds nothing there —
 *     B's drafts are never read); then its expiry, its revocation and the creator's **current**
 *     permission (an active account, read access to the item now, or site administration for a theme).
 *     Item data is built by the projection's rules, narrowed to the fields the creator may read.
 *   - Every refusal is the same `PreviewDenied` (the caller answers 403 without telling why).
 */

export class PreviewDenied extends Error {
  constructor(readonly reason: string) {
    super('Preview not allowed.');
    this.name = 'PreviewDenied';
  }
}

export class PreviewServiceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
    this.name = 'PreviewServiceError';
  }
}

const DEFAULT_TTL_S = 3600;
const MAX_TTL_S = 24 * 3600;
const MIN_TTL_S = 60;

const hashPreviewToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** What a valid preview shows. */
export type PreviewTarget =
  | { kind: 'item'; siteId: string; expiresAt: Date; item: PreviewItemRow }
  | {
      kind: 'theme';
      siteId: string;
      expiresAt: Date;
      theme: { versionId: string; templates: Record<string, string>; assets: Array<{ path: string; sha256: string; contentType: string; size: number }> };
    };

type Link = typeof previewLinks.$inferSelect;

export class PreviewService {
  constructor(private readonly deps: { db: Database; cache?: CacheProvider; now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private permissions(siteId: string, userId: string): PermissionService {
    return new PermissionService({
      db: this.deps.db,
      cache: this.deps.cache,
      ctx: { userId, siteId, roleId: null, user: null, ip: null, headers: {}, now: this.now() },
    });
  }

  /** Whether `userId` (an active account) may preview this target now; the fields it may read for an item. */
  private async allowed(siteId: string, userId: string, kind: 'item' | 'theme', collection: string | null, targetId: string): Promise<string[] | null> {
    const [user] = await this.deps.db.select({ status: users.status }).from(users).where(eq(users.id, userId));
    if (user?.status !== 'active') return null;
    const perms = this.permissions(siteId, userId);
    if (kind === 'theme') {
      if (!(await perms.bundle()).admin) return null;
      const [version] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
        tx
          .select({ id: themeVersions.id })
          .from(themeVersions)
          .where(and(eq(themeVersions.siteId, siteId), eq(themeVersions.id, targetId), isNotNull(themeVersions.sealedAt))),
      );
      return version ? ['*'] : null;
    }
    if (!collection) return null;
    const read = await perms.canAccess(collection, 'read');
    if (!read) return null;
    const [visible] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .select({ id: items.id })
        .from(items)
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(and(eq(items.siteId, siteId), eq(items.id, targetId), eq(collections.name, collection), perms.whereFor(read))),
    );
    return visible ? read.fields : null;
  }

  async create(input: {
    siteId: string;
    userId: string | null;
    kind: unknown;
    collection?: unknown;
    targetId: unknown;
    ttlSeconds?: unknown;
  }): Promise<{ id: string; token: string; expiresAt: Date }> {
    const { siteId, userId } = input;
    if (!userId) throw new PreviewServiceError('FORBIDDEN', 'Preview links are created by a signed-in user.', 403);
    if (input.kind !== 'item' && input.kind !== 'theme') throw new PreviewServiceError('VALIDATION', 'kind must be "item" or "theme".');
    if (typeof input.targetId !== 'string' || !input.targetId) throw new PreviewServiceError('VALIDATION', 'target_id is required.');
    const collection = input.kind === 'item' ? input.collection : null;
    if (input.kind === 'item' && (typeof collection !== 'string' || !collection)) throw new PreviewServiceError('VALIDATION', 'collection is required for an item preview.');
    const ttl = input.ttlSeconds === undefined ? DEFAULT_TTL_S : Number(input.ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < MIN_TTL_S || ttl > MAX_TTL_S) {
      throw new PreviewServiceError('VALIDATION', `ttl_seconds must be an integer from ${MIN_TTL_S} to ${MAX_TTL_S}.`);
    }
    const fields = await this.allowed(siteId, userId, input.kind, collection as string | null, input.targetId);
    if (!fields) throw new PreviewServiceError('NOT_FOUND', 'Nothing to preview, or no permission to preview it.', 404);

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + ttl * 1000);
    const [row] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .insert(previewLinks)
        .values({ siteId, kind: input.kind as 'item' | 'theme', collection: collection as string | null, targetId: input.targetId as string, createdBy: userId, tokenHash: hashPreviewToken(token), expiresAt })
        .returning({ id: previewLinks.id }),
    );
    return { id: row!.id, token, expiresAt };
  }

  /** Revoke a link of the site: its creator, or a site administrator. */
  async revoke(siteId: string, id: string, actor: { userId: string | null; admin: boolean }): Promise<void> {
    const done = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .update(previewLinks)
        .set({ revokedAt: this.now() })
        .where(
          and(
            eq(previewLinks.siteId, siteId),
            eq(previewLinks.id, id),
            actor.admin ? undefined : eq(previewLinks.createdBy, actor.userId ?? ''),
            sql`${previewLinks.revokedAt} IS NULL`,
          ),
        )
        .returning({ id: previewLinks.id }),
    );
    if (done.length === 0) throw new PreviewServiceError('NOT_FOUND', 'Preview link not found.', 404);
  }

  /** The valid link of `siteId` with this token, with the creator's current permission checked. */
  private async link(siteId: string, token: string): Promise<{ link: Link; fields: string[] }> {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) throw new PreviewDenied('malformed');
    const [link] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .select()
        .from(previewLinks)
        .where(and(eq(previewLinks.siteId, siteId), eq(previewLinks.tokenHash, hashPreviewToken(token)))),
    );
    if (!link) throw new PreviewDenied('unknown');
    if (link.revokedAt) throw new PreviewDenied('revoked');
    if (link.expiresAt.getTime() <= this.now().getTime()) throw new PreviewDenied('expired');
    const fields = await this.allowed(siteId, link.createdBy, link.kind, link.collection, link.targetId);
    if (!fields) throw new PreviewDenied('permission');
    return { link, fields };
  }

  async resolve(siteId: string, token: string): Promise<PreviewTarget> {
    const { link, fields } = await this.link(siteId, token);
    if (link.kind === 'item') {
      const item = await runSiteTransaction(this.deps.db, siteId, (tx) => previewItemRow(tx, siteId, link.collection!, link.targetId, fields));
      if (!item) throw new PreviewDenied('gone');
      return { kind: 'item', siteId, expiresAt: link.expiresAt, item };
    }
    const [version] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .select({ id: themeVersions.id, templates: themeVersions.templates, assets: themeVersions.assets })
        .from(themeVersions)
        .where(and(eq(themeVersions.siteId, siteId), eq(themeVersions.id, link.targetId), isNotNull(themeVersions.sealedAt))),
    );
    if (!version) throw new PreviewDenied('gone');
    return { kind: 'theme', siteId, expiresAt: link.expiresAt, theme: { versionId: version.id, templates: version.templates, assets: version.assets } };
  }

  /**
   * An asset a preview page uses: of the previewed theme version, or (an item preview) of the site's
   * active version. Null when it is neither or does not exist.
   */
  async asset(siteId: string, token: string, versionId: string, sha256: string, ext: string): Promise<{ contentType: string; bytes: Buffer } | null> {
    const { link } = await this.link(siteId, token);
    return runSiteTransaction(this.deps.db, siteId, async (tx) => {
      if (link.kind === 'theme') {
        if (versionId !== link.targetId) return null;
      } else {
        const [active] = await tx.select({ v: siteThemes.themeVersionId }).from(siteThemes).where(eq(siteThemes.siteId, siteId));
        if (active?.v !== versionId) return null;
      }
      const [row] = await tx
        .select({ contentType: themeAssets.contentType, bytes: themeAssets.bytes })
        .from(themeAssets)
        .where(and(eq(themeAssets.siteId, siteId), eq(themeAssets.versionId, versionId), eq(themeAssets.sha256, sha256), sql`${themeAssets.path} LIKE ${`%.${ext}`}`))
        .orderBy(themeAssets.path)
        .limit(1);
      return row ?? null;
    });
  }
}
