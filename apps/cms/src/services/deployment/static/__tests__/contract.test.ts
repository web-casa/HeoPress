import { describe, expect, it } from 'vitest';
import type { PageDataPage, PageDataSnapshot } from '@heopress/contracts/page-data';
import { CF_HEADER_RULES, renderContract, staticContractOf, STATIC_PLATFORMS, SUPPORT_MATRIX } from '../contract';

/** The static target response contract and the support matrix (HeoPress P11 task 4.4). */

const page = (path: string, noindex = false): PageDataPage => ({
  path,
  status: 200,
  vm: { page: { type: 'item', path } } as never,
  headHtml: noindex ? '<meta name="robots" content="noindex,follow">' : '<link rel="canonical" href="x">',
  bodies: {},
  disclosureRequired: false,
  disclosures: {},
  xRobotsTag: noindex ? 'noindex, follow' : null,
});

function snapshot(copies = 2): PageDataSnapshot {
  return {
    version: 1,
    siteId: 'site_a',
    revision: 7,
    host: 'www.example.com',
    origin: 'https://www.example.com',
    name: 'A',
    defaultLanguage: 'en',
    pages: [page('/'), page('/moon/'), page('/members/', true)],
    notFound: null,
    files: [
      { path: '/feed.xml', contentType: 'application/rss+xml; charset=utf-8', body: '', headers: {} },
      { path: '/robots.txt', contentType: 'text/plain; charset=utf-8', body: '', headers: {} },
      ...Array.from({ length: copies }, (_, i) => ({
        path: `/a${i}.md`,
        contentType: 'text/markdown; charset=utf-8',
        body: '',
        headers: { 'x-robots-tag': 'noindex', link: `<https://www.example.com/a${i}/>; rel="canonical"` },
      })),
    ],
    routes: [
      { path: '/old-moon/', status: 301, location: 'https://www.example.com/moon/' },
      { path: '/withdrawn/', status: 410 },
    ],
    unsupported: ['search', 'list-pagination', 'preview', 'ai-traffic'],
  };
}

const file = (r: ReturnType<typeof renderContract>, name: string) => r.files.find((f) => f.path === name)?.body ?? '';

describe('static response contract', () => {
  const contract = staticContractOf(snapshot());

  it('collects types, noindex, Markdown canonical, 301 and 410 from the snapshot', () => {
    expect(contract.redirects).toEqual([{ path: '/old-moon/', location: 'https://www.example.com/moon/' }]);
    expect(contract.gone).toEqual(['/withdrawn/']);
    expect(contract.headers).toContainEqual(expect.objectContaining({ path: '/members/', headers: [['X-Robots-Tag', 'noindex, follow']] }));
    expect(contract.headers).toContainEqual({ path: '/a0.md', headers: [['Content-Type', 'text/markdown; charset=utf-8'], ['X-Robots-Tag', 'noindex'], ['Link', '<https://www.example.com/a0/>; rel="canonical"']] });
  });

  it('Netlify: _headers folds shared headers by extension; _redirects answers 301 and 410', () => {
    const r = renderContract('netlify', contract);
    expect(r.errors).toEqual([]);
    expect(file(r, '_headers')).toContain('/*.md\n  Content-Type: text/markdown; charset=utf-8\n  X-Robots-Tag: noindex');
    expect(file(r, '_headers')).toContain('/a1.md\n  Link: <https://www.example.com/a1/>; rel="canonical"');
    expect(file(r, '_headers')).toContain('/feed.xml\n  Content-Type: application/rss+xml; charset=utf-8');
    expect(file(r, '_redirects')).toBe('/old-moon/ https://www.example.com/moon/ 301!\n/withdrawn/ /404.html 410!\n');
  });

  it('Cloudflare Pages: 410 is not expressible — answered 404 and said so', () => {
    const r = renderContract('cloudflare-pages', contract);
    expect(file(r, '_redirects')).toBe('/old-moon/ https://www.example.com/moon/ 301\n');
    expect(r.warnings.join(' ')).toMatch(/answer 404, not 410/);
    expect(SUPPORT_MATRIX['cloudflare-pages']['gone-410'].support).toBe('degraded');
  });

  it('Cloudflare Pages: past 100 header rules, Link headers go first (warned), never the content types', () => {
    const r = renderContract('cloudflare-pages', staticContractOf(snapshot(CF_HEADER_RULES + 20)));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/without their canonical Link header/);
    const headers = file(r, '_headers');
    expect(headers).toContain('/*.md\n  Content-Type: text/markdown; charset=utf-8\n  X-Robots-Tag: noindex');
    expect(headers.split('\n\n').length).toBeLessThanOrEqual(CF_HEADER_RULES);
  });

  it('Cloudflare Pages: more than 2000 redirects is refused', () => {
    const many = { ...contract, redirects: Array.from({ length: 2001 }, (_, i) => ({ path: `/r${i}/`, location: '/' })) };
    expect(renderContract('cloudflare-pages', many).errors.join(' ')).toMatch(/2001 redirects/);
  });

  it('Vercel: header routes continue, then 301 and 410, then the file system and the not-found page', () => {
    const r = renderContract('vercel', contract);
    const cfg = JSON.parse(file(r, 'vercel.json')) as { routes: Array<Record<string, unknown>> };
    expect(cfg.routes).toContainEqual({ src: '^/old-moon/$', status: 301, headers: { Location: 'https://www.example.com/moon/' } });
    expect(cfg.routes).toContainEqual({ src: '^/withdrawn/$', status: 410, dest: '/404.html' });
    expect(cfg.routes).toContainEqual(expect.objectContaining({ src: '^/members/$', headers: { 'X-Robots-Tag': 'noindex, follow' }, continue: true }));
    const fs = cfg.routes.findIndex((x) => x['handle'] === 'filesystem');
    expect(fs).toBeGreaterThan(cfg.routes.findIndex((x) => x['status'] === 410));
  });

  it('VPS: a Caddy snippet with the same answers', () => {
    const body = file(renderContract('vps', contract), 'Caddyfile.static');
    expect(body).toContain('redir /old-moon/ https://www.example.com/moon/ 301');
    expect(body).toContain('respond /withdrawn/ 410');
    expect(body).toContain('X-Robots-Tag "noindex, follow"');
  });

  it('the matrix: search, preview and analytics are unavailable on every static target', () => {
    for (const p of STATIC_PLATFORMS) for (const f of ['search', 'preview', 'analytics'] as const) expect(SUPPORT_MATRIX[p][f].support).toBe('no');
  });
});
