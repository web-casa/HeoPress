import { describe, expect, it } from 'vitest';
import { CF_WORKER_WARN_BYTES, renderContract, staticContractOf, STATIC_PLATFORMS, SUPPORT_MATRIX, type StaticContract } from '../contract';
import { HOST, snapshot } from './negotiation-fixture';
import {
  caddyNegotiation,
  negotiationContractOf,
  negotiationEdgeFunction,
  negotiationWorker,
  NETLIFY_CONFIG_FILE,
  NETLIFY_FUNCTION_FILE,
  vercelNegotiationRoutes,
  type NegotiationRule,
} from '../edge-negotiation';

/** Markdown negotiation on static targets (HeoPress v1.2 P11 task 4.5; spec publishing/static-edge-negotiation). */

const fileOf = (r: ReturnType<typeof renderContract>, name: string) => r.files.find((f) => f.path === name)?.body ?? null;
const rules = (contract: StaticContract) => contract.negotiation?.rules ?? [];
const ruleContract = (paths: NegotiationRule[]): StaticContract => ({ headers: [], redirects: [], gone: [], negotiation: { enabled: true, copies: true, rules: paths } });

describe('the negotiation contract', () => {
  it('names every page whose Markdown copy is its own, and only those', () => {
    const contract = staticContractOf(snapshot());
    expect(rules(contract).map((r) => [r.path, r.markdown])).toEqual([
      ['/about/', '/about.md'],
      ['/moon/', '/moon.md'],
    ]);
    expect(rules(contract)[0]!.link).toBe(`<https://${HOST}/about/>; rel="canonical"`);
    expect(contract.negotiation).toMatchObject({ enabled: true, copies: true });
  });

  it('negotiates nothing while the site has the switch off, and nothing while it has no copies', () => {
    const off = staticContractOf(snapshot({ markdownCopies: true, markdownNegotiation: false }));
    expect(off.negotiation).toMatchObject({ enabled: false, copies: true, rules: [] });
    const noCopies = staticContractOf(snapshot({ markdownCopies: false, markdownNegotiation: true }));
    expect(noCopies.negotiation).toMatchObject({ enabled: true, copies: false, rules: [] });
    // A snapshot from before the change carries no switches: no rule at all, and no false claim.
    const old = { ...snapshot(), discovery: undefined };
    expect(negotiationContractOf(old)).toBeUndefined();
    expect(staticContractOf(old).negotiation).toBeUndefined();
  });

  it('leaves a path a generated rule cannot quote out of the rule', () => {
    const quote = snapshot();
    const page = quote.pages.find((p) => p.path === '/moon/')!;
    quote.pages = [
      { ...page, path: "/o'brien/" },
      ...quote.pages.filter((p) => p.path !== '/moon/'),
    ];
    quote.files = quote.files.map((f) =>
      f.path === '/moon.md' ? { ...f, path: "/o'brien.md", headers: { ...f.headers, link: `<https://${HOST}/o'brien/>; rel="canonical"` } } : f,
    );
    expect(rules(staticContractOf(quote)).map((r) => r.path)).toEqual(['/about/']);
  });

  it('the matrix separates the copy (markdown-canonical) from the address (markdown-negotiation)', () => {
    for (const platform of STATIC_PLATFORMS) {
      expect(SUPPORT_MATRIX[platform]['markdown-canonical']).toBeDefined();
      expect(SUPPORT_MATRIX[platform]['markdown-negotiation']).toBeDefined();
    }
    expect(SUPPORT_MATRIX['cloudflare-pages']['markdown-negotiation'].support).toBe('yes');
    for (const platform of ['vps', 'vercel'] as const) {
      expect(SUPPORT_MATRIX[platform]['markdown-negotiation'].support).toBe('degraded');
      expect(SUPPORT_MATRIX[platform]['markdown-negotiation'].note).toMatch(/q-values are not compared/);
    }
    // Netlify is code too (an Edge Function, so it compares q-values like the runtime), but this deploy path uploads
    // files only and never sends `edge_functions`: the function exists only where Netlify builds the site itself.
    expect(SUPPORT_MATRIX.netlify['markdown-negotiation'].support).toBe('degraded');
    expect(SUPPORT_MATRIX.netlify['markdown-negotiation'].note).toMatch(/Edge Function/);
    expect(SUPPORT_MATRIX.netlify['markdown-negotiation'].note).toMatch(/netlify\.toml/);
    expect(SUPPORT_MATRIX.netlify['markdown-negotiation'].note).toMatch(/edge_functions/);
    // Every target that is not `yes` says why (the matrix is read by the Studio next to the target choice).
    for (const platform of STATIC_PLATFORMS) {
      const feature = SUPPORT_MATRIX[platform]['markdown-negotiation'];
      if (feature.support !== 'yes') expect(feature.note, platform).toBeTruthy();
    }
  });
});

