import { describe, expect, it } from 'vitest';
import { SiteIdentitySchema, SiteSeoSettingsSchema } from '@heopress/contracts/schemas';
import {
  decideIndexing,
  contributionFragment,
  itemStructuredData,
  jsonLdText,
  materializeContribution,
  materializedNodes,
  structuredDataReport,
  validContributions,
  type JsonLdGraph,
  type MaterializedNode,
  type StructuredDataContribution,
  type StructuredDataInput,
} from '../index';

/**
 * Contributed structured data and the final check (tasks 2.9, 2.10; spec seo/page-metadata "关联结构化数据图"): an
 * item's own JSON-LD and extensions' contributions merged into the one graph, the core deciding identifiers and owners,
 * conflicts reported once and never duplicated, nothing contributed on a page that is not indexable.
 */
const URL_ = 'https://example.com/hello/';
const settings = SiteSeoSettingsSchema.parse({});
const indexable = decideIndexing({ settings, pageType: 'item', collection: 'articles' });
const notIndexable = decideIndexing({ settings, pageType: 'item', collection: 'articles', itemRobots: 'noindex,follow' });
const page = (contributed: MaterializedNode[], over: Partial<StructuredDataInput> = {}): StructuredDataInput => ({
  pageType: 'item',
  indexing: indexable,
  siteName: 'Example',
  homeUrl: 'https://example.com/',
  locale: 'en',
  identity: SiteIdentitySchema.parse({ kind: 'organization', name: 'Example Ltd' }),
  siteType: 'blog',
  page: { url: URL_, title: 'Hello', collection: 'articles' },
  contributed,
  ...over,
});
const ids = (g: JsonLdGraph | null) => g!['@graph'].map((n) => n['@id']);
const byId = (g: JsonLdGraph | null, id: string) => g!['@graph'].find((n) => n['@id'] === id);

describe("an item's own structured data (task 2.9)", () => {
  it('scenario 附加自定义活动数据: an Event with an @id is one node of the one graph, and the page refers to it', () => {
    const { nodes, diagnostics } = itemStructuredData(
      JSON.stringify({ '@context': 'https://schema.org', '@type': 'Event', '@id': '#event', name: 'Launch', startDate: '2026-11-01T10:00:00Z', location: { '@type': 'Place', name: 'Hall' } }),
      URL_,
    );
    expect(diagnostics).toEqual([]);
    expect(nodes).toEqual([{ source: 'item', owner: 'page', fragment: 'event', node: { '@type': 'Event', name: 'Launch', startDate: '2026-11-01T10:00:00Z', location: { '@type': 'Place', name: 'Hall' } } }]);
    const { graph, diagnostics: final } = structuredDataReport(page(nodes));
    expect(final).toEqual([]);
    expect(graph!['@context']).toBe('https://schema.org');
    expect(byId(graph, `${URL_}#event`)).toMatchObject({ '@type': 'Event', name: 'Launch' });
    expect(byId(graph, `${URL_}#webpage`)).toMatchObject({ about: [{ '@id': `${URL_}#event` }] });
    // One graph: every node once.
    expect(new Set(ids(graph)).size).toBe(ids(graph).length);
    expect(jsonLdText(graph!).match(/"@context"/g)).toHaveLength(1);
  });

  it('a list, an @graph document, the page address with a fragment and no @id at all', () => {
    const graphDoc = itemStructuredData(JSON.stringify({ '@context': 'https://schema.org/', '@graph': [{ '@type': 'Event', '@id': `${URL_}#a` }, { '@type': 'Place' }] }), URL_);
    expect(graphDoc.nodes.map((n) => n.fragment)).toEqual(['a', 'custom-2']);
    const list = itemStructuredData(JSON.stringify([{ '@type': 'Product', name: 'X' }]), URL_);
    expect(list.nodes).toHaveLength(1);
    expect(list.diagnostics).toEqual([]);
  });

  it('refused with a diagnostic: not JSON, another vocabulary, a reserved type, another address, a fragment of the system, a fragment twice', () => {
    expect(itemStructuredData('{nope', URL_).diagnostics.map((d) => d.code)).toEqual(['invalid-json']);
    expect(itemStructuredData(JSON.stringify({ '@context': 'https://vocab.example.com/', '@type': 'Event' }), URL_).nodes).toEqual([]);
    const r = itemStructuredData(
      JSON.stringify([
        { '@type': 'WebPage', name: 'second page' },
        { '@type': 'Organization', '@id': 'https://example.com/#identity', description: 'claims the site' },
        { '@type': 'Event', '@id': '#article' },
        { '@type': 'Event', '@id': '#ext-seo-x' },
        { '@type': 'Event', '@id': '#e' },
        { '@type': 'Event', '@id': '#e' },
        { name: 'no type' },
      ]),
      URL_,
    );
    expect(r.nodes.map((n) => n.fragment)).toEqual(['e']);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['reserved-type', 'foreign-id', 'id-conflict', 'id-conflict', 'id-conflict', 'invalid-node']);
    expect(r.diagnostics.every((d) => d.source === 'item')).toBe(true);
  });

  it('syntax limits: keywords, non-names, embedded identifiers, deep nesting and size are removed or refused', () => {
    const r = itemStructuredData(
      JSON.stringify({
        '@type': 'Event',
        '@reverse': { x: 1 },
        '$field': 'body',
        'bad key': 1,
        organizer: { '@type': 'Organization', '@id': 'https://example.com/#identity', name: 'Org' },
        location: { '@id': '#venue' },
        deep: { a: { b: { c: { d: { e: { f: { g: { h: { i: 'too deep' } } } } } } } } },
      }),
      URL_,
    );
    expect(r.nodes[0]!.node).toEqual({ '@type': 'Event', organizer: { '@type': 'Organization', name: 'Org' }, location: { '@id': '#venue' } });
    // Past the depth limit nothing is left of the nested value: it is removed whole.
    expect(r.diagnostics.map((d) => d.message)).toContain('node 1.deep.a.b.c.d.e.f.g.h (nested too deep) removed');
    expect(r.diagnostics.every((d) => d.code === 'removed-property')).toBe(true);
    expect(itemStructuredData(JSON.stringify({ '@type': 'Event', name: 'x'.repeat(17_000) }), URL_).diagnostics.map((d) => d.code)).toEqual(['too-large']);
  });
});

