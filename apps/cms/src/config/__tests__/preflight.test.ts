import { describe, expect, it } from 'vitest';

import {
  assertSupportedLlmProvider,
  assertSupportedRuntime,
  assertNoLegacyEnv,
  assertSupportedPostgres,
  assertSupportedNode,
  findLegacyEnv,
  MIN_NODE_MAJOR,
  PreflightError,
  runStartupPreflight,
  type PreflightQuery,
} from '../preflight';

describe('Node.js version preflight', () => {
  it('accepts the minimum supported major and newer', () => {
    expect(() => assertSupportedNode('24.0.0')).not.toThrow();
    expect(() => assertSupportedNode('v24.21.0')).not.toThrow();
    expect(() => assertSupportedNode('26.1.0')).not.toThrow();
  });

  it('rejects Node.js 22 and names the required version', () => {
    expect(() => assertSupportedNode('22.11.0')).toThrow(PreflightError);
    expect(() => assertSupportedNode('22.11.0')).toThrow(`需要 Node.js >= ${MIN_NODE_MAJOR}`);
    expect(() => assertSupportedNode('22.11.0')).toThrow(/current version is 22\.11\.0/);
  });

  it('rejects an unparseable version instead of passing it', () => {
    expect(() => assertSupportedNode('unknown')).toThrow(PreflightError);
  });
});

describe('legacy LUMIBASE_ environment preflight', () => {
  it('passes when only HEOPRESS_ variables are set', () => {
    expect(() => assertNoLegacyEnv({ HEOPRESS_ENV: 'production', DATABASE_URL: 'x' })).not.toThrow();
  });

  it('fails when a required variable is set only with the old prefix and names the new one', () => {
    let message = '';
    try {
      assertNoLegacyEnv({ LUMIBASE_ENV: 'production' });
    } catch (err) {
      expect(err).toBeInstanceOf(PreflightError);
      message = (err as Error).message;
    }
    expect(message).toContain('LUMIBASE_ENV -> HEOPRESS_ENV');
  });

  it('lists every legacy variable, including *_FILE and empty values', () => {
    const found = findLegacyEnv({ LUMIBASE_TOKEN: '', LUMIBASE_SMTP_URL_FILE: '/run/secrets/smtp', HEOPRESS_URL: 'x' });
    expect(found).toEqual([
      { legacy: 'LUMIBASE_SMTP_URL_FILE', replacement: 'HEOPRESS_SMTP_URL_FILE' },
      { legacy: 'LUMIBASE_TOKEN', replacement: 'HEOPRESS_TOKEN' },
    ]);
  });

  it('still fails when the new variable is also set, so stale configuration is not ignored silently', () => {
    expect(() => assertNoLegacyEnv({ LUMIBASE_ENV: 'production', HEOPRESS_ENV: 'production' })).toThrow(
      /LUMIBASE_ENV -> HEOPRESS_ENV/,
    );
  });
});

describe('runtime preflight', () => {
  it('accepts an unset or docker runtime', () => {
    expect(() => assertSupportedRuntime({})).not.toThrow();
    expect(() => assertSupportedRuntime({ HEOPRESS_RUNTIME: 'docker' })).not.toThrow();
  });

  it('refuses the removed Cloudflare runtime with an actionable message', () => {
    expect(() => assertSupportedRuntime({ HEOPRESS_RUNTIME: 'cloudflare' })).toThrow(PreflightError);
    expect(() => assertSupportedRuntime({ HEOPRESS_RUNTIME: 'cloudflare' })).toThrow(/runs only on Node\.js/);
  });
});

describe('LLM provider preflight', () => {
  it('refuses the removed Workers AI and Vertex providers by name', () => {
    expect(() => assertSupportedLlmProvider({ LLM_PROVIDER: 'workers-ai' })).toThrow(/LLM_PROVIDER="workers-ai" was removed/);
    expect(() => assertSupportedLlmProvider({ LLM_PROVIDER: 'vertex' })).toThrow(PreflightError);
  });

  it('accepts supported providers and an unset value', () => {
    for (const provider of [undefined, 'echo', 'openai', 'anthropic', 'gemini', 'nvidia']) {
      expect(() => assertSupportedLlmProvider(provider ? { LLM_PROVIDER: provider } : {})).not.toThrow();
    }
  });
});

describe('runStartupPreflight', () => {
  it('checks the Node.js version before the environment', () => {
    expect(() => runStartupPreflight({ nodeVersion: '22.0.0', env: { LUMIBASE_ENV: 'x' } })).toThrow(
      /Node\.js >= 24/,
    );
  });

  it('passes on a supported runtime with a clean environment', () => {
    expect(() => runStartupPreflight({ nodeVersion: '24.21.0', env: {} })).not.toThrow();
  });
});

describe('PostgreSQL version preflight', () => {
  const server = (num: string, version: string): PreflightQuery => async () => [{ num, version }];

  it('accepts PostgreSQL 18', async () => {
    await expect(assertSupportedPostgres(server('180006', '18.6'))).resolves.toEqual({ versionNum: 180006, version: '18.6' });
  });

  it('rejects PostgreSQL 17 at once and names the required version', async () => {
    let calls = 0;
    const pg17: PreflightQuery = async () => { calls += 1; return [{ num: '170005', version: '17.5' }]; };
    await expect(assertSupportedPostgres(pg17)).rejects.toThrow('需要 PostgreSQL >= 18');
    await expect(assertSupportedPostgres(pg17)).rejects.toThrow(/connected server is 17\.5/);
    expect(calls).toBe(2);
  });

  it('retries while the server is not reachable yet, then checks the version', async () => {
    let attempts = 0;
    let clock = 0;
    const flaky: PreflightQuery = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('ECONNREFUSED');
      return [{ num: '180006', version: '18.6' }];
    };
    await assertSupportedPostgres(flaky, { connectTimeoutMs: 10_000, retryIntervalMs: 1_000, now: () => clock, sleep: async (ms) => { clock += ms; } });
    expect(attempts).toBe(3);
  });

  it('gives up after the connect timeout with a preflight error', async () => {
    let clock = 0;
    const down: PreflightQuery = async () => { throw new Error('ECONNREFUSED'); };
    await expect(
      assertSupportedPostgres(down, { connectTimeoutMs: 3_000, retryIntervalMs: 1_000, now: () => clock, sleep: async (ms) => { clock += ms; } }),
    ).rejects.toThrow(/Could not reach PostgreSQL within 3000 ms/);
  });

  it('fails at the deadline when the server accepts the connection but never answers', async () => {
    const hung: PreflightQuery = () => new Promise(() => {});
    const started = Date.now();
    await expect(assertSupportedPostgres(hung, { connectTimeoutMs: 30, retryIntervalMs: 10, minAttemptMs: 20 })).rejects.toThrow(
      /Could not reach PostgreSQL within 30 ms/,
    );
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('asks a reachable server once even when the connect deadline is zero', async () => {
    const slow: PreflightQuery = () => new Promise((resolve) => setTimeout(() => resolve([{ num: '170005', version: '17.5' }]), 20));
    await expect(assertSupportedPostgres(slow, { connectTimeoutMs: 0 })).rejects.toThrow('需要 PostgreSQL >= 18');
  });
});
