/**
 * Git-integration helpers that do not need a provider or a database: configuration, the OAuth handshake, the
 * pull-request validation check, the CI-log store's read-through cache and provenance recording (HeoPress P12;
 * P14 tasks 8.1/8.2).
 *
 * These are the parts an operator can actually reach without GitHub/GitLab credentials, which is why they are cheap
 * to test and worth pinning: a missing client secret must leave the provider disabled, a token exchange without an
 * access token is an error, a malformed `heopress/intents.json` fails the check, and a stored log is preferred to a
 * provider fetch.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { gitCiRuns, gitProvenance } from '@heopress/database';
import type { AppEnv } from '../../../env';
import { getGitConfig, resolvePublicBaseUrl } from '../config';
import { buildAuthorizeUrl, exchangeCodeForToken } from '../oauth';
import { validatePullRequest } from '../validation';
import { getOrFetchLog } from '../ci-log-store';
import { queryProvenance, recordProvenance } from '../provenance';
import type { GitProvider, RepoRef } from '../providers/types';

const repo: RepoRef = { owner: 'acme', repo: 'site' };

function context(env: Record<string, unknown>, url = 'https://cms.example.test/api/v1/integrations/git') {
  const app = new Hono<AppEnv>();
  app.get('/config', (c) => c.json(getGitConfig(c)));
  app.get('/base', (c) => c.json({ base: resolvePublicBaseUrl(c) }));
  const path = new URL(url).pathname.endsWith('/base') ? '/base' : '/config';
  return app.request(new URL(path, new URL(url).origin), {}, env);
}

describe('getGitConfig', () => {
  it('enables a provider only when both its id and secret are present, and reads env bindings first', async () => {
    const full = await context({
      GITHUB_CLIENT_ID: 'gh-id',
      GITHUB_CLIENT_SECRET: 'gh-secret',
      GITLAB_CLIENT_ID: 'gl-id',
      GITLAB_CLIENT_SECRET: 'gl-secret',
      GITHUB_APP_ID: 'app-1',
      GITHUB_APP_PRIVATE_KEY: 'pem',
      ENCRYPTION_KEY: 'enc',
      HEOPRESS_PUBLIC_URL: 'https://cms.example.test/',
    });
    expect(await full.json()).toMatchObject({
      encryptionKey: 'enc',
      publicBaseUrl: 'https://cms.example.test',
      github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
      gitlab: { clientId: 'gl-id', clientSecret: 'gl-secret' },
      githubApp: { appId: 'app-1' },
    });
  });

  it('leaves a provider disabled when the secret or id is missing', async () => {
    const partial = await context({ GITHUB_CLIENT_ID: 'gh-id', GITLAB_CLIENT_SECRET: 'gl-secret' });
    const config = (await partial.json()) as Record<string, unknown>;
    expect(config.github).toBeUndefined();
    expect(config.gitlab).toBeUndefined();
    expect(config.githubApp).toBeUndefined();
    expect(config.encryptionKey).toBeUndefined();
  });

  it('falls back to process.env and derives the public origin from the request', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'env-id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'env-secret');
    try {
      const res = await context({}, 'https://derived.example.test/api/v1/integrations/git/config');
      expect(await res.json()).toMatchObject({ github: { clientId: 'env-id', clientSecret: 'env-secret' }, publicBaseUrl: 'https://derived.example.test' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds the GitHub authorize URL with the least-privilege scope and state', () => {
    const url = new URL(buildAuthorizeUrl('github', { clientId: 'id', clientSecret: 's' }, 'https://cms.example.test/cb', 'st'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('id');
    expect(url.searchParams.get('scope')).toBe('repo');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('redirect_uri')).toBe('https://cms.example.test/cb');
  });

  it('builds the GitLab authorize URL with a response type', () => {
    const url = new URL(buildAuthorizeUrl('gitlab', { clientId: 'id', clientSecret: 's' }, 'https://cms.example.test/cb', 'st'));
    expect(url.origin + url.pathname).toBe('https://gitlab.com/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('api read_api');
  });
});

describe('exchangeCodeForToken', () => {
  const config = { clientId: 'id', clientSecret: 'secret' };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('exchanges a GitHub code and splits the comma-separated scopes', async () => {
    const fetchFn = vi.fn(async () => json({ access_token: 'gh-token', scope: 'repo,status' }));
    await expect(exchangeCodeForToken('github', config, 'code', 'https://cb', fetchFn as unknown as typeof fetch)).resolves.toEqual({
      accessToken: 'gh-token',
      scopes: ['repo', 'status'],
    });
    expect(fetchFn).toHaveBeenCalledWith('https://github.com/login/oauth/access_token', expect.objectContaining({ method: 'POST' }));
  });

  it('refuses a GitHub answer without a token and a non-2xx answer', async () => {
    const noToken = vi.fn(async () => json({ error: 'bad_verification_code' }));
    await expect(exchangeCodeForToken('github', config, 'code', 'https://cb', noToken as unknown as typeof fetch)).rejects.toThrow(/no token|bad_verification_code/);
    const failed = vi.fn(async () => json({}, 500));
    await expect(exchangeCodeForToken('github', config, 'code', 'https://cb', failed as unknown as typeof fetch)).rejects.toThrow('GitHub token exchange -> 500');
  });

  it('exchanges a GitLab code with a form body and space-separated scopes', async () => {
    const fetchFn = vi.fn(async () => json({ access_token: 'gl-token', scope: 'api read_api' }));
    await expect(exchangeCodeForToken('gitlab', config, 'code', 'https://cb', fetchFn as unknown as typeof fetch)).resolves.toEqual({
      accessToken: 'gl-token',
      scopes: ['api', 'read_api'],
    });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, { body: string }];
    expect(init.body).toContain('grant_type=authorization_code');
  });

  it('refuses a GitLab answer without a token and a non-2xx answer', async () => {
    const noToken = vi.fn(async () => json({}));
    await expect(exchangeCodeForToken('gitlab', config, 'code', 'https://cb', noToken as unknown as typeof fetch)).rejects.toThrow('no token');
    const failed = vi.fn(async () => json({}, 401));
    await expect(exchangeCodeForToken('gitlab', config, 'code', 'https://cb', failed as unknown as typeof fetch)).rejects.toThrow('GitLab token exchange -> 401');
  });
});

describe('validatePullRequest', () => {
  const provider = (contents: string | null | (() => never)) =>
    ({
      getFileContents: async () => (typeof contents === 'function' ? contents() : contents),
    }) as unknown as GitProvider;

  it('passes when the config cannot be read or is absent', async () => {
    await expect(validatePullRequest(provider(() => { throw new Error('404'); }), repo, 'sha')).resolves.toEqual({ state: 'success', summary: 'No HeoPress config found to validate.' });
    await expect(validatePullRequest(provider(null), repo, 'sha')).resolves.toEqual({ state: 'success', summary: 'No HeoPress config found to validate.' });
  });

  it('fails a config that is not JSON, and validates one object or an array of intents', async () => {
    await expect(validatePullRequest(provider('{not json'), repo, 'sha')).resolves.toMatchObject({ state: 'failure' });

    const intent = (name: string, collection: string) => ({
      name,
      collection,
      rules: [{ type: 'required_fields', fields: ['title'] }],
      schedule: '0 * * * *',
    });
    const valid = JSON.stringify([intent('One', 'posts'), intent('Two', 'pages')]);
    const ok = await validatePullRequest(provider(valid), repo, 'sha');
    expect(ok.state).toBe('success');
    expect(ok.summary).toContain('2 intent(s)');

    const single = await validatePullRequest(provider(JSON.stringify(intent('One', 'posts'))), repo, 'sha');
    expect(single.state).toBe('success');
  });

  it('reports the invalid intents, at most three lines', async () => {
    const invalid = JSON.stringify([{}, {}, {}, {}]);
    const result = await validatePullRequest(provider(invalid), repo, 'sha');
    expect(result.state).toBe('failure');
    expect(result.summary.split(' | ')).toHaveLength(3);
  });
});

describe('getOrFetchLog', () => {
  const buffer = (text: string) => new TextEncoder().encode(text) as unknown as Buffer;
  const stream = (text: string) => new Blob([text]).stream() as unknown as ReadableStream;

  function deps(run: Record<string, unknown> | null, stored: { body: unknown } | null) {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      select: () => {
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.where = () => chain;
        chain.limit = () => Promise.resolve(run ? [{ ...run }] : []);
        chain.then = (resolve: (v: unknown) => void) => Promise.resolve(run ? [{ ...run }] : []).then(resolve);
        return chain;
      },
      update: () => {
        const chain: Record<string, unknown> = {};
        chain.set = (set: Record<string, unknown>) => {
          updates.push(set);
          return chain;
        };
        chain.where = () => Promise.resolve(undefined);
        chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
        return chain;
      },
    } as never;
    const storage = {
      get: vi.fn(async () => stored),
      put: vi.fn(async () => undefined),
    } as never;
    return { deps: { db, storage, siteId: 'site_a', integrationId: 'int_1' }, updates, storage };
  }

  it('reads the stored log, whether it is a byte view or a stream, without asking the provider', async () => {
    const provider = { getJobLogs: vi.fn(async () => 'fresh') } as unknown as GitProvider;
    for (const body of [buffer('stored text'), stream('stored text')]) {
      const { deps: d } = deps({ id: 'run_1', logRef: 'git-ci-logs/site_a/int_1/5.log' }, { body });
      await expect(getOrFetchLog(d, provider, repo, '5')).resolves.toBe('stored text');
    }
    expect(provider.getJobLogs).not.toHaveBeenCalled();
  });

  it('fetches, stores and records the log reference when nothing is stored', async () => {
    const provider = { getJobLogs: vi.fn(async () => 'from provider') } as unknown as GitProvider;
    const { deps: d, updates, storage } = deps({ id: 'run_1', logRef: null }, null);
    await expect(getOrFetchLog(d, provider, repo, '5', 'job-1')).resolves.toBe('from provider');
    expect(provider.getJobLogs).toHaveBeenCalledWith(repo, '5', 'job-1');
    expect((storage as unknown as { put: unknown }).put).toHaveBeenCalledWith('git-ci-logs/site_a/int_1/5.log', expect.anything(), { contentType: 'text/plain' });
    expect(updates[0]).toMatchObject({ logRef: 'git-ci-logs/site_a/int_1/5.log' });
  });

  it('fetches for an unknown run without recording a reference', async () => {
    const provider = { getJobLogs: vi.fn(async () => 'unreferenced') } as unknown as GitProvider;
    const { deps: d, updates } = deps(null, null);
    await expect(getOrFetchLog(d, provider, repo, '5')).resolves.toBe('unreferenced');
    expect(updates).toEqual([]);
  });
});

describe('provenance', () => {
  it('records the change with nulls for what it does not know', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const db = {
      insert: (table: unknown) => {
        const chain: Record<string, unknown> = {};
        chain.values = (values: Record<string, unknown>) => {
          inserted.push({ table, ...values });
          return Promise.resolve(undefined);
        };
        chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
        return chain;
      },
    } as never;
    await recordProvenance(db, { siteId: 'site_a', commitSha: 'sha', changeType: 'content' });
    expect(inserted[0]).toMatchObject({ table: gitProvenance, siteId: 'site_a', commitSha: 'sha', integrationId: null, collection: null, itemId: null, prNumber: null, changeType: 'content' });
  });

  it('queries with every optional filter and clamps the limit', async () => {
    const limits: unknown[] = [];
    const db = {
      select: () => {
        const chain: Record<string, unknown> = {};
        chain.from = () => chain;
        chain.where = () => chain;
        chain.orderBy = () => chain;
        chain.limit = (value: unknown) => {
          limits.push(value);
          return Promise.resolve([]);
        };
        chain.then = (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve);
        return chain;
      },
    } as never;
    await queryProvenance(db, { siteId: 'site_a', integrationId: 'int_1', collection: 'posts', itemId: 'it_1', limit: 1000 });
    expect(limits).toEqual([500]);
    await queryProvenance(db, { siteId: 'site_a' });
    expect(limits).toEqual([500, 100]);
  });
});

// The CI-run table is the join the log store reads; naming it keeps the fixture honest.
void gitCiRuns;
