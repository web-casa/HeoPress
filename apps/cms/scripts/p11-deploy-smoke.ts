/**
 * Manual smoke test of the static deployment adapters against the real providers (HeoPress P11 tasks 4.1, 4.2, 4.4).
 * Not run in CI: it needs credentials. It uploads a tiny fixture site (pages, a noindex page, a Markdown copy, a feed,
 * a redirect and a withdrawn address) through the same adapter and static response contract the worker uses, waits
 * until the deployment is live, then requests the live addresses and checks the answers.
 *
 *   pnpm --filter @heopress/cms exec tsx scripts/p11-deploy-smoke.ts <cloudflare-pages|vercel|netlify> [--transcript]
 *
 * Environment (read only here, never printed):
 *   HEOPRESS_SMOKE_TOKEN      the provider token (Cloudflare: API token with "Cloudflare Pages: Edit")
 *   HEOPRESS_SMOKE_PROJECT    Cloudflare `<accountId>/<project>`, Vercel `[team_x/]<project>`, Netlify site id
 *   HEOPRESS_SMOKE_ORIGIN     optional: the production address to check (default: the deployment's own URL)
 *
 * `--transcript` prints the adapter's normalized answers (ids, states, URLs; no token) as JSON, to refresh the recorded
 * responses under `src/services/deployment/__tests__/recordings/`. Exit code 0 when every check passes.
 */
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { getProvider, TERMINAL_STATUSES, type StaticFile } from '../src/services/deployment/providers';
import { renderContract, staticContractOf, type StaticPlatform } from '../src/services/deployment/static/contract';
import { contentTypeOf } from '../src/services/deployment/static/static-deployer';

const platform = process.argv[2] as StaticPlatform;
const transcript = process.argv.includes('--transcript');
const token = process.env.HEOPRESS_SMOKE_TOKEN ?? '';
const projectId = process.env.HEOPRESS_SMOKE_PROJECT ?? '';
if (!['cloudflare-pages', 'vercel', 'netlify'].includes(platform) || !token || !projectId) {
  console.error('usage: HEOPRESS_SMOKE_TOKEN=… HEOPRESS_SMOKE_PROJECT=… tsx scripts/p11-deploy-smoke.ts <cloudflare-pages|vercel|netlify> [--transcript]');
  process.exit(2);
}

const html = (title: string, robots = '') => `<!doctype html><html><head><title>${title}</title>${robots}</head><body><h1>${title}</h1></body></html>`;
const snapshot = {
  version: 1,
  siteId: 'smoke',
  revision: 1,
  host: 'www.example.com',
  origin: 'https://www.example.com',
  name: 'Smoke',
  defaultLanguage: 'en',
  pages: [
    { path: '/', status: 200, vm: {}, headHtml: '', bodies: {}, disclosureRequired: false, disclosures: {}, xRobotsTag: null },
    { path: '/members/', status: 200, vm: {}, headHtml: '<meta name="robots" content="noindex">', bodies: {}, disclosureRequired: false, disclosures: {}, xRobotsTag: 'noindex' },
  ],
  notFound: null,
  files: [
    { path: '/hello.md', contentType: 'text/markdown; charset=utf-8', body: '# Hello\n', headers: { 'x-robots-tag': 'noindex', link: '<https://www.example.com/hello/>; rel="canonical"' } },
    { path: '/feed.xml', contentType: 'application/rss+xml; charset=utf-8', body: '<rss version="2.0"><channel><title>Smoke</title></channel></rss>', headers: {} },
  ],
  routes: [
    { path: '/old/', status: 301, location: '/hello/' },
    { path: '/withdrawn/', status: 410 },
  ],
  unsupported: [],
} as unknown as PageDataSnapshot;

const files: StaticFile[] = [
  ['/index.html', html('Smoke')],
  ['/hello/index.html', html('Hello')],
  ['/members/index.html', html('Members', '<meta name="robots" content="noindex">')],
  ['/404.html', html('Not found')],
  ...snapshot.files.map((f) => [f.path, f.body] as [string, string]),
].map(([path, body]) => ({ path, bytes: Buffer.from(body), contentType: contentTypeOf(path) }));
const rendered = renderContract(platform, staticContractOf(snapshot));
for (const f of rendered.files) files.push({ path: `/${f.path}`, bytes: Buffer.from(f.body), contentType: contentTypeOf(f.path) });

const provider = getProvider(platform)!;
const target = { provider: platform, projectId };
const log: unknown[] = [];
const marker = `heopress-smoke-${Date.now()}`;

const verify = await provider.verifyToken(token, target);
log.push({ step: 'verify', ...verify });
if (!verify.ok) throw new Error(`verify failed: ${verify.reason}`);
let ref = await provider.deployStatic!(token, target, files, { marker });
log.push({ step: 'deploy', ref });
for (let i = 0; i < 120 && !TERMINAL_STATUSES.has(ref.status); i++) {
  await new Promise((r) => setTimeout(r, 5000));
  ref = await provider.getStatus(token, target, ref.providerDeploymentId);
}
log.push({ step: 'final', ref });
log.push({ step: 'findByMarker', ref: await provider.findByMarker!(token, target, marker) });
if (ref.status !== 'ready') {
  log.push({ step: 'logs', log: (await provider.getLogs(token, target, ref.providerDeploymentId).catch((e: Error) => e.message)).slice(-2000) });
}

const origin = (process.env.HEOPRESS_SMOKE_ORIGIN ?? ref.url ?? '').replace(/\/+$/, '');
const checks: Array<{ path: string; ok: boolean; got: string }> = [];
const check = async (path: string, want: (r: Response) => boolean) => {
  const res = await fetch(`${origin}${path}`, { redirect: 'manual' });
  const got = `${res.status} type=${res.headers.get('content-type')} robots=${res.headers.get('x-robots-tag')} link=${res.headers.get('link')} location=${res.headers.get('location')}`;
  checks.push({ path, ok: want(res), got });
};
if (ref.status === 'ready' && origin) {
  await check('/', (r) => r.status === 200);
  await check('/members/', (r) => r.status === 200 && /noindex/.test(r.headers.get('x-robots-tag') ?? ''));
  await check('/hello.md', (r) => r.status === 200 && (r.headers.get('content-type') ?? '').startsWith('text/markdown') && /noindex/.test(r.headers.get('x-robots-tag') ?? ''));
  await check('/hello.md', (r) => /rel="canonical"/.test(r.headers.get('link') ?? ''));
  await check('/feed.xml', (r) => r.status === 200 && (r.headers.get('content-type') ?? '').startsWith('application/rss+xml'));
  await check('/old/', (r) => r.status === 301 && (r.headers.get('location') ?? '').endsWith('/hello/'));
  await check('/withdrawn/', (r) => (platform === 'cloudflare-pages' ? r.status === 404 : r.status === 410));
}

if (transcript) console.log(JSON.stringify({ platform, warnings: rendered.warnings, log }, null, 2));
console.log(JSON.stringify({ platform, status: ref.status, url: ref.url, checks }, null, 2));
process.exit(ref.status === 'ready' && checks.length > 0 && checks.every((c) => c.ok) ? 0 : 1);
