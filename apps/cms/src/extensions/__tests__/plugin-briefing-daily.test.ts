/**
 * The official daily-briefing plugin (HeoPress v1.1, backlog P12; spec extensions/briefing-sections "官方日报插件"):
 * the manifest is a valid declaration of exactly two read-only sections, and each `compute` counts and links honestly
 * under the UTC day/Monday boundaries the plugin documents.
 *
 * The plugin is not a workspace package, so this suite drives its source with a fake `PluginContext` — the same shape
 * the host passes — instead of building it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { briefingSectionsOf, contentDeclarationIssues, templateSourceProblems } from '@heopress/contracts/extensions';
import { ExtensionManifestSchema } from '@heopress/contracts/schemas';
import daily, {
  COLLECTION,
  draftsUntouchedSince,
  MAX_ITEMS,
  PAGE_SIZE,
  publishedOn,
  TODAY_SECTION_ID,
  WEEK_SECTION_ID,
  type BriefingRow,
} from '../../../../../examples/plugin-briefing-daily/src/index';

/** One registered section, as the plugin hands it to the host. */
interface Section {
  id: string;
  compute(): Promise<{ count: number; items: Array<{ label: string; href: string }> }>;
}

/** A fake context: one list answer per `status`, and the sections the plugin registers. */
function fakeContext(pages: Record<string, BriefingRow[]>) {
  const registered: Section[] = [];
  const list = vi.fn(async (_collection: string, params?: Record<string, unknown>) => {
    const status = String(params?.status ?? '');
    return { data: pages[status] ?? [], meta: { limit: PAGE_SIZE, offset: 0 } };
  });
  const ctx = {
    items: { list },
    extensionPoints: { register: (point: string, section: Section) => {
      expect(point).toBe('briefing-sections');
      registered.push(section);
    } },
  };
  daily(ctx as never);
  const section = (id: string) => {
    const found = registered.find((s) => s.id === id);
    if (!found) throw new Error(`section ${id} was not registered`);
    return found;
  };
  return { ctx, list, section };
}

const row = (id: string, over: Partial<BriefingRow> = {}): BriefingRow => ({ id, ...over });

describe('daily briefing plugin: the manifest', () => {
  it('is the official plugin, declaring two read-only sections and its public briefing collection and routes', () => {
    const path = fileURLToPath(new URL('../../../../../examples/plugin-briefing-daily/heopress-extension.json', import.meta.url));
    const parsed = ExtensionManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    expect(parsed.name).toBe('heopress-briefing-daily');
    expect(parsed.displayName).toBe('Daily briefing');
    expect([...parsed.capabilities].sort()).toEqual(['ext:briefing-sections', 'ext:collections', 'ext:routes', 'items:read:articles']);
    expect(briefingSectionsOf(parsed)).toEqual([
      { id: 'today', title: 'Today', description: 'Articles published today (UTC)' },
      { id: 'week', title: 'This week', description: 'Drafts not updated since Monday (UTC)' },
    ]);
    // The public half (HeoPress v1.1 P12): its own collection, a list and an item route, templates for both engines.
    expect(parsed.collections).toEqual([
      expect.objectContaining({
        name: 'briefings',
        fields: expect.arrayContaining([
          expect.objectContaining({ name: 'title', type: 'string', interface: 'input' }),
          expect.objectContaining({ name: 'slug', type: 'string', interface: 'slug' }),
          expect.objectContaining({ name: 'body', type: 'text', interface: 'wysiwyg' }),
          expect.objectContaining({ name: 'briefing_date', type: 'datetime', interface: 'datetime' }),
          expect.objectContaining({ name: 'period', type: 'string', interface: 'input' }),
        ]),
      }),
    ]);
    expect(parsed.routes).toEqual([
      expect.objectContaining({ id: 'briefing', kind: 'item', path: '/briefing/:slug', collection: 'briefings', template: 'briefing' }),
      expect.objectContaining({ id: 'briefing-index', kind: 'list', path: '/briefing', collection: 'briefings', template: 'index', title: 'Briefing', pageSize: 20 }),
    ]);
    expect(Object.keys(parsed.templates?.classic ?? {}).sort()).toEqual(['briefing', 'index']);
    expect(Object.keys(parsed.templates?.astro ?? {}).sort()).toEqual(['briefing', 'index']);
    // The declarations are internally valid: routes name the plugin's collection and a template both engines have;
    // the Astro item template places the system head and no script; the Classic ones place `{% seo_head %}` and the
    // item template `{% item_body %}`.
    const declarations = { collections: parsed.collections, routes: parsed.routes, templates: parsed.templates, components: parsed.components };
    expect(contentDeclarationIssues(parsed.name, declarations, parsed.capabilities)).toEqual([]);
    expect(templateSourceProblems(parsed.templates!.classic.briefing!, 'classic', false)).toEqual([]);
    expect(templateSourceProblems(parsed.templates!.astro.briefing!, 'astro', false)).toEqual([]);
    // Read-only: the plugin never writes, publishes, fetches or holds a secret.
    expect(parsed.capabilities.filter((c) => /^(items:(write|publish)|http:|secrets:)/.test(c))).toEqual([]);
  });
});

