import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, sites, systemState, users, type Database } from '@heopress/database';

import app from '../index';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';
import {
  CdcDispatcher,
  DrizzleDeliveryLog,
  DrizzleSubscriptionDispatchStore,
  loadWebhookTarget,
} from '../modules/cdc/change-feed/dispatcher';
import { DrizzleCdcEventStore } from '../modules/cdc/change-feed/feed-reader';
import {
  SIGNATURE_HEADER,
  verifyCdcWebhookSignature,
  WebhookSender,
} from '../modules/cdc/change-feed/webhook-sender';

/**
 * Change Feed end to end on a real PostgreSQL (P02 task 3.2; spec
 * platform/feature-surface "保留功能可用 / Change Feed 产生事件").
 *
 * Through the real app: setup → login → collection → webhook + webhook
 * subscription → create an item. Then:
 *   1. the pull API (`GET /api/v1/cdc/events`, long-poll) returns the create
 *      event for that item;
 *   2. the production dispatcher signs and delivers the event to a webhook
 *      receiver, which verifies the `X-HeoPress-Signature` HMAC.
 *
 * The receiver listens on 127.0.0.1, which the production webhook transport
 * refuses (SSRF guard). Step 2 therefore builds the same CdcDispatcher with the
 * production stores and WebhookSender but a plain fetch; everything except the
 * network guard is the production path.
 *
 * Needs DATABASE_URL (disposable database), HEOPRESS_ENV=development and
 * JWT_SECRET, like the golden-path E2E.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL?.trim() || undefined;
const SITE = '__default__';
const COLLECTION = 'feed_articles';
const ADMIN_EMAIL = 'feed-admin@example.test';
const ADMIN_PASSWORD = 'Change-Feed-E2E-1!';
const WEBHOOK_SECRET = 'whsec_change_feed_e2e_0123456789abcdef';
const ENV = { ...process.env } as unknown as Record<string, unknown>;

interface Received {
  headers: IncomingMessage['headers'];
  body: string;
}

let bearer = '';
const request = (path: string, init?: RequestInit) => app.request(path, init, ENV);
const headers = () => ({ 'content-type': 'application/json', 'x-heopress-site': SITE, authorization: bearer });

describe.skipIf(!TEST_DATABASE_URL)('Change Feed end to end (PostgreSQL)', () => {
  let db: Database;
  let server: Server;
  let receiverUrl = '';
  const received: Received[] = [];

  async function resetFixture(): Promise<void> {
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.isBootstrap, true)).catch(() => undefined);
    await db.delete(systemState).catch(() => undefined);
  }

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL!);
    // Fail loudly when the database is configured but unreachable.
    await db.execute(sql`SELECT 1`);
    await resetFixture();
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        received.push({ headers: req.headers, body });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    receiverUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (db) await resetFixture();
  });

  it('a created item reaches the pull API and a signed webhook', async () => {
    // ── setup + login ───────────────────────────────────────────────────────
    const setup = await request('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, firstName: 'Feed', lastName: 'Admin' },
        adminPath: '/feed-e2e-admin',
        policy: STANDARD_LOCKOUT_POLICY,
        project: { defaultLanguage: 'en', siteUrl: 'https://feed.example.test', displayTitle: 'Feed E2E' },
      }),
    });
    expect(setup.status, await setup.clone().text()).toBe(201);
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-heopress-site': SITE },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    bearer = `Bearer ${((await login.json()) as { data: { token: string } }).data.token}`;

    // ── collection, signed webhook, webhook subscription ───────────────────
    const coll = await request('/api/v1/collections', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: COLLECTION }),
    });
    expect(coll.status).toBe(201);

    const hook = await request('/api/v1/webhooks', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ name: 'feed-e2e', url: receiverUrl, secret: WEBHOOK_SECRET }),
    });
    expect(hook.ok, await hook.clone().text()).toBe(true);
    const webhookId = ((await hook.json()) as { data: { id: string } }).data.id;

    const sub = await request('/api/v1/cdc/subscriptions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        name: 'feed-e2e-webhook',
        kind: 'webhook',
        webhook_id: webhookId,
        collections: [COLLECTION],
        payload_mode: 'snapshot',
      }),
    });
    expect(sub.status, await sub.clone().text()).toBe(201);
    const subscriptionId = ((await sub.json()) as { data: { id: string } }).data.id;

    // ── the content write ──────────────────────────────────────────────────
    const item = await request(`/api/v1/items/${COLLECTION}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ data: { title: 'Change Feed E2E' }, status: 'draft' }),
    });
    expect(item.status).toBe(201);
    const itemId = ((await item.json()) as { data: { id: string } }).data.id;

    // ── 1. pull API (long-poll past the 2 s safety lag) ────────────────────
    const pulled = await request(`/api/v1/cdc/events?collections=${COLLECTION}&wait=10`, { headers: headers() });
    expect(pulled.status, await pulled.clone().text()).toBe(200);
    const feed = (await pulled.json()) as {
      data: Array<{ operation: string; itemId: string; collection: string }>;
      meta: { nextCursor: string | null };
    };
    expect(feed.data).toContainEqual(
      expect.objectContaining({ resource: 'item', operation: 'create', itemId, collection: COLLECTION, siteId: SITE }),
    );
    // Reading on from the returned cursor must not repeat the event (the
    // cursor/column precision mismatch fixed by migration 0020 did).
    expect(feed.meta.nextCursor).toBeTruthy();
    const next = await request(
      `/api/v1/cdc/events?collections=${COLLECTION}&cursor=${encodeURIComponent(feed.meta.nextCursor!)}`,
      { headers: headers() },
    );
    expect(next.status).toBe(200);
    expect(((await next.json()) as { data: unknown[] }).data).toEqual([]);

    // ── 2. signed webhook delivery ─────────────────────────────────────────
    const target = await loadWebhookTarget(db, SITE, webhookId);
    expect(target, 'the webhook has a signing secret').not.toBeNull();
    const sender = new WebhookSender({ fetchImpl: (url, init) => fetch(url, init) });
    const dispatcher = new CdcDispatcher({
      eventStore: new DrizzleCdcEventStore(db),
      subscriptions: new DrizzleSubscriptionDispatchStore(db),
      deliveryLog: new DrizzleDeliveryLog(db),
      senders: {
        webhook: { deliver: (s, envelopes) => sender.deliver(target!, envelopes, { id: s.id, name: s.name }) },
      },
      safetyLagMs: 0,
    });
    expect(await dispatcher.dispatchSubscriptionById(SITE, subscriptionId)).toBe(true);

    expect(received).toHaveLength(1);
    const delivery = received[0]!;
    const signature = delivery.headers[SIGNATURE_HEADER.toLowerCase()];
    expect(typeof signature).toBe('string');
    expect(await verifyCdcWebhookSignature(WEBHOOK_SECRET, signature as string, delivery.body)).toBe(true);
    expect(await verifyCdcWebhookSignature('wrong-secret', signature as string, delivery.body)).toBe(false);
    const payload = JSON.parse(delivery.body) as {
      events: Array<{ type: string; itemId: string; data?: { title?: string } }>;
      subscription: { id: string };
    };
    expect(payload.subscription.id).toBe(subscriptionId);
    expect(payload.events).toContainEqual(
      expect.objectContaining({ type: 'items.create', itemId, data: expect.objectContaining({ title: 'Change Feed E2E' }) }),
    );
  });
});
