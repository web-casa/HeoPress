/**
 * Studio workspace endpoints (HeoPress P07a, ADR-0019). `/api/v1/studio` is on the Studio access gate
 * (`STUDIO_ACCESS_PATH_PREFIXES`: app access and two-step verification for the current site); each route here also
 * requires an interactive Studio session — a HeoPress login token — and refuses API keys, frontend sessions and
 * sessions of external issuers, since the gate itself skips requests that do not say they come from Studio.
 *
 *   GET /network-summary                 the cross-site read-only summary (spec studio/network-summary)
 *   GET /network-summary/ai-traffic?days= its AI traffic series over 7, 30 or 90 days
 *   GET /overview/feed?from=&to=          the current site's overview feed (spec studio/overview)
 *   GET /events, /events/stats            the site's event stream and its counts (spec ops/event-log)
 *   GET /service-status                   status cards of Logs & monitoring
 *   GET /content/items, …/:id/history     the review workspace's lists and an item's review history
 */
import { Hono, type Context } from 'hono';
import { servicesWithin } from '../services/ops/service-status';
import { eq } from 'drizzle-orm';
import { authSessions, users } from '@heopress/database';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { extractClientIp } from '../modules/login-guard/ip-extract';
import { consumeRateLimit, RATE_LIMIT_UNAVAILABLE_RETRY_SECONDS } from '../middleware/rate-limit-helper';
import { isFrontendAudience } from '../services/auth/token-audience';
import { networkAiTraffic, networkSummary, type SummaryPrincipal } from '../services/studio/network-summary';
import { overviewFeed } from '../services/studio/overview-feed';
import { CONTENT_VIEWS, contentList, reviewHistory, type ContentView } from '../services/studio/content-list';
import { itemServiceForRequest } from '../services/item-service-factory';
import { EVENT_SOURCES, eventStats, readEvents, type EventFilter, type EventLevel, type EventSource } from '../services/ops/event-stream';
import { auditSites, reachabilitySites } from '@heopress/database';
import { linkScanOf } from '../services/site-network/link-graph';
import { collectHealth } from './health';
import { sql } from 'drizzle-orm';
import { permissionServiceForRequest } from '../services/item-service-factory';

export const studioRouter = new Hono<AppEnv>();

const SUMMARY_RATE_LIMIT = 60;
const SUMMARY_RATE_WINDOW_SECONDS = 60;

function requestHeaders(c: Context<AppEnv>): Record<string, string> {
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/** The interactive Studio principal of `c`, or the refusal to answer. */
async function studioPrincipal(c: Context<AppEnv>): Promise<{ principal: SummaryPrincipal } | { refusal: Response }> {
  const auth = c.get('auth');
  const forbidden = () => ({
    refusal: c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only an interactive Studio session can read this.' }] }, 403),
  });
  if (!auth?.userId || auth.method !== 'session' || auth.apiKeyId || isFrontendAudience(auth.raw?.aud) || typeof auth.raw?.sid !== 'string') {
    return forbidden();
  }
  const db = c.get('db');
  const [user] = await db.select({ id: users.id, email: users.email, isBootstrap: users.isBootstrap, status: users.status }).from(users).where(eq(users.id, auth.userId)).limit(1);
  if (!user || user.status !== 'active') {
    return { refusal: c.json({ errors: [{ code: 'UNAUTHENTICATED', message: 'No active session.' }] }, 401) };
  }
  const [session] = await db.select({ mfaVerified: authSessions.mfaVerified }).from(authSessions).where(eq(authSessions.id, auth.raw.sid)).limit(1);
  return {
    principal: {
      user: { id: user.id, email: user.email, isBootstrap: user.isBootstrap },
      mfaVerified: session?.mfaVerified === true,
      currentSiteId: c.get('siteId'),
      req: { ip: extractClientIp(c), headers: requestHeaders(c) },
    },
  };
}

studioRouter.get('/network-summary', async (c) => {
  const who = await studioPrincipal(c);
  if ('refusal' in who) return who.refusal;
  const { principal } = who;
  const budget = await consumeRateLimit(c.get('runtime')?.rateLimiter, `rl:network-summary:${principal.user.id}`, SUMMARY_RATE_LIMIT, SUMMARY_RATE_WINDOW_SECONDS);
  if (budget.status !== 'allow') {
    c.header('Retry-After', String(budget.status === 'unavailable' ? RATE_LIMIT_UNAVAILABLE_RETRY_SECONDS : budget.retryAfterSeconds));
    return c.json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many summary requests. Try again shortly.' }] }, 429);
  }
  const summary = await networkSummary(c.get('db'), principal);
  // One record per read: who and how many sites — never the figures (sites/site-switching).
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: 'studio_network_summary_read',
    actorEmail: principal.user.email,
    ip: principal.req.ip,
    userAgent: c.req.header('user-agent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { userId: principal.user.id, sites: summary.sites.length },
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ data: summary.sites, meta: { elapsedMs: summary.elapsedMs } });
});

