/**
 * An example HeoPress plugin contributing one Studio overview briefing section (HeoPress v1.1): "Stale drafts" — the
 * drafts of `articles` nobody has touched for two weeks, oldest first, each linking to its editor.
 *
 * It uses one extension point, `briefing-sections`, and only types from `@heopress/extension-sdk` (`import type`), so the
 * built `dist/index.js` has no runtime import and the host loads it as one self-contained module.
 *
 * What the host does, not this file:
 *   - it calls `compute` only when the Studio asks for the briefing (`GET /api/v1/extensions/briefing-sections`), inside
 *     a deadline (default 1 500 ms) and a request budget (default 10);
 *   - it checks the answer: a non-negative integer `count` and at most ten items, each a label (≤ 80 characters) and a
 *     site-relative `href` (`/…`). Absolute URLs are refused, so a briefing link can never send the operator off-site;
 *   - it refuses the section at load if the manifest does not declare its id, and records the refusal.
 *
 * `ctx.items.list` goes through the normal read path: the site boundary, the requesting person's permissions, Hold and
 * the field-level rules all apply, and the plugin needs `items:read:articles` for it.
 */
import type { BriefingSectionDefinition, PluginContext } from '@heopress/extension-sdk';

/** The section id; `heopress-extension.json` declares the same one, with the title the Studio shows. */
export const SECTION_ID = 'stale-drafts';
/** Days without an update after which a draft counts as stale. */
export const STALE_DAYS = 14;
/** Links a briefing section may list at most (the host's contract). */
export const MAX_ITEMS = 10;
/** Drafts one read looks at: the oldest first, so the count is exact for sites with up to this many drafts. */
export const PAGE_SIZE = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

/** What this plugin reads from one item of the list response. */
export interface DraftRow {
  id: string;
  title?: unknown;
  updatedAt?: unknown;
  data?: Record<string, unknown>;
}

/** One stale draft, as the briefing lists it. */
export interface StaleDraft {
  label: string;
  href: string;
  updatedAt: string;
}

function timestamp(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function titleOf(row: DraftRow): string {
  if (typeof row.title === 'string' && row.title.trim() !== '') return row.title.trim();
  const fromData = row.data?.title;
  return typeof fromData === 'string' ? fromData.trim() : '';
}

/**
 * The drafts of `rows` not updated for `staleDays` before `now`, the oldest first. Pure: the plugin's only judgement is
 * here, so it is easy to read and to reason about.
 */
export function staleDrafts(rows: readonly DraftRow[], now: number, staleDays = STALE_DAYS): StaleDraft[] {
  const cutoff = now - staleDays * DAY_MS;
  const out: StaleDraft[] = [];
  for (const row of rows) {
    const updated = timestamp(row.updatedAt);
    // A row without a readable timestamp is left alone: guessing would put it in the wrong place.
    if (updated === null || updated > cutoff) continue;
    out.push({
      label: titleOf(row) || row.id,
      href: `/content/articles/${encodeURIComponent(row.id)}`,
      updatedAt: new Date(updated).toISOString(),
    });
  }
  return out.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** The plugin: register the section and return no other export. */
export default (ctx: PluginContext) => {
  const section: BriefingSectionDefinition = {
    id: SECTION_ID,
    compute: async () => {
      const page = (await ctx.items.list('articles', {
        status: 'draft',
        sort: ['updatedAt'],
        limit: PAGE_SIZE,
      })) as { data?: DraftRow[] } | null;
      const rows = Array.isArray(page?.data) ? page.data : [];
      const stale = staleDrafts(rows, Date.now());
      return {
        count: stale.length,
        items: stale.slice(0, MAX_ITEMS).map(({ label, href }) => ({ label, href })),
      };
    },
  };
  ctx.extensionPoints.register('briefing-sections', section);
  return {};
};
