import type { DeploymentProvider, DeploymentRef, DeploymentStatus, ProviderTarget, StaticFile } from './provider';
import { bearer, guardedFetch } from './http';
import { blake3Hex } from '../static/blake3';

const API = 'https://api.cloudflare.com/client/v4';

/**
 * Cloudflare Pages adapter, Direct Upload (HeoPress P11 task 4.1; spec publishing/frontend-deployments "部署到 Cloudflare
 * Pages"): Cloudflare does not build — the static output is uploaded as Wrangler's `pages deploy` does it
 * (workers-sdk `packages/wrangler/src/pages/upload.ts`, `src/api/pages/deploy.ts`, checked 2026-10-28):
 *
 *   1. `GET  /accounts/{account}/pages/projects/{project}/upload-token` → `{ jwt }` (the asset calls use it, not the token);
 *   2. `POST /pages/assets/check-missing` `{ hashes }` → the hashes Cloudflare does not hold yet;
 *   3. `POST /pages/assets/upload` `[{ key, value (base64), metadata: { contentType }, base64: true }]`, in buckets
 *      (≤ 40 MiB, ≤ 2000 files);
 *   4. `POST /pages/assets/upsert-hashes` `{ hashes }` (all of them);
 *   5. `POST /accounts/{account}/pages/projects/{project}/deployments` multipart: `manifest` (`{"/path": hash}`), `branch`
 *      (the project's production branch), `commit_message` (our marker), `_headers`, `_redirects`.
 *
 * An asset's key is `blake3(base64(content) + extension)`, hex, first 32 characters (`@cloudflare/deploy-helpers`
 * `hashFile`). `projectId` is `<accountId>/<projectName>`; the token is an API token with "Cloudflare Pages: Edit".
 * A deployment is live once its `latest_stage` is `deploy` with `success`; a failed one never replaces production.
 */

const CF_MAX_ASSET_BYTES = 25 * 1024 * 1024;
const CF_MAX_FILES = 20_000;
const BUCKET_BYTES = 40 * 1024 * 1024;
const BUCKET_FILES = 2000;
/** Files Cloudflare reads as configuration: sent as form fields, never as assets. */
const CONFIG = new Set(['/_headers', '/_redirects', '/_routes.json']);

function parseCfProject(projectId: string): { account: string; project: string } {
  const m = /^([0-9a-f]{32})\/([a-z0-9][a-z0-9-]{0,57})$/i.exec(projectId.trim());
  if (!m) throw new Error('Cloudflare Pages target: projectId must be "<accountId>/<projectName>".');
  return { account: m[1]!, project: m[2]!.toLowerCase() };
}

/** Wrangler's asset key. */
export function cfAssetHash(bytes: Uint8Array, path: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1] ?? '';
  return blake3Hex(Buffer.from(bytes).toString('base64') + ext).slice(0, 32);
}

interface CfEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

async function cf<T>(url: string, init: RequestInit & { token: string }): Promise<T> {
  const { token, ...rest } = init;
  const res = await guardedFetch(url, { ...rest, headers: { ...bearer(token), ...(rest.headers as Record<string, string> | undefined) }, timeoutMs: 120_000 });
  const json = (await res.json().catch(() => ({}))) as CfEnvelope<T>;
  if (!res.ok || json.success === false) {
    const msg = (json.errors ?? []).map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ');
    throw new Error(`Cloudflare Pages ${new URL(url).pathname.replace(/^\/client\/v4/, '')} failed (${res.status})${msg ? `: ${msg}` : ''}`);
  }
  return json.result as T;
}

/** `latest_stage` → normalized status. */
export function mapCfStatus(stage: { name?: string; status?: string } | undefined): DeploymentStatus {
  const status = (stage?.status ?? '').toLowerCase();
  if (status === 'failure') return 'error';
  if (status === 'canceled' || status === 'cancelled' || status === 'skipped') return 'canceled';
  if ((stage?.name ?? '').toLowerCase() === 'deploy' && status === 'success') return 'ready';
  if (status === 'idle' && (stage?.name ?? '') === 'queued') return 'queued';
  return 'building';
}

function toRef(d: Record<string, unknown>): DeploymentRef {
  const status = mapCfStatus(d['latest_stage'] as { name?: string; status?: string } | undefined);
  const trigger = (d['deployment_trigger'] ?? {}) as { metadata?: { branch?: string; commit_hash?: string; commit_message?: string } };
  return {
    providerDeploymentId: String(d['id'] ?? ''),
    status,
    url: typeof d['url'] === 'string' ? (d['url'] as string) : undefined,
    branch: trigger.metadata?.branch,
    commitSha: trigger.metadata?.commit_hash,
    commitMessage: trigger.metadata?.commit_message,
    completedAt: status === 'ready' || status === 'error' || status === 'canceled' ? new Date() : undefined,
  };
}

