import { runInNewContext } from 'node:vm';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { markdownUrlOf } from '@heopress/public-site';
import type { RenderedContract, StaticPlatform } from './contract';

/**
 * Markdown content negotiation on a static target (HeoPress v1.2 P11 task 4.5; spec publishing/static-edge-negotiation):
 * the Classic engine answers a page's **own** address with the page's Markdown when the request's `Accept` prefers
 * `text/markdown` over `text/html` (`apps/site-classic/src/negotiation.ts`). A static target runs no such code, so the
 * contract carries the pages that negotiate and each platform's configuration expresses the same answer:
 *
 *   - Cloudflare Pages: a Pages Function (`_worker.js`) decides with the full RFC 9110 rule, from a bounded map of the
 *     negotiable paths (no scan of the request, O(1) lookup), and passes everything else through to the assets;
 *   - Vercel: `vercel.json` route entries with `has`/`missing` conditions on the `accept` header that rewrite the address
 *     to the `.md` copy, plus the `Vary: Accept` header;
 *   - VPS: a Caddy matcher per page (a CEL expression on the `Accept` header) that rewrites to the `.md` copy, and
 *     `header Vary "Accept"` on the page's address;
 *   - Netlify: nothing can express it (`_headers`/`_redirects` cannot vary on `Accept`), so the feature is `no` in the
 *     matrix and the deploy record says so — never faked.
 *
 * A platform configuration can only match the header **text**; comparing q-values needs code. Vercel and Caddy therefore
 * serve Markdown only when the request names `text/markdown`, does not also accept `text/html` (nor a wildcard) and does not
 * refuse it with `q=0`. That set is a strict subset of what the runtime negotiates: a static target never answers Markdown
 * where the Classic engine would answer HTML. `replayEdgeNegotiation` decides what a generated rule serves and is what CI
 * proves; the platforms' own behaviour is unproven (see the docs' post-deploy check).
 */

/** One page that answers Markdown at its own address, and the copy it answers with. */
export interface NegotiationRule {
  /** The page's address on the site (`/2026/10/hello/`). */
  path: string;
  /** The Markdown copy it answers with (`/2026/10/hello.md`), a file of the same snapshot. */
  markdown: string;
  /** The copy's `Link: <page>; rel="canonical"` value, replayed on the negotiated answer. */
  link: string;
}

/** The negotiation part of the static contract (absent in contracts stored before v1.2: no negotiation). */
export interface NegotiationContract {
  /** The site's `discovery.markdownNegotiation` switch. */
  enabled: boolean;
  /** The site's `discovery.markdownCopies` switch: a static target rewrites to the copy, so it needs them. */
  copies: boolean;
  /** The pages that negotiate; empty unless `enabled` and `copies`. */
  rules: NegotiationRule[];
}

