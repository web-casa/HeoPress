// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { z } from 'zod';
import { sites } from '@heopress/database';
import { SiteConfigUpdateSchema, SiteContentSettingsSchema } from '@heopress/contracts/schemas';
import { eq } from 'drizzle-orm';
import { canonicalOf } from '../services/studio/canonical';
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteMember } from '../middleware/site-member';
import { publishChecks } from '../services/studio/publish-checks';
import { resolvePublicPath } from '../services/site-network/public-path';
import { requireSiteAdmin } from '../middleware/site-admin';
import { ContentSettingsError, ContentSettingsService } from '../services/site-network/content-settings-service';
import { listPublishedSponsored } from '../services/site-network/sponsored-items';
import { SeoSettingsError, SeoSettingsService } from '../services/site-network/seo-settings-service';
import { SiteIdentityError, SiteIdentityService } from '../services/site-network/site-identity-service';
import { sitePresetOf } from '../services/site-network/preset-installer';
import { structuredDataReportOf } from '../services/site-network/structured-data-report';
import { ROOT_FILE_MAX_BYTES, RootFileError, RootFilesService } from '../services/site-network/root-files';
import { addManualLink, deleteManualLink, LinkGraphError, linkScanOf, listManualLinks, requestLinkScan } from '../services/site-network/link-graph';
import { linkReport } from '../services/site-network/link-report';
import { aiTrafficReport } from '../services/site-network/ai-traffic';
import { createImpactRedirect, LinkImpactError, linkImpact, updateImpactLinks } from '../services/site-network/link-impact';
import { AuditTriageError, IGNORE_MAX_DAYS, auditViewOf, ignoreAuditIssue, requestSiteAudit, resolvedAuditView, restoreAuditIssue } from '../services/site-network/site-audit';
import { AuditLogger } from '../modules/audit/logger';
import { ReachabilityError, reachabilityViewOf, requestReachabilityCheck } from '../services/site-network/reachability';
import { readableScope } from '../services/site-network/readable-items';
import { itemServiceForRequest, permissionServiceForRequest } from '../services/item-service-factory';

/**
 * Site (tenant) configuration surface. Reads/writes the row in `sites` for the
 * active tenant resolved by `withTenant` (header `X-HeoPress-Site`). Identity +
 * branding + theme live directly on the row; per-user appearance overrides
 * live in `users.preferences` and are resolved client-side.
 */
export const siteRouter = new Hono<AppEnv>();

siteRouter.get('/', async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const [row] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Site not found.' }] }, 404);
  }

  return c.json({ data: row });
});

// Site administrators only (HeoPress P07a task 12.2): the name, default language and branding are the site's settings.
siteRouter.patch('/', requireSiteAdmin(), async (c) => {
  const siteId = c.get('siteId');
  const db = c.get('db');

  const body = await c.req.json().catch(() => ({}));
  const parsed = SiteConfigUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { errors: [{ code: 'VALIDATION', message: parsed.error.message, issues: parsed.error.issues }] },
      400,
    );
  }
  const patch = parsed.data;

  // Empty-string sentinels from the form mean "clear" → store NULL.
  const blankToNull = <T>(v: T | '' | undefined): T | null | undefined =>
    v === '' ? null : v;

  const [existing] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!existing) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Site not found.' }] }, 404);
  }

  // Build the SET payload from only the keys the caller supplied.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if ('name' in patch) set.name = patch.name;
  if ('displayTitle' in patch) set.displayTitle = blankToNull(patch.displayTitle);
  if ('siteUrl' in patch) set.siteUrl = blankToNull(patch.siteUrl);
  if ('descriptor' in patch) set.descriptor = blankToNull(patch.descriptor);
  if ('domain' in patch) set.domain = blankToNull(patch.domain);
  if ('defaultLanguage' in patch) set.defaultLanguage = patch.defaultLanguage;
  if ('defaultAppearance' in patch) set.defaultAppearance = patch.defaultAppearance;
  if ('defaultSaveAction' in patch) set.defaultSaveAction = patch.defaultSaveAction;
  if ('branding' in patch) set.branding = patch.branding;
  if ('themeOverrides' in patch) set.themeOverrides = patch.themeOverrides;
  if ('customCss' in patch) set.customCss = blankToNull(patch.customCss);

  let row: typeof existing | undefined;
  try {
    row = (await contentSettingsFor(c).updateSite(set)) ?? undefined;
  } catch (err) {
    if (err instanceof ContentSettingsError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    }
    // Postgres unique_violation on `sites.domain`.
    if (isUniqueViolation(err)) {
      return c.json(
        { errors: [{ code: 'DOMAIN_TAKEN', message: 'That domain is already in use.' }] },
        409,
      );
    }
    throw err;
  }

  if (!row) {
    return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Site not found.' }] }, 404);
  }

  // If the domain changed, drop the stale subdomain→site cache entries so the
  // tenant middleware re-resolves. Cover both old and new first-label.
  if ('domain' in patch && existing.domain !== row.domain) {
    const cache = c.get('runtime')?.cache;
    if (cache) {
      const labels = [existing.domain, row.domain]
        .filter((d): d is string => Boolean(d))
        .map((d) => d.split('.')[0]);
      await Promise.all(labels.map((sub) => cache.delete(`site-domain:${sub}`)));
    }
  }

  return c.json({ data: row });
});

