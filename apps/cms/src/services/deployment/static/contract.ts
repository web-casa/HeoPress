import type { PageDataSnapshot } from '@heopress/contracts/page-data';

/**
 * The static target response contract (HeoPress P11 task 4.4; spec publishing/frontend-deployments, design "静态响应适配器必须
 * 验证 301/410/noindex/canonical 头"): what a static deployment of a site must answer beyond its files — each file's
 * `Content-Type` and representation headers (`X-Robots-Tag`, the Markdown copy's `Link: rel="canonical"`), each page's
 * `X-Robots-Tag`, the redirects (301) and the withdrawn addresses (410) — written in each platform's own configuration:
 *
 *   - Cloudflare Pages: `_headers` (at most 100 rules) and `_redirects` (at most 2000 static rules; 301 only — a 410 is not
 *     expressible and is served as the not-found page, said in the support matrix and the deploy's warnings);
 *   - Netlify: `_headers` and `_redirects` (`/path /404.html 410` for a withdrawn address);
 *   - Vercel: `vercel.json` `routes` (headers with `continue`, `status` 301 / 410, then the file system);
 *   - VPS: a Caddy snippet written next to the build (the operator's Caddyfile imports it).
 *
 * Pure: the deployer adds the files this returns to the upload. A contract that cannot be expressed on the platform is an
 * error (the deploy is refused, the live version stays); one expressed partially is a warning on the deploy record.
 */

export const STATIC_PLATFORMS = ['vps', 'cloudflare-pages', 'vercel', 'netlify'] as const;
export type StaticPlatform = (typeof STATIC_PLATFORMS)[number];

type Support = 'yes' | 'degraded' | 'no';

export interface FeatureSupport {
  support: Support;
  /** Why, when not plainly `yes` (English; Studio translates by feature and level). */
  note?: string;
}

const STATIC_FEATURES = ['noindex', 'markdown-canonical', 'redirect-301', 'gone-410', 'feeds', 'search', 'preview', 'analytics'] as const;
export type StaticFeature = (typeof STATIC_FEATURES)[number];

const RUNTIME_ONLY: Record<'search' | 'preview' | 'analytics', FeatureSupport> = {
  search: { support: 'no', note: 'Site search needs the runtime; a static target has none.' },
  preview: { support: 'no', note: 'Draft preview stays on the administration domain; never on the public target.' },
  analytics: { support: 'no', note: 'Unavailable until edge log import is configured.' },
};

/**
 * The runtime feature support matrix (task 4.4): what each target answers like the Classic engine, what it answers
 * differently, and what it cannot answer at all. Shown in Studio next to the target choice.
 */
export const SUPPORT_MATRIX: Readonly<Record<StaticPlatform, Record<StaticFeature, FeatureSupport>>> = {
  vps: {
    noindex: { support: 'yes' },
    'markdown-canonical': { support: 'yes' },
    'redirect-301': { support: 'yes' },
    'gone-410': { support: 'yes' },
    feeds: { support: 'yes' },
    ...RUNTIME_ONLY,
  },
  'cloudflare-pages': {
    noindex: { support: 'yes' },
    'markdown-canonical': { support: 'degraded', note: 'Cloudflare Pages allows 100 header rules: past that, Markdown copies keep noindex but lose their Link header.' },
    'redirect-301': { support: 'yes', note: 'At most 2000 redirects.' },
    'gone-410': { support: 'degraded', note: 'Cloudflare Pages redirects cannot answer 410: withdrawn addresses answer 404.' },
    feeds: { support: 'yes' },
    ...RUNTIME_ONLY,
  },
  vercel: {
    noindex: { support: 'yes' },
    'markdown-canonical': { support: 'yes' },
    'redirect-301': { support: 'yes', note: 'At most 2048 routes.' },
    'gone-410': { support: 'yes' },
    feeds: { support: 'yes' },
    ...RUNTIME_ONLY,
  },
  netlify: {
    noindex: { support: 'yes' },
    'markdown-canonical': { support: 'yes' },
    'redirect-301': { support: 'yes' },
    'gone-410': { support: 'yes' },
    feeds: { support: 'yes' },
    ...RUNTIME_ONLY,
  },
};

