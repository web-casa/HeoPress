/**
 * The official glossary plugin of HeoPress (`heopress-glossary`), built only on the public Extension SDK and the
 * capabilities its manifest (`heopress-extension.json`) declares.
 *
 * Declared in the manifest, run by the host without this code:
 *   - the `terms` collection (`heopress_glossary__terms`), its term pages `/glossary/:slug` and index `/glossary`, with
 *     Classic and Astro templates, and the `tooltip` theme component;
 *   - a `DefinedTerm` structured-data node on each term page; the `references` private storage, its admin table and
 *     count widget, and the plugin's settings.
 *
 * Registered here:
 *   - `gate-checks` → `citation`: a term definition without a source citation needs a person (`needs_review`);
 *   - `events` → subscription `link-on-publish`: after an article is published (or changed while published) its body's
 *     terms are linked to their pages and the term references are updated; an unpublished or deleted article's
 *     references are removed; a changed term queues a full recomputation;
 *   - `jobs` → `relink`: every 6 hours (or when queued) recompute the term links of every published article, one batch
 *     per run, continuing from the last article done (`continueLater` / `checkpoint`).
 *
 * The plugin registers no pre-publish hook (its manifest declares none), so it never blocks a publish, even when its
 * bundle fails to load. Article edits go through `ctx.items` (the normal write path: a new version, Hold, the
 * publish guards and other plugins' pre-publish hooks apply); an edit that is refused is retried by the next run.
 */
import {
  defineJob,
  defineSubscription,
  type GateCheckDefinition,
  type JobRunContext,
  type PluginContext,
  type PluginEvent,
} from '@heopress/extension-sdk';
import { citationVerdict } from './citation';
import { linkTerms, termHref, type GlossaryTerm } from './linker';

/** The plugin's term collection on a site (`<namespace>__<collection>`). */
export const TERMS = 'heopress_glossary__terms';
/** The collection whose bodies get term links (the capabilities name it). */
export const CONTENT = 'articles';
const BODY = 'body';
const REFERENCES = 'references';
const PAGE = 200;

interface Settings {
  trailingSlash: boolean;
  localePrefixes: Record<string, string>;
  maxLinks: number;
  batchSize: number;
}