/**
 * Detect a Postgres unique-constraint violation (SQLSTATE 23505). Drizzle wraps
 * the driver error, so the original `code` lives on `err.cause` rather than the
 * top-level Error — check both.
 */
function isUniqueViolation(err: unknown): boolean {
  const hasCode = (e: unknown): boolean =>
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === '23505';
  if (hasCode(err)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  return hasCode(cause);
}

/**
 * Content settings (HeoPress P05): languages, time zone, URL policy, permalink
 * patterns, cross-site translations and the sponsored-content policy. Members
 * read them; only the site's administrators change them.
 */
const contentSettingsFor = (c: Context<AppEnv>) =>
  new ContentSettingsService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    actor: { userId: c.get('auth')?.userId ?? null, apiKeyId: c.get('auth')?.apiKeyId ?? null, email: c.get('auth')?.email ?? null },
  });

siteRouter.get('/content-settings', async (c) => c.json({ data: await contentSettingsFor(c).get() }));

/**
 * Published sponsored items, page by page (P05 task 1.9): what to re-render when the sponsor policy changes.
 * Site administrators (and the renderer's administrative key) only: the list ignores collection, row and
 * field permissions.
 */
siteRouter.get('/sponsored-items', requireSiteAdmin(), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 100) || 100, 1), 500);
  const after = c.req.query('after') || undefined;
  const page = await listPublishedSponsored(c.get('db'), c.get('siteId'), { after, limit });
  return c.json({ data: page.items, meta: { next: page.next } });
});

siteRouter.put('/content-settings', requireSiteAdmin(), async (c) => {
  const parsed = SiteContentSettingsSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400);
  }
  try {
    return c.json({ data: await contentSettingsFor(c).update(parsed.data) });
  } catch (err) {
    if (err instanceof ContentSettingsError) {
      return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }] }, err.status);
    }
    throw err;
  }
});

/**
 * The site's SEO / GEO settings (HeoPress P07 task 1.4): read with their defaults and version; changed by its
 * administrators against the version read (409 when stale). The public pages and discovery files follow at once.
 */
const seoSettingsFor = (c: Context<AppEnv>) =>
  new SeoSettingsService({ db: c.get('db'), siteId: c.get('siteId'), actor: { userId: c.get('auth')?.userId ?? null, apiKeyId: c.get('auth')?.apiKeyId ?? null } });

siteRouter.get('/seo-settings', async (c) => c.json({ data: await seoSettingsFor(c).get() }));

siteRouter.put('/seo-settings', requireSiteAdmin(), async (c) => {
  try {
    return c.json({ data: await seoSettingsFor(c).update(await c.req.json().catch(() => ({}))) });
  } catch (err) {
    if (err instanceof SeoSettingsError) {
      return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }] }, err.status);
    }
    throw err;
  }
});

/**
 * Whom the site speaks for (HeoPress P07 task 2.12): an organisation, a person or a local business, with its name, logo,
 * contact details and official profiles (`null` until set). Changed by its administrators against the version read
 * (409 when stale); the structured data of its pages follows at once.
 */
