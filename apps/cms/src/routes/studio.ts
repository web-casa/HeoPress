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
 *   /consumers…                          event consumer operations and state reconciliation (P11, below)
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
import { BACKLOG_ALERT_SECONDS, consumerExists, listConsumers, listDeadLetters, replayConsumer, type ReplayFrom } from '../modules/events/consumer-ops';
import { latestReconciliationReport, runStateReconciliation } from '../services/publishing/state-reconciliation';
import { recordSystemEvent } from '../services/ops/system-events';
import { listBackups, requestBackup } from '../services/backup/backup-service';
import { backupConfigFromEnv, backupsConfigured, type BackupConfig } from '../services/backup/config';
import { listDrills, requestDrill } from '../services/backup/drill';
import { listSiteExports, requestSiteExport } from '../services/site-export/export-jobs';

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

/**
 * Event consumers (HeoPress P11 tasks 1.1, 1.2; spec publishing/event-consumers): every framework consumer's backlog
 * and dead letters, replay from a chosen position, and the unified state reconciliation's report. Consumers serve the
 * whole instance, so this is the bootstrap administrator's (403 for everyone else).
 *
 *   GET  /consumers                         backlog, failures and position of each consumer
 *   GET  /consumers/:name/dead-letters      its failed events
 *   POST /consumers/:name/replay            { from: ISO time } or { eventId }
 *   GET  /consumers/reconciliation          the last reconciliation report
 *   POST /consumers/reconciliation/run      run a reconciliation now
 */
async function instanceAdministrator(c: Context<AppEnv>): Promise<{ principal: SummaryPrincipal } | { refusal: Response }> {
  const who = await siteAdministrator(c);
  if ('refusal' in who) return who;
  if (!who.principal.user.isBootstrap) {
    return { refusal: c.json({ errors: [{ code: 'FORBIDDEN', message: 'Event consumers are for the instance administrator.' }] }, 403) };
  }
  return who;
}

studioRouter.get('/consumers', async (c) => {
  const who = await instanceAdministrator(c);
  if ('refusal' in who) return who.refusal;
  c.header('Cache-Control', 'no-store');
  return c.json({ data: await listConsumers(c.get('db')), meta: { backlogAlertSeconds: BACKLOG_ALERT_SECONDS } });
});

studioRouter.get('/consumers/reconciliation', async (c) => {
  const who = await instanceAdministrator(c);
  if ('refusal' in who) return who.refusal;
  c.header('Cache-Control', 'no-store');
  return c.json({ data: await latestReconciliationReport(c.get('db')) });
});

studioRouter.post('/consumers/reconciliation/run', async (c) => {
  const who = await instanceAdministrator(c);
  if ('refusal' in who) return who.refusal;
  const runtime = c.get('runtime');
  const report = await runStateReconciliation(c.get('db'), { search: runtime?.search, keyProvider: runtime?.keys }, { trigger: 'manual', actor: who.principal.user.id });
  return c.json({ data: report });
});

studioRouter.get('/consumers/:name/dead-letters', async (c) => {
  const who = await instanceAdministrator(c);
  if ('refusal' in who) return who.refusal;
  const db = c.get('db');
  if (!(await consumerExists(db, c.req.param('name')))) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No such consumer.' }] }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json({ data: await listDeadLetters(db, c.req.param('name')) });
});

studioRouter.post('/consumers/:name/replay', async (c) => {
  const who = await instanceAdministrator(c);
  if ('refusal' in who) return who.refusal;
  const body = (await c.req.json().catch(() => null)) as { from?: unknown; eventId?: unknown } | null;
  let from: ReplayFrom | null = null;
  if (typeof body?.eventId === 'string' && body.eventId) from = { eventId: body.eventId };
  else if (typeof body?.from === 'string' && !Number.isNaN(new Date(body.from).getTime())) from = { at: new Date(body.from) };
  if (!from) return c.json({ errors: [{ code: 'VALIDATION', message: 'Give `from` (an ISO time) or `eventId`.' }] }, 400);
  const result = await replayConsumer(c.get('db'), c.req.param('name'), from);
  if (!result.ok) {
    const status = result.reason === 'busy' ? 409 : result.reason === 'dead' ? 409 : 404;
    return c.json({ errors: [{ code: result.reason.toUpperCase(), message: `Replay refused: ${result.reason}.` }] }, status);
  }
  await recordSystemEvent(c.get('db'), {
    level: 'info',
    source: 'events',
    event: 'consumer_replayed',
    message: `${c.req.param('name')}: replay of ${result.events} event(s)`,
    actor: who.principal.user.id,
    data: { consumer: c.req.param('name'), ...result.replayFrom, events: result.events },
  });
  return c.json({ data: result });
});

