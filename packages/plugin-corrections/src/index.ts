/**
 * The official corrections plugin of HeoPress (`heopress-corrections`), built only on the public Extension SDK and the
 * capabilities its manifest (`heopress-extension.json`) declares.
 *
 * Declared in the manifest, run by the host without this code:
 *   - the `reports` collection (`heopress_corrections__reports`), the moderation queue: a draft report per submission,
 *     never publicly readable, with the reporter's optional name, e-mail and comment marked hidden;
 *   - the `notices` collection (`heopress_corrections__notices`) and its pages `/corrections` and `/corrections/:slug`,
 *     with Classic and Astro templates;
 *   - a `CorrectionComment` structured-data node on each notice page; the `decisions` private storage (the idempotency
 *     ledger), its admin table and count widget, and the plugin's settings.
 *
 * Registered here:
 *   - `endpoints` → `report`: the public form a reader submits. The host verifies the form's origin (the site's own
 *     pages only), the body limit (8 KiB) and the rate limit (5 a minute), then this code validates every field and
 *     creates a draft report. The answer is one neutral sentence for every accepted submission — also for a filled
 *     honeypot, which is dropped — and the endpoint never resolves the page, so nothing tells a stranger whether it
 *     exists;
 *   - `events` → `moderate-report`: a report whose status becomes `accepted` produces exactly one notice (draft, never
 *     published by the plugin); a duplicate delivery or a second acceptance writes nothing new, because the report ->
 *     notice decision is recorded in private storage before the notice is returned to the queue. `rejected` touches
 *     nothing.
 *   - `events` → `attach-notice`: a notice that becomes `published` writes one correction block into the corrected
 *     article's body (through the normal write path: a new version, Hold, the publish guards and other plugins'
 *     pre-publish hooks apply). An existing block is never rewritten or duplicated, so an operator's edit inside it is
 *     kept; a notice that is unpublished or deleted removes exactly its block. The `write_body` setting turns body
 *     writing off (the notices then live only in the collection).
 *   - `gate-checks` → `notice-links`: an article whose correction block points at a notice that is missing or not
 *     published is `blocked`; with every notice published it passes. The check reads the site's notices through its
 *     declared `items:read` capabilities.
 *
 * The plugin declares no pre-publish hook: a bundle that fails to load then never stops article publishing, and the
 * marker invariant is kept by the gate check and by removing the block when its notice stops being public.
 */
import {
  defineEndpoint,
  defineSubscription,
  type EndpointRequest,
  type GateCheckDefinition,
  type GateCheckVerdict,
  type PluginContext,
  type PluginEvent,
} from '@heopress/extension-sdk';
import { judgeMalformedMarkers, judgeNoticeLinks, judgeUnreadable, type NoticeLookup } from './gate';
import { appendMarker, hasMarker, isMarkerId, markerBlock, markerIds, withoutMarker } from './marker';
import { correctionDay, lastPathSegment, noticeDocument, type ReportSource, type TargetArticle } from './notice';
import { NEUTRAL_ANSWER, parseReport } from './report';

/** The plugin's report collection on a site (`<namespace>__<collection>`). */
export const REPORTS = 'heopress_corrections__reports';
/** The published correction records. */
export const NOTICES = 'heopress_corrections__notices';
/** The collection whose bodies receive the correction block (the capabilities name it). */
export const ARTICLES = 'articles';
/** The private storage namespace of the report -> notice decisions. */
export const DECISIONS = 'decisions';
const BODY = 'body';

interface Settings {
  writeBody: boolean;
  markerLabel: string;
}