describe('Cloudflare Pages: a bounded Pages Function', () => {
  it('ships _worker.js with the negotiable paths, the runtime rule and a pass-through', () => {
    const r = renderContract('cloudflare-pages', staticContractOf(snapshot()));
    const worker = fileOf(r, '_worker.js') ?? '';
    expect(worker).toContain('const NEGOTIABLE = new Map([["/about/",["/about.md","<https://www.example.com/about/>; rel=\\"canonical\\""]]');
    expect(worker).toContain('NEGOTIABLE.get(url.pathname)');
    expect(worker).toContain('function prefersMarkdown(accept)');
    expect(worker).toContain("return env.ASSETS.fetch(request);");
    expect(worker).toContain('export default worker;');
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('ships no worker and no warning when the site has nothing to negotiate', () => {
    const r = renderContract('cloudflare-pages', staticContractOf(snapshot({ markdownCopies: true, markdownNegotiation: false })));
    expect(fileOf(r, '_worker.js')).toBeNull();
    expect(r.warnings).toEqual([]);
  });

  it('says the switch cannot be kept without copies', () => {
    const r = renderContract('cloudflare-pages', staticContractOf(snapshot({ markdownCopies: false, markdownNegotiation: true })));
    expect(fileOf(r, '_worker.js')).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/no Markdown copies/);
  });

  it('warns when the generated worker outgrows the plan checks (not an error: the deploy goes on)', () => {
    const many: NegotiationRule[] = Array.from({ length: Math.ceil(CF_WORKER_WARN_BYTES / 24) + 200 }, (_, i) => ({
      path: `/p${i}/`,
      markdown: `/p${i}.md`,
      link: `<https://www.example.com/p${i}/>; rel="canonical"`,
    }));
    expect(negotiationWorker({ enabled: true, copies: true, rules: many })!.length).toBeGreaterThan(CF_WORKER_WARN_BYTES);
    const r = renderContract('cloudflare-pages', ruleContract(many));
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/Pages Functions bundle limit/);
  });
});

describe('Vercel: routes with has/missing on the accept header', () => {
  const rendered = () => renderContract('vercel', staticContractOf(snapshot()));
  const config = () => JSON.parse(fileOf(rendered(), 'vercel.json')!) as { routes: Array<Record<string, unknown>> };

  it('rewrites the page address to its copy and sets Vary: Accept on both answers', () => {
    const routes = config().routes;
    expect(routes).toContainEqual({
      src: '^/moon/$',
      has: [{ type: 'header', key: 'accept', value: '(?i).*text/markdown.*' }],
      missing: [
        { type: 'header', key: 'accept', value: '(?i).*(?:text/html|text/\\*|\\*/\\*).*' },
        { type: 'header', key: 'accept', value: '(?i).*text/markdown\\s*;\\s*q\\s*=\\s*0(?:\\.0{0,3})?\\s*(?:,|$).*' },
      ],
      dest: '/moon.md',
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Robots-Tag': 'noindex', Link: '<https://www.example.com/moon/>; rel="canonical"', Vary: 'Accept' },
    });
    expect(routes).toContainEqual({ src: '^(?:/about/|/moon/)$', headers: { Vary: 'Accept' }, continue: true });
    const filesystem = routes.findIndex((x) => x['handle'] === 'filesystem');
    expect(routes.findIndex((x) => x['dest'] === '/moon.md')).toBeLessThan(filesystem);
  });

  it('drops the rules that do not fit 2048 routes and says how many pages keep HTML', () => {
    const many: NegotiationRule[] = Array.from({ length: 3000 }, (_, i) => ({ path: `/p${i}/`, markdown: `/p${i}.md`, link: `<https://www.example.com/p${i}/>; rel="canonical"` }));
    const rooms = vercelNegotiationRoutes({ enabled: true, copies: true, rules: many }, 100);
    expect(rooms.rewrites).toHaveLength(99);
    expect(rooms.dropped).toBe(2901);
    const r = renderContract('vercel', ruleContract(many));
    expect(r.errors).toEqual([]);
    // 2048 routes - the file system and the not-found page - the Vary route leaves 2045 rewrites.
    expect(r.warnings.join(' ')).toMatch(new RegExp(`^${3000 - 2045} page\\(s\\) keep HTML`));
    const routes = (JSON.parse(fileOf(r, 'vercel.json')!) as { routes: unknown[] }).routes;
    expect(routes.length).toBeLessThanOrEqual(2048);
  });

  it('a contract that cannot fit even without negotiation is still refused', () => {
    const headers = Array.from({ length: 2048 }, (_, i) => ({ path: `/h${i}`, headers: [['X-Robots-Tag', 'noindex']] as Array<[string, string]> }));
    const r = renderContract('vercel', { headers, redirects: [], gone: [] });
    expect(r.errors.join(' ')).toMatch(/Vercel allows 2048/);
  });
});