const siteIdentityFor = (c: Context<AppEnv>) =>
  new SiteIdentityService({ db: c.get('db'), siteId: c.get('siteId'), actor: { userId: c.get('auth')?.userId ?? null, apiKeyId: c.get('auth')?.apiKeyId ?? null } });

siteRouter.get('/identity', async (c) => c.json({ data: await siteIdentityFor(c).get() }));

/** The canonical domain (HeoPress P07a task 8.2): members read it; switching stays with `/domains`. */
siteRouter.get('/canonical', requireSiteMember(), async (c) => c.json({ data: await canonicalOf(c.get('db'), c.get('siteId')) }));

/**
 * The site's content preset (HeoPress P07 task 2.4): its version and the kept report of the last install or upgrade —
 * what was added and what was skipped and why (a site field of the same name is never overwritten). Administrators only.
 */
siteRouter.get('/preset', requireSiteAdmin(), async (c) => c.json({ data: await sitePresetOf(c.get('db'), c.get('siteId')) }));

/**
 * What the site's structured-data contributions came to (HeoPress P07 tasks 2.9, 2.10): its extensions' site nodes,
 * and what was left out — of the extensions' contributions and of published items' own structured data — and why.
 * Administrators only.
 */
siteRouter.get('/structured-data', requireSiteMember(), async (c) => c.json({ data: await structuredDataReportOf(c.get('db'), c.get('siteId')) }));

/**
 * The site's root files (HeoPress P07 task 3.8): text files served at the site's root — verification files, `ads.txt`.
 * Administrators only; a name the system answers itself is refused (409), every write is audited.
 */
const rootFilesFor = (c: Context<AppEnv>) => {
  const auth = c.get('auth');
  return new RootFilesService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    actor: {
      userId: auth?.userId ?? null,
      email: auth?.email ?? null,
      apiKeyId: auth?.apiKeyId ?? null,
      method: auth?.method ?? null,
      ip: c.get('ip') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      requestId: c.get('requestId') ?? null,
    },
  });
};
const rootFileFailure = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof RootFileError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  throw err;
};

siteRouter.get('/root-files', requireSiteMember(), async (c) => c.json({ data: await rootFilesFor(c).list() }));

siteRouter.get('/root-files/:filename', requireSiteMember(), async (c) => {
  const file = await rootFilesFor(c).get(c.req.param('filename'));
  return file ? c.json({ data: file }) : c.json({ errors: [{ code: 'NOT_FOUND', message: 'No such root file.' }] }, 404);
});

/**
 * A request body, read up to `max` bytes and no further (null: longer — the read stops there, whatever the request
 * declares and however it is sent, chunked included).
 */
async function boundedBody(req: Request, max: number): Promise<string | null> {
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The file's text as the body (`text/plain`, what the SDK sends) or JSON `{ "content": "…" }` — either way read to a
 * bound of its own (this route is outside the global JSON body limit: JSON escaping can double a file at the size limit),
 * so a body past what any valid file can take is refused as it is read (Codex review of batch 7). The service then checks
 * the file's own bytes.
 */
siteRouter.put('/root-files/:filename', requireSiteAdmin(), async (c) => {
  const text = (c.req.header('content-type') ?? '').toLowerCase().startsWith('text/plain');
  // The text itself, or the text escaped as JSON in a small envelope: at most six bytes for each byte of the file (a
  // serialiser may write any character as `\u00XX`).
  const raw = await boundedBody(c.req.raw, text ? ROOT_FILE_MAX_BYTES : 6 * ROOT_FILE_MAX_BYTES + 1024);
  if (raw === null) return c.json({ errors: [{ code: 'TOO_LARGE', message: `A root file is at most ${ROOT_FILE_MAX_BYTES} bytes.` }] }, 400);
  let content: unknown = raw;
  if (!text) {
    let body: unknown = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    content = body && typeof body === 'object' ? (body as { content?: unknown }).content : undefined;
  }
  try {
    return c.json({ data: await rootFilesFor(c).put(c.req.param('filename'), content) });
  } catch (err) {
    return rootFileFailure(c, err);
  }
});

siteRouter.delete('/root-files/:filename', requireSiteAdmin(), async (c) => {
  try {
    await rootFilesFor(c).remove(c.req.param('filename'));
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return rootFileFailure(c, err);
  }
});

siteRouter.put('/identity', requireSiteAdmin(), async (c) => {
  try {
    return c.json({ data: await siteIdentityFor(c).update(await c.req.json().catch(() => ({}))) });
  } catch (err) {
    if (err instanceof SiteIdentityError) {
      return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) }] }, err.status);
    }
    throw err;
  }
});

