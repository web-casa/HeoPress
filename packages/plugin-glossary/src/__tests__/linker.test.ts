import { describe, expect, it } from 'vitest';
import { citationVerdict } from '../citation';
import { LINK_MARKER, linkTerms, termHref, tooltipOf, unlinkTerms, type GlossaryTerm } from '../linker';

const term = (slug: string, title: string, over: Partial<GlossaryTerm> = {}): GlossaryTerm => ({
  id: `id_${slug}`,
  slug,
  title,
  aliases: [],
  definition: `${title} defined.`,
  locale: '',
  ...over,
});
const opts = { hrefOf: (t: GlossaryTerm) => `/glossary/${t.slug}/`, maxLinks: 20, locale: 'en' };
const hrefs = (html: string) => [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);

describe('linkTerms', () => {
  it('links the first occurrence of each term, whole words only, with the definition as the tooltip', () => {
    const { html, linked } = linkTerms('<p>An API is not a rapid thing. The API again.</p>', [term('api', 'API'), term('rapid', 'rap')], opts);
    expect(html).toBe(`<p>An <a href="/glossary/api/" title="API defined." ${LINK_MARKER}="api">API</a> is not a rapid thing. The API again.</p>`);
    expect(linked.map((t) => t.slug)).toEqual(['api']);
  });

  it('prefers the longest term, matches aliases case-insensitively and keeps the text as written', () => {
    const { html, linked } = linkTerms('<p>Use a rest api or an Application Programming Interface.</p>', [
      term('api', 'API', { aliases: ['application programming interface'] }),
      term('rest-api', 'REST API'),
    ], opts);
    expect(hrefs(html)).toEqual(['/glossary/rest-api/', '/glossary/api/']);
    expect(html).toContain('>rest api</a>');
    expect(html).toContain('>Application Programming Interface</a>');
    expect(linked.map((t) => t.slug)).toEqual(['rest-api', 'api']);
  });

  it('never links inside links, code, preformatted text or headings', () => {
    const body = '<h2>API</h2><p><a href="https://example.com/">API docs</a> <code>API</code></p><pre>API</pre><p>The API.</p>';
    const { html } = linkTerms(body, [term('api', 'API')], opts);
    expect(hrefs(html)).toEqual(['https://example.com/', '/glossary/api/']);
    expect(html).toContain('<h2>API</h2>');
    expect(html).toContain('<code>API</code>');
  });

  it('matches terms of unspaced scripts inside words', () => {
    const { html } = linkTerms('<p>这是一个应用程序接口的例子。</p>', [term('jiekou', '接口', { locale: 'zh-CN' })], { ...opts, locale: 'zh-CN' });
    expect(hrefs(html)).toEqual(['/glossary/jiekou/']);
  });

  it('links only terms of the body\'s language (or without one) and at most maxLinks', () => {
    const terms = [term('a', 'alpha', { locale: 'fr' }), term('b', 'beta'), term('c', 'gamma')];
    expect(linkTerms('<p>alpha beta gamma</p>', terms, opts).linked.map((t) => t.slug)).toEqual(['b', 'c']);
    expect(linkTerms('<p>alpha beta gamma</p>', terms, { ...opts, maxLinks: 1 }).linked.map((t) => t.slug)).toEqual(['b']);
  });

  it('is idempotent and removes its own stale links (a term gone, a definition changed), leaving others', () => {
    const first = linkTerms('<p>An API and a <a href="/x/">link</a>.</p>', [term('api', 'API')], opts).html;
    expect(linkTerms(first, [term('api', 'API')], opts).html).toBe(first);
    const changed = linkTerms(first, [term('api', 'API', { definition: 'New meaning.' })], opts).html;
    expect(changed).toContain('title="New meaning."');
    const gone = linkTerms(first, [], opts);
    expect(gone.html).toBe('<p>An API and a <a href="/x/">link</a>.</p>');
    expect(unlinkTerms(first)).toBe(gone.html);
  });

  it('escapes the href and tooltip, and handles terms with markup characters', () => {
    const { html } = linkTerms('<p>R&amp;D matters.</p>', [term('r-and-d', 'R&D', { definition: 'Research "and" <b>development</b> & 5 > 4' })], opts);
    // The definition is text: markup in it is dropped, the rest escaped.
    expect(html).toContain('title="Research &quot;and&quot; development &amp; 5 &gt; 4"');
    expect(html).toContain('>R&amp;D</a>');
  });
});

describe('termHref and tooltipOf', () => {
  it('adds the language prefix and the trailing slash the site uses', () => {
    const site = { localePrefixes: { fr: '/fr/' }, trailingSlash: true };
    expect(termHref({ slug: 'alpha', locale: '' }, site)).toBe('/glossary/alpha/');
    expect(termHref({ slug: 'alpha', locale: 'fr' }, site)).toBe('/fr/glossary/alpha/');
    expect(termHref({ slug: 'alpha', locale: 'fr' }, { localePrefixes: { fr: 'javascript:x' }, trailingSlash: false })).toBe('/glossary/alpha');
  });
  it('keeps the tooltip to one short line', () => {
    expect(tooltipOf({ title: 'T', definition: '' })).toBe('T');
    expect(tooltipOf({ title: 'T', definition: 'a\n  b' })).toBe('a b');
    expect(tooltipOf({ title: 'T', definition: 'x'.repeat(300) })).toHaveLength(200);
  });
});

describe('citationVerdict', () => {
  it('a definition without an http(s) source needs review', () => {
    expect(citationVerdict({}).verdict).toBe('needs_review');
    expect(citationVerdict({ source_url: '  ' })).toMatchObject({ verdict: 'needs_review', evidence: { missing: 'source_url' } });
    expect(citationVerdict({ source_url: 'javascript:alert(1)' })).toMatchObject({ verdict: 'needs_review', evidence: { invalid: 'source_url' } });
    expect(citationVerdict({ source_url: 'https://example.com/source', source_title: 'Source' })).toEqual({
      verdict: 'passed',
      evidence: { source: 'https://example.com/source', title: 'Source' },
    });
  });
});
