import { and, eq, inArray, isNull } from 'drizzle-orm';
import { collections, items, userSites, type Database } from '@heopress/database';
import type { VectorCandidate, VectorPurpose } from '@heopress/runtime/node';
import { PermissionService, type CompiledPermission } from './permission-service';
import type { PolicyRule } from '@heopress/contracts';
import { applyFieldMask, evaluate, type MagicContext } from './permission-dsl';
import { resolvePublicRoleId } from './auth/public-role';

/**
 * Re-checking vector hits before they reach a prompt (HeoPress P03 task 5.5;
 * spec "检索命中后复核"). `PgVectorStore.query` passes every candidate —
 * fresh or cached — to a verifier; this one checks item sources against the
 * current rows and the current permissions of the principal:
 *
 *   - the item still exists, is not deleted, and is at the revision the
 *     vector was computed from (`updated_at`);
 *   - `public_answer`: the item is published and inside its publish window,
 *     and the site's public role may read it now;
 *   - `internal_writing`: the user is a member of the site now, with the
 *     role the membership has now;
 *   - either way the principal's read permission must cover the item's row
 *     (the policy rule is evaluated against the current row) and every field
 *     the chunk was built from (`metadata.fields`, or `metadata.fieldName`);
 *     a chunk that does not say which fields it holds needs unrestricted
 *     field access.
 *
 * The principal is resolved afresh on every call — memberships, public role
 * and permission bundles are read from the database, never from a cache — so
 * a revocation applies to the next verification, including refills and
 * cached candidates (Codex review 4, #2–#5). Unknown source types are dropped
 * (fail closed). Purposes are judged separately.
 */

export const itemRevision = (updatedAt: Date): string => updatedAt.toISOString();

export interface ItemVerifierOptions {
  db: Database;
  purpose: VectorPurpose;
  /** Required for `internal_writing`: whose permissions apply. */
  userId?: string;
  now?: Date;
}

interface Principal {
  ctx: MagicContext;
  permissions: Map<string, Promise<CompiledPermission | null>>;
}

/** Fields a chunk was built from, as recorded when it was indexed. */
function chunkFields(c: VectorCandidate): string[] | null {
  const m = c.metadata ?? {};
  if (Array.isArray(m.fields) && m.fields.every((f) => typeof f === 'string')) return m.fields as string[];
  if (typeof m.fieldName === 'string') return [m.fieldName];
  return null;
}

export function itemCandidateVerifier(opts: ItemVerifierOptions) {
  return async (candidates: VectorCandidate[]): Promise<VectorCandidate[]> => {
    const itemCandidates = candidates.filter((c) => c.sourceType === 'item' && c.purpose === opts.purpose);
    if (itemCandidates.length === 0) return [];
    if (opts.purpose === 'internal_writing' && !opts.userId) return [];
    const rows = await opts.db
      .select({ item: items, collection: collections.name })
      .from(items)
      .innerJoin(collections, eq(collections.id, items.collectionId))
      .where(and(inArray(items.id, [...new Set(itemCandidates.map((c) => c.sourceId))]), isNull(items.deletedAt)));
    const byId = new Map(rows.map((r) => [r.item.id, r]));
    const now = opts.now ?? new Date();

    // One principal per site, resolved now.
    const principals = new Map<string, Promise<Principal | null>>();
    const principalFor = (siteId: string) => {
      let p = principals.get(siteId);
      if (!p) {
        p = resolvePrincipal(opts, siteId);
        principals.set(siteId, p);
      }
      return p;
    };

    const out: VectorCandidate[] = [];
    for (const c of itemCandidates) {
      const row = byId.get(c.sourceId);
      if (!row || row.item.siteId !== c.siteId || itemRevision(row.item.updatedAt) !== c.revision) continue;
      if (opts.purpose === 'public_answer') {
        const live =
          row.item.status === 'published' &&
          (!row.item.publishAt || row.item.publishAt <= now) &&
          (!row.item.unpublishAt || row.item.unpublishAt > now);
        if (!live) continue;
      }
      const principal = await principalFor(c.siteId);
      if (!principal) continue;
      let perm = principal.permissions.get(row.collection);
      if (!perm) {
        perm = new PermissionService({ db: opts.db, ctx: principal.ctx }).canAccess(row.collection, 'read');
        principal.permissions.set(row.collection, perm);
      }
      const granted = await perm;
      if (!granted) continue;
      const snapshot = {
        id: row.item.id,
        status: row.item.status,
        sort: row.item.sort,
        user_created: row.item.userCreated,
        user_updated: row.item.userUpdated,
        created_at: row.item.createdAt,
        updated_at: row.item.updatedAt,
        data: row.item.data as Record<string, unknown>,
      };
      if (!evaluate(granted.rule as PolicyRule | null, snapshot, principal.ctx)) continue;
      const fields = chunkFields(c);
      const unrestricted = granted.fields.includes('*') && !granted.fields.some((f) => f.startsWith('-'));
      if (fields === null) {
        if (!unrestricted) continue;
      } else {
        const allowed = new Set(applyFieldMask(fields, granted.fields));
        if (!fields.every((f) => allowed.has(f))) continue;
      }
      out.push(c);
    }
    return out;
  };
}

async function resolvePrincipal(opts: ItemVerifierOptions, siteId: string): Promise<Principal | null> {
  if (opts.purpose === 'public_answer') {
    const roleId = await resolvePublicRoleId(opts.db, siteId);
    if (!roleId) return null;
    return { ctx: { userId: null, siteId, roleId, ip: null, headers: {} }, permissions: new Map() };
  }
  const [membership] = await opts.db
    .select({ roleId: userSites.roleId })
    .from(userSites)
    .where(and(eq(userSites.userId, opts.userId!), eq(userSites.siteId, siteId)))
    .limit(1);
  if (!membership) return null;
  return {
    ctx: { userId: opts.userId!, siteId, roleId: membership.roleId ?? null, ip: null, headers: {} },
    permissions: new Map(),
  };
}

/** The sites a user is a member of now — the `siteIds` for internal retrieval. */
export async function currentMemberSites(db: Database, userId: string): Promise<string[]> {
  const rows = await db.select({ siteId: userSites.siteId }).from(userSites).where(eq(userSites.userId, userId));
  return rows.map((r) => r.siteId);
}