describe('extension contributions (task 2.9)', () => {
  const event: StructuredDataContribution = { key: 'event', scope: 'item', collections: ['articles'], node: { '@type': 'Event', name: { $field: 'title' }, '@id': 'https://elsewhere.example.com/#x' } };

  it('the contract: invalid contributions are refused, each with a diagnostic', () => {
    const { contributions, diagnostics } = validContributions('seo-x', [
      event,
      { key: 'event', scope: 'item', node: { '@type': 'Event' } },
      { key: 'Bad', scope: 'item', node: { '@type': 'Event' } },
      { key: 'page', scope: 'site', node: { '@type': 'WebPage' } },
      { key: 'big', scope: 'site', node: { '@type': 'Thing', text: 'x'.repeat(5000) } },
      { key: 'where', scope: 'everywhere', node: { '@type': 'Thing' } },
      { key: 'typeless', scope: 'site', node: { name: 'x' } },
    ]);
    expect(contributions.map((c) => c.key)).toEqual(['event']);
    expect(diagnostics.map((d) => d.code)).toEqual(['invalid-contribution', 'invalid-contribution', 'reserved-type', 'too-large', 'invalid-contribution', 'invalid-contribution']);
    expect(validContributions('seo-x', 'nope').diagnostics).toHaveLength(1);
  });

  it('fragments: distinct for distinct extensions and keys, and readable back at the longest keys', () => {
    expect(contributionFragment('a', 'b-c')).not.toBe(contributionFragment('a-b', 'c'));
    expect(contributionFragment('seo_x', 'k')).not.toBe(contributionFragment('seo-x', 'k'));
    expect(contributionFragment('p'.repeat(41), 'k')).not.toBe(contributionFragment(`${'p'.repeat(40)}q`, 'k'));
    // Two keys whose 32-bit FNV-1a tags collide (Codex review of batch 5c): the tag is 128 bits of SHA-256 now.
    expect(contributionFragment('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaarvisveja', 'org')).not.toBe(contributionFragment('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaayxaabfda', 'org'));
    const long = materializeContribution('e'.repeat(60), { key: 'k'.repeat(40), scope: 'item', node: { '@type': 'Event' } }, 'fp', {});
    expect(materializedNodes([long.node])).toHaveLength(1);
  });

  it('the size limit holds with the item\'s values in place', () => {
    const big: StructuredDataContribution = { key: 'big', scope: 'item', node: { '@type': 'Event', a: { $field: 'body' }, b: { $field: 'body' } } };
    const m = materializeContribution('seo-x', big, 'fp', { body: 'x'.repeat(5000) });
    expect(m.node).toBeNull();
    expect(m.diagnostics.map((d) => d.code)).toEqual(['too-large']);
  });

  it("an item node takes the item's public fields; the core assigns its identifier", () => {
    const { node } = materializeContribution('seo-x', event, 'fp1', { title: 'Launch' });
    expect(node).toEqual({ source: 'extension:seo-x', owner: 'page', fragment: 'ext-seo-x_event', node: { '@type': 'Event', name: 'Launch' }, itemFields: ['name'], fingerprint: 'fp1' });
    const g = structuredDataReport(page([node!])).graph;
    expect(byId(g, `${URL_}#ext-seo-x_event`)).toMatchObject({ '@type': 'Event', name: 'Launch' });
  });

  it('scenario 贡献方夹带正文: a node claiming the site cannot take an item\'s body — removed, with a diagnostic', () => {
    const site: StructuredDataContribution = { key: 'org', scope: 'site', node: { '@type': 'Organization', name: 'Partner', description: { $field: 'body' } } };
    const m = materializeContribution('seo-x', site, 'fp', { body: 'SECRET BODY' });
    expect(m.node!.node).toEqual({ '@type': 'Organization', name: 'Partner' });
    expect(m.diagnostics.map((d) => d.code)).toEqual(['site-node-item-field']);
    // Also when a stored site node says it carries an item's value (the final check, whatever the projection holds).
    const forged: MaterializedNode = { source: 'extension:seo-x', owner: 'site', fragment: 'ext-seo-x_org', node: { '@type': 'Organization', name: 'Partner', description: 'SECRET BODY' }, itemFields: ['description'] };
    const r = structuredDataReport(page([forged]));
    expect(JSON.stringify(r.graph)).not.toContain('SECRET BODY');
    expect(byId(r.graph, 'https://example.com/#ext-seo-x_org')).toEqual({ '@id': 'https://example.com/#ext-seo-x_org', '@type': 'Organization', name: 'Partner' });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['site-node-item-field']);
    // A site node is the site's, not the page's: the page does not refer to it.
    expect(byId(r.graph, `${URL_}#webpage`)!.about).toBeUndefined();
  });
});

