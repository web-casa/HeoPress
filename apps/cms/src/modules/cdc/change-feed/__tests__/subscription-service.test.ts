/**
 * Change Feed subscriptions: creation, patching, checkpoints and replay (HeoPress P04 tasks 3.1–3.5, 6.2–6.3; P14
 * task 8.1).
 *
 * Every rule here exists because a feed consumer can lose or repeat events: a checkout is forward-only (a rewind
 * goes through replay), a status change follows the state machine (dead/stale resume only via replay), a replay
 * target inside the retention window is kept and one before it refused, and the registry position changes with the
 * checkpoint in one transaction. The database is an in-memory stand-in; `positions-and-retention.db.integration`
 * exercises the same paths on PostgreSQL.
 */
import { describe, expect, it } from 'vitest';
import { cdcSubscriptions } from '@heopress/database';
import { encodeCdcCursor } from '@heopress/contracts/schemas';
import {
  AckRegressionError,
  InvalidTransitionError,
  MAX_SUBSCRIPTIONS_PER_SITE,
  ReplayOutOfRetentionError,
  SubscriptionLimitExceededError,
  SubscriptionNameConflictError,
  SubscriptionNotFoundError,
  SubscriptionService,
  WebhookSecretRequiredError,
} from '../subscription-service';
import type { CdcEventStore } from '../feed-reader';

const siteId = 'site_a';
const NOW = new Date('2026-06-04T10:00:00.000Z');