/**
 * The internal link graph (HeoPress P07 tasks 5.3, 5.4): its broken links and orphan pages, limited to the items the caller
 * may read; a full scan, and the registered (navigation) links, for administrators.
 */
const linkFailure = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof LinkGraphError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  throw err;
};

siteRouter.get('/links/report', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const permissions = permissionServiceForRequest(c);
  // Registered (navigation) links are an administrator's: shown to administrators only.
  const navigation = (await permissions.bundle()).admin;
  return c.json({ data: await linkReport(db, siteId, { readable: await readableScope(db, siteId, permissions), navigation }) });
});

siteRouter.post('/links/scan', requireSiteAdmin(), async (c) => {
  await requestLinkScan(c.get('db'), c.get('siteId'), { now: true });
  return c.json({ data: await linkScanOf(c.get('db'), c.get('siteId')) });
});

siteRouter.get('/links/manual', requireSiteAdmin(), async (c) => c.json({ data: await listManualLinks(c.get('db'), c.get('siteId')) }));

siteRouter.post('/links/manual', requireSiteAdmin(), async (c) => {
  const body = (await c.req.json().catch(() => null)) as { label?: unknown; url?: unknown } | null;
  try {
    const link = await addManualLink(c.get('db'), c.get('siteId'), { label: body?.label, url: body?.url }, c.get('auth')?.userId ?? null);
    return c.json({ data: link }, 201);
  } catch (err) {
    return linkFailure(c, err);
  }
});

siteRouter.delete('/links/manual/:id', requireSiteAdmin(), async (c) => {
  try {
    await deleteManualLink(c.get('db'), c.get('siteId'), c.req.param('id'));
    return c.json({ data: { deleted: true } });
  } catch (err) {
    return linkFailure(c, err);
  }
});

/**
 * The site audit (HeoPress P07 tasks 5.1, 5.2): its issues as the caller may see them (the pages it may read; issues about
 * what only administrators see, to administrators), a machine-readable export of the same (JSON or CSV, for CI and agents),
 * and a run, asked for by an administrator (the worker runs it).
 */
const auditFor = async (c: Context<AppEnv>, limit?: number) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const permissions = permissionServiceForRequest(c);
  const admin = (await permissions.bundle()).admin;
  const rule = c.req.query('rule') || undefined;
  const raw = c.req.query('status');
  const status = raw === 'open' || raw === 'ignored' ? raw : undefined;
  return auditViewOf(db, siteId, { readable: await readableScope(db, siteId, permissions), admin, rule, limit, status });
};

/** Ignoring and restoring are an administrator's decision in Studio; never an API key (HeoPress P07a task 10.2). */
const triageRefusal = (c: Context<AppEnv>) => {
  const auth = c.get('auth');
  return auth?.type === 'api_key' || auth?.method === 'api_key' || auth?.apiKeyId
    ? c.json({ errors: [{ code: 'FORBIDDEN', message: 'Audit issues are ignored and restored by a site administrator in Studio.' }] }, 403)
    : null;
};

const ignoreBody = z.object({ reason: z.string().max(500).nullable().optional(), days: z.number().int().min(1).max(IGNORE_MAX_DAYS).optional() });

siteRouter.post('/audit/issues/:issueId/ignore', requireSiteAdmin(), async (c) => {
  const refused = triageRefusal(c);
  if (refused) return refused;
  const parsed = ignoreBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  try {
    const auth = c.get('auth');
    const result = await ignoreAuditIssue(c.get('db'), c.get('siteId'), c.req.param('issueId'), { ...parsed.data, actor: auth?.userId ?? null });
    await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
      event: 'audit_issue_ignored',
      actorEmail: typeof auth?.email === 'string' ? auth.email : null,
      requestId: c.get('requestId') ?? null,
      metadata: { issueId: c.req.param('issueId'), fingerprint: result.fingerprint, until: result.until, reason: parsed.data.reason ?? null },
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof AuditTriageError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    throw err;
  }
});

