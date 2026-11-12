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
 *   - Netlify: an Edge Function (`netlify/edge-functions/negotiate.ts`, routed by the generated `netlify.toml`) with the
 *     same bounded map and the same rule, against Netlify's `Request`/`Context` handler;
 *   - Vercel: `vercel.json` route entries with `has`/`missing` conditions on the `accept` header that rewrite the address
 *     to the `.md` copy, plus the `Vary: Accept` header;
 *   - VPS: a Caddy matcher per page (a CEL expression on the `Accept` header) that rewrites to the `.md` copy, and
 *     `header Vary "Accept"` on the page's address.
 *
 * A platform configuration can only match the header **text**; comparing q-values needs code, which is why the two
 * code targets implement the runtime rule verbatim. Vercel and Caddy therefore serve Markdown only when the request names
 * `text/markdown`, does not also accept `text/html` (nor a wildcard) and does not refuse it with `q=0`. That set is a strict
 * subset of what the runtime negotiates: a configuration target never answers Markdown where the Classic engine would answer
 * HTML. `replayEdgeNegotiation` decides what a generated rule serves and is what CI proves; the platforms' own behaviour is
 * unproven (see the docs' post-deploy check).
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

/** The Netlify Edge Function of a contract, and the `netlify.toml` that routes it (Netlify's default function directory). */
export const NETLIFY_FUNCTION_FILE = 'netlify/edge-functions/negotiate.ts';
export const NETLIFY_CONFIG_FILE = 'netlify.toml';
/** The function name `netlify.toml` declares: the file name without its extension. */
const NETLIFY_FUNCTION_NAME = 'negotiate';

/** The entries both code targets look up: `path → [markdown copy, canonical Link]`, in path order. */
const negotiationEntries = (contract: NegotiationContract) => contract.rules.map((r) => [r.path, [r.markdown, r.link]]);

/**
 * The Netlify Edge Function of a contract (`netlify/edge-functions/negotiate.ts`): the same bounded map and the same
 * RFC 9110 rule as the Cloudflare Pages Function, in Netlify's `Request → Response` handler shape. `context.next()` is
 * every non-negotiable path and every method other than GET/HEAD; a Markdown request is rewritten to the copy through
 * `context.rewrite()` (which returns the copy's response, so the representation headers can be set). Empty when the site
 * has nothing to negotiate.
 */
export function negotiationEdgeFunction(contract: NegotiationContract): string | null {
  if (!contract.rules.length) return null;
  return `// Generated by HeoPress (v1.2 P11 task 4.5, Netlify): Markdown content negotiation at a page's own address.
// Bounded: the map below is the whole rule; other addresses are passed to the assets unchanged. Both answers of a
// negotiable page say Vary: Accept, and the Markdown one carries the copy's type, noindex and canonical Link.
const NEGOTIABLE = new Map(${JSON.stringify(negotiationEntries(contract))});

${PREFERS_MARKDOWN_JS}

function addVary(headers) {
  const current = headers.get('Vary');
  if (!current) headers.set('Vary', 'Accept');
  else if (!/(^|,)\\s*accept\\s*(,|$)/i.test(current)) headers.set('Vary', current + ', Accept');
}

const negotiate = async (request, context) => {
  const rule = NEGOTIABLE.get(new URL(request.url).pathname);
  if (!rule || (request.method !== 'GET' && request.method !== 'HEAD')) return context.next();
  const markdown = prefersMarkdown(request.headers.get('Accept'));
  let answer;
  if (markdown) {
    const copy = new URL(request.url);
    copy.pathname = rule[0];
    answer = await context.rewrite(copy);
  } else {
    answer = await context.next();
  }
  const headers = new Headers(answer.headers);
  addVary(headers);
  if (markdown) {
    headers.set('Content-Type', 'text/markdown; charset=utf-8');
    headers.set('X-Robots-Tag', 'noindex');
    headers.set('Link', rule[1]);
  }
  // A HEAD answer carries no body, and neither may a null-body status (204/304) be given one.
  const body = request.method === 'HEAD' || answer.status === 204 || answer.status === 304 ? null : answer.body;
  return new Response(body, { status: answer.status, statusText: answer.statusText, headers });
};

export default negotiate;
`;
}

/**
 * The `netlify.toml` of a contract: the one declaration that routes the function on every path. Netlify looks for edge
 * functions in `netlify/edge-functions` by default, so the directory needs no build setting; a build output that brings
 * its own `netlify.toml` is refused by the scan (the deployer owns this file). Empty when nothing negotiates.
 */
export function netlifyNegotiationConfig(contract: NegotiationContract): string | null {
  if (!contract.rules.length) return null;
  return `# Generated by HeoPress (v1.2 P11 task 4.5, Netlify): route the generated Edge Function.
[[edge_functions]]
  path = "/*"
  function = "${NETLIFY_FUNCTION_NAME}"
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
  by: 'worker' | 'netlify-function' | 'vercel-routes' | 'caddy' | 'none';
  /** The representation headers the matched rule sets (Content-Type, X-Robots-Tag, Link, Vary). */
  headers: Record<string, string>;
  /**
   * The response body the code targets answered (empty for HEAD). `null` for the configuration targets: their rule decides
   * a file and its headers, never the file's own bytes.
   */
  body: string | null;
}

export interface EdgeReplayInput {
  platform: StaticPlatform;
  /** The rendered configuration of the platform (as the deployer would upload it). */
  rendered: RenderedContract;
  /** The requested address (`/first/`, `/first.md`). */
  path: string;
  /** The request's `Accept` header (absent: none). */
  accept?: string;
  /** The request's method (default GET): only the code targets treat GET and HEAD differently. */
  method?: 'GET' | 'HEAD';
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

async function replayWorker(body: string, path: string, accept: string | undefined, method: 'GET' | 'HEAD'): Promise<EdgeReplay> {
  const source = body.replace(/\nexport default worker;\s*$/, '\nworker;');
  const worker = runInNewContext(source, { Request, Response, Headers, URL }, { timeout: 1000 }) as WorkerLike;
  let served = assetOf(path);
  const assets = (request: Request): Promise<Response> => {
    served = assetOf(new URL(request.url).pathname);
    // The asset server's own answer: what the worker passes through, or adds to.
    return Promise.resolve(new Response('asset', { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', Vary: 'Accept-Encoding' } }));
  };
  const request = new Request(`https://www.example.com${path}`, { method, headers: accept === undefined ? {} : { accept } });
  const answer = await worker.fetch(request, { ASSETS: { fetch: assets } });
  const headers = representationOf(answer.headers);
  return { served, markdown: headers['Link'] !== undefined, by: 'worker', headers, body: await answer.text() };
}

/** The Netlify Edge Function, executed exactly as generated against a stub `context`. */
interface NetlifyHandler {
  (request: Request, context: { next: () => Promise<Response>; rewrite: (url: URL) => Promise<Response> }): Promise<Response>;
}

/**
 * Whether the generated `netlify.toml` routes the function on every path: an `[[edge_functions]]` block naming both the
 * function and `path = "/*"`. Without it the module is just a file in the deploy and nothing would call it.
 */
function netlifyFunctionDeclared(toml: string): boolean {
  let block: Record<string, string> | null = null;
  for (const raw of toml.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line === '[[edge_functions]]') {
      block = {};
      continue;
    }
    if (line.startsWith('[')) {
      block = null;
      continue;
    }
    const pair = /^([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"$/.exec(line);
    if (pair && block) block[pair[1]!] = pair[2]!;
    if (pair && block && block['function'] === NETLIFY_FUNCTION_NAME && block['path'] === '/*') return true;
  }
  return false;
}

async function replayNetlify(body: string, path: string, accept: string | undefined, method: 'GET' | 'HEAD'): Promise<EdgeReplay> {
  const source = body.replace(/\nexport default negotiate;\s*$/, '\nnegotiate;');
  const negotiate = runInNewContext(source, { Request, Response, Headers, URL }, { timeout: 1000 }) as NetlifyHandler;
  let served = assetOf(path);
  const assets = (url: URL): Promise<Response> => {
    served = assetOf(url.pathname);
    // The asset server's answer for that URL: the request's own address, or the rewrite target. The copy is Markdown.
    const type = served.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8';
    return Promise.resolve(new Response('asset', { status: 200, headers: { 'Content-Type': type, Vary: 'Accept-Encoding' } }));
  };
  const url = new URL(`https://www.example.com${path}`);
  const context = { next: () => assets(url), rewrite: (target: URL) => assets(target) };
  const request = new Request(url, { method, headers: accept === undefined ? {} : { accept } });
  const answer = await negotiate(request, context);
  const headers = representationOf(answer.headers);
  return { served, markdown: headers['Link'] !== undefined, by: 'netlify-function', headers, body: await answer.text() };
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
    if (typeof dest === 'string' && has.length > 0) return { served: dest, markdown: true, by: 'vercel-routes', headers, body: null };
    if (route['handle'] === 'filesystem') break;
  }
  return { served: assetOf(path), markdown: false, by: 'vercel-routes', headers, body: null };
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
  return { served, markdown: headers['Link'] !== undefined, by: 'caddy', headers, body: null };
}

/**
 * Replay what the generated rule of one platform answers for `(path, Accept, method)`: the file the edge would serve, the
 * headers it sets and (for the code targets) the body it answers. Vercel and Caddy are read back from the rendered
 * configuration and evaluated as their documented matching works; Cloudflare's `_worker.js` and Netlify's
 * `netlify/edge-functions/negotiate.ts` are executed as generated, in a fresh `node:vm` context, against a stub asset
 * server / `context`. A Netlify deploy without the generated `netlify.toml` declaration has no rule. Pure (no filesystem,
 * no network): this is what CI can prove about the rule, not what the platform actually does.
 */
export async function replayEdgeNegotiation(input: EdgeReplayInput): Promise<EdgeReplay> {
  const { platform, rendered, path, accept, method = 'GET' } = input;
  switch (platform) {
    case 'cloudflare-pages': {
      const worker = fileBody(rendered, '_worker.js');
      return worker ? replayWorker(worker, path, accept, method) : { served: assetOf(path), markdown: false, by: 'none', headers: {}, body: null };
    }
    case 'netlify': {
      const fn = fileBody(rendered, NETLIFY_FUNCTION_FILE);
      const config = fileBody(rendered, NETLIFY_CONFIG_FILE);
      if (!fn || !config || !netlifyFunctionDeclared(config)) return { served: assetOf(path), markdown: false, by: 'none', headers: {}, body: null };
      return replayNetlify(fn, path, accept, method);
    }
    case 'vercel': {
      const config = fileBody(rendered, 'vercel.json');
      return config ? replayVercel(config, path, accept) : { served: assetOf(path), markdown: false, by: 'none', headers: {}, body: null };
    }
    case 'vps': {
      const snippet = fileBody(rendered, 'Caddyfile.static');
      return snippet ? replayCaddy(snippet, path, accept) : { served: assetOf(path), markdown: false, by: 'none', headers: {}, body: null };
    }
  }
}
