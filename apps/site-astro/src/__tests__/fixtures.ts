import type { PageDataPage, PageDataSnapshot } from '@heopress/contracts/page-data';
import type { ThemeViewModel } from '@heopress/contracts/theme';

const ORIGIN = 'https://blog.example.com';

function vm(over: Partial<ThemeViewModel> & { page: ThemeViewModel['page'] }): ThemeViewModel {
  return {
    site: { name: 'Example Blog', locale: 'en', locales: ['en'], homeUrl: `${ORIGIN}/` },
    item: null,
    list: [],
    pagination: null,
    alternates: [],
    nav: [{ label: 'Example Blog', url: `${ORIGIN}/` }],
    seo: { title: '', description: '', canonical: null, robots: null },
    ...over,
  };
}

const head = (title: string, canonical: string) =>
  `<title>${title}</title><link rel="canonical" href="${canonical}"><link rel="alternate" hreflang="en" href="${canonical}"><script type="application/ld+json">{"@context":"https://schema.org","@graph":[]}</script>`;

/** A small site: a home listing a sponsored and a plain article, the two articles, a 404, robots.txt and llms.txt. */
export function sampleSnapshot(opts: { disclosure?: boolean; revision?: number } = {}): PageDataSnapshot {
  const disclosureRequired = opts.disclosure ?? true;
  const disclosures = { a1: 'Sponsored by Acme' };
  const cards = [
    { id: 'a1', title: 'Garden tools', excerpt: '', url: `${ORIGIN}/garden-tools/`, publishedAt: '2026-10-02T00:00:00.000Z', sponsored: true },
    { id: 'a2', title: 'Heron notes', excerpt: '', url: `${ORIGIN}/heron-notes/`, publishedAt: '2026-10-01T00:00:00.000Z', sponsored: false },
  ];
  const item = (id: string, title: string, sponsored: boolean): PageDataPage => ({
    path: `/${title.toLowerCase().replace(/ /g, '-')}/`,
    status: 200,
    vm: vm({
      page: { type: 'item', locale: 'en', path: `/${title.toLowerCase().replace(/ /g, '-')}/`, status: 200, query: null },
      item: { id, collection: 'articles', title, url: `${ORIGIN}/${title.toLowerCase().replace(/ /g, '-')}/`, locale: 'en', publishedAt: '2026-10-01T00:00:00.000Z', fields: {}, sponsor: { sponsored, name: sponsored ? 'Acme' : null } },
    }),
    headHtml: head(title, `${ORIGIN}/${title.toLowerCase().replace(/ /g, '-')}/`),
    bodies: { [id]: sponsored ? '<p>Buy <a href="https://acme.example.com/" rel="sponsored">tools</a>.</p>' : '<p>Herons.</p>' },
    disclosureRequired,
    disclosures: sponsored ? disclosures : {},
    xRobotsTag: null,
  });
  return {
    version: 1,
    siteId: 'site_astro_fixture',
    revision: opts.revision ?? 7,
    host: 'blog.example.com',
    origin: ORIGIN,
    name: 'Example Blog',
    defaultLanguage: 'en',
    pages: [
      {
        path: '/',
        status: 200,
        vm: vm({ page: { type: 'home', locale: 'en', path: '/', status: 200, query: null }, list: cards }),
        headHtml: head('Example Blog', `${ORIGIN}/`),
        bodies: {},
        disclosureRequired,
        disclosures,
        xRobotsTag: null,
      },
      item('a1', 'Garden tools', true),
      item('a2', 'Heron notes', false),
    ],
    notFound: {
      path: '/404.html',
      status: 404,
      vm: vm({ page: { type: 'error', locale: 'en', path: '/', status: 404, query: null } }),
      headHtml: '<title>404 | Example Blog</title><meta name="robots" content="noindex">',
      bodies: {},
      disclosureRequired,
      disclosures: {},
      xRobotsTag: null,
    },
    files: [
      { path: '/robots.txt', contentType: 'text/plain; charset=utf-8', body: `User-agent: *\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, headers: {} },
      { path: '/llms.txt', contentType: 'text/plain; charset=utf-8', body: '# Example Blog\n', headers: {} },
      { path: '/garden-tools.md', contentType: 'text/markdown; charset=utf-8', body: '# Garden tools\n', headers: { 'x-robots-tag': 'noindex' } },
    ],
    unsupported: ['search', 'list-pagination', 'preview', 'ai-traffic'],
  };
}
