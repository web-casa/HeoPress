import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { prefersMarkdown } from '@heopress/site-classic/negotiation';
import { renderContract, staticContractOf, STATIC_PLATFORMS, type RenderedContract, type StaticPlatform } from '../contract';
import { replayEdgeNegotiation, type EdgeReplay } from '../edge-negotiation';
import { snapshot } from './negotiation-fixture';

/**
 * The negotiation replay harness (HeoPress v1.2 P11 task 4.5; spec publishing/static-edge-negotiation): for a platform, an
 * address and an `Accept`, which file the generated rule serves and with which headers. This is what CI can prove about
 * the rule; the platforms' own behaviour is checked after a deploy (see the docs).
 */

const contract = staticContractOf(snapshot());
const rendered = Object.fromEntries(STATIC_PLATFORMS.map((p) => [p, renderContract(p, contract)])) as Record<StaticPlatform, RenderedContract>;

const replay = (platform: StaticPlatform, path: string, accept?: string, method?: 'GET' | 'HEAD'): Promise<EdgeReplay> =>
  replayEdgeNegotiation({ platform, rendered: rendered[platform], path, accept, method });

/** Every target now expresses a rule: two in code (Cloudflare Pages, Netlify), two in configuration (Vercel, VPS). */
const CONFIGURED = ['cloudflare-pages', 'netlify', 'vercel', 'vps'] as const;

describe('the replay harness decides the same way on every target that has a rule', () => {
  it('answers the Markdown copy when the request prefers Markdown', async () => {
    for (const platform of CONFIGURED) {
      const answer = await replay(platform, '/moon/', 'text/markdown');
      expect(answer, platform).toMatchObject({ served: '/moon.md', markdown: true });
      expect(answer.headers).toEqual({
        'Content-Type': 'text/markdown; charset=utf-8',
        'X-Robots-Tag': 'noindex',
        Link: '<https://www.example.com/moon/>; rel="canonical"',
        // The asset server's own Vary (Accept-Encoding) is kept and Accept appended, never replaced.
        Vary: platform === 'cloudflare-pages' || platform === 'netlify' ? 'Accept-Encoding, Accept' : 'Accept',
      });
      expect(answer.by, platform).toBe(platform === 'cloudflare-pages' ? 'worker' : platform === 'netlify' ? 'netlify-function' : platform === 'vercel' ? 'vercel-routes' : 'caddy');
      // The code targets run the generated module, so the body comes from the stub asset server.
      expect(answer.body).toBe(platform === 'cloudflare-pages' || platform === 'netlify' ? 'asset' : null);
    }
  });

  it('answers the page itself for a browser, a wildcard, an absent header and a text wildcard — and still says Vary', async () => {
    const accepts = ['text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8', 'text/html', '*/*', 'text/*', undefined];
    for (const platform of CONFIGURED) {
      for (const accept of accepts) {
        const answer = await replay(platform, '/moon/', accept);
        expect(answer, `${platform} ${String(accept)}`).toMatchObject({ served: '/moon/index.html', markdown: false });
        expect(answer.headers['Vary']?.split(',').map((v) => v.trim())).toContain('Accept');
        expect(answer.headers['Link']).toBeUndefined();
      }
    }
  });

  it('serves the page at an address that does not negotiate', async () => {
    for (const platform of CONFIGURED) {
      expect(await replay(platform, '/search/', 'text/markdown')).toMatchObject({ served: '/search/index.html', markdown: false });
      expect(await replay(platform, '/members/', 'text/markdown')).toMatchObject({ served: '/members/index.html', markdown: false });
    }
  });

  it('leaves a direct request for the copy alone', async () => {
    for (const platform of CONFIGURED) {
      expect(await replay(platform, '/moon.md', 'text/markdown')).toMatchObject({ served: '/moon.md', markdown: false });
    }
  });

  it('answers a HEAD request with the same file and headers, and no body', async () => {
    for (const platform of ['cloudflare-pages', 'netlify'] as const) {
      const get = await replay(platform, '/moon/', 'text/markdown', 'GET');
      const head = await replay(platform, '/moon/', 'text/markdown', 'HEAD');
      expect(head, platform).toMatchObject({ served: '/moon.md', markdown: true, headers: get.headers });
      expect(head.body, platform).toBe('');
      expect(get.body, platform).toBe('asset');
    }
  });

  it('refuses Markdown when the request refuses it, on every target', async () => {
    for (const platform of CONFIGURED) {
      expect(await replay(platform, '/moon/', 'text/markdown;q=0'), platform).toMatchObject({ served: '/moon/index.html', markdown: false });
      expect(await replay(platform, '/moon/', 'text/markdown;q=0.000, application/json'), platform).toMatchObject({ served: '/moon/index.html', markdown: false });
    }
  });
});