describe('VPS: a Caddy matcher per page', () => {
  it('rewrites the address to the copy and sets Vary on the page', () => {
    const body = fileOf(renderContract('vps', staticContractOf(snapshot())), 'Caddyfile.static') ?? '';
    expect(body).toContain('@negotiate_md {');
    expect(body).toContain('\tpath /about/ /moon/');
    expect(body).toContain('header @negotiate_md Vary "Accept"');
    expect(body).toContain(`@negotiate_md_0 \`path('/about/') && header_regexp('Accept', r'(?i)text/markdown')`);
    expect(body).toContain("header @negotiate_md_0 {");
    expect(body).toContain('\tLink "<https://www.example.com/about/>; rel=\\"canonical\\""');
    expect(body).toContain('rewrite @negotiate_md_0 /about.md');
    expect(body).toContain('rewrite @negotiate_md_1 /moon.md');
    expect(caddyNegotiation({ enabled: true, copies: true, rules: [] })).toEqual([]);
  });
});

describe('Netlify: an Edge Function routed by netlify.toml', () => {
  const rendered = () => renderContract('netlify', staticContractOf(snapshot()));

  it('ships the Edge Function and its route, with the bounded map, the runtime rule and a pass-through', () => {
    const r = rendered();
    expect(r.files.map((f) => f.path).sort()).toEqual([NETLIFY_CONFIG_FILE, NETLIFY_FUNCTION_FILE, '_headers', '_redirects'].sort());
    const fn = fileOf(r, NETLIFY_FUNCTION_FILE) ?? '';
    expect(fn).toContain('const NEGOTIABLE = new Map([["/about/",["/about.md","<https://www.example.com/about/>; rel=\\"canonical\\""]]');
    expect(fn).toContain('const negotiate = async (request, context)');
    expect(fn).toContain('function prefersMarkdown(accept)');
    expect(fn).toContain('return context.next();');
    expect(fn).toContain('answer = await context.rewrite(copy);');
    expect(fn).toContain("headers.set('Content-Type', 'text/markdown; charset=utf-8');");
    expect(fn).toContain("headers.set('X-Robots-Tag', 'noindex');");
    expect(fn).toContain("headers.set('Link', rule[1]);");
    expect(fn).toContain('export default negotiate;');
    expect(fileOf(r, NETLIFY_CONFIG_FILE)).toBe(
      '# Generated by HeoPress (v1.2 P11 task 4.5, Netlify): route the generated Edge Function.\n[[edge_functions]]\n  path = "/*"\n  function = "negotiate"\n',
    );
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
    // The copies themselves are unchanged: they keep their type, noindex and canonical Link.
    expect(fileOf(r, '_headers')).toContain('/*.md\n  Content-Type: text/markdown; charset=utf-8\n  X-Robots-Tag: noindex');
  });

  it('emits neither file — and leaves _headers/_redirects byte-identical — when there is nothing to negotiate', () => {
    const off = renderContract('netlify', staticContractOf(snapshot({ markdownCopies: true, markdownNegotiation: false })));
    expect(off.files.map((f) => f.path).sort()).toEqual(['_headers', '_redirects']);
    expect(fileOf(off, '_headers')).toBe(fileOf(rendered(), '_headers'));
    expect(fileOf(off, '_redirects')).toBe(fileOf(rendered(), '_redirects'));
  });

  it('says the switch cannot be kept without copies', () => {
    const r = renderContract('netlify', staticContractOf(snapshot({ markdownCopies: false, markdownNegotiation: true })));
    expect(r.files.map((f) => f.path).sort()).toEqual(['_headers', '_redirects']);
    expect(r.warnings.join(' ')).toMatch(/no Markdown copies/);
  });

  it('keeps the map bounded: one entry per rule, looked up — never scanned', () => {
    const many: NegotiationRule[] = [
      { path: '/a/', markdown: '/a.md', link: '<https://www.example.com/a/>; rel="canonical"' },
      { path: '/b/', markdown: '/b.md', link: '<https://www.example.com/b/>; rel="canonical"' },
      { path: '/c/', markdown: '/c.md', link: '<https://www.example.com/c/>; rel="canonical"' },
    ];
    const contract = { enabled: true, copies: true, rules: many };
    const fn = negotiationEdgeFunction(contract)!;
    const literal = /const NEGOTIABLE = new Map\((.*)\);\n/.exec(fn)?.[1] ?? '';
    expect(JSON.parse(literal)).toEqual(many.map((r) => [r.path, [r.markdown, r.link]]));
    expect(fn).toContain('NEGOTIABLE.get(new URL(request.url).pathname)');
    expect(fn).not.toMatch(/NEGOTIABLE\.(?:forEach|entries|values|keys)/);
    expect(fn).not.toMatch(/snapshot|page data/i);
    // Nothing to negotiate: no function either (the caller emits no file at all).
    expect(negotiationEdgeFunction({ enabled: false, copies: true, rules: [] })).toBeNull();
  });
});
