import { describe, expect, it } from 'vitest';
import { SiteIdentitySchema, SiteSeoSettingsSchema, type SiteIdentity } from '@heopress/contracts/schemas';
import { decideIndexing, jsonLdText, structuredData, type JsonLdGraph, type StructuredDataInput } from '../index';

/**
 * The page's JSON-LD graph (tasks 2.4, 2.12; spec seo/page-metadata "结构化数据规则", "站点身份", "关联结构化数据图"):
 * stable @ids, nothing made up, a page not indexed describes the site only.
 */
const HOME = 'https://example.com/';
const settings = SiteSeoSettingsSchema.parse({});
const indexable = decideIndexing({ settings, pageType: 'item', collection: 'articles' });
const identity = (over: Record<string, unknown>): SiteIdentity => SiteIdentitySchema.parse(over);
const nodes = (g: JsonLdGraph | null) => g!['@graph'];
const node = (g: JsonLdGraph | null, type: string) => nodes(g).find((n) => n['@type'] === type);
const article = (over: Partial<StructuredDataInput> = {}): StructuredDataInput => ({
  pageType: 'item',
  indexing: indexable,
  siteName: 'Example',
  homeUrl: HOME,
  locale: 'en',
  identity: null,
  siteType: 'blog',
  page: { url: 'https://example.com/hello/', title: 'Hello', description: 'An excerpt', publishedAt: '2026-10-01T00:00:00.000Z', modifiedAt: '2026-10-02T00:00:00.000Z', collection: 'articles' },
  ...over,
});