const projectUrl = (t: ProviderTarget) => {
  const { account, project } = parseCfProject(t.projectId);
  return `${API}/accounts/${account}/pages/projects/${encodeURIComponent(project)}`;
};

export const cloudflarePagesProvider: DeploymentProvider = {
  key: 'cloudflare-pages',

  async verifyToken(token, target) {
    let url: string;
    try {
      url = projectUrl(target);
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    const res = await guardedFetch(url, { headers: bearer(token) });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Invalid Cloudflare API token (it needs Cloudflare Pages: Edit).' };
    if (res.status === 404) return { ok: false, reason: 'Cloudflare Pages project not found.' };
    return { ok: false, reason: `Cloudflare Pages verify failed (${res.status}).` };
  },

  trigger() {
    return Promise.reject(new Error('Cloudflare Pages targets deploy the static output of the Astro engine (Direct Upload); there is no build to trigger.'));
  },

  async getStatus(token, target, id) {
    return toRef(await cf<Record<string, unknown>>(`${projectUrl(target)}/deployments/${encodeURIComponent(id)}`, { token }));
  },

  async getLogs(token, target, id) {
    const r = await cf<{ data?: Array<{ line?: string }> }>(`${projectUrl(target)}/deployments/${encodeURIComponent(id)}/history/logs`, { token });
    return (r.data ?? []).map((l) => l.line ?? '').join('\n');
  },

  verifyWebhook() {
    return Promise.resolve(false);
  },

  parseWebhook() {
    return null;
  },

  async deployStatic(token, target, files: StaticFile[], opts) {
    const base = projectUrl(target);
    const project = await cf<{ production_branch?: string }>(base, { token });
    const assets = files.filter((f) => !CONFIG.has(f.path));
    if (assets.length > CF_MAX_FILES) throw new Error(`Cloudflare Pages accepts at most ${CF_MAX_FILES} files; the output has ${assets.length}.`);
    const hashed = assets.map((f) => {
      if (f.bytes.byteLength > CF_MAX_ASSET_BYTES) throw new Error(`${f.path}: over Cloudflare Pages' 25 MiB file limit.`);
      return { ...f, hash: cfAssetHash(f.bytes, f.path) };
    });
    const { jwt } = await cf<{ jwt: string }>(`${base}/upload-token`, { token });
    const asset = (path: string, body: unknown) =>
      cf<unknown>(`${API}/pages/assets/${path}`, { token: jwt, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const unique = [...new Map(hashed.map((h) => [h.hash, h])).values()];
    const missing = new Set((await asset('check-missing', { hashes: unique.map((h) => h.hash) })) as string[]);
    let bucket: typeof unique = [];
    let bytes = 0;
    const flush = async () => {
      if (!bucket.length) return;
      await asset(
        'upload',
        bucket.map((f) => ({ key: f.hash, value: Buffer.from(f.bytes).toString('base64'), metadata: { contentType: f.contentType }, base64: true })),
      );
      bucket = [];
      bytes = 0;
    };
    for (const f of unique.filter((u) => missing.has(u.hash))) {
      if (bucket.length >= BUCKET_FILES || bytes + f.bytes.byteLength > BUCKET_BYTES) await flush();
      bucket.push(f);
      bytes += f.bytes.byteLength;
    }
    await flush();
    await asset('upsert-hashes', { hashes: unique.map((h) => h.hash) });
    const form = new FormData();
    form.append('manifest', JSON.stringify(Object.fromEntries(hashed.map((h) => [h.path, h.hash]))));
    form.append('branch', project.production_branch ?? 'main');
    form.append('commit_message', opts.marker);
    form.append('commit_dirty', 'false');
    for (const f of files.filter((x) => CONFIG.has(x.path))) {
      form.append(f.path.slice(1), new File([Buffer.from(f.bytes)], f.path.slice(1)));
    }
    return toRef(await cf<Record<string, unknown>>(`${base}/deployments`, { token, method: 'POST', body: form }));
  },

  async findByMarker(token, target, marker) {
    const list = await cf<Array<Record<string, unknown>>>(`${projectUrl(target)}/deployments?env=production&per_page=25`, { token });
    const hit = (list ?? []).find((d) => (d['deployment_trigger'] as { metadata?: { commit_message?: string } } | undefined)?.metadata?.commit_message === marker);
    return hit ? toRef(hit) : null;
  },
};