siteRouter.delete('/audit/issues/:issueId/ignore', requireSiteAdmin(), async (c) => {
  const refused = triageRefusal(c);
  if (refused) return refused;
  try {
    const auth = c.get('auth');
    const result = await restoreAuditIssue(c.get('db'), c.get('siteId'), c.req.param('issueId'));
    await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).write({
      event: 'audit_issue_restored',
      actorEmail: typeof auth?.email === 'string' ? auth.email : null,
      requestId: c.get('requestId') ?? null,
      metadata: { issueId: c.req.param('issueId'), fingerprint: result.fingerprint },
    });
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof AuditTriageError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    throw err;
  }
});

/** Resolved issues, by what the caller may see (HeoPress P07a task 10.2). */
siteRouter.get('/audit/resolved', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const permissions = permissionServiceForRequest(c);
  const admin = (await permissions.bundle()).admin;
  const limit = Number(c.req.query('limit') ?? 200);
  return c.json({ data: await resolvedAuditView(db, siteId, { readable: await readableScope(db, siteId, permissions), admin, limit: Number.isFinite(limit) && limit > 0 ? limit : 200 }) });
});

siteRouter.get('/audit', async (c) => {
  const limit = Number(c.req.query('limit') ?? 1000);
  return c.json({ data: await auditFor(c, Number.isFinite(limit) && limit > 0 ? limit : 1000) });
});

siteRouter.post('/audit/run', requireSiteAdmin(), async (c) => {
  await requestSiteAudit(c.get('db'), c.get('siteId'));
  return c.json({ data: { requested: true } }, 202);
});

const csvCell = (v: unknown) => {
  const t = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  // A cell a spreadsheet would read as a formula is quoted as text.
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

siteRouter.get('/audit/export', async (c) => {
  const view = await auditFor(c, 10_000);
  const format = c.req.query('format') === 'csv' ? 'csv' : 'json';
  const name = `audit-${c.get('siteId')}`;
  if (format === 'csv') {
    const lines = [['rule', 'severity', 'title', 'item_id', 'url', 'evidence', 'state'].join(',')];
    for (const i of view.issues) {
      const pages = i.pages.length ? i.pages : [null];
      for (const p of pages) lines.push([i.rule, i.severity, i.title, p?.itemId ?? '', p?.url ?? '', i.evidence, i.state.status].map(csvCell).join(','));
    }
    c.header('Content-Disposition', `attachment; filename="${name}.csv"`);
    return c.body(`${lines.join('\r\n')}\r\n`, 200, { 'Content-Type': 'text/csv; charset=utf-8' });
  }
  c.header('Content-Disposition', `attachment; filename="${name}.json"`);
  return c.json({ version: 1, siteId: c.get('siteId'), generatedAt: new Date().toISOString(), run: view.run, rules: view.rules, total: view.total, issues: view.issues });
});

/**
 * Change impact (HeoPress P07 task 5.5): the pages that may be affected when a page is unpublished, deleted or moved
 * (`depth` 1–2, `limit` ≤ 200), limited to what the caller may read; a redirect from its address (administrators); its
 * links in other pages changed to another address (each page as far as the caller may update it).
 */
const impactFailure = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof LinkImpactError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  throw err;
};

siteRouter.get('/links/impact/:itemId', async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const permissions = permissionServiceForRequest(c);
  // Whole numbers or nothing (Codex review of task 5.5: never NaN into the query).
  const intParam = (name: string, fallback: number) => {
    const raw = c.req.query(name);
    if (raw === undefined || raw === '') return fallback;
    return /^\d{1,6}$/.test(raw) ? Number(raw) : null;
  };
  const depth = intParam('depth', 1);
  const limit = intParam('limit', 100);
  if (depth === null || limit === null) return c.json({ errors: [{ code: 'INVALID', message: 'depth and limit are whole numbers.' }] }, 400);
  const navigation = (await permissions.bundle()).admin;
  try {
    const data = await linkImpact(db, siteId, c.req.param('itemId'), { readable: await readableScope(db, siteId, permissions), navigation, depth, limit });
    return c.json({ data });
  } catch (err) {
    return impactFailure(c, err);
  }
});