describe('site identity (task 2.12)', () => {
  it('a person with a name and two profiles: a Person node with its name and sameAs — no logo, no contact details', () => {
    const g = structuredData(article({ pageType: 'home', page: { url: HOME, title: 'Example' }, identity: identity({ kind: 'person', name: 'Sam Example', sameAs: ['https://social.example.com/sam', 'https://code.example.com/sam'] }) }));
    expect(node(g, 'Person')).toEqual({
      '@type': 'Person',
      '@id': 'https://example.com/#identity',
      name: 'Sam Example',
      url: HOME,
      sameAs: ['https://social.example.com/sam', 'https://code.example.com/sam'],
    });
    expect(node(g, 'Organization')).toBeUndefined();
    // The home: WebSite and the identity, the page about it.
    expect(node(g, 'WebSite')).toMatchObject({ '@id': 'https://example.com/#website', publisher: { '@id': 'https://example.com/#identity' } });
    expect(node(g, 'WebPage')).toMatchObject({ about: { '@id': 'https://example.com/#identity' } });
  });

  it('an organisation: logo, contact details and address as filled in', () => {
    const g = structuredData(
      article({
        identity: identity({
          kind: 'organization', name: 'Example Ltd', logo: 'https://example.com/logo.png', email: 'press@example.com', telephone: '+44 20 0000 0000',
          address: { streetAddress: '1 High St', addressLocality: 'London', addressCountry: 'gb' },
        }),
      }),
    );
    expect(node(g, 'Organization')).toEqual({
      '@type': 'Organization',
      '@id': 'https://example.com/#identity',
      name: 'Example Ltd',
      url: HOME,
      logo: { '@type': 'ImageObject', url: 'https://example.com/logo.png' },
      email: 'press@example.com',
      telephone: '+44 20 0000 0000',
      address: { '@type': 'PostalAddress', streetAddress: '1 High St', addressLocality: 'London', addressCountry: 'GB' },
    });
    expect(node(g, 'BlogPosting')).toMatchObject({ publisher: { '@id': 'https://example.com/#identity' } });
  });

  it('a local business with only its name: a LocalBusiness node and nothing else made up', () => {
    const g = structuredData(article({ identity: identity({ kind: 'local_business', name: 'Corner Café' }) }));
    expect(node(g, 'LocalBusiness')).toEqual({ '@type': 'LocalBusiness', '@id': 'https://example.com/#identity', name: 'Corner Café', url: HOME });
  });

  it('no identity set: no identity node, no publisher, no author made up', () => {
    const g = structuredData(article());
    expect(nodes(g).map((n) => n['@type'])).toEqual(['WebSite', 'WebPage', 'BlogPosting']);
    expect(node(g, 'WebSite')).not.toHaveProperty('publisher');
    expect(node(g, 'BlogPosting')).not.toHaveProperty('publisher');
    expect(node(g, 'BlogPosting')).not.toHaveProperty('author');
  });

  it('one identity across a site\'s languages: it hangs from the origin, the WebSite from the language\'s home', () => {
    const g = structuredData(article({ homeUrl: 'https://example.com/ja/', locale: 'ja', identity: identity({ kind: 'organization', name: 'Example' }) }));
    expect(node(g, 'Organization')!['@id']).toBe('https://example.com/#identity');
    expect(node(g, 'WebSite')!['@id']).toBe('https://example.com/ja/#website');
  });

  it('one identity under every language strategy: subdirectory, subdomain, own domain (Codex review of batch 5a)', () => {
    const org = identity({ kind: 'organization', name: 'Example' });
    for (const homeUrl of ['https://example.com/ja/', 'https://ja.example.com/', 'https://example.jp/']) {
      const g = structuredData(article({ homeUrl, siteOrigin: HOME, locale: 'ja', identity: org }));
      expect(node(g, 'Organization'), homeUrl).toMatchObject({ '@id': 'https://example.com/#identity', url: HOME });
      expect(node(g, 'WebSite')!['@id'], homeUrl).toBe(`${homeUrl}#website`);
      expect(node(g, 'WebSite'), homeUrl).toMatchObject({ publisher: { '@id': 'https://example.com/#identity' } });
    }
  });

  it('the profile list holds each address once, however it is spelled', () => {
    const parsed = SiteIdentitySchema.parse({ kind: 'person', name: 'X', sameAs: ['https://Social.Example.com:443', 'https://code.example.com/sam'] });
    expect(parsed.sameAs).toEqual(['https://social.example.com/', 'https://code.example.com/sam']);
    for (const pair of [
      ['https://social.example.com', 'https://SOCIAL.example.com/'],
      ['https://social.example.com/', 'https://social.example.com:443/'],
      ['http://social.example.com/', 'http://social.example.com:80'],
    ]) {
      expect(SiteIdentitySchema.safeParse({ kind: 'person', name: 'X', sameAs: pair }).success, pair.join(' ')).toBe(false);
    }
  });

  it('the contract refuses what it cannot vouch for', () => {
    for (const bad of [
      { kind: 'person', name: '' },
      { kind: 'organization', name: 'X', logo: 'javascript:alert(1)' },
      { kind: 'organization', name: 'X', sameAs: ['https://a.example.com', 'https://a.example.com'] },
      { kind: 'organization', name: 'X', email: 'not an email' },
      { kind: 'organization', name: 'X', telephone: 'call me' },
      { kind: 'organization', name: 'X', address: { addressCountry: 'Germany' } },
      { kind: 'robot', name: 'X' },
    ]) {
      expect(SiteIdentitySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('structured data rules (task 2.4)', () => {
  it('the article type follows the site type', () => {
    for (const [siteType, type] of [['news', 'NewsArticle'], ['blog', 'BlogPosting'], ['docs', 'Article'], [null, 'Article']] as const) {
      expect(nodes(structuredData(article({ siteType }))).map((n) => n['@type']), String(siteType)).toContain(type);
    }
    // A page (not an article): a WebPage only.
    expect(nodes(structuredData(article({ page: { url: 'https://example.com/about/', title: 'About', collection: 'pages' } }))).map((n) => n['@type'])).toEqual(['WebSite', 'WebPage']);
  });

  it('a list page (category, tag, author) is a CollectionPage with its breadcrumb, and has no article', () => {
    const g = structuredData(
      article({
        pageType: 'taxonomy',
        indexing: decideIndexing({ settings, pageType: 'taxonomy', collection: 'categories' }),
        page: { url: 'https://example.com/category/news/', title: 'News', collection: 'categories' },
        breadcrumb: [{ name: 'Example', url: HOME }, { name: 'News', url: 'https://example.com/category/news/' }],
      }),
    );
    expect(nodes(g).map((n) => n['@type'])).toEqual(['WebSite', 'CollectionPage', 'BreadcrumbList']);
    expect(node(g, 'CollectionPage')).not.toHaveProperty('datePublished');
  });

  it('a page not indexed describes the site only: identity and WebSite', () => {
    const noindex = decideIndexing({ settings, pageType: 'item', itemRobots: 'noindex,follow' });
    const g = structuredData(article({ indexing: noindex, identity: identity({ kind: 'organization', name: 'Example' }) }));
    expect(nodes(g).map((n) => n['@type'])).toEqual(['Organization', 'WebSite']);
    // Search and error pages likewise.
    for (const pageType of ['search', 'error'] as const) {
      expect(nodes(structuredData(article({ pageType, indexing: decideIndexing({ settings, pageType }) }))).map((n) => n['@type'])).toEqual(['WebSite']);
    }
  });

  it('a breadcrumb of two or more steps; the article names its author and is the page\'s main entity', () => {
    const g = structuredData(
      article({
        breadcrumb: [
          { name: 'Example', url: HOME },
          { name: 'News', url: 'https://example.com/category/news/' },
          { name: 'Hello', url: 'https://example.com/hello/' },
        ],
        author: { name: 'Ada', url: 'https://example.com/author/ada/' },
      }),
    );
    expect(node(g, 'BreadcrumbList')).toEqual({
      '@type': 'BreadcrumbList',
      '@id': 'https://example.com/hello/#breadcrumb',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Example', item: HOME },
        { '@type': 'ListItem', position: 2, name: 'News', item: 'https://example.com/category/news/' },
        { '@type': 'ListItem', position: 3, name: 'Hello', item: 'https://example.com/hello/' },
      ],
    });
    expect(node(g, 'WebPage')).toMatchObject({ breadcrumb: { '@id': 'https://example.com/hello/#breadcrumb' } });
    expect(node(g, 'BlogPosting')).toMatchObject({
      author: { '@type': 'Person', name: 'Ada', url: 'https://example.com/author/ada/' },
      mainEntityOfPage: { '@id': 'https://example.com/hello/#webpage' },
      datePublished: '2026-10-01T00:00:00.000Z',
      dateModified: '2026-10-02T00:00:00.000Z',
    });
    // One step is no breadcrumb.
    expect(node(structuredData(article({ breadcrumb: [{ name: 'Example', url: HOME }] })), 'BreadcrumbList')).toBeUndefined();
    // A personal site's articles are its person's.
    expect(node(structuredData(article({ identity: identity({ kind: 'person', name: 'Sam' }) })), 'BlogPosting')).toMatchObject({ author: { '@id': 'https://example.com/#identity' } });
  });

  it('the primary image is one node, referred to by the page and the article (Codex review of batch 5a)', () => {
    const g = structuredData(article({ page: { ...article().page!, image: 'https://example.com/hello.png' } }));
    const images = nodes(g).filter((n) => n['@type'] === 'ImageObject');
    expect(images).toEqual([{ '@type': 'ImageObject', '@id': 'https://example.com/hello/#primaryimage', url: 'https://example.com/hello.png', contentUrl: 'https://example.com/hello.png' }]);
    expect(node(g, 'WebPage')).toMatchObject({ primaryImageOfPage: { '@id': 'https://example.com/hello/#primaryimage' } });
    expect(node(g, 'BlogPosting')).toMatchObject({ image: { '@id': 'https://example.com/hello/#primaryimage' } });
    // Every reference in the graph names a node of the graph.
    const ids = new Set(nodes(g).map((n) => n['@id']));
    const refs = JSON.stringify(g).match(/"@id":"[^"]+"/g)!.map((r) => r.slice(7, -1));
    expect(refs.every((r) => ids.has(r))).toBe(true);
  });

  it('every @id is stable: the same page gives the same graph', () => {
    expect(JSON.stringify(structuredData(article()))).toBe(JSON.stringify(structuredData(article())));
    expect(nodes(structuredData(article())).every((n) => typeof n['@id'] === 'string' && n['@id'].startsWith('https://example.com/'))).toBe(true);
  });

  it('no graph without an absolute home (no identifiers to hang it from)', () => {
    expect(structuredData(article({ homeUrl: '/' }))).toBeNull();
  });

  it('the script text cannot end the script or the document', () => {
    const g = structuredData(article({ page: { url: 'https://example.com/x/', title: '</script><script>alert(1)</script> & \u2028', collection: 'articles' } }))!;
    const text = jsonLdText(g);
    expect(text).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(text)).toEqual(g);
  });

  it('FAQPage only from the explicit questions and answers; a heading ending in a question mark makes none', () => {
    // Body text with question-mark headings, no questions field: no FAQPage.
    const plain = structuredData(article({ page: { ...article().page!, title: 'Why is the sky blue?', description: 'What is Rayleigh scattering?' } }));
    expect(node(plain, 'FAQPage')).toBeUndefined();
    // The explicit field: one FAQPage, each pair a Question with its Answer, empty pairs left out.
    const g = structuredData(article({ faq: [{ question: ' Why  blue? ', answer: 'Rayleigh scattering.' }, { question: 'No answer?', answer: '  ' }, { question: '', answer: 'No question.' }] }));
    expect(node(g, 'FAQPage')).toEqual({
      '@type': 'FAQPage',
      '@id': 'https://example.com/hello/#faq',
      isPartOf: { '@id': 'https://example.com/hello/#webpage' },
      inLanguage: 'en',
      mainEntity: [{ '@type': 'Question', name: 'Why blue?', acceptedAnswer: { '@type': 'Answer', text: 'Rayleigh scattering.' } }],
    });
    // At most fifty; none on a page that is not indexed; none on a list page.
    const many = Array.from({ length: 60 }, (_, i) => ({ question: `Q${i}?`, answer: `A${i}` }));
    expect((node(structuredData(article({ faq: many })), 'FAQPage')!.mainEntity as unknown[]).length).toBe(50);
    expect(node(structuredData(article({ faq: many, indexing: decideIndexing({ settings, pageType: 'item', itemRobots: 'noindex,follow' }) })), 'FAQPage')).toBeUndefined();
    expect(node(structuredData(article({ faq: many, pageType: 'taxonomy', indexing: decideIndexing({ settings, pageType: 'taxonomy', collection: 'tags' }) })), 'FAQPage')).toBeUndefined();
  });

  it('a personal site\'s home: Person and WebSite, the page about the person; the same home not indexed: Person and WebSite only', () => {
    const person = identity({ kind: 'person', name: 'Sam Example', sameAs: ['https://social.example.com/sam'] });
    const home = { pageType: 'home' as const, page: { url: HOME, title: 'Example' }, identity: person };
    const indexed = structuredData(article({ ...home, indexing: decideIndexing({ settings, pageType: 'home' }) }));
    expect(nodes(indexed).map((n) => n['@type'])).toEqual(['Person', 'WebSite', 'WebPage']);
    expect(node(indexed, 'WebPage')).toMatchObject({ about: { '@id': 'https://example.com/#identity' } });
    const closed = SiteSeoSettingsSchema.parse({ index: { pageTypes: { home: false } } });
    const hidden = structuredData(article({ ...home, indexing: decideIndexing({ settings: closed, pageType: 'home' }) }));
    expect(nodes(hidden).map((n) => n['@type'])).toEqual(['Person', 'WebSite']);
  });
});