/** The text of a Drizzle `sql` template, enough to route a fake `execute`. */
function sqlText(node: unknown): string {
  const chunks = (node as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  return chunks.flatMap((chunk) => {
    const value = (chunk as { value?: unknown }).value;
    return typeof value === 'string' ? [value] : Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : [];
  }).join('');
}

interface Options {
  subscriptions?: Array<Record<string, unknown>>;
  webhooks?: Array<Record<string, unknown>>;
  deliveries?: Array<Record<string, unknown>>;
  registry?: { txid: string; seq: number } | null;
  eventsAfter?: number;
  latest?: Date | null;
  expired?: boolean;
  deleteRows?: boolean;
}

function harness(options: Options = {}) {
  const subscriptions = [...(options.subscriptions ?? [])];
  const webhooks = [...(options.webhooks ?? [])];
  const deliveries = [...(options.deliveries ?? [])];
  const audits: Array<{ event: string; metadata: Record<string, unknown> }> = [];
  const executed: string[] = [];
  let transactions = 0;

  /** The columns a predicate can name a row by. */
  const IDENTITY = ['id', 'name', 'webhookId', 'policyId', 'roleId', 'apiKeyId'] as const;
  const matches = (row: Record<string, unknown>, params: unknown[]): boolean => {
    if (params.length === 0) return true;
    const named = params.filter((value) => typeof value === 'string');
    const names = new Set<string>();
    for (const candidate of [...subscriptions, ...webhooks]) {
      for (const column of IDENTITY) {
        const value = candidate[column];
        if (typeof value === 'string' && named.includes(value)) names.add(value);
      }
    }
    // A predicate that names a row selects it; one that only names the site selects every row of the site.
    if (names.size === 0) return true;
    return IDENTITY.some((column) => row[column] !== undefined && names.has(String(row[column])));
  };

  const paramsOf = (predicate: unknown): unknown[] => {
    const out: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const chunk = node as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
      if (chunk.constructor?.name === 'Param') {
        out.push(chunk.value);
        return;
      }
      if (Array.isArray(chunk.queryChunks)) chunk.queryChunks.forEach(walk);
    };
    walk(predicate);
    return out;
  };

  const rowsFor = (table: unknown): Array<Record<string, unknown>> => {
    if (table === cdcSubscriptions) return subscriptions;
    if (deliveries.length && String(table && (table as { name?: string }).name).includes('deliveries')) return deliveries;
    return [];
  };
  const tableOf = (table: unknown): 'subscriptions' | 'deliveries' | 'other' => {
    if (table === cdcSubscriptions) return 'subscriptions';
    if ((table as { name?: string } | undefined)?.name && String((table as { name: string }).name).includes('deliveries')) return 'deliveries';
    return 'other';
  };

  const db = {
    select: (projection?: Record<string, unknown>) => {
      let table: unknown;
      let params: unknown[] = [];
      const snapshot = () => {
        const tableKind = tableOf(table);
        if (tableKind === 'other') return [];
        // `select({ n: count() })` is the count view.
        if (projection && 'n' in projection) return [{ n: rowsFor(table).length }];
        return rowsFor(table).filter((row) => matches(row, params)).map((row) => ({ ...row }));
      };
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = t;
        return chain;
      };
      chain.where = (predicate: unknown) => {
        params = paramsOf(predicate);
        return chain;
      };
      chain.for = () => chain;
      chain.orderBy = () => chain;
      chain.limit = () => chain;
      chain.offset = () => chain;
      chain.then = (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) => Promise.resolve(snapshot()).then(resolve, reject);
      return chain;
    },
    insert: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      let values: Record<string, unknown> = {};
      chain.values = (input: Record<string, unknown>) => {
        values = input;
        return chain;
      };
      chain.returning = () => {
        if (table === cdcSubscriptions) {
          const created = {
            id: `sub_${subscriptions.length + 1}`,
            siteId,
            status: 'active',
            cursorOccurredAt: null,
            cursorId: null,
            webhookId: null,
            extensionName: null,
            consecutiveFailures: 0,
            lastDeliveredAt: null,
            createdAt: NOW,
            updatedAt: NOW,
            ...values,
          };
          subscriptions.push(created);
          return Promise.resolve([{ ...created }]);
        }
        return Promise.resolve([{ ...values }]);
      };
      chain.onConflictDoUpdate = () => chain;
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    update: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      let set: Record<string, unknown> = {};
      let params: unknown[] = [];
      const apply = (): Array<Record<string, unknown>> => {
        const target = rowsFor(table).filter((row) => matches(row, params));
        for (const row of target) {
          Object.assign(row, Object.fromEntries(Object.entries(set).filter(([, v]) => v !== undefined)));
        }
        return target.map((row) => ({ ...row }));
      };
      chain.set = (input: Record<string, unknown>) => {
        set = input;
        return chain;
      };
      chain.where = (predicate: unknown) => {
        params = paramsOf(predicate);
        return chain;
      };
      chain.returning = () => Promise.resolve(apply());
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(apply()).then(resolve);
      return chain;
    },
    delete: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.where = (predicate: unknown) => {
        const params = paramsOf(predicate);
        const rows = rowsFor(table);
        const keep = rows.filter((row) => !matches(row, params));
        rows.length = 0;
        rows.push(...keep);
        return Promise.resolve(undefined);
      };
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    execute: (query: unknown) => {
      const text = sqlText(query);
      executed.push(text);
      if (text.includes('FROM lumibase_event_consumers') && text.includes('SELECT')) {
        return Promise.resolve(options.registry ? [{ txid: options.registry.txid, seq: options.registry.seq }] : []);
      }
      if (text.includes('lumibase_cdc_change_events')) return Promise.resolve([]);
      return Promise.resolve([]);
    },
    transaction: async (cb: (tx: unknown) => Promise<unknown>) => {
      transactions += 1;
      return cb(db);
    },
  };

  const eventStore: CdcEventStore = {
    countAfter: async () => options.eventsAfter ?? 0,
    latest: async () => (options.latest ? ({ id: 'ev_head', occurredAt: options.latest } as never) : null),
    isExpired: async () => options.expired ?? false,
    readAfter: async () => [] as never,
    readBefore: async () => [] as never,
  } as unknown as CdcEventStore;

  const service = new SubscriptionService({
    db: db as never,
    siteId,
    eventStore,
    cache: { delete: async () => undefined } as never,
    retentionDays: 7,
    now: () => NOW,
    audit: (event, metadata) => {
      audits.push({ event, metadata });
    },
  });

  return {
    service,
    subscriptions,
    webhooks,
    deliveries,
    audits,
    executed,
    db,
    transactionCount: () => transactions,
  };
}

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'sub_1',
  siteId,
  name: 'Puller',
  kind: 'pull',
  collections: ['posts'],
  operations: ['create'],
  payloadMode: 'full',
  cursorOccurredAt: null,
  cursorId: null,
  status: 'active',
  webhookId: null,
  extensionName: null,
  consecutiveFailures: 0,
  lastDeliveredAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('create', () => {
  it('refuses the 51st subscription for a site', async () => {
    const many = Array.from({ length: MAX_SUBSCRIPTIONS_PER_SITE }, (_, i) => row({ id: `sub_${i}`, name: `s${i}` }));
    const { service } = harness({ subscriptions: many });
    await expect(service.create({ name: 'one too many', kind: 'pull', collections: ['posts'], operations: ['create'], payload_mode: 'full' } as never)).rejects.toBeInstanceOf(
      SubscriptionLimitExceededError,
    );
  });

  it('refuses a duplicate name', async () => {
    const { service } = harness({ subscriptions: [row()] });
    await expect(service.create({ name: 'Puller', kind: 'pull', collections: ['posts'], operations: ['create'], payload_mode: 'full' } as never)).rejects.toBeInstanceOf(
      SubscriptionNameConflictError,
    );
  });

  it('a webhook subscription needs a webhook with a signing secret', async () => {
    const missing = harness();
    await expect(
      missing.service.create({ name: 'Hook', kind: 'webhook', webhook_id: 'wh_missing', collections: ['posts'], operations: ['create'], payload_mode: 'full' } as never),
    ).rejects.toBeInstanceOf(WebhookSecretRequiredError);

    const secretless = harness({ webhooks: [] });
    // The row exists but has no secret: the query filters on `secret`, so it is absent.
    await expect(
      secretless.service.create({ name: 'Hook', kind: 'webhook', webhook_id: 'wh_1', collections: ['posts'], operations: ['create'], payload_mode: 'full' } as never),
    ).rejects.toBeInstanceOf(WebhookSecretRequiredError);
  });

  it('creates a pull subscription with its registry entry, and audits it', async () => {
    const { service, subscriptions, audits, executed, transactionCount } = harness();
    const created = await service.create({ name: 'Puller', kind: 'pull', collections: ['posts'], operations: ['create'], payload_mode: 'full' } as never);
    expect(created).toMatchObject({ name: 'Puller', kind: 'pull', status: 'active', cursor: null, lag: { events: 0, behindMs: null } });
    expect(subscriptions).toHaveLength(1);
    expect(transactionCount()).toBe(1);
    expect(executed.some((text) => text.includes('lumibase_event_consumers') && text.includes('INSERT'))).toBe(true);
    expect(audits).toEqual([{ event: 'cdc_subscription_created', metadata: { subscriptionId: 'sub_1', name: 'Puller', kind: 'pull' } }]);
  });

  it('keeps the extension name of a plugin subscription', async () => {
    const { service } = harness();
    const created = await service.create({ name: 'Ext', kind: 'pull', collections: [], operations: [], payload_mode: 'full', extension_name: 'ext_1' } as never);
    expect(created.extensionName).toBe('ext_1');
    expect(created.collections).toEqual([]);
    expect(created.operations).toEqual([]);
  });
});

