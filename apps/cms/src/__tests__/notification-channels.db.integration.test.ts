import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { WebSocket } from 'ws';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditLog, notificationChannels, notificationDeliveries, type Database } from '@heopress/database';
import { classifyAddress, createRuntime } from '@heopress/runtime/node';
import { DockerRealtimeProvider, InProcessRealtimeHub } from '@heopress/runtime/docker';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { attachNodeRealtime } from '../realtime/node-hub';
import { emitAgentNotification } from '../modules/notifications/agent-notifications';
import {
  backoffMs,
  DEFAULT_MAX_ATTEMPTS,
  enqueueChannelNotifications,
  NotificationChannelService,
} from '../modules/notifications/channels/channel-service';
import type { SenderOptions } from '../modules/notifications/channels/senders';
import { sealSecret } from '../services/crypto/secret-vault';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Outbound notification channels and in-Studio realtime notifications (HeoPress P10 tasks 5.2, 5.5, 5.6; spec
 * agents/notifications), through the app and a real database:
 *
 *  - only a site's administrators manage its channels; targets are sealed and never returned;
 *  - an event becomes a delivery per subscribed channel, sent to a mock server with summary + link only;
 *  - a failing channel is retried with backoff up to the cap, then marked failed and audited — and never fails the
 *    operation that produced the event; secrets never reach the logs;
 *  - an agent notification reaches the online administrator sessions of its own site only (two sites online).
 */

const JWT_SECRET = 'notify-test-secret';
const KEK = Buffer.alloc(32, 9).toString('base64');