studioRouter.get('/network-summary/ai-traffic', async (c) => {
  const who = await studioPrincipal(c);
  if ('refusal' in who) return who.refusal;
  const { principal } = who;
  const budget = await consumeRateLimit(c.get('runtime')?.rateLimiter, `rl:network-summary:${principal.user.id}`, SUMMARY_RATE_LIMIT, SUMMARY_RATE_WINDOW_SECONDS);
  if (budget.status !== 'allow') {
    c.header('Retry-After', String(budget.status === 'unavailable' ? RATE_LIMIT_UNAVAILABLE_RETRY_SECONDS : budget.retryAfterSeconds));
    return c.json({ errors: [{ code: 'RATE_LIMITED', message: 'Too many summary requests. Try again shortly.' }] }, 429);
  }
  const data = await networkAiTraffic(c.get('db'), principal, Number(c.req.query('days') ?? 30));
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
    event: 'studio_network_summary_read',
    actorEmail: principal.user.email,
    ip: principal.req.ip,
    userAgent: c.req.header('user-agent') ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { userId: principal.user.id, sites: data.sites.length, view: 'ai-traffic' },
  });
  c.header('Cache-Control', 'no-store');
  const { elapsedMs, ...body } = data;
  return c.json({ data: body, meta: { elapsedMs } });
});

const MAX_WINDOW_MS = 14 * 86_400_000;

/** Monday 00:00 UTC of the week holding `now`, and the Monday after. */
function thisWeek(now: Date): { from: Date; to: Date } {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  from.setUTCDate(from.getUTCDate() - ((from.getUTCDay() + 6) % 7));
  return { from, to: new Date(from.getTime() + 7 * 86_400_000) };
}

studioRouter.get('/overview/feed', async (c) => {
  const who = await studioPrincipal(c);
  if ('refusal' in who) return who.refusal;
  const from = c.req.query('from') ? new Date(c.req.query('from')!) : null;
  const to = c.req.query('to') ? new Date(c.req.query('to')!) : null;
  let window = thisWeek(new Date());
  if (from || to) {
    if (!from || !to || Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from || to.getTime() - from.getTime() > MAX_WINDOW_MS) {
      return c.json({ errors: [{ code: 'VALIDATION', message: '`from` and `to` must be ISO times, `to` after `from`, at most 14 days apart.' }] }, 400);
    }
    window = { from, to };
  }
  const data = await overviewFeed(c.get('db'), c.get('siteId'), permissionServiceForRequest(c), window);
  c.header('Cache-Control', 'no-store');
  return c.json({ data });
});

/** Logs & monitoring is for site administrators (spec ops/event-log); members and API keys get 403. */
async function siteAdministrator(c: Context<AppEnv>): Promise<{ principal: SummaryPrincipal } | { refusal: Response }> {
  const who = await studioPrincipal(c);
  if ('refusal' in who) return who;
  if (!(await permissionServiceForRequest(c).bundle()).admin && !who.principal.user.isBootstrap) {
    return { refusal: c.json({ errors: [{ code: 'FORBIDDEN', message: 'Logs and monitoring are for site administrators.' }] }, 403) };
  }
  return who;
}

const LEVELS = new Set<EventLevel>(['info', 'warn', 'error']);
const list = (raw: string | undefined) => (raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : []);

function filterOf(c: Context<AppEnv>): EventFilter | null {
  const from = c.req.query('from') ? new Date(c.req.query('from')!) : undefined;
  const to = c.req.query('to') ? new Date(c.req.query('to')!) : undefined;
  if ((from && Number.isNaN(from.getTime())) || (to && Number.isNaN(to.getTime()))) return null;
  return {
    levels: list(c.req.query('level')).filter((l): l is EventLevel => LEVELS.has(l as EventLevel)),
    sources: list(c.req.query('source')).filter((s): s is EventSource => (EVENT_SOURCES as readonly string[]).includes(s)),
    from,
    to,
    q: c.req.query('q')?.slice(0, 200) || undefined,
  };
}

studioRouter.get('/events', async (c) => {
  const who = await siteAdministrator(c);
  if ('refusal' in who) return who.refusal;
  const filter = filterOf(c);
  if (!filter) return c.json({ errors: [{ code: 'VALIDATION', message: '`from` and `to` must be ISO times.' }] }, 400);
  const since = c.req.query('since') ? new Date(c.req.query('since')!) : undefined;
  const page = await readEvents(
    c.get('db'),
    { siteId: c.get('siteId'), platform: who.principal.user.isBootstrap },
    filter,
    { cursor: c.req.query('cursor'), since: since && !Number.isNaN(since.getTime()) ? since : undefined, limit: Number(c.req.query('limit') ?? 50) || 50 },
  );
  c.header('Cache-Control', 'no-store');
  return c.json({ data: page.events, meta: { nextCursor: page.nextCursor, earliest: page.earliest, earliestBySource: page.earliestBySource } });
});

