// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { createHash } from 'node:crypto';
import type {
  DeploymentProvider,
  DeploymentRef,
  DeploymentStatus,
  InboundRequest,
  ProviderTarget,
  TriggerOptions,
} from './provider';
import { bearer, guardedFetch, hmacHex, timingSafeEqual } from './http';

const API = 'https://api.vercel.com';

/**
 * Vercel adapter (design §4; checked against the REST reference 2026-10-28, HeoPress P11 task 4.2). Token is a Vercel
 * access token; `projectId` is the project id or name, optionally `<teamId>/<project>` (the calls then carry `teamId`).
 *
 *   - verify: `GET /v9/projects/{idOrName}`;
 *   - trigger (Git projects): `POST /v13/deployments` redeploying the latest production deployment (`deploymentId`) —
 *     the previous body sent a `gitSource` with only a `ref`, which the API refuses (it needs the repository);
 *   - static output (P11): each file `POST /v2/files` (`x-vercel-digest`: SHA-1), then `POST /v13/deployments` with
 *     `files: [{ file, sha, size }]`, `target: production`, `projectSettings.framework: null` (no build) and the marker in
 *     `meta.heopressMarker`; `vercel.json` (the static response contract's routes) is one of the files;
 *   - status `GET /v13/deployments/{id}` (`readyState`), events `GET /v3/deployments/{id}/events`, lookup
 *     `GET /v6/deployments?projectId=…&target=production`.
 */

/** Map Vercel `readyState` → normalized status (design §3.3). */
export function mapVercelStatus(readyState: string | undefined): DeploymentStatus {
  switch ((readyState ?? '').toUpperCase()) {
    case 'QUEUED':
    case 'INITIALIZING':
      return 'queued';
    case 'BUILDING':
      return 'building';
    case 'READY':
      return 'ready';
    case 'CANCELED':
      return 'canceled';
    case 'ERROR':
    default:
      return (readyState ?? '').toUpperCase() === 'ERROR' ? 'error' : 'queued';
  }
}

function toRef(d: Record<string, unknown>): DeploymentRef {
  const status = mapVercelStatus(d['readyState'] as string | undefined);
  const meta = (d['meta'] ?? {}) as Record<string, unknown>;
  return {
    providerDeploymentId: String(d['uid'] ?? d['id'] ?? ''),
    status,
    url: d['url'] ? `https://${String(d['url'])}` : undefined,
    branch: meta['githubCommitRef'] as string | undefined,
    commitSha: meta['githubCommitSha'] as string | undefined,
    commitMessage: meta['githubCommitMessage'] as string | undefined,
    completedAt:
      status === 'ready' || status === 'error' || status === 'canceled' ? new Date() : undefined,
  };
}

function split(projectId: string): { project: string; qs: string } {
  const m = /^(team_[A-Za-z0-9]+)\/(.+)$/.exec(projectId);
  return m ? { project: m[2]!, qs: `teamId=${encodeURIComponent(m[1]!)}` } : { project: projectId, qs: '' };
}
const withQs = (url: string, qs: string) => (qs ? `${url}${url.includes('?') ? '&' : '?'}${qs}` : url);

