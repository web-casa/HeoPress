// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { createHash } from 'node:crypto';
import type {
  DeploymentProvider,
  DeploymentRef,
  DeploymentStatus,
  InboundRequest,
  TriggerOptions,
} from './provider';
import {
  bearer,
  decodeJwsPayload,
  guardedFetch,
  sha256Hex,
  timingSafeEqual,
  verifyJwsHs256,
} from './http';

const API = 'https://api.netlify.com/api/v1';

/**
 * Netlify adapter (design §4; checked against the API reference and "Get started with the Netlify API" 2026-10-28,
 * HeoPress P11 task 4.2). Token is a personal access token; `projectId` is the site id.
 *
 *   - verify `GET /sites/{site_id}`; trigger (Git sites) `POST /sites/{site_id}/builds`;
 *   - static output (P11), the file digest method: `POST /sites/{site_id}/deploys` `{ files: { "/path": sha1 }, title }`
 *     → `{ id, required: [sha1…] }`, then `PUT /deploys/{deploy_id}/files/{path}` (`application/octet-stream`) for each
 *     required digest; the deploy is live when its `state` is `ready`. `_headers` / `_redirects` are files of the deploy;
 *   - status `GET /sites/{site_id}/deploys/{deploy_id}`; there is no public build-log endpoint (the old
 *     `/deploys/{id}/log` is not in the API): the log is the deploy's `error_message` and summary messages;
 *   - lookup `GET /sites/{site_id}/deploys?per_page=20` by `title`.
 */

/** Map Netlify `state` → normalized status (design §3.3). */
export function mapNetlifyStatus(state: string | undefined): DeploymentStatus {
  switch ((state ?? '').toLowerCase()) {
    case 'new':
    case 'enqueued':
    case 'pending_review':
      return 'queued';
    case 'building':
    case 'uploading':
    case 'uploaded':
    case 'preparing':
    case 'prepared':
    case 'processing':
      return 'building';
    case 'ready':
    case 'current':
      return 'ready';
    case 'error':
    case 'failed':
      return 'error';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    default:
      return 'queued';
  }
}

function toRef(d: Record<string, unknown>): DeploymentRef {
  const status = mapNetlifyStatus(d['state'] as string | undefined);
  return {
    providerDeploymentId: String(d['id'] ?? ''),
    status,
    url: (d['deploy_ssl_url'] ?? d['ssl_url'] ?? d['url']) as string | undefined,
    branch: d['branch'] as string | undefined,
    commitSha: d['commit_ref'] as string | undefined,
    commitMessage: undefined,
    errorMessage: d['error_message'] as string | undefined,
    completedAt:
      status === 'ready' || status === 'error' || status === 'canceled' ? new Date() : undefined,
  };
}

