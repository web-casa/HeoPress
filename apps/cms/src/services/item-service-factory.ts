// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { apiKeys, userSites, users } from '@heopress/database';
import type { AppEnv, AuthPrincipal } from '../env';
import type { MagicContext } from './permission-dsl';
import { ItemService, type ItemServiceDeps } from './item-service';
import { resolveNegativeTtl } from './negative-cache';
import { PermissionService } from './permission-service';

/**
 * ItemService construction helpers that make the RBAC posture *explicit*.
 *
 * ## Why this module exists
 *
 * `ItemService` enforces row/field RBAC only when it is given a
 * `permissionCtx` — otherwise `this.permissions` is `null` and every
 * `perm()` check short-circuits to "allowed" (fail-open). That design is
 * intentional (system workers legitimately run without a user principal),
 * but it means a request-scoped call site that simply *forgets* to pass
 * `permissionCtx` silently bypasses authorization — indistinguishable from
 * a deliberate system context.
 *
 * This exact bug shipped once already: the AI `updateItem` skill executed
 * `ItemService.patch()` on a service built without `permissionCtx`, letting
 * LLM-driven mutations skip RBAC. To stop it recurring, every ItemService
 * built for a **request** must go through {@link itemServiceForRequest}
 * (which always attaches a `permissionCtx`), and every ItemService built for
 * a **system/background** flow must go through {@link itemServiceForSystem}
 * (which forces the author to name a reason). A regression test
 * (`item-service-rbac-context.test.ts`) asserts route files construct
 * ItemService only via these helpers, so a bare `new ItemService(...)` on a
 * user-facing path fails CI rather than production.
 */

/** Build the request-scoped MagicContext used to enforce RBAC. */
export function buildRequestPermissionContext(input: {
  auth: AuthPrincipal | undefined;
  siteId: string;
  headers: Record<string, string>;
  ip: string | null;
}): MagicContext {
  const { auth, siteId, headers, ip } = input;
  return {
    userId: auth?.userId ?? null,
    siteId,
    // Must be forwarded, not hardcoded null. `PermissionService.compile()`
    // resolves roles from `user_sites` / `user_roles` / `api_key_roles` /
    // `ctx.roleId` — and for an anonymous principal the first three are all
    // empty by definition, so `ctx.roleId` is the *only* path by which the
    // `public` role reaches the bundle. Dropping it made every public grant
    // inert on the content API. `ctx.user.roles` is not a fallback: compile()
    // overwrites `ctx.user` with a DB snapshot, which is null when there is
    // no `userId`.
    roleId: auth?.roleId ?? null,
    user: auth
      ? {
          id: auth.userId ?? null,
          email: auth.email ?? null,
          roles: auth.roles ?? [],
          ...(auth.raw ?? {}),
        }
      : null,
    ip,
    headers,
    apiKey: auth?.apiKey ?? null,
    principal: !auth
      ? undefined
      : auth.isFrontendUser
        ? 'frontend'
        : auth.type === 'api_key' || auth.apiKeyId
          ? 'api_key'
          : auth.type === 'anonymous'
            ? 'anonymous'
            : 'user',
  };
}

function collectRequestHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Construct an ItemService bound to the authenticated principal of `c`.
 *
 * Use this for **every** ItemService created while handling an HTTP request
 * (routes, GraphQL resolvers, MCP endpoint). It always attaches a
 * `permissionCtx`, so the returned service enforces the same row/field RBAC
 * as the normal `/items` API — an AI or MCP caller can never do more than the
 * bearer token could do directly.
 *
 * `overrides` lets a caller add optional deps (e.g. omit `search`, or rebind
 * `db` to a transaction handle for a batch operation) but cannot remove the
 * permission context — `permissionCtx` and `siteId` are applied last, so a
 * caller can never accidentally widen the RBAC posture or cross tenants.
 */