describe('where the targets differ, by design', () => {
  it('a header naming both types is HTML in configuration, Markdown only where code runs', async () => {
    // The runtime: q(markdown)=0.9 > q(html)=0.5, so Markdown. vercel.json and Caddy can only match the text.
    const accept = 'text/markdown;q=0.9, text/html;q=0.5';
    expect(prefersMarkdown(accept)).toBe(true);
    for (const platform of ['cloudflare-pages', 'netlify'] as const) {
      expect(await replay(platform, '/moon/', accept), platform).toMatchObject({ served: '/moon.md', markdown: true });
    }
    for (const platform of ['vercel', 'vps'] as const) {
      expect(await replay(platform, '/moon/', accept), platform).toMatchObject({ served: '/moon/index.html', markdown: false });
    }
  });

  it('a wildcard next to Markdown is HTML everywhere (the runtime ties, the configuration sees an HTML range)', async () => {
    const accept = 'text/markdown, */*';
    expect(prefersMarkdown(accept)).toBe(false);
    for (const platform of CONFIGURED) expect(await replay(platform, '/moon/', accept), platform).toMatchObject({ served: '/moon/index.html', markdown: false });
  });

  it('the generated code is the runtime rule: same answer for every generated Accept', async () => {
    await fc.assert(
      fc.asyncProperty(acceptHeader(), async (accept) => {
        for (const platform of ['cloudflare-pages', 'netlify'] as const) {
          const answer = await replay(platform, '/moon/', accept);
          expect(answer.markdown, `${platform}: ${accept}`).toBe(prefersMarkdown(accept));
        }
      }),
      { numRuns: 150 },
    );
  });

  it('configuration answers Markdown only where the runtime does, over well-formed headers', async () => {
    await fc.assert(
      fc.asyncProperty(wellFormedHeader(), async (accept) => {
        for (const platform of ['vercel', 'vps'] as const) {
          const answer = await replay(platform, '/moon/', accept);
          if (answer.markdown) expect(prefersMarkdown(accept), `${platform}: ${accept}`).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe('Netlify: the declaration is part of the rule', () => {
  const clone = (): RenderedContract => ({ ...rendered.netlify, files: rendered.netlify.files.map((f) => ({ ...f })) });
  const none = { served: '/moon/index.html', markdown: false, by: 'none', headers: {}, body: null };

  it('reports no rule when the generated netlify.toml is missing', async () => {
    const without = clone();
    without.files = without.files.filter((f) => f.path !== 'netlify.toml');
    expect(await replayEdgeNegotiation({ platform: 'netlify', rendered: without, path: '/moon/', accept: 'text/markdown' })).toEqual(none);
  });

  it('reports no rule when netlify.toml does not route this function on /*', async () => {
    const wrong = clone();
    wrong.files = wrong.files.map((f) => (f.path === 'netlify.toml' ? { ...f, body: f.body.replace('path = "/*"', 'path = "/blog/*"') } : f));
    expect(await replayEdgeNegotiation({ platform: 'netlify', rendered: wrong, path: '/moon/', accept: 'text/markdown' })).toEqual(none);
    const renamed = clone();
    renamed.files = renamed.files.map((f) => (f.path === 'netlify.toml' ? { ...f, body: f.body.replace('function = "negotiate"', 'function = "other"') } : f));
    expect(await replayEdgeNegotiation({ platform: 'netlify', rendered: renamed, path: '/moon/', accept: 'text/markdown' })).toEqual(none);
  });

  it('reports no rule when the site has nothing to negotiate', async () => {
    const off = renderContract('netlify', staticContractOf(snapshot({ markdownCopies: true, markdownNegotiation: false })));
    expect(await replayEdgeNegotiation({ platform: 'netlify', rendered: off, path: '/moon/', accept: 'text/markdown' })).toEqual(none);
  });
});

/** Accept headers of well-formed ranges and q-values (the subset property's domain). */
function wellFormedHeader(): fc.Arbitrary<string> {
  return fc
    .array(
      fc
        .tuple(fc.constantFrom('text/html', 'text/markdown', 'text/*', '*/*', 'application/json', 'image/webp'), fc.constantFrom('', ';q=0', ';q=0.1', ';q=0.5', ';q=1'))
        .map(([media, q]) => `${media}${q}`),
      { maxLength: 4 },
    )
    .map((ranges) => ranges.join(', '));
}

/** Accept headers built from real media ranges, q-values and junk (the worker must survive all of them). */
function acceptHeader(): fc.Arbitrary<string> {
  const range = fc
    .tuple(
      fc.constantFrom('text/html', 'text/markdown', 'text/*', '*/*', 'application/json', 'TEXT/MARKDOWN', 'text/markdown;', 'nonsense', ''),
      fc.constantFrom('', ';q=0', ';q=0.5', ';q=1', ';q=1.000', ';q=0.75', ';q=0.1234', ';q=abc', ';q="0.5"', ';level=1'),
    )
    .map(([media, q]) => `${media}${q}`);
  return fc.array(range, { maxLength: 4 }).map((parts) => parts.join(', '));
}