async function vercelJson(res: Response, what: string): Promise<Record<string, unknown>> {
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Vercel ${what} failed (${res.status}): ${String((json['error'] as Record<string, unknown>)?.['message'] ?? '')}`);
  return json;
}

export const vercelProvider: DeploymentProvider = {
  key: 'vercel',

  async verifyToken(token, target) {
    const { project, qs } = split(target.projectId);
    const res = await guardedFetch(withQs(`${API}/v9/projects/${encodeURIComponent(project)}`, qs), {
      headers: bearer(token),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'Invalid Vercel token.' };
    if (res.status === 404) return { ok: false, reason: 'Vercel project not found.' };
    return { ok: false, reason: `Vercel verify failed (${res.status}).` };
  },

  async trigger(token, target, opts: TriggerOptions) {
    const { project, qs } = split(target.projectId);
    const latest = await vercelJson(
      await guardedFetch(withQs(`${API}/v6/deployments?projectId=${encodeURIComponent(project)}&target=production&limit=1`, qs), { headers: bearer(token) }),
      'trigger',
    );
    const last = ((latest['deployments'] ?? []) as Array<Record<string, unknown>>)[0];
    if (!last) throw new Error('Vercel trigger failed: the project has no production deployment to redeploy.');
    const json = await vercelJson(
      await guardedFetch(withQs(`${API}/v13/deployments`, qs), {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: project, project, target: 'production', deploymentId: last['uid'], meta: opts.reason ? { heopressReason: opts.reason.slice(0, 200) } : undefined }),
      }),
      'trigger',
    );
    return toRef(json);
  },

  async getStatus(token, target, providerDeploymentId) {
    const res = await guardedFetch(withQs(`${API}/v13/deployments/${encodeURIComponent(providerDeploymentId)}`, split(target.projectId).qs), {
      headers: bearer(token),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`Vercel status failed (${res.status}).`);
    return toRef(json);
  },

  async getLogs(token, target, providerDeploymentId) {
    const res = await guardedFetch(
      withQs(`${API}/v3/deployments/${encodeURIComponent(providerDeploymentId)}/events`, split(target.projectId).qs),
      { headers: bearer(token) },
    );
    if (!res.ok) throw new Error(`Vercel logs failed (${res.status}).`);
    const events = (await res.json().catch(() => [])) as Array<Record<string, unknown>>;
    return events
      .map((e) => String((e['payload'] as Record<string, unknown>)?.['text'] ?? e['text'] ?? ''))
      .filter(Boolean)
      .join('\n');
  },

  async verifyWebhook(req: InboundRequest, secret: string) {
    // Vercel signs webhooks with HMAC-SHA1 over the raw body, sent as lowercase
    // hex in `x-vercel-signature`. Recompute and compare in constant time.
    // An empty secret (inbound webhooks not configured) or missing signature
    // is always rejected.
    if (!secret) return false;
    const sig = req.headers['x-vercel-signature'];
    if (!sig) return false;
    const expected = await hmacHex(secret, req.rawBody, 'SHA-1');
    return timingSafeEqual(sig.toLowerCase(), expected);
  },

  parseWebhook(rawBody: string) {
    try {
      const evt = JSON.parse(rawBody) as Record<string, unknown>;
      const payload = (evt['payload'] ?? {}) as Record<string, unknown>;
      const deployment = (payload['deployment'] ?? {}) as Record<string, unknown>;
      const id = String(deployment['id'] ?? payload['deploymentId'] ?? '');
      if (!id) return null;
      const type = String(evt['type'] ?? '');
      const status: DeploymentStatus =
        type === 'deployment.ready'
          ? 'ready'
          : type === 'deployment.error'
            ? 'error'
            : type === 'deployment.canceled'
              ? 'canceled'
              : 'building';
      return {
        providerDeploymentId: id,
        status,
        url: deployment['url'] ? `https://${String(deployment['url'])}` : undefined,
        completedAt: status === 'building' ? undefined : new Date(),
      };
    } catch {
      return null;
    }
  },

  async deployStatic(token, target, files, opts) {
    const { project, qs } = split(target.projectId);
    const listed: Array<{ file: string; sha: string; size: number }> = [];
    const uploaded = new Set<string>();
    for (const f of files) {
      const sha = createHash('sha1').update(f.bytes).digest('hex');
      listed.push({ file: f.path.replace(/^\/+/, ''), sha, size: f.bytes.byteLength });
      if (uploaded.has(sha)) continue;
      const res = await guardedFetch(withQs(`${API}/v2/files`, qs), {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/octet-stream', 'x-vercel-digest': sha, 'Content-Length': String(f.bytes.byteLength) },
        body: Buffer.from(f.bytes),
        timeoutMs: 120_000,
      });
      if (!res.ok) await vercelJson(res, `upload of ${f.path}`);
      uploaded.add(sha);
    }
    const json = await vercelJson(
      await guardedFetch(withQs(`${API}/v13/deployments?skipAutoDetectionConfirmation=1`, qs), {
        method: 'POST',
        headers: { ...bearer(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: project,
          project,
          target: 'production',
          files: listed,
          meta: { heopressMarker: opts.marker },
          projectSettings: { framework: null, buildCommand: null, installCommand: null, outputDirectory: null },
        }),
      }),
      'deployment',
    );
    return toRef(json);
  },

  async findByMarker(token, target, marker) {
    const { project, qs } = split(target.projectId);
    const json = await vercelJson(
      await guardedFetch(withQs(`${API}/v6/deployments?projectId=${encodeURIComponent(project)}&target=production&limit=20`, qs), { headers: bearer(token) }),
      'lookup',
    );
    const hit = ((json['deployments'] ?? []) as Array<Record<string, unknown>>).find((d) => (d['meta'] as Record<string, unknown> | undefined)?.['heopressMarker'] === marker);
    return hit ? toRef({ ...hit, readyState: hit['readyState'] ?? hit['state'] }) : null;
  },
};
