import type { PageDataFile, PageDataPage, PageDataSnapshot } from '@heopress/contracts/page-data';

/** Shared fixture of the Markdown negotiation tests (v1.2 P11 task 4.5): one site with negotiable and non-negotiable pages. */

export const HOST = 'www.example.com';

const page = (path: string, noindex = false): PageDataPage => ({
  path,
  status: 200,
  vm: { page: { type: 'item', path } } as never,
  headHtml: noindex ? '<meta name="robots" content="noindex,follow">' : `<link rel="canonical" href="https://${HOST}${path}">`,
  bodies: {},
  disclosureRequired: false,
  disclosures: {},
  xRobotsTag: noindex ? 'noindex, follow' : null,
});

const copy = (path: string, canonical = path): PageDataFile => ({
  path: `${path.replace(/\/$/, '')}.md`,
  contentType: 'text/markdown; charset=utf-8',
  body: `# ${path}`,
  headers: { 'x-robots-tag': 'noindex', link: `<https://${HOST}${canonical}>; rel="canonical"` },
});

export function snapshot(discovery: PageDataSnapshot['discovery'] = { markdownCopies: true, markdownNegotiation: true }): PageDataSnapshot {
  return {
    version: 1,
    siteId: 'site_a',
    revision: 7,
    host: HOST,
    origin: `https://${HOST}`,
    name: 'A',
    defaultLanguage: 'en',
    pages: [page('/'), page('/moon/'), page('/about/'), page('/members/', true), page('/search/')],
    notFound: null,
    files: [
      { path: '/robots.txt', contentType: 'text/plain; charset=utf-8', body: '', headers: {} },
      copy('/moon/'),
      copy('/about/'),
      // A noindex page has no copy in practice; one here proves the rule does not negotiate it.
      copy('/members/'),
      // A copy whose canonical points elsewhere is not the page's own representation.
      copy('/search/', '/elsewhere/'),
    ],
    routes: [],
    discovery,
    unsupported: ['search', 'list-pagination', 'preview', 'ai-traffic'],
  };
}
