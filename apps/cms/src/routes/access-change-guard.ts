import type { Context, MiddlewareHandler } from 'hono';
import { and, eq } from 'drizzle-orm';
import { policies, roles, userSites, users, type Database } from '@heopress/database';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { guardAdmins, LastAdminError, sitesOfUser } from '../services/access/admin-guard';

/**
 * Changes to who may do what on a site (HeoPress P07a tasks 11.2, 12.4): every write to roles, policies and
 * memberships runs inside the last-administrator guard's transaction — the handler's `db` is that transaction — and,
 * when it succeeds, leaves one site audit record: who, which object, and a summary of it before and after.
 */

type Kind = 'role' | 'policy' | 'member';

interface Target {
  kind: Kind;
  id: string | null;
  userId: string | null;
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Path segments after the router's mount point. */
function segments(c: Context<AppEnv>, mount: string): string[] {
  const path = c.req.path;
  const at = path.indexOf(mount);
  return path.slice(at + mount.length).split('/').filter(Boolean);
}

async function summary(db: Database, siteId: string, target: Target): Promise<Record<string, unknown> | null> {
  try {
    return await summaryOf(db, siteId, target);
  } catch {
    // A summary is context for the record; failing to read it never fails the change.
    return null;
  }
}

async function summaryOf(db: Database, siteId: string, target: Target): Promise<Record<string, unknown> | null> {
  if (target.kind === 'role' && target.id) {
    const [r] = await db.select({ name: roles.name, adminAccess: roles.adminAccess, appAccess: roles.appAccess }).from(roles).where(and(eq(roles.siteId, siteId), eq(roles.id, target.id)));
    if (!target.userId) return r ?? null;
  }
  if (target.kind === 'policy' && target.id && !target.userId) {
    const [p] = await db
      .select({ name: policies.name, adminAccess: policies.adminAccess, appAccess: policies.appAccess, enforceTfa: policies.enforceTfa, validFrom: policies.validFrom, validUntil: policies.validUntil })
      .from(policies)
      .where(and(eq(policies.siteId, siteId), eq(policies.id, target.id)));
    return p ?? null;
  }
  if (target.userId) {
    const [m] = await db
      .select({ roleId: userSites.roleId, roleName: roles.name })
      .from(userSites)
      .leftJoin(roles, and(eq(roles.id, userSites.roleId), eq(roles.siteId, siteId)))
      .where(and(eq(userSites.siteId, siteId), eq(userSites.userId, target.userId)));
    const [u] = await db.select({ status: users.status, email: users.email }).from(users).where(eq(users.id, target.userId));
    // The role by name too (spec ops/event-log "改角色": the event names the former and the new role).
    return m || u ? { member: !!m, roleId: m?.roleId ?? null, roleName: m?.roleName ?? null, email: u?.email ?? null, accountStatus: u?.status ?? null } : null;
  }
  return null;
}

/** Which object a request changes, from its path under `mount` (`/roles`, `/policies`, `/users`). */
function targetOf(kind: Kind, parts: string[], body: Record<string, unknown>): Target {
  const [id, sub, subId] = parts;
  if (kind === 'member') return { kind, id: null, userId: id && id !== 'invite' ? id : null };
  const userId = sub === 'users' ? (subId ?? (typeof body.userId === 'string' ? body.userId : null)) : null;
  return { kind, id: id ?? null, userId };
}

export function accessChangeGuard(kind: Kind, mount: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!MUTATING.has(c.req.method)) return next();
    const db = c.get('db');
    const siteId = c.get('siteId');
    const body = c.req.header('content-type')?.includes('json') ? ((await c.req.raw.clone().json().catch(() => ({}))) as Record<string, unknown>) : {};
    const target = targetOf(kind, segments(c, mount), body);
    // A change to an account's status reaches every site the person belongs to.
    const accountChange = kind === 'member' && c.req.method === 'PATCH' && body.status !== undefined && target.userId;
    const siteIds = accountChange ? [...new Set([siteId, ...(await sitesOfUser(db, target.userId!))])] : [siteId];
    try {
      await guardAdmins(db, { siteIds, userIds: target.userId ? [target.userId] : [] }, async (tx) => {
        const before = await summary(tx as unknown as Database, siteId, target);
        c.set('db', tx as unknown as Database);
        try {
          await next();
        } finally {
          c.set('db', db);
        }
        if (c.res.status >= 300) return;
        const after = c.req.method === 'DELETE' && !target.userId ? null : await summary(tx as unknown as Database, siteId, target);
        const auth = c.get('auth');
        await new AuditLogger({ db: tx as unknown as Database, siteId }).write({
          event: `access_${kind}_${c.req.method === 'POST' ? 'added' : c.req.method === 'DELETE' ? 'removed' : 'changed'}`,
          actorEmail: typeof auth?.email === 'string' ? auth.email : null,
          ip: c.get('ip') ?? null,
          requestId: c.get('requestId') ?? null,
          metadata: { actorId: auth?.userId ?? auth?.apiKeyId ?? null, method: c.req.method, path: `${mount}/${segments(c, mount).join('/')}`, target, before, after },
        });
      });
    } catch (err) {
      if (err instanceof LastAdminError) {
        c.res = c.json({ errors: [{ code: err.code, message: err.message, sites: err.siteIds }] }, 409);
        return;
      }
      throw err;
    }
  };
}