interface ItemRow {
  id: string;
  status: string;
  version: number;
  data: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const codeOf = (err: unknown): string | undefined => (err && typeof err === 'object' ? (err as { code?: string }).code : undefined);

function rowOf(value: unknown): ItemRow | null {
  const r = obj(value);
  const data = obj(r?.data);
  if (!r || typeof r.id !== 'string' || !data) return null;
  return { id: r.id, status: String(r.status ?? ''), version: Number(r.version ?? 0), data };
}

function rowsOf(page: unknown): ItemRow[] {
  const list = obj(page)?.data;
  return Array.isArray(list) ? list.map(rowOf).filter((r): r is ItemRow => r !== null) : [];
}

async function settingsOf(ctx: PluginContext): Promise<Settings> {
  const values = await ctx.settings.all();
  return {
    writeBody: values.write_body !== false,
    markerLabel: str(values.marker_label) || 'Correction',
  };
}

/** One item of the site, or null when it is gone. */
async function detail(ctx: PluginContext, collection: string, id: string): Promise<ItemRow | null> {
  try {
    return rowOf(await ctx.items.detail(collection, id));
  } catch (err) {
    if (codeOf(err) === 'NOT_FOUND') return null;
    throw err;
  }
}

/** The report field that carries the moderation decision (the queue's `status` column). */
function decisionOf(row: ItemRow): 'accepted' | 'rejected' | null {
  if (row.status === 'accepted' || row.status === 'rejected') return row.status;
  const value = str(row.data.status);
  return value === 'accepted' || value === 'rejected' ? value : null;
}

/**
 * The article a page path names. The plugin has no route table, so it uses the last segment of the path — the article's
 * id when the permalink ends in it, otherwise its slug. The published article wins when a language shares the slug.
 */
async function articleAt(ctx: PluginContext, pagePath: string): Promise<ItemRow | null> {
  const segment = lastPathSegment(pagePath);
  if (!segment) return null;
  const byId = await detail(ctx, ARTICLES, segment);
  if (byId) return byId;
  const rows = rowsOf(await ctx.items.list(ARTICLES, { filter: { slug: { _eq: segment } }, limit: 5 }));
  return rows.find((r) => r.status === 'published') ?? rows[0] ?? null;
}

const targetOf = (row: ItemRow): TargetArticle => ({ id: row.id, title: str(row.data.title), locale: str(row.data.locale) });

const reportSourceOf = (row: ItemRow): ReportSource => ({
  reportId: row.id,
  pagePath: str(row.data.page_path),
  excerpt: str(row.data.excerpt),
  correction: str(row.data.correction),
});

/** The notice a report already produced, if the ledger or the site says so (a lost ledger must not duplicate one). */
async function existingNotice(ctx: PluginContext, reportId: string): Promise<string | null> {
  const found = await ctx.storage.collection(DECISIONS).get(`notice:${reportId}`);
  const fromLedger = str(found?.data.notice);
  if (fromLedger) return fromLedger;
  const rows = rowsOf(await ctx.items.list(NOTICES, { filter: { report_id: { _eq: reportId } }, limit: 2 }));
  return rows[0]?.id ?? null;
}

// ─── The public form ─────────────────────────────────────────────────────────

/**
 * Validate one submission and, unless it is a trapped robot, write a draft report. The endpoint looks the page up
 * nowhere: refusing a malformed path and accepting a well-formed one say nothing about whether the page exists, and the
 * answer is the same sentence either way.
 */
async function reportSubmission(ctx: PluginContext, req: EndpointRequest): Promise<{ status?: number; body?: unknown }> {
  const parsed = parseReport(req.body);
  if (!parsed.ok) return { status: 422, body: { errors: parsed.errors } };
  if (parsed.trapped || !parsed.fields) return { body: { message: NEUTRAL_ANSWER } };
  const fields = parsed.fields;
  await ctx.items.create(REPORTS, {
    data: {
      status: 'pending',
      page_path: fields.pagePath,
      excerpt: fields.excerpt,
      correction: fields.correction,
      comment: fields.comment,
      reporter_name: fields.reporterName,
      reporter_email: fields.reporterEmail,
      submitted_at: new Date().toISOString(),
    },
    status: 'draft',
  });
  return { body: { message: NEUTRAL_ANSWER } };
}

// ─── Moderation: an accepted report becomes one draft notice ─────────────────

/**
 * React to a report's decision. `accepted` creates one draft notice and records the decision; a delivery repeated, or a
 * report accepted twice, finds the record and writes nothing. `rejected` (and a report still pending) touches nothing:
 * the report stays in the queue, privately, until the operator deletes it.
 */
async function moderateReport(ctx: PluginContext, event: PluginEvent): Promise<void> {
  if (event.collection !== REPORTS || event.operation === 'delete') return;
  const report = await detail(ctx, REPORTS, event.itemId);
  if (!report || decisionOf(report) !== 'accepted') return;
  if (await existingNotice(ctx, report.id)) return;

  const article = await articleAt(ctx, str(report.data.page_path));
  let noticeId: string | null = null;
  try {
    noticeId = rowOf(await ctx.items.create(NOTICES, { data: noticeDocument(reportSourceOf(report), article ? targetOf(article) : null, new Date()), status: 'draft' }))?.id ?? null;
  } catch (err) {
    const code = codeOf(err);
    // The notice is already there (a repeated acceptance that lost its ledger): adopt it instead of failing.
    if (code === 'PATH_TAKEN' || code === 'DUPLICATE_ID') noticeId = await existingNotice(ctx, report.id);
    else throw err;
  }
  if (!noticeId) return;
  await ctx.storage.collection(DECISIONS).put(`notice:${report.id}`, {
    report: report.id,
    notice: noticeId,
    article: article?.id ?? '',
    state: 'accepted',
    event: event.id,
    at: new Date().toISOString(),
  });
}

// ─── The correction block in the article ─────────────────────────────────────

/** A write the normal path refused (a newer version, a hold, another plugin's veto): the next notice change retries. */
const RETRYABLE = new Set(['VERSION_CONFLICT', 'ITEM_HELD', 'PUBLISH_VETOED', 'NOT_FOUND', 'PINNED_BY_HUMAN']);

async function rememberArticle(ctx: PluginContext, reportId: string, articleId: string): Promise<void> {
  const store = ctx.storage.collection(DECISIONS);
  const doc = await store.get(`notice:${reportId}`);
  if (!doc || str(doc.data.article) === articleId) return;
  await store.put(`notice:${reportId}`, { ...doc.data, article: articleId });
}

/** The article a notice is attached to: its recorded id first, the page path second (the path may have changed). */
async function articleOfNotice(ctx: PluginContext, notice: ItemRow): Promise<ItemRow | null> {
  const recorded = str(notice.data.article_id);
  if (recorded) {
    const byId = await detail(ctx, ARTICLES, recorded);
    if (byId) return byId;
  }
  return articleAt(ctx, str(notice.data.page_path));
}

/** Write the block of a published notice into its article, once. */
async function attachNotice(ctx: PluginContext, notice: ItemRow, settings: Settings): Promise<void> {
  const reportId = str(notice.data.report_id);
  if (!isMarkerId(reportId)) return;
  const article = await articleOfNotice(ctx, notice);
  if (!article) return; // documented: the notice stays, the article is gone, no block is written anywhere
  const body = article.data[BODY];
  if (typeof body !== 'string') return; // an article without a body field is left untouched
  if (hasMarker(body, reportId)) {
    await rememberArticle(ctx, reportId, article.id);
    return; // never a second block; an operator's edit inside the existing one is kept
  }
  const when = new Date(str(notice.data.corrected_on));
  const block = markerBlock({
    reportId,
    label: settings.markerLabel,
    excerpt: str(notice.data.excerpt),
    correction: str(notice.data.correction),
    date: correctionDay(Number.isNaN(when.getTime()) ? new Date() : when),
  });
  try {
    await ctx.items.patch(ARTICLES, article.id, { data: { [BODY]: appendMarker(body, block) }, expectedVersion: article.version });
  } catch (err) {
    if (RETRYABLE.has(codeOf(err) ?? '')) {
      console.warn(`[corrections] the correction block of ${reportId} was not written (${codeOf(err)}); the next notice change retries`);
      return;
    }
    throw err;
  }
  await rememberArticle(ctx, reportId, article.id);
}

/** Remove exactly the block of a notice that is no longer public (unpublished or deleted). */
async function detachNotice(ctx: PluginContext, noticeId: string, notice: ItemRow | null): Promise<void> {
  const store = ctx.storage.collection(DECISIONS);
  let reportId = notice ? str(notice.data.report_id) : '';
  let articleId = notice ? str(notice.data.article_id) : '';
  if (!reportId || !articleId) {
    // The notice is gone: its ledger record still names the report and the article.
    const { documents } = await store.query({ where: { notice: noticeId }, limit: 1 });
    const recorded = documents[0]?.data;
    if (!reportId) reportId = str(recorded?.report);
    if (!articleId) articleId = str(recorded?.article);
  }
  if (!isMarkerId(reportId)) return;
  const article = articleId ? await detail(ctx, ARTICLES, articleId) : notice ? await articleAt(ctx, str(notice.data.page_path)) : null;
  const body = article?.data[BODY];
  if (!article || typeof body !== 'string' || !hasMarker(body, reportId)) return;
  const next = withoutMarker(body, reportId);
  if (next === body) return;
  try {
    await ctx.items.patch(ARTICLES, article.id, { data: { [BODY]: next }, expectedVersion: article.version });
  } catch (err) {
    if (RETRYABLE.has(codeOf(err) ?? '')) return;
    throw err;
  }
}

/**
 * React to a notice's state: published → its article gets the block; unpublished or deleted → the block goes. The
 * `write_body` setting turns all of it off, leaving the notices in the collection only.
 */
async function onNoticeChange(ctx: PluginContext, event: PluginEvent): Promise<void> {
  if (event.collection !== NOTICES) return;
  const settings = await settingsOf(ctx);
  if (!settings.writeBody) return;
  if (event.operation === 'delete') {
    await detachNotice(ctx, event.itemId, null);
    return;
  }
  const notice = await detail(ctx, NOTICES, event.itemId);
  if (!notice) return;
  if (notice.status === 'published') await attachNotice(ctx, notice, settings);
  else await detachNotice(ctx, notice.id, notice);
}

// ─── Gate check ──────────────────────────────────────────────────────────────

/**
 * The notices every correction block in the body points at. Reads the site's notices through the plugin's
 * `items:read:heopress_corrections__notices` capability; an unreadable site is `needs_review`, never `passed`.
 */
async function noticeLinksVerdict(ctx: PluginContext, bodyHtml: string): Promise<GateCheckVerdict> {
  const ids = markerIds(bodyHtml);
  if (ids.length === 0) return { verdict: 'passed', evidence: { corrections: 0 } };
  const malformed = ids.filter((id) => !isMarkerId(id));
  if (malformed.length > 0) return judgeMalformedMarkers(malformed);
  const lookups: NoticeLookup[] = [];
  try {
    for (const report of ids) {
      const rows = rowsOf(await ctx.items.list(NOTICES, { filter: { report_id: { _eq: report } }, limit: 5 }));
      const published = rows.find((r) => r.status === 'published');
      const any = published ?? rows[0];
      lookups.push({ report, notice: any ? { id: any.id, status: any.status } : null });
    }
  } catch {
    return judgeUnreadable();
  }
  return judgeNoticeLinks(lookups);
}

// ─── Registration ────────────────────────────────────────────────────────────

export default function corrections(ctx: PluginContext): Record<string, never> {
  const gateCheck: GateCheckDefinition = {
    id: 'notice-links',
    check: (draft) => (draft.collection === ARTICLES ? noticeLinksVerdict(ctx, draft.bodyHtml) : { verdict: 'passed' }),
  };
  ctx.extensionPoints.register(
    'endpoints',
    defineEndpoint({
      name: 'report',
      kind: 'form',
      methods: ['POST'],
      maxBodyBytes: 8 * 1024,
      ratePerMinute: 5,
      maxDurationMs: 5_000,
      maxRequests: 0,
      handle: (req) => reportSubmission(ctx, req),
    }),
  );
  ctx.extensionPoints.register(
    'events',
    defineSubscription({
      name: 'moderate-report',
      collections: [REPORTS],
      operations: ['create', 'update'],
      maxRequests: 0,
      handle: (event) => moderateReport(ctx, event),
    }),
  );
  ctx.extensionPoints.register(
    'events',
    defineSubscription({
      name: 'attach-notice',
      collections: [NOTICES],
      operations: ['create', 'update', 'delete'],
      maxRequests: 0,
      handle: (event) => onNoticeChange(ctx, event),
    }),
  );
  ctx.extensionPoints.register('gate-checks', gateCheck);
  return {};
}
