import { describe, expect, it } from 'vitest';
import { detectFormat, parseCsv, parseRedirectImport, toPath } from '../services/site-network/redirect-import-parse';

/**
 * Reading redirect exports (HeoPress P05 tasks 1.7, 1.8; spec
 * content/site-network-model "批量导入重定向", "WordPress 导出中的正则规则").
 * The samples follow the documented shapes of each plugin's export; they are
 * written for these tests, not copied from any plugin. A record becomes a
 * rule only when the rule does what the plugin did.
 */

const HOSTS = { site: new Set(['example.com', 'www.example.com']), languageEntries: new Set(['zh.example.com']) };
const parse = (content: string, format?: Parameters<typeof parseRedirectImport>[2]) => {
  const out = parseRedirectImport(content, HOSTS, format);
  if ('error' in out) throw new Error(out.error);
  return out;
};
const json = (redirects: unknown[]) => JSON.stringify({ redirects });

describe('CSV', () => {
  it('quoted fields, doubled quotes, commas and line breaks inside quotes; CRLF, CR, a BOM; lines counted on every break', () => {
    const parsed = parseCsv('﻿a,"b,c","d ""e"""\r\n"multi\nline",x\r\n\r\n"cr\rbreak",y\rz,w\n');
    if (!('rows' in parsed)) throw new Error(parsed.error);
    expect(parsed.rows.map((r) => r.cells)).toEqual([
      ['a', 'b,c', 'd "e"'],
      ['multi\nline', 'x'],
      ['cr\rbreak', 'y'],
      ['z', 'w'],
    ]);
    expect(parsed.rows.map((r) => r.line)).toEqual([1, 2, 5, 7]);
  });

  it('a quote left open, or text after a closing quote, makes the file unreadable — never a rule', () => {
    expect(parseCsv('/a,"/b\n/c,/d\n')).toEqual({ error: 'a quote opened on line 1 is never closed' });
    expect(parseCsv('/a,"/b"x\n')).toEqual({ error: 'text after a closing quote on line 1' });
    expect(parseCsv('/a,/b"c\n')).toEqual({ error: 'a quote inside an unquoted field on line 1' });
    expect(parseRedirectImport('/a,"/b\n', HOSTS)).toEqual({ error: 'a quote opened on line 1 is never closed' });
  });
});

describe('paths', () => {
  it('the primary domain and aliases only, no query, decoded, no trailing slash, requestable length', () => {
    expect(toPath('https://www.example.com/old/', HOSTS)).toEqual({ ok: true, path: '/old' });
    expect(toPath('/%E5%85%B3%E4%BA%8E/', HOSTS)).toEqual({ ok: true, path: '/关于' });
    expect(toPath('old-page', HOSTS)).toEqual({ ok: true, path: '/old-page' });
    expect(toPath('/', HOSTS)).toEqual({ ok: true, path: '/' });
    expect(toPath('https://other.example.org/x', HOSTS)).toMatchObject({ ok: false });
    // A language entry domain's paths are another language's: not folded into a plain path.
    expect(toPath('https://zh.example.com/b', HOSTS)).toMatchObject({ ok: false, reason: expect.stringContaining('language entry domain') });
    expect(toPath('/a?b=1', HOSTS)).toMatchObject({ ok: false, reason: 'has a query or fragment' });
    expect(toPath('/%E0%A4%A', HOSTS)).toMatchObject({ ok: false });
    expect(toPath('/a/../b', HOSTS)).toMatchObject({ ok: false });
    expect(toPath(`/${'a'.repeat(2040)}`, HOSTS)).toMatchObject({ ok: false, reason: 'too long to be requested' });
    expect(toPath('/a\uD800b', HOSTS)).toMatchObject({ ok: false, reason: 'not valid text (a broken character)' });
  });
});