describe('daily briefing plugin: Today', () => {
  afterEach(() => vi.useRealTimers());

  it("counts the articles published today (UTC) and links each to its editor", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') });
    const { section, list } = fakeContext({
      published: [
        row('morning', { title: 'Morning story', publishedAt: '2026-11-10T09:00:00.000Z' }),
        row('later', { title: 'Later story', publishedAt: '2026-11-10T11:30:00.000Z' }),
        row('yesterday', { title: 'Yesterday story', publishedAt: '2026-11-09T23:59:59.000Z' }),
        row('tomorrow', { title: 'Scheduled', publishedAt: '2026-11-11T00:00:00.000Z' }),
        row('no-date', { title: 'No publish date' }),
        row('untitled', { publishedAt: '2026-11-10T08:00:00.000Z' }),
      ],
    });
    expect(await section(TODAY_SECTION_ID).compute()).toEqual({
      count: 3,
      items: [
        { label: 'Later story', href: '/content/articles/later' },
        { label: 'Morning story', href: '/content/articles/morning' },
        { label: 'untitled', href: '/content/articles/untitled' },
      ],
    });
    expect(list).toHaveBeenCalledWith(COLLECTION, {
      status: 'published',
      sort: ['-updated_at'],
      limit: PAGE_SIZE,
      withTotal: false,
    });
  });

  it('caps the links at ten while the count stays the full number of hits', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') });
    const rows = Array.from({ length: 13 }, (_, i) =>
      row(`a${i}`, { title: `Story ${i}`, publishedAt: `2026-11-10T${String(i).padStart(2, '0')}:00:00.000Z` }),
    );
    const result = await fakeContext({ published: rows }).section(TODAY_SECTION_ID).compute();
    expect(result.count).toBe(13);
    expect(result.items).toHaveLength(MAX_ITEMS);
  });

  it('keeps the href inside the site and escapes the id', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') });
    const { section } = fakeContext({ published: [row('a 1/2', { title: 'Odd id', publishedAt: '2026-11-10T09:00:00.000Z' })] });
    expect((await section(TODAY_SECTION_ID).compute()).items).toEqual([
      { label: 'Odd id', href: '/content/articles/a%201%2F2' },
    ]);
  });

  it('answers an empty section when nothing was published today', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') });
    const result = await fakeContext({ published: [row('old', { title: 'Old', publishedAt: '2026-11-01T09:00:00.000Z' })] })
      .section(TODAY_SECTION_ID)
      .compute();
    expect(result).toEqual({ count: 0, items: [] });
  });
});

describe('daily briefing plugin: This week', () => {
  afterEach(() => vi.useRealTimers());

  it('counts the drafts untouched since Monday (UTC), oldest first', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') }); // a Tuesday; the week starts 2026-11-09.
    const { section, list } = fakeContext({
      draft: [
        row('last-week', { title: 'Last week', updatedAt: '2026-11-08T23:59:59.000Z' }),
        row('older', { title: 'Older', updatedAt: '2026-11-02T09:00:00.000Z' }),
        row('monday', { title: 'Updated Monday', updatedAt: '2026-11-09T00:00:00.000Z' }),
        row('today', { title: 'Updated today', updatedAt: '2026-11-10T10:00:00.000Z' }),
        row('no-date', { title: 'No update date' }),
      ],
    });
    expect(await section(WEEK_SECTION_ID).compute()).toEqual({
      count: 2,
      items: [
        { label: 'Older', href: '/content/articles/older' },
        { label: 'Last week', href: '/content/articles/last-week' },
      ],
    });
    expect(list).toHaveBeenCalledWith(COLLECTION, {
      status: 'draft',
      sort: ['updated_at'],
      limit: PAGE_SIZE,
      withTotal: false,
    });
  });

  it('answers an empty section when every draft moved this week', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-10T12:00:00Z') });
    const result = await fakeContext({ draft: [row('fresh', { title: 'Fresh', updatedAt: '2026-11-10T10:00:00.000Z' })] })
      .section(WEEK_SECTION_ID)
      .compute();
    expect(result).toEqual({ count: 0, items: [] });
  });
});

describe('daily briefing plugin: the pure judgements', () => {
  it('never guesses a row without a timestamp into a section', () => {
    const rows = [row('a', { updatedAt: 'not-a-date' }), row('b', { updatedAt: 123 as never })];
    expect(publishedOn(rows, Date.parse('2026-11-10T12:00:00Z'))).toEqual([]);
    expect(draftsUntouchedSince(rows, Date.parse('2026-11-10T12:00:00Z'))).toEqual([]);
  });

  it('uses UTC boundaries at midnight and Monday', () => {
    const due = [row('midnight', { publishedAt: '2026-11-10T00:00:00.000Z' })];
    expect(publishedOn(due, Date.parse('2026-11-10T00:00:00Z'))).toHaveLength(1);
    expect(publishedOn(due, Date.parse('2026-11-09T23:59:59Z'))).toHaveLength(0);
    // Sunday 2026-11-08 is before the Monday 2026-11-09 week start; Monday 00:00 is not.
    const week = [row('sunday', { updatedAt: '2026-11-08T23:59:59.000Z' }), row('monday', { updatedAt: '2026-11-09T00:00:00.000Z' })];
    expect(draftsUntouchedSince(week, Date.parse('2026-11-10T12:00:00Z')).map((e) => e.label)).toEqual(['sunday']);
  });
});
