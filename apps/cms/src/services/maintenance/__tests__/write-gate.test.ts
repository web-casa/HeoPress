/**
 * The process write gate (HeoPress P13 tasks 2.1, 2.3) and its HTTP guard, with an in-memory switch. The database
 * version (acknowledgements read by the upgrade's drain) is `upgrade.db.integration.test.ts`.
 */
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../../env';
import { withWriteGate } from '../../../middleware/maintenance';
import { WriteGate, type GateSql } from '../write-gate';

function fakeSwitch() {
  const state = { active: false, epoch: 0, failRead: false };
  const acks: Array<{ epoch: number; frozen: boolean; inflight: number }> = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (text.includes('FROM lumibase_maintenance')) {
      if (state.failRead) throw new Error('connection lost');
      return [{ active: state.active, epoch: state.epoch, reason: state.active ? 'upgrade' : null, step: null, to_version: null, started_at: null }];
    }
    if (text.includes('INSERT INTO lumibase_maintenance_acks')) {
      acks.push({ epoch: values[2] as number, frozen: values[3] as boolean, inflight: values[4] as number });
      return [];
    }
    return [];
  }) as unknown as GateSql;
  return { state, acks, sql };
}

describe('process write gate', () => {
  it('refuses writes while frozen, runs freeze hooks once per epoch and acknowledges only when drained', async () => {
    const s = fakeSwitch();
    const gate = new WriteGate({ sql: s.sql, processRole: 'all', heartbeatMs: 0 });
    let paused = 0;
    let resumed = 0;
    gate.onFreeze(() => {
      paused += 1;
    });
    gate.onThaw(() => {
      resumed += 1;
    });
    await gate.poll();
    const leave = gate.enter();
    expect(leave).toBeTypeOf('function');

    s.state.active = true;
    s.state.epoch = 1;
    await gate.poll();
    expect(gate.isFrozen()).toBe(true);
    expect(gate.enter()).toBeNull();
    expect(paused).toBe(1);
    expect(s.acks.at(-1)).toEqual({ epoch: 1, frozen: true, inflight: 1 });

    leave!();
    leave!(); // idempotent
    await gate.poll();
    expect(s.acks.at(-1)).toEqual({ epoch: 1, frozen: true, inflight: 0 });
    await gate.poll();
    expect(paused).toBe(1);

    s.state.active = false;
    s.state.epoch = 2;
    await gate.poll();
    expect(gate.isFrozen()).toBe(false);
    expect(resumed).toBe(2); // the first poll (inactive) and the thaw
    expect(gate.enter()).toBeTypeOf('function');
  });

  it('a freeze hook that fails keeps the process from acknowledging the freeze until it succeeds', async () => {
    const s = fakeSwitch();
    const gate = new WriteGate({ sql: s.sql, processRole: 'worker', heartbeatMs: 0, log: () => {} });
    let fail = true;
    gate.onFreeze(() => {
      if (fail) throw new Error('queue busy');
    });
    s.state.active = true;
    s.state.epoch = 4;
    await gate.poll();
    expect(gate.isFrozen()).toBe(true);
    expect(s.acks.at(-1)).toMatchObject({ epoch: 4, frozen: false });
    fail = false;
    await gate.poll();
    expect(s.acks.at(-1)).toMatchObject({ epoch: 4, frozen: true });
  });

  it('refuses writes until the switch has been read once; a database without the switch table is open', async () => {
    const s = fakeSwitch();
    s.state.failRead = true;
    const gate = new WriteGate({ sql: s.sql, processRole: 'web', heartbeatMs: 0, log: () => {} });
    await gate.start();
    try {
      expect(gate.isFrozen()).toBe(true);
      expect(gate.enter()).toBeNull();
      s.state.failRead = false;
      await gate.poll();
      expect(gate.isFrozen()).toBe(false);
      expect(gate.enter()).toBeTypeOf('function');
    } finally {
      await gate.stop();
    }

    const missing = (async () => {
      throw Object.assign(new Error('relation "lumibase_maintenance" does not exist'), { code: '42P01' });
    }) as unknown as GateSql;
    const old = new WriteGate({ sql: missing, processRole: 'web', log: () => {} });
    await old.poll();
    expect(old.enter()).toBeTypeOf('function');
  });

  it('keeps the last state when the switch cannot be read (a frozen process stays frozen)', async () => {
    const s = fakeSwitch();
    const gate = new WriteGate({ sql: s.sql, processRole: 'web', log: () => {} });
    s.state.active = true;
    s.state.epoch = 1;
    await gate.poll();
    s.state.failRead = true;
    s.state.active = false;
    await gate.poll();
    expect(gate.isFrozen()).toBe(true);
  });
});