describe('formats', () => {
  it('plain CSV: from,to[,type] with or without a header; /* is a prefix; an unknown type is for a person', () => {
    const out = parse('from,to,type\n/blog,/,prefix\n/foo,/bar\n/old/*,/new\n/x,/y,regex\n');
    expect(out.format).toBe('csv');
    expect(out.rules.map((r) => [r.line, r.from, r.to, r.match])).toEqual([
      [2, '/blog', '/', 'prefix'],
      [3, '/foo', '/bar', 'exact'],
      [4, '/old', '/new', 'prefix'],
    ]);
    expect(out.manual).toEqual([{ line: 5, original: '/x,/y,regex', reason: 'unknown type "regex"' }]);
    expect(parse('/a,/b\n').rules).toHaveLength(1);
  });

  it('spec "WordPress 导出中的正则规则": Redirection JSON — plain and the proven regex shapes convert, others are listed with their text', () => {
    const file = json([
      { id: 1, url: '/hello-world/', match_type: 'url', action_type: 'url', action_code: 301, action_data: { url: '/hello/' }, regex: false },
      { id: 2, url: '^/blog/(.*)$', match_type: 'url', action_code: 301, action_data: { url: '/news/$1' }, regex: true },
      { id: 3, url: '^/old-page/?$', match_type: 'url', action_code: 301, action_data: { url: '/new-page/' }, regex: true },
      { id: 4, url: '^/p/(\\d+)/(.*)$', match_type: 'url', action_code: 301, action_data: { url: '/posts/$2-$1' }, regex: true },
      { id: 5, url: '/temp', match_type: 'url', action_code: 302, action_data: { url: '/elsewhere' }, regex: false },
      { id: 6, url: '/gone', match_type: 'url', action_type: 'error', action_code: 410, action_data: '', regex: false },
      { id: 7, url: '/by-login', match_type: 'login', action_code: 301, action_data: { url: '/x' }, regex: false },
    ]);
    expect(detectFormat(file)).toBe('redirection');
    const out = parse(file);
    expect(out.rules.map((r) => [r.line, r.from, r.to, r.match])).toEqual([
      [1, '/hello-world', '/hello', 'exact'],
      [2, '/blog', '/news', 'prefix'],
      [3, '/old-page', '/new-page', 'exact'],
    ]);
    expect(out.manual.map((m) => [m.line, m.reason])).toEqual([
      [4, 'regular expression that is not a plain path or prefix rule'],
      [5, 'status 302: only permanent redirects (301) are imported'],
      [6, 'action "error" is not a redirect to a URL'],
      [7, 'conditional redirect (login)'],
    ]);
    expect(JSON.parse(out.manual[0]!.original)).toMatchObject({ id: 4, url: '^/p/(\\d+)/(.*)$' });
  });

  it('Redirection JSON: switched-off rules and the match_data regex flag are honoured; lossy details are noted; a BOM is fine', () => {
    const file = json([
      { url: '/off', enabled: false, match_type: 'url', action_type: 'url', action_code: 301, action_data: { url: '/x' } },
      { url: '^/new-flag/(.*)$', match_type: 'url', action_type: 'url', action_code: 301, action_data: { url: '/n/$1' }, match_data: { source: { flag_regex: true, flag_query: 'pass' } } },
      { url: '/Case', match_type: 'url', action_type: 'url', action_code: 301, action_data: { url: '/case' }, match_data: { source: { flag_case: true, flag_query: 'pass' } } },
      { url: '/strict', match_type: 'url', action_type: 'url', action_code: 308, action_data: { url: '/s' }, match_data: { source: { flag_trailing: false, flag_query: 'pass' } } },
    ]);
    const out = parse(`﻿${file}`);
    // Case-insensitive matching cannot be kept (here /case would no longer redirect): for a person.
    expect(out.manual.map((m) => [m.line, m.reason])).toEqual([
      [1, 'switched off in the export'],
      [3, 'case-insensitive matching (here a path matches with its exact case only)'],
    ]);
    expect(out.rules.map((r) => [r.from, r.to, r.match])).toEqual([
      ['/new-flag', '/n', 'prefix'],
      ['/strict', '/s', 'exact'],
    ]);
    // Conversions that only widen the match, or keep the query, say so.
    expect(out.rules[1]!.notes).toEqual(['the export matched the trailing slash exactly; here both forms redirect', '308 in the export: answered with 301 here']);
  });

  it('only the two proven regex shapes convert: anchored, segment boundaries on both sides', () => {
    const rx = (url: string, target: string) => json([{ url, match_type: 'url', action_code: 301, action_data: { url: target }, regex: true }]);
    // ^/foo?$ also matches /fo; ^/a(.*)$ maps /abc to /bbc; an unanchored /a/(.*) matches anywhere; . is any character.
    for (const [url, target] of [
      ['^/foo?$', '/bar'],
      ['^/a(.*)$', '/b$1'],
      ['/a/(.*)', '/b/$1'],
      ['^/a/(.*)$', '/b$1'],
      ['^/a.b/(.*)$', '/c/$1'],
      ['^/a/(.*)$', '/$1/x'],
    ] as const) {
      expect(parse(rx(url, target)).rules, `${url} → ${target}`).toEqual([]);
    }
    expect(parse(rx('^/(.*)$', '/new/$1')).rules.map((r) => [r.from, r.to, r.match])).toEqual([['/', '/new', 'prefix']]);
    expect(parse(rx('^/old$', '/new')).rules.map((r) => [r.from, r.match])).toEqual([['/old', 'exact']]);
  });

  it('Redirection CSV, with or without its header (then: source, target, regex, code)', () => {
    const csv = 'source,target,regex,code,type,hits,title,status\n/a,/b,0,301,url,3,,enabled\n"^/c/(.*)",/d/$1,1,301,url,0,,enabled\n/e,/f,0,301,url,0,,disabled\n';
    expect(detectFormat(csv)).toBe('redirection');
    const out = parse(csv);
    expect(out.rules.map((r) => [r.from, r.to, r.match])).toEqual([
      ['/a', '/b', 'exact'],
      ['/c', '/d', 'prefix'],
    ]);
    expect(out.manual.map((m) => m.reason)).toEqual(['switched off in the export']);
    expect(parse('/old,/new,0,301\n', 'redirection').rules.map((r) => [r.line, r.from, r.to])).toEqual([[1, '/old', '/new']]);
  });

  it('Yoast CSV: plain and regex formats', () => {
    const csv = 'Origin,Target,Type,Format\nold,new,301,plain\n^/cat/(.*)$,/topics/$1,301,regex\n^/x(\\d)$,/y,301,regex\nkept,/z,307,plain\n';
    expect(detectFormat(csv)).toBe('yoast');
    const out = parse(csv);
    expect(out.rules.map((r) => [r.from, r.to, r.match])).toEqual([
      ['/old', '/new', 'exact'],
      ['/cat', '/topics', 'prefix'],
    ]);
    expect(out.manual.map((m) => m.line)).toEqual([4, 5]);
  });

  it('Rank Math CSV: exact and the proven regex shapes; start, contains and switched-off rules for a person', () => {
    const csv =
      'id,source,matching,destination,type,status\n1,/old,exact,/new,301,active\n2,/shop/,start,/store,301,active\n3,promo,contains,/sale,301,active\n4,^/tag/(.*)$,regex,/topics/$1,301,active\n5,/off,exact,/x,301,inactive\n';
    expect(detectFormat(csv)).toBe('rank_math');
    const out = parse(csv);
    expect(out.rules.map((r) => [r.from, r.to, r.match])).toEqual([
      ['/old', '/new', 'exact'],
      ['/tag', '/topics', 'prefix'],
    ]);
    // "start" sends every /shop/… to /store: a prefix rule would keep the rest instead.
    expect(out.manual.map((m) => [m.line, m.reason])).toEqual([
      [3, 'matching "start" sends many paths to one target; it is not a path or prefix rule'],
      [4, 'matching "contains" sends many paths to one target; it is not a path or prefix rule'],
      [6, 'switched off in the export'],
    ]);
  });

  it('another host, a language entry domain, a query, the same source twice: each listed for a person', () => {
    const out = parse('/a,https://other.example.org/x\n/b?x=1,/c\n/d,/e\n/d,/f\nhttps://example.com/g,/h\n/i,https://zh.example.com/j\n');
    expect(out.rules.map((r) => r.from)).toEqual(['/d']);
    expect(out.manual.map((m) => [m.line, m.reason])).toEqual([
      [1, "target a different host (other.example.org): only this site's paths can be redirected to"],
      [2, 'source has a query or fragment'],
      [4, 'same source as line 3'],
      // A source naming a host would apply on every domain here, the language entry domains too.
      [5, 'a source with a host: here the rule would apply on every domain of the site, its language entry domains too'],
      [6, "target on a language entry domain (zh.example.com): its paths are another language's, not this rule's"],
    ]);
    // Without language entry domains, a source on the primary domain is that path.
    expect(parseRedirectImport('https://example.com/g,/h\n', { site: HOSTS.site, languageEntries: new Set() })).toMatchObject({ rules: [{ from: '/g', to: '/h' }] });
  });

  it('unreadable JSON is an error, not an empty import', () => {
    expect(parseRedirectImport('{"redirects": [', HOSTS)).toEqual({ error: 'not valid JSON' });
    expect(parseRedirectImport('{"other": []}', HOSTS)).toEqual({ error: 'no "redirects" list in the JSON' });
  });
});