describe.skipIf(!hasDbIntegrationUrl)('notification channels — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let runtime: ReturnType<typeof createRuntime>;
  let mock: Server;
  let port = 0;
  const seen: Array<{ url: string; body: string }> = [];
  let respond: (res: ServerResponse) => void = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"errcode":0}');

  const sender = (): SenderOptions => ({
    outbound: {
      resolve: async (host) => (host === 'hooks.example.com' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.8', family: 4 }]),
      classify: (ip) => (ip === '127.0.0.1' ? 'public' : classifyAddress(ip)),
    },
  });

  beforeAll(async () => {
    db = await connectDbIntegration('notification-channels');
    env = { ...process.env, JWT_SECRET, ENCRYPTION_KEY: KEK, HEOPRESS_STORAGE: 'local' };
    runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
    mock = createServer((req: IncomingMessage, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', body });
        respond(res);
      });
    });
    await new Promise<void>((r) => mock.listen(0, '127.0.0.1', r));
    port = (mock.address() as AddressInfo).port;
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'ntf', jwtSecret: JWT_SECRET });
  });
  afterEach(async () => {
    seen.length = 0;
    respond = (res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"errcode":0}');
    if (fx) await fx.teardown();
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    await new Promise<void>((r) => mock.close(() => r()));
  });

  const as = async (who: 'adminA' | 'adminB' | 'onlyA', site: 'a' | 'b') => fx.headers(site, await fx.session(who, site));
  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers: { ...headers, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const service = (site: 'a' | 'b', now?: () => Date) =>
    new NotificationChannelService({ db, siteId: fx.sites[site], keys: runtime.keys, publicUrl: 'https://cms.example.com/console', sender: sender(), now });

  /** Point a channel at the mock server (the API takes https only; the mock speaks http). */
  async function aimAtMock(site: 'a' | 'b', id: string, path: string, secret?: string): Promise<void> {
    const sealed = await sealSecret(runtime.keys, JSON.stringify({ url: `http://hooks.example.com:${port}${path}`, ...(secret ? { secret } : {}) }), `notification-channel|${id}`);
    await runSiteTransaction(db, fx.sites[site], (tx) =>
      tx.update(notificationChannels).set({ targetCiphertext: sealed.ciphertext }).where(and(eq(notificationChannels.siteId, fx.sites[site]), eq(notificationChannels.id, id))),
    );
  }

  it('only the site administrators manage channels; targets are sealed and never returned', async () => {
    const admin = await as('adminA', 'a');
    const created = await call('/api/v1/notification-channels', 'POST', admin, {
      name: 'Ops group',
      kind: 'wecom',
      target: { url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=wk-secret-1' },
      events: ['approval', 'veto', 'budget'],
    });
    expect(created.status).toBe(201);
    const text = await created.text();
    expect(text).not.toContain('wk-secret-1');
    const channel = JSON.parse(text).data;
    expect(channel).toMatchObject({ kind: 'wecom', targetHint: 'qyapi.weixin.qq.com', events: ['approval', 'veto', 'budget'], enabled: true });

    const [row] = await runSiteTransaction(db, fx.sites.a, (tx) => tx.select().from(notificationChannels).where(eq(notificationChannels.id, channel.id)));
    expect(row!.targetCiphertext).not.toContain('wk-secret-1');

    const list = await call('/api/v1/notification-channels', 'GET', admin);
    expect(await list.text()).not.toContain('wk-secret-1');

    // An editor of the site, and the other site's administrator, cannot reach it.
    expect((await call('/api/v1/notification-channels', 'GET', await as('onlyA', 'a'))).status).toBe(403);
    const other = await as('adminB', 'b');
    expect((await (await call('/api/v1/notification-channels', 'GET', other)).json()).data).toEqual([]);
    expect((await call(`/api/v1/notification-channels/${channel.id}`, 'GET', other)).status).toBe(404);
    expect((await call(`/api/v1/notification-channels/${channel.id}`, 'DELETE', other)).status).toBe(404);

    // A validation error never echoes the submitted token.
    const bad = await call('/api/v1/notification-channels', 'POST', admin, { name: 'tg', kind: 'telegram', target: { token: 'nope-tok-secret', chatId: 'x' }, events: [] });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain('nope-tok-secret');
    // http (not https) targets are refused at the API.
    const plain = await call('/api/v1/notification-channels', 'POST', admin, { name: 'plain', kind: 'webhook', target: { url: 'http://hooks.example.com/h' }, events: [] });
    expect(plain.status).toBe(400);
  });

  it('delivers an event to each subscribed channel with summary and link only', async () => {
    const admin = await as('adminA', 'a');
    const mk = async (name: string, kind: string, events: string[]) =>
      (await (await call('/api/v1/notification-channels', 'POST', admin, { name, kind, target: { url: 'https://hooks.example.com/x', secret: 'hook-secret' }, events })).json()).data;
    const feishu = await mk('Feishu', 'feishu', ['veto']);
    const hook = await mk('Hook', 'webhook', ['veto']);
    const ding = await mk('Ding', 'dingtalk', ['incident']); // not subscribed to veto
    await aimAtMock('a', feishu.id, '/feishu', 'hook-secret');
    await aimAtMock('a', hook.id, '/hook', 'hook-secret');
    await aimAtMock('a', ding.id, '/ding', 'hook-secret');

    // Without keys the emit only queues; the queue then runs against the mock.
    await emitAgentNotification(
      { db, siteId: fx.sites.a },
      { kind: 'veto', severity: 'warning', title: 'Veto window open', body: 'SECRET ARTICLE BODY TEXT', deepLink: '/mission-control/inbox?entry=veto:v1', entityId: 'v1' },
    );
    expect(await service('a').deliverDue()).toEqual({ sent: 2, retried: 0, failed: 0 });
    expect(seen.map((s) => s.url.split('?')[0]).sort()).toEqual(['/feishu', '/hook']);
    const all = seen.map((s) => s.body).join('\n');
    expect(all).not.toContain('SECRET ARTICLE BODY TEXT');
    expect(all).not.toContain('hook-secret');
    expect(all).toContain('https://cms.example.com/console/mission-control/inbox?entry=veto:v1');
    expect(seen.some((s) => s.url.startsWith('/ding'))).toBe(false);

    const rows = await runSiteTransaction(db, fx.sites.a, (tx) => tx.select().from(notificationDeliveries).where(eq(notificationDeliveries.siteId, fx.sites.a)));
    expect(rows.map((r) => r.channelId).sort()).toEqual([feishu.id, hook.id].sort());
    for (const r of rows) expect(r.message).toEqual({ title: 'Veto window open', severity: 'warning', siteName: expect.any(String), path: '/mission-control/inbox?entry=veto:v1' });
  });

  it('sends to the mock server and records sent', async () => {
    const svc = service('a');
    const ch = await svc.create({ name: 'Hook', kind: 'webhook', target: { url: 'https://hooks.example.com/x', secret: 'hook-secret' }, events: ['approval'] });
    await aimAtMock('a', ch.id, '/hook', 'hook-secret');
    const ids = await runSiteTransaction(db, fx.sites.a, (tx) => enqueueChannelNotifications(tx, fx.sites.a, { event: 'approval', title: 'Approval requested', severity: 'info', path: '/mission-control/inbox?entry=approval:a1' }));
    expect(ids).toHaveLength(1);
    expect(await svc.deliverDue({ ids })).toEqual({ sent: 1, retried: 0, failed: 0 });
    const body = JSON.parse(seen[0]!.body);
    expect(body).toMatchObject({ event: 'approval', title: 'Approval requested', link: 'https://cms.example.com/console/mission-control/inbox?entry=approval:a1' });
    const [d] = await svc.deliveries(ch.id);
    expect(d).toMatchObject({ status: 'sent', attempts: 1, lastError: null });
  });

  it('retries a failing channel with backoff up to the cap, then fails it and audits — without logging secrets', async () => {
    respond = (res) => res.writeHead(503).end('down');
    let clock = new Date('2026-10-27T08:00:00Z');
    const svc = service('a', () => clock);
    const ch = await svc.create({ name: 'Flaky', kind: 'dingtalk', target: { url: 'https://hooks.example.com/robot/send?access_token=dt-secret-2', secret: 'hook-secret' }, events: ['incident'] });
    await aimAtMock('a', ch.id, '/robot/send?access_token=dt-secret-2', 'hook-secret');
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      const [id] = await runSiteTransaction(db, fx.sites.a, (tx) =>
        tx.insert(notificationDeliveries).values({ siteId: fx.sites.a, channelId: ch.id, event: 'incident', message: { title: 'Incident', severity: 'critical', siteName: 'A', path: null }, nextAttemptAt: clock }).returning({ id: notificationDeliveries.id }),
      );
      for (let attempt = 1; attempt <= DEFAULT_MAX_ATTEMPTS; attempt++) {
        const r = await svc.deliverDue();
        const [d] = await svc.deliveries(ch.id);
        expect(d!.attempts).toBe(attempt);
        expect(d!.lastError).toBe('http_503');
        if (attempt < DEFAULT_MAX_ATTEMPTS) {
          expect(r).toEqual({ sent: 0, retried: 1, failed: 0 });
          expect(Date.parse(d!.nextAttemptAt) - clock.getTime()).toBe(backoffMs(attempt));
          // Not due yet: nothing is sent.
          expect(await svc.deliverDue()).toEqual({ sent: 0, retried: 0, failed: 0 });
          clock = new Date(Date.parse(d!.nextAttemptAt));
        } else {
          expect(r).toEqual({ sent: 0, retried: 0, failed: 1 });
          expect(d!.status).toBe('failed');
        }
      }
      // The cap holds: later sweeps send nothing more.
      clock = new Date(clock.getTime() + 24 * 3600_000);
      expect(await svc.deliverDue()).toEqual({ sent: 0, retried: 0, failed: 0 });
      expect(seen).toHaveLength(DEFAULT_MAX_ATTEMPTS);
      expect(id).toBeTruthy();

      const audits = await runSiteTransaction(db, fx.sites.a, (tx) => tx.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'notification_delivery_failed'))));
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits)).not.toContain('dt-secret-2');

      const logged = spies.flatMap((s) => s.mock.calls.flat()).map((a) => (a instanceof Error ? String(a.stack) : JSON.stringify(a))).join('\n');
      expect(logged).not.toContain('dt-secret-2');
      expect(logged).not.toContain('hook-secret');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('a channel refused by the outbound boundary fails at once, and the business operation still completes', async () => {
    const svc = service('a');
    const ch = await svc.create({ name: 'Evil', kind: 'webhook', target: { url: 'https://internal.example.com/hook' }, events: ['budget'] });
    // The business transaction (a budget pause, say) commits with its queued delivery.
    const marker = await runSiteTransaction(db, fx.sites.a, async (tx) => {
      await enqueueChannelNotifications(tx, fx.sites.a, { event: 'budget', title: 'Budget used up', severity: 'warning' });
      return 'committed';
    });
    expect(marker).toBe('committed');
    expect(await svc.deliverDue()).toEqual({ sent: 0, retried: 0, failed: 1 });
    const [d] = await svc.deliveries(ch.id);
    expect(d).toMatchObject({ status: 'failed', lastError: 'blocked', attempts: 1 });
    // emit never rejects even when every channel fails.
    await expect(
      emitAgentNotification({ db, siteId: fx.sites.a, keys: runtime.keys }, { kind: 'incident', severity: 'critical', title: 'x', body: 'y', entityId: 'i1' }),
    ).resolves.toBeUndefined();
  });

  it('in-Studio: an agent notification reaches only the online administrator sessions of its own site', async () => {
    const hub = new InProcessRealtimeHub();
    const server = createServer();
    const { close } = attachNodeRealtime({ server, hub, jwtSecret: JWT_SECRET });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const wsPort = (server.address() as AddressInfo).port;
    const sockets: WebSocket[] = [];
    try {
      const open = async (who: 'adminA' | 'adminB' | 'onlyA', site: 'a' | 'b') => {
        const res = await call('/api/v1/realtime/ticket', 'POST', await as(who, site));
        expect(res.status).toBe(200);
        const { data } = (await res.json()) as { data: { ticket: string } };
        const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/api/v1/realtime?ticket=${encodeURIComponent(data.ticket)}`);
        const frames: Array<Record<string, unknown>> = [];
        ws.on('message', (m) => frames.push(JSON.parse(m.toString())));
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => resolve());
          ws.on('error', reject);
        });
        sockets.push(ws);
        return frames;
      };
      const adminA = await open('adminA', 'a');
      const editorA = await open('onlyA', 'a');
      const adminB = await open('adminB', 'b');
      await new Promise((r) => setTimeout(r, 50));

      await emitAgentNotification(
        { db, siteId: fx.sites.a, realtime: new DockerRealtimeProvider(hub) },
        { kind: 'approval', severity: 'info', title: 'Approval requested', body: 'agent wants to publish', deepLink: '/mission-control/inbox?entry=approval:a1', entityId: 'a1' },
      );
      await new Promise((r) => setTimeout(r, 100));

      const notes = (frames: Array<Record<string, unknown>>) => frames.filter((f) => f.type === 'notification');
      expect(notes(adminA)).toHaveLength(1);
      expect(notes(adminA)[0]).toMatchObject({
        type: 'notification',
        payload: { source: 'agent', notification: { kind: 'approval', title: 'Approval requested', entityId: 'a1', deepLink: '/mission-control/inbox?entry=approval:a1' } },
      });
      expect(notes(editorA)).toHaveLength(0);
      expect(notes(adminB)).toHaveLength(0);

      // And the other way round.
      await emitAgentNotification({ db, siteId: fx.sites.b, realtime: new DockerRealtimeProvider(hub) }, { kind: 'incident', severity: 'critical', title: 'Incident', body: '', entityId: 'i9' });
      await new Promise((r) => setTimeout(r, 100));
      expect(notes(adminB)).toHaveLength(1);
      expect(notes(adminA)).toHaveLength(1);
    } finally {
      for (const ws of sockets) ws.close();
      close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
