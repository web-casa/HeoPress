// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { users, userSites, scopeSite } from '@heopress/database';
import { and, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import type { AppEnv } from '../env';
import { runDetached } from '../lib/detached';
import { requireSiteAdmin } from '../middleware/site-admin';
import { sendTeammateInvite } from '../modules/email/invite';
import {
  grantSubscriberRead,
  revokeSubscriberRead,
  listSubscriberRead,
} from '../services/auth/subscriber-access';
import {
  GRANT_ACTIONS,
  RealmAccessError,
  type GrantAction,
} from '../services/auth/realm-access';
import { bumpPermissionVersion } from '../services/permission-invalidation';
import { recordSystemEvent } from '../services/ops/system-events';
import { accessChangeGuard } from './access-change-guard';

export const usersRouter = new Hono<AppEnv>();
usersRouter.use('*', requireSiteAdmin());
// Membership changes: last-administrator guard and audit record (HeoPress P07a tasks 11.2, 12.4).
usersRouter.use('*', accessChangeGuard('member', '/users'));

// List users belonging to the active site
usersRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  
  const data = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      avatar: users.avatar,
      status: users.status,
      lastSeenAt: users.lastSeenAt,
      roleId: userSites.roleId,
      joinedAt: userSites.joinedAt,
    })
    .from(users)
    .innerJoin(userSites, eq(users.id, userSites.userId))
    .where(eq(userSites.siteId, siteId));

  return c.json({ data });
});

// ── Subscriber content access ───────────────────────────────────────────
// Grant/revoke what self-service frontend subscribers can READ. The
// `subscriber` role is empty by default (ADR-010); these endpoints attach
// `read` permissions to it via the shared subscriber policy. Registered
// before `/:id` so the static path isn't captured by the param route.

// List collections subscribers can currently read.
usersRouter.get('/subscriber-access', async (c) => {
  const data = await listSubscriberRead(c.get('db'), c.get('siteId'));
  return c.json({ data });
});

const subscriberAccessSchema = z.object({
  collection: z.string().min(1),
  // Optional so the original published-only-read contract still holds when
  // omitted. `/access/grants/subscriber` is the fuller surface.
  action: z.enum(GRANT_ACTIONS).optional(),
  publishedOnly: z.boolean().optional(),
  ownOnly: z.boolean().optional(),
  fields: z.array(z.string()).optional(),
});

// Grant (or update) a subscriber permission on a collection.
usersRouter.post('/subscriber-access', async (c) => {
  const body = await c.req.json();
  const input = subscriberAccessSchema.parse(body);
  const siteId = c.get('siteId');
  try {
    const grant = await grantSubscriberRead(c.get('db'), siteId, input);
    // Policy mutation → drop compiled permission bundles at once instead of
    // waiting out the cache TTL.
    await bumpPermissionVersion(c, siteId);
    return c.json({ data: grant });
  } catch (error) {
    if (error instanceof RealmAccessError) {
      return c.json({ errors: [{ code: error.code, message: error.message }] }, 400);
    }
    throw error;
  }
});

// Revoke a subscriber grant on a collection. `action` defaults to `read` so
// the original single-action URL keeps working.
usersRouter.delete('/subscriber-access/:collection', async (c) => {
  const collection = c.req.param('collection');
  const siteId = c.get('siteId');
  const actionParam = c.req.query('action') ?? 'read';
  if (!(GRANT_ACTIONS as readonly string[]).includes(actionParam)) {
    return c.json(
      {
        errors: [
          {
            code: 'VALIDATION',
            message: `Unknown action '${actionParam}'. Expected one of: ${GRANT_ACTIONS.join(', ')}.`,
          },
        ],
      },
      400,
    );
  }
  const removed = await revokeSubscriberRead(
    c.get('db'),
    siteId,
    collection,
    actionParam as GrantAction,
  );
  if (!removed) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }
  // Revoked grant must stop applying immediately, not after the cache TTL.
  await bumpPermissionVersion(c, siteId);
  return c.json({ data: { collection, action: actionParam, removed: true } });
});

// Get a specific user in the active site
usersRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      avatar: users.avatar,
      status: users.status,
      lastSeenAt: users.lastSeenAt,
      roleId: userSites.roleId,
      joinedAt: userSites.joinedAt,
    })
    .from(users)
    .innerJoin(userSites, eq(users.id, userSites.userId))
    .where(and(eq(userSites.siteId, siteId), eq(users.id, id)))
    .limit(1);

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  return c.json({ data: row });
});

// Invite user
const inviteSchema = z.object({
  email: z.string().email(),
  // An empty string is not "no role": it was stored verbatim as the site
  // membership's role id, leaving a member whose role resolves to nothing.
  // Omit the field to invite without a role.
  roleId: z.string().min(1).optional(),
});

