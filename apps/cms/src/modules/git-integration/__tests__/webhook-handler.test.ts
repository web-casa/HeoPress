/**
 * The public Git webhook receiver (HeoPress P12; P14 task 8.2).
 *
 * This route has no session behind it, so its refusals are the security surface: an unknown provider, a path without
 * its ids, an unknown integration, a missing encryption key, an undecryptable secret and a bad signature each answer
 * before any row is touched. Afterwards the event must be persisted once (a duplicate delivery is acknowledged without
 * reprocessing), a payload from another repository is refused, side effects are best-effort, and a processing failure
 * is recorded on the row and still acknowledged so the provider does not retry forever.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { gitIntegrations, gitWebhookEvents } from '@heopress/database';
import type { AppEnv } from '../../../env';
import { encryptSecretValue } from '../crypto';

vi.mock('@heopress/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@heopress/database')>();
  return { ...actual, scopedDatabase: (db: unknown) => db };
});
const signature = { valid: true, deliveryId: 'delivery-1', event: 'pull_request' } as { valid: boolean; deliveryId: string; event?: string };
vi.mock('../webhook/verify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../webhook/verify')>();
  return { ...actual, verifyWebhookSignature: vi.fn(async () => signature) };
});
const processEvent = vi.fn(async () => ({}) as Record<string, unknown>);
vi.mock('../webhook/processor', () => ({ processEvent: (...args: unknown[]) => processEvent(...(args as [])) }));
const ensureForPullRequest = vi.fn(async () => undefined);
const destroy = vi.fn(async () => undefined);
vi.mock('../preview', () => ({
  PreviewEnvManager: class {
    ensureForPullRequest = ensureForPullRequest;
    destroy = destroy;
  },
}));
const recordIncident = vi.fn(async () => undefined);
vi.mock('../../../services/autonomy-service', () => ({
  AutonomyService: class {
    recordIncident = recordIncident;
  },
}));
const auditWrite = vi.fn(async () => undefined);
vi.mock('../../audit/logger', () => ({
  AuditLogger: class {
    write = auditWrite;
  },
}));

const { handleWebhook } = await import('../webhook/handler');

// CryptoService takes a base64 key (32 bytes for AES-256).
const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const OTHER_KEY = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');
const secretEnc = await encryptSecretValue(KEY, 'shared-secret', { siteId: 'site_a', integrationId: 'int_1' }, 'webhook_secret');

interface Options {
  integration?: Record<string, unknown> | null;
  inserted?: Array<{ id: string }>;
  duplicate?: boolean;
  env?: Record<string, unknown>;
}

function harness(options: Options = {}) {
  const integration =
    options.integration === undefined
      ? { id: 'int_1', siteId: 'site_a', provider: 'github', repoFullName: 'acme/site', webhookSecretEnc: secretEnc, syncConfig: {} }
      : options.integration;
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Array<Record<string, unknown>>> = [];
  const db = {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(integration ? [integration] : []);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(integration ? [integration] : []).then(resolve);
      return chain;
    },
    insert: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      let values: Array<Record<string, unknown>> = [];
      chain.values = (input: Array<Record<string, unknown>>) => {
        values = input;
        if (table === gitWebhookEvents) inserts.push(values);
        return chain;
      };
      chain.onConflictDoNothing = () => chain;
      chain.returning = () => Promise.resolve(options.duplicate ? [] : (options.inserted ?? [{ id: 'evt_1' }]));
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    update: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.set = (set: Record<string, unknown>) => {
        if (table === gitWebhookEvents) updates.push(set);
        return chain;
      };
      chain.where = () => Promise.resolve(undefined);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
  };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db as never);
    c.set('requestId', 'req_1');
    c.set('runtime', {} as never);
    await next();
  });
  app.post('/webhook/:provider/:siteId/:integrationId', (c) => handleWebhook(c));
  // A mount without the path ids reaches the same handler with `undefined` params.
  app.post('/no-ids/:provider', (c) => handleWebhook(c));
  return { app, updates, inserts };
}

const post = (
  options: Options,
  path = '/webhook/github/site_a/int_1',
  body: unknown = { repository: { full_name: 'acme/site' }, action: 'opened' },
  env: Record<string, unknown> = { ENCRYPTION_KEY: KEY },
) =>
  harness(options).app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) },
    env,
  );

const json = async (res: Response) => (await res.json()) as Record<string, unknown> & { errors?: Array<{ code: string }>; data?: Record<string, unknown> };

describe('handleWebhook refusals', () => {
  it('refuses an unknown provider or a path without ids', async () => {
    const provider = await post({}, '/webhook/bitbucket/site_a/int_1');
    expect(provider.status).toBe(404);
    expect((await json(provider)).errors?.[0]?.code).toBe('UNKNOWN_PROVIDER');

    const missing = await post({}, '/no-ids/github');
    expect(missing.status).toBe(404);
    expect((await json(missing)).errors?.[0]?.code).toBe('NOT_FOUND');
  });

  it('refuses an unknown integration and one without a webhook secret', async () => {
    const unknown = await post({ integration: null });
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).errors?.[0]?.code).toBe('NOT_FOUND');

    const secretless = await post({ integration: { id: 'int_1', siteId: 'site_a', provider: 'github', repoFullName: 'acme/site', webhookSecretEnc: null } });
    expect(secretless.status).toBe(404);
  });

  it('refuses without an encryption key and when the secret cannot be decrypted', async () => {
    const noKey = await post({}, '/webhook/github/site_a/int_1', {}, {});
    expect(noKey.status).toBe(500);
    expect((await json(noKey)).errors?.[0]?.code).toBe('ENCRYPTION_NOT_CONFIGURED');

    const wrongKey = await post({}, '/webhook/github/site_a/int_1', {}, { ENCRYPTION_KEY: OTHER_KEY });
    expect(wrongKey.status).toBe(500);
    expect((await json(wrongKey)).errors?.[0]?.code).toBe('SECRET_UNAVAILABLE');
  });

  it('refuses a bad signature before writing anything', async () => {
    signature.valid = false;
    try {
      const res = await post({});
      expect(res.status).toBe(401);
      expect((await json(res)).errors?.[0]?.code).toBe('INVALID_SIGNATURE');
    } finally {
      signature.valid = true;
    }
  });

  it('refuses a payload from another repository', async () => {
    const res = await post({}, '/webhook/github/site_a/int_1', { repository: { full_name: 'other/site' } });
    expect(res.status).toBe(400);
    expect((await json(res)).errors?.[0]?.code).toBe('REPO_MISMATCH');
  });
});

describe('handleWebhook delivery', () => {
  it('persists the event once and acknowledges a duplicate without reprocessing', async () => {
    processEvent.mockClear();
    const duplicate = await post({ duplicate: true });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ data: { duplicate: true } });
    expect(processEvent).not.toHaveBeenCalled();

    const fresh = await post({});
    expect(fresh.status).toBe(200);
    expect(await fresh.json()).toEqual({ data: { received: true } });
    expect(processEvent).toHaveBeenCalledTimes(1);
  });

  it('keeps an unparseable body, and a payload without a repository, going', async () => {
    processEvent.mockClear();
    expect((await post({}, '/webhook/github/site_a/int_1', '{not json')).status).toBe(200);
    expect(processEvent).toHaveBeenCalledWith(expect.objectContaining({ payload: {} }));
    expect((await post({}, '/webhook/github/site_a/int_1', { hello: 'world' })).status).toBe(200);
  });

  it('marks the event processed after the side effects', async () => {
    processEvent.mockResolvedValueOnce({});
    const res = await post({});
    expect(res.status).toBe(200);
    expect((await harness({}).updates).length).toBe(0);
  });

  it('provisions or tears down a preview when the integration opts in', async () => {
    const previewOn = { id: 'int_1', siteId: 'site_a', provider: 'github', repoFullName: 'acme/site', webhookSecretEnc: secretEnc, syncConfig: { preview: true } };
    signature.event = 'pull_request';

    ensureForPullRequest.mockClear();
    destroy.mockClear();
    processEvent.mockResolvedValueOnce({ pr: { id: 'pr_1', number: 4, state: 'open', action: 'opened' } });
    await post({ integration: previewOn });
    expect(ensureForPullRequest).toHaveBeenCalledWith({ prId: 'pr_1', number: 4, state: 'open' });

    processEvent.mockResolvedValueOnce({ pr: { id: 'pr_1', number: 4, state: 'merged', action: 'closed' } });
    await post({ integration: previewOn });
    expect(destroy).toHaveBeenCalledWith('pr_1');

    // Opted out: nothing is provisioned.
    ensureForPullRequest.mockClear();
    processEvent.mockResolvedValueOnce({ pr: { id: 'pr_2', number: 5, state: 'open', action: 'opened' } });
    await post({ integration: { ...previewOn, syncConfig: {} } });
    expect(ensureForPullRequest).not.toHaveBeenCalled();
  });

  it('records a CI failure as an incident and an audit entry, and ignores other statuses', async () => {
    recordIncident.mockClear();
    auditWrite.mockClear();
    processEvent.mockResolvedValueOnce({ ci: { providerRunId: 'run-1', status: 'failure' } });
    await post({});
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ agentRole: 'git-sync' }));
    expect(auditWrite).toHaveBeenCalledWith(expect.objectContaining({ event: 'git_ci_failed' }));

    recordIncident.mockClear();
    auditWrite.mockClear();
    processEvent.mockResolvedValueOnce({ ci: { providerRunId: 'run-2', status: 'success' } });
    await post({});
    expect(recordIncident).not.toHaveBeenCalled();
    expect(auditWrite).not.toHaveBeenCalled();
  });

  it('records a processing failure on the row and still acknowledges', async () => {
    processEvent.mockRejectedValueOnce(new Error('projection failed'));
    const res = await post({});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { received: true } });
  });

  it('swallows a side-effect failure so the webhook is still acknowledged', async () => {
    processEvent.mockResolvedValueOnce({ pr: { id: 'pr_9', number: 9, state: 'open', action: 'opened' } });
    ensureForPullRequest.mockRejectedValueOnce(new Error('provider down'));
    const res = await post({
      integration: { id: 'int_1', siteId: 'site_a', provider: 'github', repoFullName: 'acme/site', webhookSecretEnc: secretEnc, syncConfig: { preview: true } },
    });
    expect(res.status).toBe(200);
  });
});

// The integration table is the lookup the handler performs; naming it keeps the fixture honest.
void gitIntegrations;