/** The copy's canonical `Link` — the only form the Classic engine writes (P07 task 4.2). */
const CANONICAL_LINK = /^<([^<>]+)>;\s*rel="canonical"$/i;
/** A page path or copy path a generated rule can carry safely (no quoting, placeholder or regex surprises). */
const SAFE_PATH = /^\/[^\s<>"'\\?#{}]*$/;

/**
 * The pages a static target negotiates, read from the snapshot: the `.md` copies and the pages they name as canonical.
 * The copies are only made for an indexable page canonical to itself (P07 task 4.2), which is exactly the runtime's
 * `negotiable` decision — so the static rule and the runtime cannot disagree about **which** pages negotiate.
 */
export function negotiationContractOf(snapshot: PageDataSnapshot): NegotiationContract | undefined {
  const discovery = snapshot.discovery;
  if (!discovery) return undefined;
  const rules: NegotiationRule[] = [];
  if (discovery.markdownNegotiation && discovery.markdownCopies) {
    let host: string;
    try {
      host = new URL(snapshot.origin).host.toLowerCase();
    } catch {
      return { enabled: discovery.markdownNegotiation, copies: discovery.markdownCopies, rules };
    }
    for (const file of snapshot.files) {
      if (!file.path.endsWith('.md') || !SAFE_PATH.test(file.path)) continue;
      if (!/^text\/markdown\b/i.test(file.contentType)) continue;
      const link = Object.entries(file.headers).find(([k]) => k.toLowerCase() === 'link')?.[1]?.trim();
      const named = link ? CANONICAL_LINK.exec(link) : null;
      if (!named) continue;
      const canonical = named[1]!;
      let url: URL;
      try {
        url = new URL(canonical);
      } catch {
        continue;
      }
      if (url.protocol !== 'https:' || url.host.toLowerCase() !== host) continue;
      const page = url.pathname;
      if (!SAFE_PATH.test(page)) continue;
      // The copy is the page's own `.md` address (`/a/b/` → `/a/b.md`), not some other file that names it.
      const copy = markdownUrlOf(canonical);
      if (!copy || new URL(copy).pathname !== file.path) continue;
      const row = snapshot.pages.find((p) => p.path === page && p.status === 200);
      if (!row) continue;
      if (row.xRobotsTag && /noindex/i.test(row.xRobotsTag)) continue;
      if (/<meta[^>]+name="robots"[^>]+noindex/i.test(row.headHtml)) continue;
      rules.push({ path: page, markdown: file.path, link: `<${canonical}>; rel="canonical"` });
    }
  }
  // Deterministic output: the deploy uploads the same bytes for the same snapshot.
  rules.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { enabled: discovery.markdownNegotiation, copies: discovery.markdownCopies, rules };
}

/** The RFC 9110 preference rule the Classic engine uses, as the standalone JavaScript a Pages Function runs. */
const PREFERS_MARKDOWN_JS = String.raw`function prefersMarkdown(accept) {
  if (!accept) return false;
  var TOKEN = /^[!#$%&'*+.^_\x60|~0-9a-z-]+$/;
  var QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
  var ranges = [];
  accept.split(',').forEach(function (part) {
    var segments = part.split(';').map(function (s) { return s.trim(); });
    var media = segments[0];
    if (!media) return;
    var slash = media.indexOf('/');
    if (slash <= 0 || slash === media.length - 1) return;
    var type = media.slice(0, slash).toLowerCase();
    var subtype = media.slice(slash + 1).toLowerCase();
    if (!TOKEN.test(type) || !TOKEN.test(subtype)) return;
    var q = 1;
    for (var i = 1; i < segments.length; i++) {
      var eq = segments[i].indexOf('=');
      if (eq < 0) continue;
      if (segments[i].slice(0, eq).trim().toLowerCase() !== 'q') continue;
      var value = segments[i].slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!QVALUE.test(value)) return;
      q = Number(value);
    }
    ranges.push({ type: type, subtype: subtype, q: q });
  });
  function specificity(range) {
    return range.type === '*' ? 0 : range.subtype === '*' ? 1 : 2;
  }
  function qualityOf(type, subtype) {
    var best = null;
    for (var i = 0; i < ranges.length; i++) {
      var range = ranges[i];
      if (!(range.type === '*' || (range.type === type && (range.subtype === '*' || range.subtype === subtype)))) continue;
      if (!best || specificity(range) > specificity(best) || (specificity(range) === specificity(best) && range.q > best.q)) best = range;
    }
    return best ? best.q : 0;
  }
  var markdown = qualityOf('text', 'markdown');
  return markdown > 0 && markdown > qualityOf('text', 'html');
}`;

/**
 * The Cloudflare Pages advanced-mode function (`_worker.js`) of a contract: a bounded map of the negotiable paths, the
 * RFC 9110 decision, and a pass-through for everything else. Empty when the site has nothing to negotiate.
 */
export function negotiationWorker(contract: NegotiationContract): string | null {
  if (!contract.rules.length) return null;
  const entries = contract.rules.map((r) => [r.path, [r.markdown, r.link]]);
  return `// Generated by HeoPress (v1.2 P11 task 4.5): Markdown content negotiation at a page's own address.
// Bounded: the map below is the whole rule; other addresses are passed to the assets unchanged. Both answers of a
// negotiable page say Vary: Accept, and the Markdown one carries the copy's type, noindex and canonical Link.
const NEGOTIABLE = new Map(${JSON.stringify(entries)});

${PREFERS_MARKDOWN_JS}

function addVary(headers) {
  const current = headers.get('Vary');
  if (!current) headers.set('Vary', 'Accept');
  else if (!/(^|,)\\s*accept\\s*(,|$)/i.test(current)) headers.set('Vary', current + ', Accept');
}

const worker = {
  fetch: async (request, env) => {
    const url = new URL(request.url);
    const rule = NEGOTIABLE.get(url.pathname);
    if (!rule || (request.method !== 'GET' && request.method !== 'HEAD')) return env.ASSETS.fetch(request);
    const markdown = prefersMarkdown(request.headers.get('Accept'));
    let answer;
    if (markdown) {
      const copy = new URL(request.url);
      copy.pathname = rule[0];
      answer = await env.ASSETS.fetch(new Request(copy.toString(), { method: request.method, headers: request.headers }));
    } else {
      answer = await env.ASSETS.fetch(request);
    }
    const headers = new Headers(answer.headers);
    addVary(headers);
    if (markdown) {
      headers.set('Content-Type', 'text/markdown; charset=utf-8');
      headers.set('X-Robots-Tag', 'noindex');
      headers.set('Link', rule[1]);
    }
    return new Response(request.method === 'HEAD' ? null : answer.body, { status: answer.status, statusText: answer.statusText, headers });
  },
};

export default worker;
`;
}

/** The `Accept` conditions a Vercel route expresses (RE2; `.*` works under either matching semantics). */
const VERCEL_WANTS_MARKDOWN = '(?i).*text/markdown.*';
/** The request also accepts HTML: `text/html`, `text` with a wildcard subtype, or a full wildcard. */
const VERCEL_ALSO_HTML = '(?i).*(?:text/html|text/\\*|\\*/\\*).*';
/** The request explicitly refuses Markdown (`text/markdown;q=0`, `q=0.000`). q-values are otherwise not compared. */
const VERCEL_REFUSES_MARKDOWN = '(?i).*text/markdown\\s*;\\s*q\\s*=\\s*0(?:\\.0{0,3})?\\s*(?:,|$).*';

/** Escape one page path for a Vercel `src` regex (`^/a/b/$`). */
const vercelSrcOf = (path: string) => `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

export interface VercelNegotiationRoutes {
  /** One header route naming every negotiable page (`Vary: Accept` on the HTML answer), or null. */
  vary: Record<string, unknown> | null;
  /** One rewrite route per page (address + `Accept` prefers Markdown → the `.md` copy). */
  rewrites: Array<Record<string, unknown>>;
  /** Pages whose rule did not fit the platform's route budget. */
  dropped: number;
}

/**
 * The Vercel routes of a contract. `room` is how many routes the rest of the configuration leaves (the platform allows
 * 2048); the routes that do not fit are dropped — a page then keeps HTML at its own address, its copy stays reachable —
 * and counted in `dropped`, which the renderer turns into a warning.
 */
export function vercelNegotiationRoutes(contract: NegotiationContract, room: number): VercelNegotiationRoutes {
  if (!contract.rules.length || room < 2) return { vary: null, rewrites: [], dropped: contract.rules.length };
  const used = contract.rules.slice(0, Math.max(0, room - 1));
  const paths = used.map((r) => vercelSrcOf(r.path).slice(1, -1));
  return {
    vary: { src: `^(?:${paths.join('|')})$`, headers: { Vary: 'Accept' }, continue: true },
    rewrites: used.map((r) => ({
      src: vercelSrcOf(r.path),
      has: [{ type: 'header', key: 'accept', value: VERCEL_WANTS_MARKDOWN }],
      missing: [
        { type: 'header', key: 'accept', value: VERCEL_ALSO_HTML },
        { type: 'header', key: 'accept', value: VERCEL_REFUSES_MARKDOWN },
      ],
      dest: r.markdown,
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'X-Robots-Tag': 'noindex', Link: r.link, Vary: 'Accept' },
    })),
    dropped: contract.rules.length - used.length,
  };
}

/** A Caddyfile-quoted header value. */
const caddyValue = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The Caddy directives of a contract (the snippet is imported by the site block that serves `current`): one CEL matcher
 * per page combining the address, the Markdown preference and the HTML/wildcard refusal, its representation headers, and
 * the rewrite to the copy; plus `Vary: Accept` on every negotiable page's address.
 */
export function caddyNegotiation(contract: NegotiationContract): string[] {
  if (!contract.rules.length) return [];
  const rules = [
    '# Markdown content negotiation (v1.2 P11 task 4.5): a page\'s own address answers its `.md` copy when `Accept`',
    '# names text/markdown, does not also accept HTML (a wildcard counts as HTML) and does not refuse it with q=0.',
    '@negotiate_md {',
    `\tpath ${contract.rules.map((r) => r.path).join(' ')}`,
    '}',
    'header @negotiate_md Vary "Accept"',
  ];
  contract.rules.forEach((rule, index) => {
    const match =
      `path('${rule.path}')` +
      ` && header_regexp('Accept', r'(?i)text/markdown')` +
      ` && !header_regexp('Accept', r'(?i)(?:text/html|text/\\*|\\*/\\*)')` +
      ` && !header_regexp('Accept', r'(?i)text/markdown\\s*;\\s*q\\s*=\\s*0(?:\\.0{0,3})?\\s*(?:,|$)')`;
    rules.push(
      `@negotiate_md_${index} \`${match}\``,
      `header @negotiate_md_${index} {`,
      '\tContent-Type "text/markdown; charset=utf-8"',
      '\tX-Robots-Tag "noindex"',
      `\tLink ${caddyValue(rule.link)}`,
      '}',
      `rewrite @negotiate_md_${index} ${rule.markdown}`,
    );
  });
  return rules;
}

