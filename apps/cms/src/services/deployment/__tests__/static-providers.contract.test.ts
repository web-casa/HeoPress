import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Contract tests of the static deployment adapters against recorded responses (HeoPress P11 tasks 4.1, 4.2): each
 * adapter's requests (method, URL, headers, body) are checked against what the provider documents, and its handling
 * of the recorded answers (success, in progress, failure, lookup by marker). The recordings are in `recordings/`; the
 * manual smoke script (`apps/cms/scripts/p11-deploy-smoke.ts --transcript`) prints a real deployment's answers to refresh them.
 */

interface Interaction {
  method: string;
  url: string;
  status: number;
  response: unknown;
}
interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

const calls: Call[] = [];
let script: Interaction[] = [];
let subst: Record<string, unknown> = {};

vi.mock('../providers/http', async (orig) => {
  const real = await orig<typeof import('../providers/http')>();
  return {
    ...real,
    guardedFetch: vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      calls.push({ url, method, headers: { ...(init.headers as Record<string, string>) }, body: init.body });
      const i = script.findIndex((x) => x.method === method && x.url === url);
      if (i < 0) throw new Error(`unrecorded request ${method} ${url}`);
      const [hit] = script.splice(i, 1);
      const body = JSON.stringify(hit!.response, (_k, v: unknown) => (typeof v === 'string' && v in subst ? subst[v] : v));
      return new Response(body, { status: hit!.status, headers: { 'content-type': 'application/json' } });
    }),
  };
});

const { cloudflarePagesProvider, cfAssetHash, mapCfStatus } = await import('../providers/cloudflare-pages');
const { vercelProvider } = await import('../providers/vercel');
const { netlifyProvider } = await import('../providers/netlify');