describe('reading a subscription', () => {
  it('computes lag only once a checkpoint exists', async () => {
    const { service } = harness({
      subscriptions: [row({ cursorOccurredAt: new Date('2026-06-04T09:00:00.000Z'), cursorId: 'ev_1' })],
      eventsAfter: 4,
      latest: new Date('2026-06-04T09:30:00.000Z'),
    });
    const record = await service.get('sub_1');
    expect(record.lag).toEqual({ events: 4, behindMs: 30 * 60_000 });
    expect(record.cursor).toBe(encodeCdcCursor({ occurredAtMs: new Date('2026-06-04T09:00:00.000Z').getTime(), eventId: 'ev_1' }));

    const noHead = harness({
      subscriptions: [row({ cursorOccurredAt: new Date('2026-06-04T09:00:00.000Z'), cursorId: 'ev_1' })],
      latest: null,
    });
    expect((await noHead.service.get('sub_1')).lag.behindMs).toBeNull();

    const ahead = harness({
      subscriptions: [row({ cursorOccurredAt: new Date('2026-06-04T09:59:00.000Z'), cursorId: 'ev_2' })],
      latest: new Date('2026-06-04T09:00:00.000Z'),
    });
    expect((await ahead.service.get('sub_1')).lag.behindMs).toBe(0);
  });

  it('a replay-from-time checkpoint has an empty event id and its registry position when recorded', async () => {
    const { service } = harness({
      subscriptions: [row({ cursorOccurredAt: new Date('2026-06-04T09:00:00.000Z'), cursorId: null })],
      registry: { txid: '900', seq: 3 },
    });
    const record = await service.get('sub_1');
    expect(record.cursor).toBe(encodeCdcCursor({ occurredAtMs: new Date('2026-06-04T09:00:00.000Z').getTime(), eventId: '', position: { txid: '900', seq: 3 } }));
  });

  it('falls back to null collections/operations when the row carries none', async () => {
    const { service } = harness({ subscriptions: [row({ collections: null, operations: null })] });
    const record = await service.get('sub_1');
    expect(record.collections).toEqual([]);
    expect(record.operations).toEqual([]);
  });

  it('answers 404 for an unknown subscription', async () => {
    const { service } = harness();
    await expect(service.get('sub_missing')).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    await expect(service.listDeliveries('sub_missing')).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    await expect(service.remove('sub_missing')).rejects.toBeInstanceOf(SubscriptionNotFoundError);
    await expect(service.patch('sub_missing', { name: 'x' } as never)).rejects.toBeInstanceOf(SubscriptionNotFoundError);
  });

  it('lists newest first', async () => {
    const { service } = harness({ subscriptions: [row(), row({ id: 'sub_2', name: 'Second' })] });
    expect((await service.list()).map((record) => record.id)).toEqual(['sub_1', 'sub_2']);
  });
});