/** What a generated rule answers for one request: the file the edge would serve, and the headers it sets. */
export interface EdgeReplay {
  /** The output file the edge answers with (`/first/index.html`, or the `.md` copy). */
  served: string;
  /** The edge answers the Markdown copy at the page's address. */
  markdown: boolean;
  /** Which generated rule decided (`none`: the platform has no negotiation rule). */
  by: 'worker' | 'vercel-routes' | 'caddy' | 'none';
  /** The representation headers the matched rule sets (Content-Type, X-Robots-Tag, Link, Vary). */
  headers: Record<string, string>;
}

export interface EdgeReplayInput {
  platform: StaticPlatform;
  /** The rendered configuration of the platform (as the deployer would upload it). */
  rendered: RenderedContract;
  /** The requested address (`/first/`, `/first.md`). */
  path: string;
  /** The request's `Accept` header (absent: none). */
  accept?: string;
}

const REPRESENTATION = ['Content-Type', 'X-Robots-Tag', 'Link', 'Vary'] as const;

/** The file a static target serves for an address it does not rewrite. */
const assetOf = (path: string) => (path.endsWith('/') ? `${path}index.html` : path);

/** A JS regex from an emitted RE2 pattern (`(?i)` is a JS flag, the rest is shared syntax). */
function regexOf(pattern: string): RegExp {
  const flags = /^\(\?([a-z]+)\)/.exec(pattern)?.[1] ?? '';
  return new RegExp(pattern.replace(/^\(\?[a-z]+\)/, ''), flags.replace(/[^gimsuy]/g, ''));
}