siteRouter.post('/links/impact/:itemId/redirect', requireSiteAdmin(), async (c) => {
  const body = (await c.req.json().catch(() => null)) as { to?: unknown } | null;
  try {
    return c.json({ data: await createImpactRedirect(c.get('db'), c.get('siteId'), c.req.param('itemId'), body?.to, { userId: c.get('auth')?.userId ?? null }) }, 201);
  } catch (err) {
    return impactFailure(c, err);
  }
});

siteRouter.post('/links/impact/:itemId/update-links', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { to?: unknown; sources?: unknown } | null;
  try {
    return c.json({ data: await updateImpactLinks(c.get('db'), c.get('siteId'), itemServiceForRequest(c), c.req.param('itemId'), { to: body?.to, sources: body?.sources }) });
  } catch (err) {
    return impactFailure(c, err);
  }
});

/**
 * AI traffic (HeoPress P07 task 6.2): the site's day totals of AI crawler reads and AI-referred visits over `days`
 * (1–90, default 30), to the site's members — in the site's scope, nothing of another site. `previous=1` adds the totals
 * of the period of the same length before (HeoPress P07a task 7.1).
 */
/**
 * Pre-publish checks of an item (HeoPress P07a task 5.4; spec studio/review-workspace): read through the item service —
 * the caller's read grant, its row rule and field limits; an item it may not read answers as one that does not exist.
 * Nothing is fetched over the network.
 */
siteRouter.get('/items/:collection/:id/checks', async (c) => {
  const collection = c.req.param('collection');
  const notFound = () => c.json({ errors: [{ code: 'NOT_FOUND', message: 'Item not found.' }] }, 404);
  const perm = await permissionServiceForRequest(c).canAccess(collection, 'read');
  if (!perm) return notFound();
  let item: { id: string; status: string; data: Record<string, unknown> };
  try {
    item = (await itemServiceForRequest(c).detail(collection, c.req.param('id'))) as unknown as typeof item;
  } catch {
    return notFound();
  }
  const db = c.get('db');
  const checks = await publishChecks({
    db,
    siteId: c.get('siteId'),
    collection,
    item,
    readFields: perm.fields,
    resolve: (host, path) => resolvePublicPath(db, { host, path }),
  });
  return c.json({ data: { itemId: item.id, checks } });
});

siteRouter.get('/ai-traffic', async (c) => {
  const days = Number(c.req.query('days') ?? 30);
  const previous = c.req.query('previous') === '1' || c.req.query('previous') === 'true';
  return c.json({ data: await aiTrafficReport(c.get('db'), c.get('siteId'), { days: Number.isFinite(days) ? days : 30, previous }) });
});

/**
 * The online reachability check (HeoPress P07 task 3.9; spec seo/crawl-discovery "线上可达性体检"): the last report on the
 * site's verified domains, to the site's members; a check asked for by an administrator (`hosts`: the site's verified
 * serving domains only — any other host is refused; `platform`: the one the fix advice is written for), run by the worker.
 */
siteRouter.get('/reachability', async (c) => c.json({ data: await reachabilityViewOf(c.get('db'), c.get('siteId')) }));

siteRouter.post('/reachability/run', requireSiteAdmin(), async (c) => {
  // No body is a check of the site's own domains; a body that is not a JSON object is refused, never read as no body
  // (Codex review of task 3.9, round 1: a malformed body must not start a default check).
  const text = await c.req.text();
  let body: { hosts?: unknown; platform?: unknown } | null = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as { hosts?: unknown; platform?: unknown } | null;
    } catch {
      body = null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ errors: [{ code: 'VALIDATION', message: 'The body is a JSON object: { hosts?, platform? }.' }] }, 400);
    }
  }
  try {
    await requestReachabilityCheck(c.get('db'), c.get('siteId'), { hosts: body?.hosts, platform: body?.platform });
    return c.json({ data: { requested: true } }, 202);
  } catch (err) {
    if (err instanceof ReachabilityError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    throw err;
  }
});
