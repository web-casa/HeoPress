import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { branchPreviewGrants, collections, contentVersions, items, users, type Database } from '@heopress/database';
import type { CacheProvider } from '@heopress/runtime';
import { signBranchPreviewCookie, verifyBranchPreviewCookie } from '@heopress/public-site';
import { PermissionService } from '../permission-service';
import { runSiteTransaction } from '../rls-transaction';
import { previewItemRow, type PreviewItemRow } from '../site-network/public-projection';
import { PreviewDenied, PreviewServiceError } from './preview-service';

/**
 * Branch previews on the public site (HeoPress P10 tasks 4.2, 4.4; spec agents/content-branches "分支预览",
 * "分支预览隔离与合并版本").
 *
 *   - `create`: a one-time link `https://<the item's public host>/_heopress/branch-preview/<token>` for a person who
 *     may change the item. The token (256 random bits) is shown once; only its SHA-256 is kept. One hour by default,
 *     a day at most.
 *   - `exchange`: the rendering service trades the link, once, for a signed cookie bound to the site, the grant and
 *     the branch (see `branch-preview-cookie.ts`) — only the browser that opened the link holds it.
 *   - `resolve`: on every request with the cookie, the signature, the site, the expiry, the grant (not revoked), the
 *     branch and the creator's **current** read permission are checked, and the item's page data is built from the
 *     branch by the projection's rules. Nothing is written to the public projection or any cache.
 * Every refusal is the same `PreviewDenied`.
 */

const DEFAULT_TTL_S = 3600;
const MAX_TTL_S = 24 * 3600;
const MIN_TTL_S = 60;

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

export interface BranchPreviewTarget {
  siteId: string;
  versionId: string;
  expiresAt: string;
  /** The public path the branch's item answers on (its route). */
  path: string;
  item: PreviewItemRow;
}

export class BranchPreviewService {
  constructor(private readonly deps: { db: Database; secret: string; cache?: CacheProvider; now?: () => Date }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** The fields `userId` (an active account) may read in `collection` now, if the item is visible to them. */
  private async readable(siteId: string, userId: string, collection: string, itemId: string): Promise<string[] | null> {
    const [user] = await this.deps.db.select({ status: users.status }).from(users).where(eq(users.id, userId));
    if (user?.status !== 'active') return null;
    const perms = new PermissionService({
      db: this.deps.db,
      cache: this.deps.cache,
      ctx: { userId, siteId, roleId: null, user: null, ip: null, headers: {}, now: this.now() },
    });
    const read = await perms.canAccess(collection, 'read');
    if (!read) return null;
    const [visible] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .select({ id: items.id })
        .from(items)
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(and(eq(items.siteId, siteId), eq(items.id, itemId), eq(collections.name, collection), perms.whereFor(read))),
    );
    return visible ? read.fields : null;
  }