studioRouter.get('/events/stats', async (c) => {
  const who = await siteAdministrator(c);
  if ('refusal' in who) return who.refusal;
  const filter = filterOf(c);
  if (!filter) return c.json({ errors: [{ code: 'VALIDATION', message: '`from` and `to` must be ISO times.' }] }, 400);
  c.header('Cache-Control', 'no-store');
  return c.json({ data: await eventStats(c.get('db'), { siteId: c.get('siteId'), platform: who.principal.user.isBootstrap }, filter) });
});

const HEALTH_TIMEOUT_MS = 4000;

/**
 * Status cards (HeoPress P07a task 11.5): the site group (last reachability check, audit and link scan) for site
 * administrators; the instance group — the same checks as `/health`, called here directly, and the scheduled jobs
 * that failed in the last 24 hours — for the bootstrap administrator only. Only the time of the last check; a check
 * that cannot be read in time is `unknown`.
 */
studioRouter.get('/service-status', async (c) => {
  const who = await siteAdministrator(c);
  if ('refusal' in who) return who.refusal;
  const db = c.get('db');
  const siteId = c.get('siteId');
  const [reach] = await db.select({ status: reachabilitySites.status, lastRunAt: reachabilitySites.lastRunAt }).from(reachabilitySites).where(sql`${reachabilitySites.siteId} = ${siteId}`);
  const [audit] = await db.select({ status: auditSites.status, lastRunAt: auditSites.lastRunAt, truncated: auditSites.truncated }).from(auditSites).where(sql`${auditSites.siteId} = ${siteId}`);
  const links = await linkScanOf(db, siteId);
  const card = (status: string | null | undefined, at: Date | string | null | undefined) => ({
    status: status ?? 'unknown',
    checkedAt: at ? new Date(at).toISOString() : null,
  });
  const site = {
    reachability: card(reach?.lastRunAt ? reach.status : null, reach?.lastRunAt),
    audit: card(audit?.lastRunAt ? (audit.truncated && audit.status === 'done' ? 'truncated' : audit.status) : null, audit?.lastRunAt),
    linkScan: card(links ? links.status : null, links?.finishedAt ?? links?.startedAt),
  };
  let instance: Record<string, unknown> | undefined;
  if (who.principal.user.isBootstrap) {
    const checkedAt = new Date().toISOString();
    const services = await servicesWithin(async () => (await collectHealth(c)).services as Record<string, string>, ['database', 'migrations', 'extensions', 'cache', 'search', 'storage', 'queue'], HEALTH_TIMEOUT_MS);
    const failed = (await db
      .execute(sql`SELECT count(*)::int AS n FROM lumibase_schedule_runs WHERE status = 'failed' AND scheduled_at > now() - interval '24 hours'`)
      .catch(() => [{ n: null }])) as unknown as Array<{ n: number | null }>;
    instance = {
      checkedAt,
      services,
      failedJobs24h: failed[0]?.n ?? null,
    };
  }
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { site, ...(instance ? { instance } : {}) } });
});

studioRouter.get('/content/items', async (c) => {
  const who = await studioPrincipal(c);
  if ('refusal' in who) return who.refusal;
  const view = (CONTENT_VIEWS as readonly string[]).includes(c.req.query('view') ?? '') ? (c.req.query('view') as ContentView) : 'inbox';
  const data = await contentList(
    c.get('db'),
    c.get('siteId'),
    who.principal.user.id,
    permissionServiceForRequest(c),
    {
      view,
      collection: c.req.query('collection') || undefined,
      author: c.req.query('author') || undefined,
      locale: c.req.query('locale') || undefined,
      q: c.req.query('q')?.slice(0, 200) || undefined,
    },
    c.req.query('cursor') || undefined,
  );
  c.header('Cache-Control', 'no-store');
  return c.json({ data: data.rows, meta: { counts: data.counts, nextCursor: data.nextCursor, collections: data.collections } });
});

studioRouter.get('/content/items/:collection/:id/history', async (c) => {
  const who = await studioPrincipal(c);
  if ('refusal' in who) return who.refusal;
  // Read through the item service first: not readable answers as not found.
  try {
    await itemServiceForRequest(c).detail(c.req.param('collection'), c.req.param('id'));
  } catch {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Item not found.' }] }, 404);
  }
  return c.json({ data: await reviewHistory(c.get('db'), c.get('siteId'), c.req.param('id')) });
});