/**
 * Backups and single-site exports (HeoPress P13 tasks 1.1–1.3, 1.6):
 *
 *   GET  /backups          the catalogue, the drills, and how backups are configured (instance administrator)
 *   POST /backups          ask for a full backup now (the worker takes it up within a minute)
 *   POST /backups/drills   ask for a restore drill now
 *   GET  /site-exports     the current site's exports (site administrators)
 *   POST /site-exports     ask for an export of the current site
 */
async function backupAdministrator(c: Context<AppEnv>): Promise<{ principal: SummaryPrincipal } | { refusal: Response }> {
  const who = await siteAdministrator(c);
  if ('refusal' in who) return who;
  if (!who.principal.user.isBootstrap) return { refusal: c.json({ errors: [{ code: 'FORBIDDEN', message: 'Backups are for the instance administrator.' }] }, 403) };
  return who;
}

function backupSettings(): { configured: false; error?: string } | { configured: true; config: BackupConfig } {
  const env = process.env as Record<string, string | undefined>;
  if (!backupsConfigured(env)) return { configured: false };
  try {
    return { configured: true, config: backupConfigFromEnv(env) };
  } catch (err) {
    return { configured: false, error: err instanceof Error ? err.message : String(err) };
  }
}

studioRouter.get('/backups', async (c) => {
  const who = await backupAdministrator(c);
  if ('refusal' in who) return who.refusal;
  const s = backupSettings();
  const db = c.get('db');
  c.header('Cache-Control', 'no-store');
  return c.json({
    data: {
      configured: s.configured,
      ...('error' in s && s.error ? { configError: s.error } : {}),
      ...(s.configured
        ? { target: s.config.target.description, method: s.config.method, encrypted: s.config.keyFile !== null, schedule: s.config.schedule, retention: s.config.retention }
        : {}),
      backups: await listBackups(db, { limit: 50 }),
      drills: await listDrills(db, 20),
    },
  });
});

studioRouter.post('/backups', async (c) => {
  const who = await backupAdministrator(c);
  if ('refusal' in who) return who.refusal;
  const s = backupSettings();
  if (!s.configured) return c.json({ errors: [{ code: 'BACKUPS_NOT_CONFIGURED', message: 'Set HEOPRESS_BACKUP_TARGET (and the other backup settings) first.' }] }, 409);
  return c.json({ data: await requestBackup(c.get('db'), { requestedBy: who.principal.user.id, method: s.config.method }) }, 202);
});

studioRouter.post('/backups/drills', async (c) => {
  const who = await backupAdministrator(c);
  if ('refusal' in who) return who.refusal;
  if (!backupSettings().configured) return c.json({ errors: [{ code: 'BACKUPS_NOT_CONFIGURED', message: 'Set HEOPRESS_BACKUP_TARGET (and the other backup settings) first.' }] }, 409);
  return c.json({ data: await requestDrill(c.get('db'), { requestedBy: who.principal.user.id }) }, 202);
});

studioRouter.get('/site-exports', async (c) => {
  const who = await siteAdministrator(c);
  if ('refusal' in who) return who.refusal;
  c.header('Cache-Control', 'no-store');
  return c.json({ data: await listSiteExports(c.get('db'), c.get('siteId')) });
});

studioRouter.post('/site-exports', async (c) => {
  const who = await siteAdministrator(c);
  if ('refusal' in who) return who.refusal;
  return c.json({ data: await requestSiteExport(c.get('db'), c.get('siteId'), who.principal.user.id) }, 202);
});