describe('HTTP write freeze', () => {
  async function appWith(active: boolean) {
    const s = fakeSwitch();
    s.state.active = active;
    s.state.epoch = active ? 1 : 0;
    const gate = new WriteGate({ sql: s.sql, processRole: 'web', heartbeatMs: 0 });
    await gate.poll();
    const app = new Hono<AppEnv>();
    app.use('*', withWriteGate(() => gate));
    let release: () => void = () => {};
    app.all('/api/v1/items/posts', (c) => c.json({ data: c.req.method }));
    app.post('/api/v1/slow', async (c) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return c.json({ data: 'done' });
    });
    app.post('/api/v1/graphql', (c) => c.json({ data: 'graphql' }));
    app.post('/api/v1/agents/mcp', (c) => c.json({ data: 'mcp' }));
    app.get('/api/v1/integrations/git/oauth/github/callback', (c) => c.json({ data: 'stored' }));
    return { app, gate, s, release: () => release() };
  }

  const post = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('answers 503 MAINTENANCE with Retry-After to writes and lets reads through', async () => {
    const { app } = await appWith(true);
    const write = await app.request('/api/v1/items/posts', post({ title: 'x' }));
    expect(write.status).toBe(503);
    expect(write.headers.get('retry-after')).toBe('60');
    expect(((await write.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('MAINTENANCE');
    for (const method of ['PATCH', 'PUT', 'DELETE']) expect((await app.request('/api/v1/items/posts', { method })).status).toBe(503);
    expect((await app.request('/api/v1/items/posts')).status).toBe(200);
    expect((await app.request('/api/v1/integrations/git/oauth/github/callback')).status).toBe(503);
  });

  it('lets GraphQL queries and MCP read tools through, but not mutations or writing tools', async () => {
    const { app } = await appWith(true);
    expect((await app.request('/api/v1/graphql', post({ query: '{ posts { id } }' }))).status).toBe(200);
    expect((await app.request('/api/v1/graphql', post({ query: 'mutation { createPost { id } }' }))).status).toBe(503);
    expect((await app.request('/api/v1/agents/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))).status).toBe(200);
    expect((await app.request('/api/v1/agents/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content_get' } }))).status).toBe(200);
    expect((await app.request('/api/v1/agents/mcp', post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content_update' } }))).status).toBe(503);
    expect((await app.request('/api/v1/agents/mcp', post([{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content_get' } }, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'content_publish' } }]))).status).toBe(503);
  });

  it('counts an admitted write as in flight until its response, so a freeze waits for it', async () => {
    const { app, gate, s, release } = await appWith(false);
    const pending = app.request('/api/v1/slow', post({}));
    await new Promise((r) => setTimeout(r, 5));
    s.state.active = true;
    s.state.epoch = 1;
    await gate.poll();
    expect(s.acks.at(-1)).toEqual({ epoch: 1, frozen: true, inflight: 1 });
    expect((await app.request('/api/v1/items/posts', post({}))).status).toBe(503);
    release();
    expect((await pending).status).toBe(200);
    await gate.poll();
    expect(s.acks.at(-1)).toEqual({ epoch: 1, frozen: true, inflight: 0 });
  });

  it('passes everything when no gate runs in the process', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', withWriteGate(() => null));
    app.post('/x', (c) => c.json({ data: 1 }));
    expect((await app.request('/x', { method: 'POST' })).status).toBe(200);
  });
});