export function itemServiceForRequest(
  c: Context<AppEnv>,
  overrides: Partial<Omit<ItemServiceDeps, 'permissionCtx' | 'siteId'>> = {},
): ItemService {
  const auth = c.get('auth');
  const runtime = c.get('runtime');
  const siteId = c.get('siteId');

  return new ItemService({
    db: c.get('db'),
    userId: auth?.userId ?? null,
    // Change Feed actor attribution: an API-key principal has no userId, so
    // without this the outbox would record it as `system` (Req 1.1).
    cdcActor: auth?.apiKeyId
      ? { type: 'api_key', id: auth.apiKeyId }
      : auth?.userId
        ? { type: 'user', id: auth.userId }
        : undefined,
    cache: runtime.cache,
    edgeCache: runtime.edgeCache,
    // Resolved here (not inside SchemaService) so `c.env` overrides apply (Req 19.5).
    negativeCacheTtl: resolveNegativeTtl(c.env),
    search: runtime.search,
    queue: runtime.queue,
    realtime: runtime.realtime,
    extensionEnv: c.env as unknown as Record<string, unknown>,
    keyProvider: runtime.keys,
    encryptionKey:
      c.env.ENCRYPTION_KEY || (typeof process !== 'undefined' ? process.env.ENCRYPTION_KEY : undefined),
    // An API key is a program: its revisions are not a person's (P04 — they
    // neither pin fields nor make an AI result "superseded").
    ...(auth?.apiKeyId || auth?.type === 'api_key' ? { provenance: { authorType: 'integration' as const } } : {}),
    ...overrides,
    // siteId + permissionCtx applied last so overrides can never cross tenants
    // or drop the enforcement context.
    siteId,
    permissionCtx: buildRequestPermissionContext({
      auth,
      siteId,
      headers: collectRequestHeaders(c),
      ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    }),
  });
}

/**
 * Construct a PermissionService bound to the authenticated principal of `c`.
 *
 * Use this whenever a request-path service needs to make its *own* RBAC
 * decisions outside ItemService (e.g. DependentsService gating raw batch
 * writes, aggregate/insights services). It shares the same principal context
 * as {@link itemServiceForRequest}, so a caller can never authorize more than
 * the bearer token could do directly.
 */
export function permissionServiceForRequest(c: Context<AppEnv>): PermissionService {
  const siteId = c.get('siteId');
  return new PermissionService({
    db: c.get('db'),
    cache: c.get('runtime').cache,
    ctx: buildRequestPermissionContext({
      auth: c.get('auth'),
      siteId,
      headers: collectRequestHeaders(c),
      ip: c.get('ip') ?? c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
    }),
  });
}

/**
 * Reasons a system/background ItemService legitimately runs without a
 * per-request permission context. Naming the reason forces the author to
 * justify the fail-open posture and makes each site auditable.
 */
export type SystemContextReason =
  /** Scheduled/cron flows (retention sweep, scheduled publish) — no user principal. */
  | 'scheduler'
  /** Background queue worker executing already-authorized work (veto commit, agent run). */
  | 'background-worker'
  /** GDPR erasure / SAR — gated by admin + dual-control at the service layer. */
  | 'compliance-erasure';

/**
 * Construct an ItemService that intentionally runs with system privileges
 * (no row/field RBAC). Every caller must pass a {@link SystemContextReason},
 * which documents *why* the fail-open posture is safe here (the authorization
 * decision was made upstream — cron config, an approved veto, a governed
 * agent run, or an admin-gated compliance action).
 *
 * `reason` is intentionally unused at runtime; it exists to force an explicit,
 * greppable declaration at the call site and to appear in the security
 * checklist audit table.
 */
export function itemServiceForSystem(
  deps: Omit<ItemServiceDeps, 'permissionCtx'>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  reason: SystemContextReason,
): ItemService {
  return new ItemService(deps);
}

/**
 * Construct an ItemService bound to a principal resolved **off** the request
 * path — a queue worker, or an approval being resumed.
 *
 * The third posture, and it exists because the first two did not cover this case.
 * `itemServiceForRequest(c)` needs a Hono context a worker does not have, and
 * `itemServiceForSystem` is fail-open by definition. A worker that re-resolved
 * the caller's grant (see `EffectiveCapabilityService`) has a real
 * `MagicContext` and should enforce with it, so neither of the other two is
 * honest for it.
 *
 * `siteId` and `permissionCtx` are applied last, exactly as in
 * `itemServiceForRequest`, so `deps` can neither cross tenants nor drop the
 * enforcement context.
 */
export function itemServiceForPrincipal(
  deps: Omit<ItemServiceDeps, 'permissionCtx'>,
  permissionCtx: MagicContext,
): ItemService {
  return new ItemService({ ...deps, siteId: permissionCtx.siteId, permissionCtx });
}