describe('patch', () => {
  it('follows the admin state machine: pause and resume, but not out of dead', async () => {
    const { service, subscriptions, audits } = harness({ subscriptions: [row()] });
    expect(await service.patch('sub_1', { status: 'paused' } as never)).toMatchObject({ status: 'paused' });
    expect(audits.map((a) => a.event)).toEqual(['cdc_subscription_status_changed']);
    expect(audits[0]!.metadata).toMatchObject({ from: 'active', to: 'paused' });
    expect(await service.patch('sub_1', { status: 'active' } as never)).toMatchObject({ status: 'active' });
    expect(audits).toHaveLength(2);

    subscriptions[0]!.status = 'dead';
    await expect(service.patch('sub_1', { status: 'active' } as never)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('lets a subscription keep its own name but refuses another subscription’s', async () => {
    const { service, subscriptions } = harness({
      subscriptions: [row(), row({ id: 'sub_2', name: 'Other' })],
    });
    expect(await service.patch('sub_1', { name: 'Puller' } as never)).toMatchObject({ name: 'Puller' });
    await expect(service.patch('sub_1', { name: 'Other' } as never)).rejects.toBeInstanceOf(SubscriptionNameConflictError);
    expect(subscriptions[0]!.name).toBe('Puller');
  });

  it('updates filters and payload mode without an audit when the status does not change', async () => {
    const { service, subscriptions, audits } = harness({ subscriptions: [row()] });
    const updated = await service.patch('sub_1', { collections: ['pages'], operations: ['update'], payload_mode: 'keys' } as never);
    expect(updated).toMatchObject({ collections: ['pages'], operations: ['update'], payloadMode: 'keys' });
    expect(subscriptions[0]!.updatedAt).toEqual(NOW);
    expect(audits).toEqual([]);
  });
});

describe('remove', () => {
  it('deletes the row and audits it', async () => {
    const { service, subscriptions, audits } = harness({ subscriptions: [row()] });
    await service.remove('sub_1');
    expect(subscriptions).toHaveLength(0);
    expect(audits).toEqual([{ event: 'cdc_subscription_deleted', metadata: { subscriptionId: 'sub_1', name: 'Puller', kind: 'pull' } }]);
  });
});

describe('ack', () => {
  const first = { occurredAtMs: Date.parse('2026-06-04T09:00:00.000Z'), eventId: 'ev_1' };
  const second = { occurredAtMs: Date.parse('2026-06-04T09:10:00.000Z'), eventId: 'ev_2' };

  it('refuses an unreadable cursor token', async () => {
    const { service } = harness({ subscriptions: [row()] });
    await expect(service.ack('sub_1', 'not-a-cursor')).rejects.toBeInstanceOf(AckRegressionError);
  });

  it('commits a forward checkpoint with its registry position in one transaction', async () => {
    const { service, subscriptions, transactionCount, executed } = harness({ subscriptions: [row()] });
    const record = await service.ack('sub_1', encodeCdcCursor(second));
    expect(record.cursor).toBe(encodeCdcCursor(second));
    expect(record.lastDeliveredAt).toEqual(NOW);
    expect(subscriptions[0]!.cursorId).toBe('ev_2');
    expect(transactionCount()).toBe(1);
    expect(executed.some((text) => text.includes('lumibase_event_consumers'))).toBe(true);
  });

  it('refuses a checkpoint that moves backwards', async () => {
    const { service } = harness({
      subscriptions: [row({ cursorOccurredAt: new Date(second.occurredAtMs), cursorId: second.eventId })],
      registry: { txid: '950', seq: 1 },
    });
    await expect(service.ack('sub_1', encodeCdcCursor(first))).rejects.toBeInstanceOf(AckRegressionError);
  });

  it('allows the same checkpoint again (a retried ack)', async () => {
    const { service } = harness({
      subscriptions: [row({ cursorOccurredAt: new Date(second.occurredAtMs), cursorId: second.eventId })],
    });
    await expect(service.ack('sub_1', encodeCdcCursor(second))).resolves.toMatchObject({ status: 'active' });
  });

  it('answers 404 when the row is gone', async () => {
    const { service } = harness({ subscriptions: [] });
    await expect(service.ack('sub_1', encodeCdcCursor(second))).rejects.toBeInstanceOf(SubscriptionNotFoundError);
  });
});

describe('replay', () => {
  const actor = { type: 'user', id: 'usr_1' };

  it('refuses an unreadable cursor token', async () => {
    const { service } = harness({ subscriptions: [row()] });
    await expect(service.replay('sub_1', { cursor: 'nope' }, actor)).rejects.toBeInstanceOf(ReplayOutOfRetentionError);
  });

  it('refuses a target before the retention window', async () => {
    const { service } = harness({ subscriptions: [row({ status: 'dead' })], expired: true });
    await expect(
      service.replay('sub_1', { cursor: encodeCdcCursor({ occurredAtMs: Date.parse('2020-01-01T00:00:00.000Z'), eventId: 'ev_old' }) }, actor),
    ).rejects.toBeInstanceOf(ReplayOutOfRetentionError);
  });

  it('rewinds by cursor, resets the failure count and reactivates the subscription', async () => {
    const { service, subscriptions, audits } = harness({
      subscriptions: [row({ status: 'dead', consecutiveFailures: 4, cursorOccurredAt: new Date(NOW.getTime() - 3_600_000), cursorId: 'ev_9' })],
    });
    const target = { occurredAtMs: Date.parse('2026-06-04T09:00:00.000Z'), eventId: 'ev_1' };
    const record = await service.replay('sub_1', { cursor: encodeCdcCursor(target) }, actor);
    expect(record).toMatchObject({ status: 'active', consecutiveFailures: 0 });
    expect(subscriptions[0]!.cursorId).toBe('ev_1');
    expect(audits[0]!.event).toBe('cdc_subscription_replayed');
    expect(audits[0]!.metadata).toMatchObject({
      previousStatus: 'dead',
      actorType: 'user',
      actorId: 'usr_1',
      from: expect.any(String),
      to: encodeCdcCursor(target),
    });
  });

  it('rewinds to a time, storing an empty event id (a checkpoint whose position the registry holds)', async () => {
    const { service, audits } = harness({ subscriptions: [row({ status: 'stale' })] });
    const record = await service.replay('sub_1', { occurredAfter: '2026-06-04T09:00:00.000Z' }, { type: 'admin' });
    expect(record.cursor).toBe(encodeCdcCursor({ occurredAtMs: Date.parse('2026-06-04T09:00:00.000Z'), eventId: '' }));
    expect(audits[0]!.metadata).toMatchObject({ actorId: null, from: null });
  });
});

describe('delivery history', () => {
  it('clamps the page size and the page number', async () => {
    const { service } = harness({ subscriptions: [row()] });
    const zero = await service.listDeliveries('sub_1', { limit: 0, page: 0 });
    expect(zero).toEqual({ data: [], total: 0 });
    const huge = await service.listDeliveries('sub_1', { limit: 500, page: 2 });
    expect(huge.total).toBe(0);
    const def = await service.listDeliveries('sub_1');
    expect(def).toEqual({ data: [], total: 0 });
  });
});