const fileBody = (rendered: RenderedContract, path: string) => rendered.files.find((f) => f.path === path)?.body ?? null;

/** A response's representation headers, under their canonical names. */
function representationOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of REPRESENTATION) {
    const value = headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

/** The Cloudflare worker, executed exactly as generated against a stub asset server. */
interface WorkerLike {
  fetch: (request: Request, env: { ASSETS: { fetch: (request: Request) => Promise<Response> } }) => Promise<Response>;
}

async function replayWorker(body: string, path: string, accept: string | undefined): Promise<EdgeReplay> {
  const source = body.replace(/\nexport default worker;\s*$/, '\nworker;');
  const worker = runInNewContext(source, { Request, Response, Headers, URL }, { timeout: 1000 }) as WorkerLike;
  let served = assetOf(path);
  const assets = (request: Request): Promise<Response> => {
    served = assetOf(new URL(request.url).pathname);
    // The asset server's own answer: what the worker passes through, or adds to.
    return Promise.resolve(new Response('asset', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', Vary: 'Accept-Encoding' } }));
  };
  const request = new Request(`https://www.example.com${path}`, { headers: accept === undefined ? {} : { accept } });
  const answer = await worker.fetch(request, { ASSETS: { fetch: assets } });
  const headers = representationOf(answer.headers);
  return { served, markdown: headers['Link'] !== undefined, by: 'worker', headers };
}

/** The Vercel configuration: routes in order, `has`/`missing` header conditions honoured, headers merged. */
function replayVercel(body: string, path: string, accept: string | undefined): EdgeReplay {
  const config = JSON.parse(body) as { routes?: Array<Record<string, unknown>> };
  const header = accept ?? null;
  const conditionHolds = (condition: Record<string, unknown>): boolean => {
    if (condition['type'] !== 'header' || String(condition['key']).toLowerCase() !== 'accept') return false;
    const value = condition['value'];
    if (header === null || typeof value !== 'string') return false;
    return regexOf(value).test(header);
  };
  const headers: Record<string, string> = {};
  for (const route of config.routes ?? []) {
    if (typeof route['src'] === 'string' && !regexOf(route['src']).test(path)) continue;
    const has = (route['has'] as Array<Record<string, unknown>> | undefined) ?? [];
    const missing = (route['missing'] as Array<Record<string, unknown>> | undefined) ?? [];
    if (!has.every(conditionHolds) || missing.some(conditionHolds)) continue;
    for (const [name, value] of Object.entries((route['headers'] as Record<string, string> | undefined) ?? {})) headers[name] = value;
    const dest = route['dest'];
    if (typeof dest === 'string' && has.length > 0) return { served: dest, markdown: true, by: 'vercel-routes', headers };
    if (route['handle'] === 'filesystem') break;
  }
  return { served: assetOf(path), markdown: false, by: 'vercel-routes', headers };
}

/** A named matcher of the Caddy snippet: its page list, or its CEL expression. */
type CaddyMatcher = { paths: string[] } | { cel: string };

/** One Caddy directive that a request can match: a header block or a rewrite, under its matcher. */
interface CaddyDirective {
  matcher: string;
  headers?: Array<[string, string]>;
  rewrite?: string;
}

/** Read the negotiation part of the snippet: block/CEL matchers, header directives and rewrites, in file order. */
function caddyDirectives(body: string): { matchers: Map<string, CaddyMatcher>; directives: CaddyDirective[] } {
  const lines = body.split('\n').map((l) => l.trim());
  const matchers = new Map<string, CaddyMatcher>();
  const directives: CaddyDirective[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const block = /^@(\w+) \{$/.exec(line);
    if (block) {
      const inside: string[] = [];
      for (i += 1; i < lines.length && lines[i] !== '}'; i++) inside.push(lines[i]!);
      const listed = inside.find((l) => l.startsWith('path '));
      if (listed) matchers.set(block[1]!, { paths: listed.slice('path '.length).split(/\s+/).filter(Boolean) });
      continue;
    }
    const cel = /^@(\w+) `(.+)`$/.exec(line);
    if (cel) {
      matchers.set(cel[1]!, { cel: cel[2]! });
      continue;
    }
    const headerBlock = /^header @(\w+) \{$/.exec(line);
    if (headerBlock) {
      const headers: Array<[string, string]> = [];
      for (i += 1; i < lines.length && lines[i] !== '}'; i++) {
        const pair = /^(\S+)\s+(.+)$/.exec(lines[i]!);
        if (pair) headers.push([pair[1]!, pair[2]!.replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"')]);
      }
      directives.push({ matcher: headerBlock[1]!, headers });
      continue;
    }
    const headerLine = /^header @(\w+)\s+(\S+)\s+(.+)$/.exec(line);
    if (headerLine) {
      directives.push({ matcher: headerLine[1]!, headers: [[headerLine[2]!, headerLine[3]!.replace(/^"(.*)"$/, '$1').replace(/\\"/g, '"')]] });
      continue;
    }
    const rewrite = /^rewrite @(\w+)\s+(\S+)$/.exec(line);
    if (rewrite) directives.push({ matcher: rewrite[1]!, rewrite: rewrite[2]! });
  }
  return { matchers, directives };
}

/** Whether a Caddy matcher holds for the request (the page list, or the CEL expression our renderer writes). */
function caddyMatches(matcher: CaddyMatcher, path: string, accept: string): boolean {
  if ('paths' in matcher) return matcher.paths.includes(path);
  const address = /path\('([^']*)'\)/.exec(matcher.cel)?.[1];
  if (address !== path) return false;
  for (const [, negated, pattern] of matcher.cel.matchAll(/(!?)header_regexp\('Accept', r'((?:[^'\\]|\\.)*)'\)/g)) {
    if (regexOf(pattern!).test(accept) !== (negated !== '!')) return false;
  }
  return true;
}

/** The Caddy snippet: the header directives and rewrite that match, evaluated as the matchers read. */
function replayCaddy(body: string, path: string, accept: string | undefined): EdgeReplay {
  const { matchers, directives } = caddyDirectives(body);
  const value = accept ?? '';
  const headers: Record<string, string> = {};
  let served = assetOf(path);
  for (const directive of directives) {
    const matcher = matchers.get(directive.matcher);
    if (!matcher || !caddyMatches(matcher, path, value)) continue;
    for (const [name, header] of directive.headers ?? []) headers[name] = header;
    if (directive.rewrite) served = directive.rewrite;
  }
  return { served, markdown: headers['Link'] !== undefined, by: 'caddy', headers };
}

/**
 * Replay what the generated rule of one platform answers for `(path, Accept)`: the file the edge would serve and the
 * headers it sets. Vercel and Caddy are read back from the rendered configuration and evaluated as their documented
 * matching works; Cloudflare's `_worker.js` is executed as generated (in a fresh `node:vm` context, against a stub asset
 * server). Netlify has no rule. Pure (no filesystem, no network): this is what CI can prove about the rule, not what the
 * platform actually does.
 */
export async function replayEdgeNegotiation(input: EdgeReplayInput): Promise<EdgeReplay> {
  const { platform, rendered, path, accept } = input;
  switch (platform) {
    case 'cloudflare-pages': {
      const worker = fileBody(rendered, '_worker.js');
      return worker ? replayWorker(worker, path, accept) : { served: assetOf(path), markdown: false, by: 'none', headers: {} };
    }
    case 'vercel': {
      const config = fileBody(rendered, 'vercel.json');
      return config ? replayVercel(config, path, accept) : { served: assetOf(path), markdown: false, by: 'none', headers: {} };
    }
    case 'vps': {
      const snippet = fileBody(rendered, 'Caddyfile.static');
      return snippet ? replayCaddy(snippet, path, accept) : { served: assetOf(path), markdown: false, by: 'none', headers: {} };
    }
    case 'netlify':
      return { served: assetOf(path), markdown: false, by: 'none', headers: {} };
  }
}