export const CF_HEADER_RULES = 100;
const CF_REDIRECTS = 2000;
const VERCEL_ROUTES = 2048;

/** The configuration files a platform reads (the build output must not bring its own: the scan refuses them). */
export const PLATFORM_CONFIG_FILES = ['_headers', '_redirects', '_routes.json', '_worker.js', 'vercel.json', 'netlify.toml', '.vercel', 'Caddyfile.static'];

interface HeaderRule {
  path: string;
  headers: Array<[string, string]>;
  /** A page rule whose noindex its HTML head also carries (droppable when rules run short). */
  metaCovered?: boolean;
  /** A rule that only carries a Markdown copy's Link (droppable, with a warning). */
  linkOnly?: boolean;
}

export interface StaticContract {
  headers: HeaderRule[];
  redirects: Array<{ path: string; location: string }>;
  gone: string[];
}

export interface RenderedContract {
  /** Files to add to the upload (`path` without a leading slash), or for VPS the snippet. */
  files: Array<{ path: string; body: string }>;
  warnings: string[];
  errors: string[];
}

const canon = (name: string) => name.toLowerCase().replace(/(^|-)([a-z])/g, (_m, d: string, c: string) => `${d}${c.toUpperCase()}`);
const ext = (path: string) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? null;
const safeValue = (v: string) => !/[\r\n]/.test(v);

/** The contract of a snapshot: the headers, redirects and withdrawn addresses a static target must answer. */
export function staticContractOf(snapshot: PageDataSnapshot): StaticContract {
  const headers: HeaderRule[] = [];
  for (const f of snapshot.files) {
    const hs: Array<[string, string]> = [['Content-Type', f.contentType]];
    for (const [k, v] of Object.entries(f.headers)) if (k.toLowerCase() !== 'content-type') hs.push([canon(k), v]);
    headers.push({ path: f.path, headers: hs.filter(([, v]) => safeValue(v)) });
  }
  for (const p of snapshot.pages) {
    if (!p.xRobotsTag || !safeValue(p.xRobotsTag)) continue;
    headers.push({ path: p.path, headers: [['X-Robots-Tag', p.xRobotsTag]], metaCovered: /<meta[^>]+name="robots"[^>]+noindex/i.test(p.headHtml) });
  }
  const routes = snapshot.routes ?? [];
  return {
    headers,
    redirects: routes.filter((r) => r.status === 301 && r.location).map((r) => ({ path: r.path, location: r.location! })),
    gone: routes.filter((r) => r.status === 410).map((r) => r.path),
  };
}

/**
 * Fold the headers files of one extension share into one `/*.ext` rule (the per-path rules keep the rest): Cloudflare
 * Pages and Netlify merge every rule that matches.
 */
function folded(rules: HeaderRule[]): HeaderRule[] {
  const byExt = new Map<string, HeaderRule[]>();
  const rest: HeaderRule[] = [];
  for (const r of rules) {
    const e = r.metaCovered === undefined ? ext(r.path) : null;
    if (e) byExt.set(e, [...(byExt.get(e) ?? []), r]);
    else rest.push(r);
  }
  const out: HeaderRule[] = [];
  for (const [e, group] of byExt) {
    if (group.length < 2) {
      out.push(...group);
      continue;
    }
    const key = (h: [string, string]) => `${h[0]}\u0000${h[1]}`;
    const common = group[0]!.headers.filter((h) => group.every((g) => g.headers.some((x) => key(x) === key(h))));
    if (common.length) out.push({ path: `/*.${e}`, headers: common });
    for (const g of group) {
      const own = g.headers.filter((h) => !common.some((c) => key(c) === key(h)));
      if (own.length) out.push({ path: g.path, headers: own, linkOnly: own.every(([k]) => k === 'Link') });
    }
  }
  return [...out, ...rest];
}

const headersFile = (rules: HeaderRule[]) => rules.map((r) => `${r.path}\n${r.headers.map(([k, v]) => `  ${k}: ${v}`).join('\n')}`).join('\n\n') + '\n';