export const netlifyProvider: DeploymentProvider = {
  key: 'netlify',

  async verifyToken(token, target) {
    const res = await guardedFetch(`${API}/sites/${encodeURIComponent(target.projectId)}`, {
      headers: bearer(token),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401) return { ok: false, reason: 'Invalid Netlify token.' };
    if (res.status === 404) return { ok: false, reason: 'Netlify site not found.' };
    return { ok: false, reason: `Netlify verify failed (${res.status}).` };
  },

  async trigger(token, target, opts: TriggerOptions) {
    const body: Record<string, unknown> = {};
    if (opts.branch ?? target.defaultBranch) body['branch'] = opts.branch ?? target.defaultBranch;
    const res = await guardedFetch(`${API}/sites/${encodeURIComponent(target.projectId)}/builds`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Netlify trigger failed (${res.status}).`);
    // A build references its deploy; surface the deploy id when present.
    const deployId = json['deploy_id'] ?? json['id'];
    return {
      providerDeploymentId: String(deployId ?? ''),
      status: 'queued',
    };
  },

  async getStatus(token, target, providerDeploymentId) {
    const res = await guardedFetch(
      `${API}/sites/${encodeURIComponent(target.projectId)}/deploys/${encodeURIComponent(providerDeploymentId)}`,
      { headers: bearer(token) },
    );
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Netlify status failed (${res.status}).`);
    return toRef(json);
  },

  async getLogs(token, target, providerDeploymentId) {
    const res = await guardedFetch(
      `${API}/sites/${encodeURIComponent(target.projectId)}/deploys/${encodeURIComponent(providerDeploymentId)}`,
      { headers: bearer(token) },
    );
    if (!res.ok) throw new Error(`Netlify logs failed (${res.status}).`);
    const d = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const messages = (((d['summary'] as Record<string, unknown> | undefined)?.['messages'] ?? []) as Array<Record<string, unknown>>).map(
      (m) => `${String(m['type'] ?? 'info')}: ${String(m['title'] ?? '')} ${String(m['description'] ?? '')}`.trim(),
    );
    return [d['error_message'] ? `error: ${String(d['error_message'])}` : '', ...messages].filter(Boolean).join('\n');
  },

  async verifyWebhook(req: InboundRequest, secret: string) {
    // Netlify signs outgoing notifications with a compact JWS (HS256) in
    // `x-webhook-signature`, keyed by the per-site configured secret. Two steps,
    // both required: the JWS signature must verify under the secret, AND the
    // JWS payload must bind to *these* body bytes. Verifying the signature
    // alone would let a JWS captured from one notification authenticate a
    // different body, since the body is not part of the signing input.
    // An empty secret or a missing/malformed JWS is rejected.
    const sig = req.headers['x-webhook-signature'];
    if (!sig || !secret) return false;
    if (!(await verifyJwsHs256(sig, secret))) return false;

    const payload = decodeJwsPayload(sig);
    if (payload === null) return false;
    // Documented form: `{ "sha256": "<hex digest of the raw body>" }`.
    try {
      const claims = JSON.parse(payload) as Record<string, unknown>;
      const claimed = claims['sha256'];
      if (typeof claimed === 'string') {
        return timingSafeEqual(claimed.toLowerCase(), await sha256Hex(req.rawBody));
      }
    } catch {
      // Not JSON — fall through to the literal-body form below.
    }
    // Tolerated variant: the payload *is* the raw body. Still binds the
    // signature to the bytes, so it is safe to accept.
    return timingSafeEqual(payload, req.rawBody);
  },

  parseWebhook(rawBody: string) {
    try {
      const d = JSON.parse(rawBody) as Record<string, unknown>;
      const id = String(d['id'] ?? '');
      if (!id) return null;
      return toRef(d);
    } catch {
      return null;
    }
  },

  async deployStatic(token, target, files, opts) {
    const digests = new Map<string, string>();
    const bySha = new Map<string, (typeof files)[number]>();
    for (const f of files) {
      if (/[#?]/.test(f.path)) throw new Error(`${f.path}: Netlify file paths cannot contain # or ?.`);
      const sha = createHash('sha1').update(f.bytes).digest('hex');
      digests.set(f.path, sha);
      if (!bySha.has(sha)) bySha.set(sha, f);
    }
    const res = await guardedFetch(`${API}/sites/${encodeURIComponent(target.projectId)}/deploys`, {
      method: 'POST',
      headers: { ...bearer(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: Object.fromEntries(digests), title: opts.marker, draft: false }),
      timeoutMs: 60_000,
    });
    const deploy = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Netlify deploy failed (${res.status}): ${String(deploy['message'] ?? '')}`);
    const id = String(deploy['id'] ?? '');
    for (const sha of (deploy['required'] ?? []) as string[]) {
      const f = bySha.get(sha);
      if (!f) continue;
      const path = f.path.split('/').map(encodeURIComponent).join('/');
      const up = await guardedFetch(`${API}/deploys/${encodeURIComponent(id)}/files${path}`, {
        method: 'PUT',
        headers: { ...bearer(token), 'Content-Type': 'application/octet-stream' },
        body: Buffer.from(f.bytes),
        timeoutMs: 120_000,
      });
      if (!up.ok) throw new Error(`Netlify upload of ${f.path} failed (${up.status}).`);
    }
    return toRef(deploy);
  },

  async findByMarker(token, target, marker) {
    const res = await guardedFetch(`${API}/sites/${encodeURIComponent(target.projectId)}/deploys?per_page=20`, { headers: bearer(token) });
    if (!res.ok) throw new Error(`Netlify lookup failed (${res.status}).`);
    const list = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
    const hit = list.find((d) => d['title'] === marker);
    return hit ? toRef(hit) : null;
  },
};