usersRouter.post('/invite', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');
  const parsed = inviteSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400);
  }
  const input = parsed.data;

  // Check if user exists globally by email
  let [existingUser] = await db.select().from(users).where(eq(users.email, input.email)).limit(1);

  if (!existingUser) {
    const dummyLogtoId = `shadow_${nanoid()}`;
    const [newUser] = await db.insert(users).values({
      email: input.email,
      externalId: dummyLogtoId,
      status: 'invited',
    }).returning();
    existingUser = newUser!;
  }

  if (!existingUser) {
    return c.json({ errors: [{ code: 'INTERNAL_ERROR' }] }, 500);
  }

  // Bind to site
  const bound = await db.insert(userSites).values({
    userId: existingUser.id,
    siteId,
    roleId: input.roleId,
  }).onConflictDoNothing().returning({ userId: userSites.userId }); // If already in site, do nothing
  // Already a member (HeoPress P07a task 12.5, spec studio/settings "批量邀请"): said so, its role unchanged, no email.
  // Only what the inviter needs: never the account row (it holds the password hash of a person who may belong to other sites).
  const invited = { id: existingUser.id, email: existingUser.email, status: existingUser.status };
  if (bound.length === 0) return c.json({ data: invited, meta: { alreadyMember: true } });
  await bumpPermissionVersion(c, siteId);

  // Best-effort invite email — sent AFTER the binding so a mail failure can't
  // affect the invite itself. Detached via waitUntil on Workers; the helper
  // never throws, so a fire-and-forget on Node is safe too.
  const inviteEmail = sendTeammateInvite({
    db,
    siteId,
    env: c.env,
    email: input.email,
    invitedBy: c.get('auth')?.email ?? undefined,
  });
  runDetached(c, inviteEmail);

  return c.json({ data: invited, meta: { alreadyMember: false } });
});

async function isBootstrapActor(c: Context<AppEnv>): Promise<boolean> {
  const actorId = c.get('auth')?.userId;
  if (!actorId) return false;
  const [actor] = await c.get('db').select({ isBootstrap: users.isBootstrap }).from(users).where(eq(users.id, actorId)).limit(1);
  return actor?.isBootstrap === true;
}

// Update user inside site (mainly role mapping)
const updateUserSchema = z.object({
  roleId: z.string().nullable().optional(),
  status: z.string().optional(), // active, suspended, etc.
});

usersRouter.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');
  const body = await c.req.json();
  const input = updateUserSchema.parse(body);

  // Validate the user is in this site
  const [membership] = await db.select().from(userSites).where(and(eq(userSites.siteId, siteId), eq(userSites.userId, id))).limit(1);
  if (!membership) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  if (input.status !== undefined && !(await isBootstrapActor(c))) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: "Only the instance's bootstrap administrator can enable or disable an account; site administrators change memberships and roles." }] }, 403);
  }

  if (input.roleId !== undefined) {
    await db.update(userSites)
      .set({ roleId: input.roleId })
      .where(and(eq(userSites.siteId, siteId), eq(userSites.userId, id)));
    await bumpPermissionVersion(c, siteId);
  }

  if (input.status !== undefined) {
    // Enabling or disabling an account reaches every site it belongs to: only the instance's bootstrap
    // administrator may (HeoPress P07a task 12.3). A site administrator changes this site's membership and role.
    const actorId = c.get('auth')?.userId;
    const [previous] = await db.select({ status: users.status, email: users.email }).from(users).where(eq(users.id, id)).limit(1);
    await db.update(users)
      .set({ status: input.status, updatedAt: new Date() })
      .where(eq(users.id, id));
    if (previous && previous.status !== input.status) {
      await recordSystemEvent(db, {
        level: 'info',
        source: 'accounts',
        event: input.status === 'active' ? 'account_enabled' : 'account_disabled',
        message: `Account ${id}: ${previous.status} → ${input.status}`,
        actor: actorId ?? null,
        data: { userId: id, before: previous.status, after: input.status },
      });
    }
  }

  return c.json({ data: { id } });
});

// Remove user from site
usersRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db.delete(userSites)
    .where(and(eq(userSites.siteId, siteId), eq(userSites.userId, id)))
    .returning();

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  await bumpPermissionVersion(c, siteId);
  return c.json({ data: null });
});

// Impersonate user
usersRouter.post('/:id/impersonate', async (c) => {
  const id = c.req.param('id');
  const siteId = c.get('siteId');
  const db = c.get('db');

  // Verify the user is in the site
  const [row] = await db.select().from(userSites).where(and(eq(userSites.siteId, siteId), eq(userSites.userId, id))).limit(1);
  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND' }] }, 404);
  }

  // Generate an impersonation token (mock implementation)
  const token = `impersonate_${nanoid()}`;
  return c.json({ data: { token } });
});