interface ItemRow {
  id: string;
  status: string;
  version: number;
  data: Record<string, unknown>;
}

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const int = (v: unknown, fallback: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback;

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

function termOf(row: ItemRow): GlossaryTerm | null {
  const title = str(row.data.title);
  const slug = str(row.data.slug);
  if (!title || !slug) return null;
  return {
    id: row.id,
    slug,
    title,
    aliases: str(row.data.aliases).split(',').map((a) => a.trim()).filter(Boolean),
    definition: str(row.data.excerpt),
    locale: str(row.data.locale),
  };
}

async function settingsOf(ctx: PluginContext): Promise<Settings> {
  const s = await ctx.settings.all();
  const prefixes = obj(s.locale_prefixes) ?? {};
  return {
    trailingSlash: s.trailing_slash !== false,
    localePrefixes: Object.fromEntries(Object.entries(prefixes).filter((e): e is [string, string] => typeof e[1] === 'string')),
    maxLinks: int(s.max_links, 20, 0, 100),
    batchSize: int(s.batch_size, 25, 1, PAGE),
  };
}

/** Published items of a collection, `limit` at a time in id order, after `after`. */
function publishedPage(ctx: PluginContext, collection: string, limit: number, after: string | null): Promise<unknown> {
  return ctx.items.list(collection, {
    status: 'published',
    sort: ['id'],
    limit,
    withTotal: false,
    ...(after ? { filter: { id: { _gt: after } } } : {}),
  });
}

/** Every published term of the site. */
async function publishedTerms(ctx: PluginContext): Promise<GlossaryTerm[]> {
  const out: GlossaryTerm[] = [];
  let after: string | null = null;
  for (;;) {
    const rows = rowsOf(await publishedPage(ctx, TERMS, PAGE, after));
    for (const row of rows) {
      const term = termOf(row);
      if (term) out.push(term);
    }
    if (rows.length < PAGE) return out;
    after = rows[rows.length - 1]!.id;
  }
}

/** A reference document's id: one per term and article (ids start with a letter). */
const referenceId = (termId: string, itemId: string) => `ref:${termId}:${itemId}`;

/** Make the article's references the terms it links (private storage, never published). */
async function updateReferences(ctx: PluginContext, row: ItemRow | { id: string }, terms: readonly GlossaryTerm[]): Promise<void> {
  const store = ctx.storage.collection(REFERENCES);
  const existing = await store.query({ where: { item: row.id }, limit: PAGE });
  const title = 'data' in row ? str(row.data.title) : '';
  const want = new Map(terms.map((t) => [referenceId(t.id, row.id), t]));
  for (const doc of existing.documents) if (!want.has(doc.id)) await store.delete(doc.id);
  for (const [id, term] of want) {
    const data = { term: term.id, term_slug: term.slug, term_title: term.title, item: row.id, collection: CONTENT, title };
    const current = existing.documents.find((d) => d.id === id);
    if (current && JSON.stringify(current.data) === JSON.stringify(data)) continue;
    await store.put(id, data);
  }
}

const codeOf = (err: unknown): string | undefined => (err && typeof err === 'object' ? (err as { code?: string }).code : undefined);

/**
 * Link the terms in one published article and record its references. Returns whether the body changed. An edit the
 * write path refuses (a newer version, a hold, another plugin's veto) is left for the next run.
 */
async function relinkArticle(ctx: PluginContext, row: ItemRow, terms: readonly GlossaryTerm[], settings: Settings): Promise<boolean> {
  const body = row.data[BODY];
  if (typeof body !== 'string') {
    await updateReferences(ctx, row, []);
    return false;
  }
  const { html, linked } = linkTerms(body, terms, {
    hrefOf: (t) => termHref(t, settings),
    maxLinks: settings.maxLinks,
    locale: str(row.data.locale),
  });
  await updateReferences(ctx, row, linked);
  if (html === body) return false;
  try {
    await ctx.items.patch(CONTENT, row.id, { data: { [BODY]: html }, expectedVersion: row.version });
    return true;
  } catch (err) {
    const code = codeOf(err);
    if (code === 'VERSION_CONFLICT' || code === 'ITEM_HELD' || code === 'PUBLISH_VETOED' || code === 'NOT_FOUND' || code === 'PINNED_BY_HUMAN') return false;
    throw err;
  }
}

/** After a content change: link and record a published article; drop the references of one that is not. */
async function onContentChange(ctx: PluginContext, event: PluginEvent): Promise<void> {
  if (event.collection === TERMS) {
    // A term was added, changed or removed: every article may link differently now. The scheduled run catches up when
    // queueing is not available.
    await ctx.jobs.enqueue('relink', { term: event.itemId }).catch(() => undefined);
    return;
  }
  if (event.collection !== CONTENT) return;
  let row: ItemRow | null = null;
  if (event.operation !== 'delete') {
    try {
      row = rowOf(await ctx.items.detail(CONTENT, event.itemId));
    } catch (err) {
      if (codeOf(err) !== 'NOT_FOUND') throw err;
    }
  }
  if (!row || row.status !== 'published') {
    await updateReferences(ctx, { id: event.itemId }, []);
    return;
  }
  const [terms, settings] = await Promise.all([publishedTerms(ctx), settingsOf(ctx)]);
  await relinkArticle(ctx, row, terms, settings);
}

/** One batch of the full recomputation, continuing after the last article of the previous batch. */
async function relinkBatch(ctx: PluginContext, job: JobRunContext): Promise<void> {
  const settings = await settingsOf(ctx);
  const terms = await publishedTerms(ctx);
  let after = str(obj(job.progress)?.after) || null;
  const rows = rowsOf(await publishedPage(ctx, CONTENT, settings.batchSize, after));
  for (const row of rows) {
    // Close to the limit: stop here, the next batch starts after the last article done.
    if (job.timeLeft() < 3_000) return job.continueLater({ after });
    await relinkArticle(ctx, row, terms, settings);
    after = row.id;
    await job.checkpoint({ after });
  }
  // A full batch: there may be more. A short one was the last.
  if (rows.length === settings.batchSize) job.continueLater({ after });
}

const citation: GateCheckDefinition = {
  id: 'citation',
  check: (draft) => (draft.collection === TERMS ? citationVerdict(draft.fields) : { verdict: 'passed' }),
};

export default function glossary(ctx: PluginContext): Record<string, never> {
  ctx.extensionPoints.register('gate-checks', citation);
  ctx.extensionPoints.register(
    'events',
    defineSubscription({
      name: 'link-on-publish',
      collections: [CONTENT, TERMS],
      operations: ['create', 'update', 'delete'],
      maxRequests: 0,
      handle: (event) => onContentChange(ctx, event),
    }),
  );
  ctx.extensionPoints.register(
    'jobs',
    defineJob({
      name: 'relink',
      schedule: { everyMinutes: 360 },
      maxDurationMs: 60_000,
      maxRequests: 0,
      maxRetries: 3,
      run: (job) => relinkBatch(ctx, job),
    }),
  );
  return {};
}