const load = (name: string) => (JSON.parse(readFileSync(join(import.meta.dirname, 'recordings', `${name}.json`), 'utf8')) as { interactions: Interaction[] }).interactions;
const file = (path: string, body: string) => ({ path, bytes: Buffer.from(body), contentType: path.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain' });
const FILES = [file('/index.html', '<h1>Hi</h1>'), file('/robots.txt', 'User-agent: *\n'), file('/_headers', '/*.md\n  X-Robots-Tag: noindex\n'), file('/_redirects', '/old/ /new/ 301\n')];

beforeEach(() => {
  calls.length = 0;
  subst = {};
});

describe('Cloudflare Pages (Direct Upload)', () => {
  const target = { provider: 'cloudflare-pages', projectId: '0123456789abcdef0123456789abcdef/heo-docs' };

  it('asset keys are Wrangler\'s: blake3(base64 + extension), 32 hex', () => {
    const k = cfAssetHash(Buffer.from('<h1>Hi</h1>'), '/index.html');
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(cfAssetHash(Buffer.from('<h1>Hi</h1>'), '/index.htm')).not.toBe(k);
  });

  it('uploads the missing assets with the upload JWT, then creates the deployment with manifest, branch, marker and config files', async () => {
    script = load('cloudflare-pages');
    const html = cfAssetHash(FILES[0]!.bytes, '/index.html');
    subst = { $MISSING_FIRST: [html] };
    const ref = await cloudflarePagesProvider.deployStatic!('cf-test-token', target, FILES, { marker: 'heopress-site_a-dep1' });
    expect(ref).toMatchObject({ providerDeploymentId: 'f64788e9-fccd-4d4a-a28a-cb84f88f6a7a', status: 'building', url: 'https://f64788e9.heo-docs.pages.dev' });

    const byPath = (p: string) => calls.find((c) => c.url.endsWith(p))!;
    expect(byPath('/upload-token').headers.Authorization).toBe('Bearer cf-test-token');
    // The asset calls carry the JWT, never the API token.
    for (const p of ['/check-missing', '/assets/upload', '/upsert-hashes']) expect(byPath(p).headers.Authorization).toBe('Bearer jwt-fake');
    const upload = JSON.parse(byPath('/assets/upload').body as string) as Array<Record<string, unknown>>;
    expect(upload).toEqual([{ key: html, value: FILES[0]!.bytes.toString('base64'), metadata: { contentType: 'text/html; charset=utf-8' }, base64: true }]);
    expect((JSON.parse(byPath('/upsert-hashes').body as string) as { hashes: string[] }).hashes).toHaveLength(2);

    const form = byPath('/deployments').body as FormData;
    expect(JSON.parse(form.get('manifest') as string)).toEqual({ '/index.html': html, '/robots.txt': cfAssetHash(FILES[1]!.bytes, '/robots.txt') });
    expect(form.get('branch')).toBe('main');
    expect(form.get('commit_message')).toBe('heopress-site_a-dep1');
    expect(await (form.get('_headers') as File).text()).toContain('X-Robots-Tag: noindex');
    expect(await (form.get('_redirects') as File).text()).toBe('/old/ /new/ 301\n');
  });

  it('status: live when the deploy stage succeeded; a failure stage is an error', async () => {
    script = load('cloudflare-pages');
    expect(await cloudflarePagesProvider.getStatus('cf-test-token', target, 'f64788e9-fccd-4d4a-a28a-cb84f88f6a7a')).toMatchObject({ status: 'ready' });
    expect((await cloudflarePagesProvider.getStatus('cf-test-token', target, 'bad1')).status).toBe('error');
    expect(mapCfStatus({ name: 'build', status: 'active' })).toBe('building');
  });

  it('a lost confirmation is found by its marker', async () => {
    script = load('cloudflare-pages');
    expect(await cloudflarePagesProvider.findByMarker!('cf-test-token', target, 'heopress-site_a-dep1')).toMatchObject({ providerDeploymentId: 'f64788e9-fccd-4d4a-a28a-cb84f88f6a7a', status: 'ready' });
    script = load('cloudflare-pages');
    expect(await cloudflarePagesProvider.findByMarker!('cf-test-token', target, 'heopress-other')).toBeNull();
  });

  it('verify: a missing project is said plainly; a malformed project id never reaches the network', async () => {
    script = load('cloudflare-pages');
    expect(await cloudflarePagesProvider.verifyToken('cf-test-token', { ...target, projectId: '0123456789abcdef0123456789abcdef/missing' })).toEqual({ ok: false, reason: 'Cloudflare Pages project not found.' });
    expect((await cloudflarePagesProvider.verifyToken('cf-test-token', { ...target, projectId: 'heo-docs' })).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('Vercel (files + deployments)', () => {
  const target = { provider: 'vercel', projectId: 'team_abc123/prj_heo' };

  it('uploads each file by SHA-1 and creates a production deployment without a build, marker in meta', async () => {
    script = load('vercel');
    script.push(...load('vercel').filter((x) => x.url.includes('/v2/files')), ...load('vercel').filter((x) => x.url.includes('/v2/files')), ...load('vercel').filter((x) => x.url.includes('/v2/files')));
    const ref = await vercelProvider.deployStatic!('vc-test-token', target, FILES, { marker: 'heopress-site_a-dep2' });
    expect(ref).toMatchObject({ providerDeploymentId: 'dpl_89qyp1cskzkLrVicDaZoDbjyHuDJ', status: 'queued', url: 'https://heo-docs-abc123.vercel.app' });
    const uploads = calls.filter((c) => c.url.includes('/v2/files'));
    expect(uploads).toHaveLength(4);
    expect(uploads[0]!.headers['x-vercel-digest']).toBe(createHash('sha1').update(FILES[0]!.bytes).digest('hex'));
    expect(uploads[0]!.headers['Content-Length']).toBe(String(FILES[0]!.bytes.byteLength));
    const body = JSON.parse(calls.find((c) => c.url.includes('/v13/deployments'))!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'prj_heo', project: 'prj_heo', target: 'production', meta: { heopressMarker: 'heopress-site_a-dep2' }, projectSettings: { framework: null } });
    expect((body['files'] as Array<Record<string, unknown>>)[0]).toEqual({ file: 'index.html', sha: createHash('sha1').update(FILES[0]!.bytes).digest('hex'), size: FILES[0]!.bytes.byteLength });
    expect(await vercelProvider.getStatus('vc-test-token', target, 'dpl_89qyp1cskzkLrVicDaZoDbjyHuDJ')).toMatchObject({ status: 'ready' });
  });

  it('an API error is reported with its message', async () => {
    script = load('vercel').filter((x) => x.status !== 200 || x.url.includes('/v2/files'));
    script.push(...script, ...script, ...script);
    await expect(vercelProvider.deployStatic!('vc-test-token', target, FILES, { marker: 'm' })).rejects.toThrow(/Vercel deployment failed \(400\): Missing files/);
  });

  it('lookup by marker, and the Git trigger redeploys the latest production deployment (a gitSource with only a ref is refused by the API)', async () => {
    script = load('vercel');
    expect(await vercelProvider.findByMarker!('vc-test-token', target, 'heopress-site_a-dep2')).toMatchObject({ providerDeploymentId: 'dpl_89qyp1cskzkLrVicDaZoDbjyHuDJ', status: 'ready' });
    const ref = await vercelProvider.trigger('vc-test-token', target, {});
    expect(ref.providerDeploymentId).toBe('dpl_redeploy');
    const body = JSON.parse(calls.at(-1)!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ deploymentId: 'dpl_prev', target: 'production' });
    expect(body).not.toHaveProperty('gitSource');
  });
});

describe('Netlify (file digest deploy)', () => {
  const target = { provider: 'netlify', projectId: '3970e0fe-8564-4903-9a55-c5f8de49fb8b' };

  it('posts the digests with the marker as title, uploads only what is required, as octet-stream', async () => {
    script = load('netlify');
    const sha = createHash('sha1').update(FILES[0]!.bytes).digest('hex');
    subst = { $REQUIRED_FIRST: [sha] };
    const ref = await netlifyProvider.deployStatic!('nf-test-token', target, FILES, { marker: 'heopress-site_a-dep3' });
    expect(ref).toMatchObject({ providerDeploymentId: '5f2a1b0c9d8e7f6a5b4c3d2e', status: 'building' });
    const create = JSON.parse(calls[0]!.body as string) as { files: Record<string, string>; title: string };
    expect(create.title).toBe('heopress-site_a-dep3');
    expect(Object.keys(create.files).sort()).toEqual(['/_headers', '/_redirects', '/index.html', '/robots.txt']);
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.url)).toEqual(['https://api.netlify.com/api/v1/deploys/5f2a1b0c9d8e7f6a5b4c3d2e/files/index.html']);
    expect(puts[0]!.headers['Content-Type']).toBe('application/octet-stream');
    expect(await netlifyProvider.getStatus('nf-test-token', target, '5f2a1b0c9d8e7f6a5b4c3d2e')).toMatchObject({ status: 'ready' });
  });

  it('a failed deploy: error state, and the log is its error and summary (no undocumented log endpoint)', async () => {
    script = load('netlify');
    expect(await netlifyProvider.getStatus('nf-test-token', target, 'err1')).toMatchObject({ status: 'error', errorMessage: expect.stringContaining('upload interrupted') });
    script = load('netlify');
    expect(await netlifyProvider.getLogs('nf-test-token', target, 'err1')).toBe("error: Failed during stage 'deploying site': upload interrupted\nerror: Deploy failed upload interrupted");
  });

  it('lookup by marker', async () => {
    script = load('netlify');
    expect(await netlifyProvider.findByMarker!('nf-test-token', target, 'heopress-site_a-dep3')).toMatchObject({ providerDeploymentId: '5f2a1b0c9d8e7f6a5b4c3d2e' });
  });
});
