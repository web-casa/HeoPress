import { eq, sql } from 'drizzle-orm';
import { sites, users, userSites, type Database } from '@heopress/database';
import { isValidSiteId } from '../identifier-guard';
import { runSiteTransaction } from '../rls-transaction';
import { installSiteNetworkPreset } from '../site-network/preset-installer';
import { ensureSystemRole } from './site-roles';

/**
 * Creating a site and its first grant (HeoPress P07 task 0.1; spec sites/site-provisioning "建站与首次授权").
 *
 * The site, its content preset, its system roles (Administrator, Member) and the creator's
 * Administrator membership commit in one transaction in the new site's scope: a failure at any step
 * leaves nothing, never a site no one can administer. Who may create a site is an instance capability:
 * until instance-level grants exist, only the bootstrap administrator (read from the database, never
 * from a token claim); an administrator of some site is not enough.
 */

export class SiteProvisioningError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'VALIDATION' | 'CONFLICT',
    message: string,
    readonly status: 400 | 403 | 409,
  ) {
    super(message);
  }
}

export interface NewSite {
  id: string;
  name: string;
  defaultLanguage?: string;
}

const MAX_NAME = 200;
/** A BCP 47-like language tag (`en`, `zh-CN`, `pt-BR`); the content settings validate it further. */
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** Whether this user may create sites: an active bootstrap administrator. */
export async function canCreateSite(db: Database, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  const [user] = await db.select({ isBootstrap: users.isBootstrap, status: users.status }).from(users).where(eq(users.id, userId)).limit(1);
  return user?.isBootstrap === true && user.status === 'active';
}

/** Checked before the transaction: what the request may not get wrong. */
export function validateNewSite(input: unknown): NewSite {
  const v = (input ?? {}) as Record<string, unknown>;
  const id = typeof v.id === 'string' ? v.id.trim() : '';
  const name = typeof v.name === 'string' ? v.name.trim() : '';
  const defaultLanguage = v.defaultLanguage === undefined ? undefined : typeof v.defaultLanguage === 'string' ? v.defaultLanguage.trim() : null;
  if (!id || !isValidSiteId(id)) throw new SiteProvisioningError('VALIDATION', 'id: lowercase letters, digits, "-" and "_".', 400);
  if (!name || name.length > MAX_NAME) throw new SiteProvisioningError('VALIDATION', `name: 1–${MAX_NAME} characters.`, 400);
  if (defaultLanguage === null || (defaultLanguage !== undefined && !LANGUAGE.test(defaultLanguage))) {
    throw new SiteProvisioningError('VALIDATION', 'defaultLanguage: a language tag such as "en" or "zh-CN".', 400);
  }
  return { id, name, ...(defaultLanguage ? { defaultLanguage } : {}) };
}

/**
 * A unique violation when inserting the site (the driver's error, or the query builder's wrapping it): another
 * request created the same id meanwhile (`exists`), or the database's hold on a recently deleted id refused it
 * after the pre-check (`held`, migration 0042). Anything else: null.
 */
export function idConflictOf(err: unknown): 'held' | 'exists' | null {
  type DbError = { code?: string; message?: string; constraint_name?: string };
  const e = err as DbError & { cause?: DbError };
  const db = e?.cause?.code ? e.cause : e;
  if (db?.code !== '23505') return null;
  if (/deleted less than 25 hours ago/.test(String(db.message ?? ''))) return 'held';
  // Only the site's own key: a unique violation elsewhere in the transaction is not "the site exists".
  return db.constraint_name === 'lumibase_sites_pkey' ? 'exists' : null;
}

/** Create the site with its preset, roles and the creator as its Administrator. */
export async function provisionSite(db: Database, input: NewSite, creatorUserId: string) {
  if (!(await canCreateSite(db, creatorUserId))) {
    throw new SiteProvisioningError('FORBIDDEN', 'Creating sites needs the instance administrator.', 403);
  }
  const [existing] = await db.select({ id: sites.id }).from(sites).where(eq(sites.id, input.id)).limit(1);
  if (existing) throw new SiteProvisioningError('CONFLICT', `A site "${input.id}" already exists.`, 409);
  // The hold on deleted ids is the database's (migration 0042: longer than any site cache); asked here for a clear answer.
  const [held] = (await db.execute(sql`SELECT public.heopress_site_id_held(${input.id}) AS held`)) as unknown as Array<{ held: boolean }>;
  if (held?.held) {
    throw new SiteProvisioningError('CONFLICT', `"${input.id}" belonged to a site deleted less than 25 hours ago; choose another id.`, 409);
  }
  try {
    return await runSiteTransaction(db, input.id, async (tx) => {
      const [created] = await tx
        .insert(sites)
        .values({ id: input.id, name: input.name, ...(input.defaultLanguage ? { defaultLanguage: input.defaultLanguage } : {}) })
        .returning();
      await installSiteNetworkPreset(tx as unknown as Database, input.id);
      const description = 'Created with the site.';
      const adminRoleId = await ensureSystemRole(tx as unknown as Database, input.id, 'administrator', description);
      const memberRoleId = await ensureSystemRole(tx as unknown as Database, input.id, 'member', description);
      if (!adminRoleId || !memberRoleId) throw new Error('site provisioning: system roles could not be created');
      await tx.insert(userSites).values({ userId: creatorUserId, siteId: input.id, roleId: adminRoleId });
      return created!;
    });
  } catch (err) {
    const conflict = idConflictOf(err);
    if (conflict === 'held') throw new SiteProvisioningError('CONFLICT', `"${input.id}" belonged to a site deleted less than 25 hours ago; choose another id.`, 409);
    if (conflict === 'exists') throw new SiteProvisioningError('CONFLICT', `A site "${input.id}" already exists.`, 409);
    throw err;
  }
}