/**
 * Construct an ItemService for the request's person on ANOTHER site (HeoPress P05, design §0
 * "跨站访问一律走目标站点的权限上下文"): the user's roles and grants there are resolved afresh from
 * their membership of that site; nothing of the request's own site carries over. Only a signed-in
 * person crosses sites — an API key, an MCP token, a frontend or anonymous caller gets null.
 * `db` is the transaction handle the caller runs in that site's scope.
 */
export function itemServiceForPersonOnSite(c: Context<AppEnv>, siteId: string, db: ItemServiceDeps['db']): ItemService | null {
  const auth = c.get('auth');
  const person = !!auth?.userId && !auth.apiKeyId && auth.type !== 'api_key' && auth.type !== 'anonymous' && !auth.isFrontendUser;
  if (!person) return null;
  const runtime = c.get('runtime');
  return new ItemService({
    db,
    rootDb: c.get('db'),
    userId: auth.userId!,
    cdcActor: { type: 'user', id: auth.userId! },
    cache: runtime.cache,
    search: runtime.search,
    queue: runtime.queue,
    realtime: runtime.realtime,
    keyProvider: runtime.keys,
    encryptionKey: c.env.ENCRYPTION_KEY || (typeof process !== 'undefined' ? process.env.ENCRYPTION_KEY : undefined),
    siteId,
    permissionCtx: {
      userId: auth.userId!,
      siteId,
      roleId: null,
      user: { id: auth.userId!, email: auth.email ?? null, roles: [] },
      ip: c.get('ip') ?? null,
      headers: {},
      apiKey: null,
      principal: 'user',
    },
  });
}

/**
 * Construct an ItemService that writes as the principal that triggered a shared field sync, on the
 * member's site, off the request path (HeoPress P05, design D "按触发者的实时权限执行"): a person's
 * roles there are resolved afresh from their membership; an API key acts only on its own site; an
 * agent run or the system writes with system privileges (`background-worker`: the source's save was
 * itself authorised). Null when the trigger cannot write on `siteId`.
 */
export async function itemServiceForTrigger(
  deps: Omit<ItemServiceDeps, 'permissionCtx' | 'siteId' | 'db'>,
  trigger: { type: 'user' | 'api_key' | 'agent' | 'system'; id: string | null },
  siteId: string,
  db: ItemServiceDeps['db'],
): Promise<ItemService | null> {
  if (trigger.type === 'user' && trigger.id) {
    // Still an active person, still a member of the site: otherwise no write there at all.
    const [person] = await db.select({ status: users.status }).from(users).where(eq(users.id, trigger.id)).limit(1);
    if (person?.status !== 'active') return null;
    const [member] = await db
      .select({ userId: userSites.userId })
      .from(userSites)
      .where(and(eq(userSites.userId, trigger.id), eq(userSites.siteId, siteId)))
      .limit(1);
    if (!member) return null;
    return new ItemService({
      ...deps,
      db,
      userId: trigger.id,
      cdcActor: { type: 'user', id: trigger.id },
      siteId,
      permissionCtx: { userId: trigger.id, siteId, roleId: null, user: { id: trigger.id, email: null, roles: [] }, ip: null, headers: {}, apiKey: null, principal: 'user' },
    });
  }
  if (trigger.type === 'api_key' && trigger.id) {
    const [key] = await db
      .select({ siteId: apiKeys.siteId, revokedAt: apiKeys.revokedAt, expiresAt: apiKeys.expiresAt })
      .from(apiKeys)
      .where(eq(apiKeys.id, trigger.id))
      .limit(1);
    // Its own site only, and only while it is still valid (not revoked, not expired).
    if (!key || key.siteId !== siteId || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) return null;
    return new ItemService({
      ...deps,
      db,
      userId: null,
      cdcActor: { type: 'api_key', id: trigger.id },
      provenance: { authorType: 'integration' },
      siteId,
      permissionCtx: { userId: null, siteId, roleId: null, user: null, ip: null, headers: {}, apiKey: { id: trigger.id }, principal: 'api_key' },
    });
  }
  return itemServiceForSystem({ ...deps, db, siteId }, 'background-worker');
}