const regexOf = (path: string) => `^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

/** Render the contract in a platform's configuration. */
export function renderContract(platform: StaticPlatform, contract: StaticContract): RenderedContract {
  const warnings: string[] = [];
  const errors: string[] = [];
  const files: RenderedContract['files'] = [];
  switch (platform) {
    case 'cloudflare-pages': {
      let rules = folded(contract.headers);
      if (rules.length > CF_HEADER_RULES) {
        const before = rules.length;
        rules = rules.filter((r) => !r.metaCovered);
        if (rules.length < before) warnings.push(`${before - rules.length} noindex page(s) rely on their robots meta tag only (Cloudflare Pages allows ${CF_HEADER_RULES} header rules).`);
      }
      if (rules.length > CF_HEADER_RULES) {
        const before = rules.length;
        rules = rules.filter((r) => !r.linkOnly);
        if (rules.length < before) warnings.push(`${before - rules.length} Markdown cop(ies) sent without their canonical Link header (Cloudflare Pages allows ${CF_HEADER_RULES} header rules); they stay noindex.`);
      }
      if (rules.length > CF_HEADER_RULES) errors.push(`The site needs ${rules.length} header rules; Cloudflare Pages allows ${CF_HEADER_RULES}.`);
      if (contract.redirects.length > CF_REDIRECTS) errors.push(`The site has ${contract.redirects.length} redirects; Cloudflare Pages allows ${CF_REDIRECTS}.`);
      if (contract.gone.length) warnings.push(`${contract.gone.length} withdrawn address(es) answer 404, not 410 (Cloudflare Pages redirects cannot answer 410).`);
      files.push({ path: '_headers', body: headersFile(rules) });
      files.push({ path: '_redirects', body: contract.redirects.map((r) => `${r.path} ${r.location} 301`).join('\n') + '\n' });
      break;
    }
    case 'netlify': {
      files.push({ path: '_headers', body: headersFile(folded(contract.headers)) });
      files.push({
        path: '_redirects',
        body: [...contract.redirects.map((r) => `${r.path} ${r.location} 301!`), ...contract.gone.map((p) => `${p} /404.html 410!`)].join('\n') + '\n',
      });
      break;
    }
    case 'vercel': {
      const routes: Array<Record<string, unknown>> = [
        ...contract.headers.map((r) => ({ src: r.path.startsWith('/*.') ? `^/.*\\.${r.path.slice(3)}$` : regexOf(r.path), headers: Object.fromEntries(r.headers), continue: true })),
        ...contract.redirects.map((r) => ({ src: regexOf(r.path), status: 301, headers: { Location: r.location } })),
        ...contract.gone.map((p) => ({ src: regexOf(p), status: 410, dest: '/404.html' })),
        { handle: 'filesystem' },
        { src: '/.*', status: 404, dest: '/404.html' },
      ];
      if (routes.length > VERCEL_ROUTES) errors.push(`The site needs ${routes.length} routes; Vercel allows ${VERCEL_ROUTES}.`);
      files.push({ path: 'vercel.json', body: JSON.stringify({ version: 2, cleanUrls: false, trailingSlash: true, routes }, null, 2) });
      break;
    }
    case 'vps': {
      const lines: string[] = ['# Generated by HeoPress (P11 task 4.4): import inside the site block that serves `current`.'];
      for (const r of contract.headers) {
        const m = r.path.startsWith('/*.') ? `path *.${r.path.slice(3)}` : `path ${r.path}`;
        lines.push(`@h${lines.length} ${m}`, `header @h${lines.length - 1} {`, ...r.headers.map(([k, v]) => `\t${k} "${v.replace(/"/g, '\\"')}"`), '}');
      }
      for (const r of contract.redirects) lines.push(`redir ${r.path} ${r.location} 301`);
      for (const p of contract.gone) lines.push(`respond ${p} 410`);
      files.push({ path: 'Caddyfile.static', body: lines.join('\n') + '\n' });
      break;
    }
  }
  return { files, warnings, errors };
}
