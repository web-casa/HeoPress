/**
 * The official HeoPress daily-briefing plugin (HeoPress v1.1, backlog P12): two Studio overview briefing sections,
 * "Today" (the `articles` published today) and "This week" (the drafts nobody has touched since Monday).
 *
 * It uses one extension point, `briefing-sections`, and only types from `@heopress/extension-sdk` (`import type`), so
 * the built `dist/index.js` has no runtime import and the host loads it as one self-contained module. It reads through
 * `ctx.items.list`, which applies the site boundary, the requesting person's permissions, Hold and the field rules;
 * the manifest asks for `items:read:articles` and nothing that writes.
 *
 * What the host does, not this file:
 *   - it calls `compute` only when the Studio asks for the briefing (`GET /api/v1/extensions/briefing-sections`),
 *     inside a deadline (default 1 500 ms) and a request budget (default 10);
 *   - it checks the answer: a non-negative integer `count` and at most ten items, each a label (≤ 80 characters) and a
 *     site-relative `href` (`/…`). Absolute URLs are refused, so a briefing link can never send the operator off-site;
 *   - it refuses a section at load if the manifest does not declare its id, and records the refusal.
 *
 * Both sections use UTC day/Monday boundaries: `PluginContext` does not expose the site's time zone, and the core
 * overview feed uses the same UTC window. Per-site time zones are the remaining part of the backlog item, not this
 * plugin's invention.
 */
import type { BriefingSectionDefinition, BriefingSectionPayload, PluginContext } from '@heopress/extension-sdk';

/** The collection these sections read. The manifest declares `items:read:articles`. */
export const COLLECTION = 'articles';
/** The section ids; `heopress-extension.json` declares the same ones, with the titles the Studio shows. */
export const TODAY_SECTION_ID = 'today';
export const WEEK_SECTION_ID = 'week';
/** Links a briefing section may list at most (the host's contract; we also trim to it ourselves). */
export const MAX_ITEMS = 10;
/** Rows one read looks at. More than this and the count is a lower bound, which the README states. */
export const PAGE_SIZE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What this plugin reads from one item of the list response. */
export interface BriefingRow {
  id: string;
  title?: unknown;
  publishedAt?: unknown;
  updatedAt?: unknown;
  data?: Record<string, unknown>;
}

/** One link, plus the timestamp the section ordered it by (kept for the pure functions and the tests). */
export interface BriefingEntry {
  label: string;
  href: string;
  at: string;
}

function timestamp(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function titleOf(row: BriefingRow): string {
  if (typeof row.title === 'string' && row.title.trim() !== '') return row.title.trim();
  const fromData = row.data?.title;
  return typeof fromData === 'string' ? fromData.trim() : '';
}

function hrefOf(row: BriefingRow): string {
  return `/content/${COLLECTION}/${encodeURIComponent(row.id)}`;
}

/** 00:00 UTC of the day holding `now`. */
export function startOfUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Monday 00:00 UTC of the week holding `now`. */
export function startOfUtcWeek(now: number): number {
  const day = startOfUtcDay(now);
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
}

/**
 * The `articles` published during the UTC day holding `now`, newest first. A row without a readable `publishedAt` is
 * left alone: guessing would put it in the wrong day.
 */
export function publishedOn(rows: readonly BriefingRow[], now: number): BriefingEntry[] {
  const from = startOfUtcDay(now);
  const to = from + DAY_MS;
  const out: BriefingEntry[] = [];
  for (const row of rows) {
    const published = timestamp(row.publishedAt);
    if (published === null || published < from || published >= to) continue;
    out.push({ label: titleOf(row) || row.id, href: hrefOf(row), at: new Date(published).toISOString() });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * The drafts whose last update is before the UTC week holding `now`, oldest first — "what has not moved this week".
 * A row without a readable `updatedAt` is left alone, for the same reason as above.
 */
export function draftsUntouchedSince(rows: readonly BriefingRow[], now: number): BriefingEntry[] {
  const weekStart = startOfUtcWeek(now);
  const out: BriefingEntry[] = [];
  for (const row of rows) {
    const updated = timestamp(row.updatedAt);
    if (updated === null || updated >= weekStart) continue;
    out.push({ label: titleOf(row) || row.id, href: hrefOf(row), at: new Date(updated).toISOString() });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function payload(entries: readonly BriefingEntry[]): BriefingSectionPayload {
  return {
    count: entries.length,
    items: entries.slice(0, MAX_ITEMS).map(({ label, href }) => ({ label, href })),
  };
}

/** The rows of one `items.list` page, or none when the host answers something unexpected. */
async function listRows(ctx: PluginContext, params: Record<string, unknown>): Promise<BriefingRow[]> {
  const page = (await ctx.items.list(COLLECTION, params)) as { data?: BriefingRow[] } | null;
  return Array.isArray(page?.data) ? page.data : [];
}

/**
 * Register both sections on the plugin context. Exported so the unit tests can drive it with a fake context;
 * the default export below is what the host calls.
 */
export function registerDailyBriefing(ctx: PluginContext): void {
  const today: BriefingSectionDefinition = {
    id: TODAY_SECTION_ID,
    compute: async () => {
      // `published_at` is not a sortable list field, so the newest updates are the closest honest page; a row
      // published today is necessarily updated today too.
      const rows = await listRows(ctx, { status: 'published', sort: ['-updated_at'], limit: PAGE_SIZE, withTotal: false });
      return payload(publishedOn(rows, Date.now()));
    },
  };
  const week: BriefingSectionDefinition = {
    id: WEEK_SECTION_ID,
    compute: async () => {
      // Oldest first, so the page holds the drafts most likely to be untouched; the count is exact up to PAGE_SIZE.
      const rows = await listRows(ctx, { status: 'draft', sort: ['updated_at'], limit: PAGE_SIZE, withTotal: false });
      return payload(draftsUntouchedSince(rows, Date.now()));
    },
  };
  ctx.extensionPoints.register('briefing-sections', today);
  ctx.extensionPoints.register('briefing-sections', week);
}

/** The plugin: register the two sections and return no other export. */
export default (ctx: PluginContext) => {
  registerDailyBriefing(ctx);
  return {};
};