describe('the final check (task 2.10)', () => {
  const ev = (fragment: string, node: Record<string, unknown> = {}, source = 'item'): MaterializedNode => ({ source, owner: 'page', fragment, node: { '@type': 'Event', ...node } });

  it('scenario 不可收录页面: nothing contributed — only the identity and the WebSite, each removal reported', () => {
    const r = structuredDataReport(page([ev('event'), { source: 'extension:x', owner: 'site', fragment: 'ext-x_org', node: { '@type': 'Organization' } }], { indexing: notIndexable }));
    expect(r.graph!['@graph'].map((n) => n['@type'])).toEqual(['Organization', 'WebSite']);
    expect(ids(r.graph)).toEqual(['https://example.com/#identity', 'https://example.com/#website']);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['ineligible-node', 'ineligible-node']);
  });

  it('type and identifier conflicts are reported and never duplicated', () => {
    const r = structuredDataReport(
      page([
        ev('event'),
        ev('event', { name: 'again' }, 'extension:x'),
        { source: 'extension:x', owner: 'page', fragment: 'ext-x_post', node: { '@type': 'BlogPosting', headline: 'second article' } },
        { source: 'item', owner: 'page', fragment: 'webpage', node: { '@type': 'Thing' } },
        { source: 'item', owner: 'site', fragment: 'identity', node: { '@type': 'Organization' } },
      ]),
    );
    expect(ids(r.graph).filter((id) => id === `${URL_}#event`)).toHaveLength(1);
    expect(byId(r.graph, `${URL_}#event`)!.name).toBeUndefined();
    expect(r.graph!['@graph'].filter((n) => n['@type'] === 'BlogPosting')).toHaveLength(1);
    expect(r.graph!['@graph'].filter((n) => n['@type'] === 'Organization')).toHaveLength(1);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['id-conflict', 'reserved-type', 'id-conflict', 'id-conflict']);
    expect(new Set(ids(r.graph)).size).toBe(ids(r.graph).length);
  });

  it('a site node is never an article (each article page has its own); the kept entries are exactly what the graph holds, a duplicate once', () => {
    const site = (fragment: string, type: string): MaterializedNode => ({ source: 'extension:x', owner: 'site', fragment, node: { '@type': type } });
    const onPage = structuredDataReport(page([site('ext-x_post', 'BlogPosting'), site('ext-x_org', 'Organization'), site('ext-x_org', 'Organization')], { page: { url: 'https://example.com/about/', title: 'About', collection: 'pages' } }));
    expect(onPage.diagnostics.map((d) => d.code)).toEqual(['reserved-type', 'id-conflict']);
    expect(onPage.kept).toHaveLength(1);
    expect(onPage.kept[0]!.fragment).toBe('ext-x_org');
    // Conflicting entries take none of the size budget: the valid one after them is kept.
    const big = (i: number): MaterializedNode => ({ source: 'extension:x', owner: 'page', fragment: `ext-x_p${i}`, node: { '@type': 'BlogPosting', text: 'x'.repeat(7800) } });
    const r = structuredDataReport(page([...Array.from({ length: 9 }, (_, i) => big(i)), ev('event')]));
    expect(r.kept.map((n) => n.fragment)).toEqual(['event']);
  });

  it('the article kind is one type: no second article of another subtype on a page that has its own', () => {
    const news = structuredDataReport(page([ev('related', {}), { source: 'item', owner: 'page', fragment: 'rel', node: { '@type': 'Article' } }, { source: 'item', owner: 'page', fragment: 'tech', node: { '@type': 'TechArticle' } }], { siteType: 'news' }));
    expect(news.graph!['@graph'].filter((n) => n['@type'] === 'NewsArticle')).toHaveLength(1);
    expect(news.kept.map((n) => n.fragment)).toEqual(['related']);
    expect(news.diagnostics.map((d) => d.code)).toEqual(['reserved-type', 'reserved-type']);
    // A page without an article of its own (a page, not an article) may carry one.
    const plain = structuredDataReport(page([{ source: 'item', owner: 'page', fragment: 'rel', node: { '@type': 'Article' } }], { page: { url: 'https://example.com/about/', title: 'About', collection: 'pages' } }));
    expect(plain.kept).toHaveLength(1);
    // One only: a second contributed article, of any subtype and from any source, is a conflict.
    const two = structuredDataReport(
      page(
        [
          { source: 'item', owner: 'page', fragment: 'one', node: { '@type': 'Article' } },
          { source: 'extension:x', owner: 'page', fragment: 'ext-x_two', node: { '@type': 'TechArticle' } },
          { source: 'item', owner: 'page', fragment: 'three', node: { '@type': ['NewsArticle', 'Thing'] } },
        ],
        { page: { url: 'https://example.com/about/', title: 'About', collection: 'pages' } },
      ),
    );
    expect(two.kept.map((n) => n.fragment)).toEqual(['one']);
    expect(two.diagnostics.map((d) => d.code)).toEqual(['reserved-type', 'reserved-type']);
  });

  it("the page's nodes and the site's each have their own size budget", () => {
    const pageNode = (i: number): MaterializedNode => ({ source: 'item', owner: 'page', fragment: `p${i}`, node: { '@type': 'Event', text: 'x'.repeat(15_000) } });
    const siteNode: MaterializedNode = { source: 'extension:x', owner: 'site', fragment: 'ext-x_org', node: { '@type': 'Organization', text: 'y'.repeat(15_000) } };
    const r = structuredDataReport(page([...Array.from({ length: 5 }, (_, i) => pageNode(i)), siteNode]));
    expect(r.kept.map((n) => n.fragment)).toEqual(['p0', 'p1', 'p2', 'p3', 'ext-x_org']);
    expect(r.diagnostics.map((d) => d.code)).toEqual(['too-large']);
  });

  it('a site node names only the identity and other site nodes — the same on every page of every language; kept as output', () => {
    const org: MaterializedNode = {
      source: 'extension:x',
      owner: 'site',
      fragment: 'ext-x_org',
      node: { '@type': 'Organization', parentOrganization: { '@id': 'https://example.com/#identity' }, member: { '@id': '#ext-x_person' }, mainEntityOfPage: { '@id': 'https://example.com/#website' }, subjectOf: { '@id': `${URL_}#event` } },
    };
    const person: MaterializedNode = { source: 'extension:x', owner: 'site', fragment: 'ext-x_person', node: { '@type': 'Person', name: 'P' } };
    const en = structuredDataReport(page([ev('event'), org, person]));
    const ja = structuredDataReport(page([ev('event'), org, person], { homeUrl: 'https://example.com/ja/', page: { url: 'https://example.com/ja/hello/', title: 'Hello', collection: 'articles' } }));
    const orgOf = (r: typeof en) => r.graph!['@graph'].find((n) => n['@id'] === 'https://example.com/#ext-x_org');
    expect(orgOf(en)).toEqual(orgOf(ja));
    expect(orgOf(en)).toEqual({ '@id': 'https://example.com/#ext-x_org', '@type': 'Organization', parentOrganization: { '@id': 'https://example.com/#identity' }, member: { '@id': 'https://example.com/#ext-x_person' } });
    expect(en.diagnostics.filter((d) => d.node === 'ext-x_org').map((d) => d.code)).toEqual(['dangling-reference', 'dangling-reference']);
    // Kept as output: stored, it passes the check again unchanged.
    const keptOrg = en.kept.find((n) => n.fragment === 'ext-x_org')!;
    // References into the site are stored relative: on another host of the site they name that host's nodes.
    expect(keptOrg.node).toEqual({ '@type': 'Organization', parentOrganization: { '@id': '#identity' }, member: { '@id': '#ext-x_person' } });
    const again = structuredDataReport(page(en.kept));
    expect(again.diagnostics).toEqual([]);
    const alias = structuredDataReport(page(en.kept, { homeUrl: 'https://www.example.com/', page: { url: 'https://www.example.com/hello/', title: 'Hello', collection: 'articles' } }));
    expect(alias.graph!['@graph'].find((n) => n['@id'] === 'https://www.example.com/#ext-x_org')).toEqual({
      '@id': 'https://www.example.com/#ext-x_org', '@type': 'Organization', parentOrganization: { '@id': 'https://www.example.com/#identity' }, member: { '@id': 'https://www.example.com/#ext-x_person' },
    });
    // A language domain of the site is the site too: its WebSite is no target for a site node; a partner's node is.
    const lang = structuredDataReport(
      page([{ source: 'extension:x', owner: 'site', fragment: 'ext-x_org', node: { '@type': 'Organization', subjectOf: { '@id': 'https://ja.example.com/#website' }, partner: { '@id': 'https://partner.example.org/#org' } } }], { siteHosts: ['example.com', 'ja.example.com'] }),
    );
    expect(lang.kept[0]!.node).toEqual({ '@type': 'Organization', partner: { '@id': 'https://partner.example.org/#org' } });
    // A node of a page of the site is not the root's (no retargeting by fragment), and host spellings are one host.
    const spelled = structuredDataReport(
      page(
        [
          {
            source: 'extension:x',
            owner: 'site',
            fragment: 'ext-x_org',
            node: {
              '@type': 'Organization',
              member: { '@id': 'https://example.com/people/#identity' },
              a: { '@id': 'https://JA.example.com./#website' },
              b: { '@id': 'https://example.com/?q=1#identity' },
              c: { '@id': 'https://EXAMPLE.com./#identity' },
              // Another scheme or port of a site host: not the site's root as it serves it — removed, never retargeted.
              d: { '@id': 'https://example.com:8443/#identity' },
              e: { '@id': 'http://example.com/#identity' },
            },
          },
        ],
        { siteHosts: ['example.com', 'ja.example.com'] },
      ),
    );
    expect(spelled.kept[0]!.node).toEqual({ '@type': 'Organization', c: { '@id': '#identity' } });
    expect(spelled.diagnostics.map((d) => d.code)).toEqual(Array(5).fill('dangling-reference'));
  });

  it('references to removed or missing nodes are removed with a diagnostic; others stay', () => {
    const r = structuredDataReport(
      page([
        { source: 'item', owner: 'page', fragment: 'post', node: { '@type': 'BlogPosting' } },
        ev('event', {
          location: { '@id': '#venue' },
          superEvent: [{ '@id': '#post' }, { '@id': '#festival' }],
          organizer: { '@id': 'https://example.com/#identity' },
          sameAs: 'https://elsewhere.example.com/launch',
          about: { '@id': 'https://elsewhere.example.com/#thing' },
        }),
        ev('festival'),
      ]),
    );
    const e = byId(r.graph, `${URL_}#event`)!;
    expect(e.location).toBeUndefined();
    expect(e.superEvent).toEqual([{ '@id': `${URL_}#festival` }]);
    expect(e.organizer).toEqual({ '@id': 'https://example.com/#identity' });
    expect(e.about).toEqual({ '@id': 'https://elsewhere.example.com/#thing' });
    expect(r.diagnostics.map((d) => d.code)).toEqual(['reserved-type', 'dangling-reference', 'dangling-reference']);
    // The page refers to what it carries only.
    expect(byId(r.graph, `${URL_}#webpage`)!.about).toEqual([{ '@id': `${URL_}#event` }, { '@id': `${URL_}#festival` }]);
  });

  it("without an identity the site's identity is no reference target", () => {
    const r = structuredDataReport(page([ev('event', { organizer: { '@id': 'https://example.com/#identity' } })], { identity: null }));
    expect(byId(r.graph, `${URL_}#event`)!.organizer).toBeUndefined();
    expect(r.diagnostics.map((d) => d.code)).toEqual(['dangling-reference']);
  });
});