  private async branch(siteId: string, versionId: string) {
    const [row] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .select({ id: contentVersions.id, itemId: contentVersions.itemId, key: contentVersions.key, data: contentVersions.data, collection: collections.name })
        .from(contentVersions)
        .innerJoin(collections, eq(collections.id, contentVersions.collectionId))
        .where(and(eq(contentVersions.siteId, siteId), eq(contentVersions.id, versionId))),
    );
    return row ?? null;
  }

  /** The branch's page data and public address, as `fields` allow; null when it has no public address. */
  private async row(siteId: string, collection: string, itemId: string, data: Record<string, unknown>, fields: string[]): Promise<{ item: PreviewItemRow; url: URL } | null> {
    const item = await runSiteTransaction(this.deps.db, siteId, (tx) => previewItemRow(tx, siteId, collection, itemId, fields, data));
    const url = (item?.card as { url?: unknown } | undefined)?.url;
    if (!item || typeof url !== 'string' || !url) return null;
    try {
      return { item, url: new URL(url) };
    } catch {
      return null;
    }
  }

  async create(input: { siteId: string; userId: string | null; collection: string; itemId: string; key: string; ttlSeconds?: unknown }): Promise<{ id: string; url: string; expiresAt: Date }> {
    const { siteId, userId } = input;
    if (!userId) throw new PreviewServiceError('FORBIDDEN', 'Branch previews are opened by a signed-in person.', 403);
    const ttl = input.ttlSeconds === undefined ? DEFAULT_TTL_S : Number(input.ttlSeconds);
    if (!Number.isInteger(ttl) || ttl < MIN_TTL_S || ttl > MAX_TTL_S) {
      throw new PreviewServiceError('VALIDATION', `ttlSeconds must be an integer from ${MIN_TTL_S} to ${MAX_TTL_S}.`);
    }
    const fields = await this.readable(siteId, userId, input.collection, input.itemId);
    if (!fields) throw new PreviewServiceError('NOT_FOUND', 'Nothing to preview, or no permission to preview it.', 404);
    const [version] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .select({ id: contentVersions.id, data: contentVersions.data })
        .from(contentVersions)
        .innerJoin(collections, eq(collections.id, contentVersions.collectionId))
        .where(and(eq(contentVersions.siteId, siteId), eq(contentVersions.itemId, input.itemId), eq(contentVersions.key, input.key), eq(collections.name, input.collection))),
    );
    if (!version) throw new PreviewServiceError('NOT_FOUND', 'Branch not found.', 404);
    const placed = await this.row(siteId, input.collection, input.itemId, version.data as Record<string, unknown>, fields);
    if (!placed) throw new PreviewServiceError('VALIDATION', 'The item has no public address yet: use a draft preview link instead.');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + ttl * 1000);
    const [row] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .insert(branchPreviewGrants)
        .values({ siteId, versionId: version.id, collection: input.collection, itemId: input.itemId, createdBy: userId, tokenHash: hashToken(token), expiresAt })
        .returning({ id: branchPreviewGrants.id }),
    );
    return { id: row!.id, url: `${placed.url.origin}/_heopress/branch-preview/${token}`, expiresAt };
  }

  /** Revoke every open preview of a branch (its creator's or, for an administrator, anyone's). */
  async revoke(siteId: string, collection: string, itemId: string, key: string, actor: { userId: string | null; admin: boolean }): Promise<number> {
    const rows = await runSiteTransaction(this.deps.db, siteId, async (tx) => {
      const [version] = await tx
        .select({ id: contentVersions.id })
        .from(contentVersions)
        .innerJoin(collections, eq(collections.id, contentVersions.collectionId))
        .where(and(eq(contentVersions.siteId, siteId), eq(contentVersions.itemId, itemId), eq(contentVersions.key, key), eq(collections.name, collection)));
      if (!version) return [];
      return tx
        .update(branchPreviewGrants)
        .set({ revokedAt: this.now() })
        .where(
          and(
            eq(branchPreviewGrants.siteId, siteId),
            eq(branchPreviewGrants.versionId, version.id),
            isNull(branchPreviewGrants.revokedAt),
            actor.admin ? undefined : eq(branchPreviewGrants.createdBy, actor.userId ?? ''),
          ),
        )
        .returning({ id: branchPreviewGrants.id });
    });
    return rows.length;
  }

  /** Trade a link for the cookie, once. */
  async exchange(siteId: string, token: string): Promise<{ cookie: string; expiresAt: Date; path: string }> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new PreviewDenied('malformed');
    const now = this.now();
    const [grant] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx
        .update(branchPreviewGrants)
        .set({ exchangedAt: now })
        .where(
          and(
            eq(branchPreviewGrants.siteId, siteId),
            eq(branchPreviewGrants.tokenHash, hashToken(token)),
            isNull(branchPreviewGrants.exchangedAt),
            isNull(branchPreviewGrants.revokedAt),
            gt(branchPreviewGrants.expiresAt, now),
          ),
        )
        .returning(),
    );
    if (!grant) throw new PreviewDenied('unknown');
    const target = await this.target(siteId, grant);
    const cookie = signBranchPreviewCookie(this.deps.secret, { siteId, grantId: grant.id, versionId: grant.versionId, expiresAt: Math.floor(grant.expiresAt.getTime() / 1000) });
    return { cookie, expiresAt: grant.expiresAt, path: target.path };
  }

  async resolve(siteId: string, cookie: string): Promise<BranchPreviewTarget> {
    const claims = verifyBranchPreviewCookie(this.deps.secret, cookie, siteId, this.now().getTime());
    if (!claims) throw new PreviewDenied('signature');
    const [grant] = await runSiteTransaction(this.deps.db, siteId, (tx) =>
      tx.select().from(branchPreviewGrants).where(and(eq(branchPreviewGrants.siteId, siteId), eq(branchPreviewGrants.id, claims.grantId))),
    );
    if (!grant || grant.versionId !== claims.versionId || !grant.exchangedAt) throw new PreviewDenied('unknown');
    if (grant.revokedAt) throw new PreviewDenied('revoked');
    if (grant.expiresAt.getTime() <= this.now().getTime()) throw new PreviewDenied('expired');
    return this.target(siteId, grant);
  }

  private async target(siteId: string, grant: typeof branchPreviewGrants.$inferSelect): Promise<BranchPreviewTarget> {
    const branch = await this.branch(siteId, grant.versionId);
    if (!branch || branch.itemId !== grant.itemId || branch.collection !== grant.collection) throw new PreviewDenied('gone');
    const fields = await this.readable(siteId, grant.createdBy, grant.collection, grant.itemId);
    if (!fields) throw new PreviewDenied('permission');
    const placed = await this.row(siteId, grant.collection, grant.itemId, branch.data as Record<string, unknown>, fields);
    if (!placed) throw new PreviewDenied('gone');
    return { siteId, versionId: grant.versionId, expiresAt: grant.expiresAt.toISOString(), path: placed.url.pathname, item: placed.item };
  }
}
