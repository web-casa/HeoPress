---
version: 2
lastUpdated: 2026-09-01T19:25:55.310Z
sourceLang: en
contentHash: f969bfdcd82da644
codeVerified: 2026-09-01T19:25:55.310Z
codeVerifiedHash: f969bfdcd82da644
codeVerifiedClaims: 10
---

# Change Feed (CDC Extension Integration)

> Spec: `docs/legacy/kiro-specs/cdc-extension-integration/` · Module: `apps/cms/src/modules/cdc/change-feed/`

A first-party **transactional outbox + relay** over HeoPress content mutations. Every item create/update/delete appends one immutable change event; consumers read them through a cursor-paginated pull API, HMAC-signed webhooks, or sandboxed extension subscribers — reliably, in order, with replay.

The Change Feed is about *your* content changes reaching *your* integrations. (The ClickHouse CDC control plane that provisioned external Postgres→ClickHouse replication was removed in HeoPress P02.)

## 1. Architecture

```
ItemService mutation ──(same request)──▶ lumibase_cdc_change_events (outbox, append-only)
        │                                        ▲
        └─ enqueue cdc-dispatch (latency path)   │ position reads (txid, seq), never past a running transaction
                                                 │
   30s sweep (correctness backstop) ──▶ CdcDispatcher ──▶ webhook (HMAC POST)
                                                 │       └▶ extension subscriber (sandbox, 5s budget)
   GET /api/v1/cdc/events  ◀── pull consumers ───┘
```

- **Writing** — every content change writes its event **in the change's own transaction** (HeoPress P04, ADR-0011): items (create, edit, publish, hold, delete, bulk), scheduled publishing and unpublishing, editorial transitions and dependents resolution. If the event cannot be written the change rolls back and the caller gets an error. Events are written for every site, not only sites with the feed enabled — search sync and later consumers depend on them.
- **Ordering** — event ids are nanoid (no ordering meaning). The feed's order is each event's **position**: the writing transaction's id and a sequence number (`txid`, `seq`). Readers only read events of transactions older than every transaction still running (`txid < pg_snapshot_xmin(pg_current_snapshot())`), so a transaction that commits late is read late — never skipped, however long it was open. Cursors keep their token format; the event id in a cursor is resolved to its position.
- **Delivery semantics** — at-least-once, never exactly-once. `event.id` is the idempotency key; consumers MUST dedupe on it. A cursor advances past a delivered batch, or past a batch that failed every retry — that batch is dead-lettered (`lumibase_event_consumer_failures`) and a replay re-delivers it — so one bad batch does not block the lane, and nothing is skipped silently.

## 2. Event envelope (schemaVersion 1)

```jsonc
{
  "id": "V1StGXR8_Z5jdHi6B-myT",        // idempotency key
  "type": "items.update",                 // <resource>.<operation> — items.* | collections.* | fields.* | settings.*
  "schemaVersion": 1,
  "siteId": "s_abc",
  "collection": "posts",
  "itemId": "itm_xyz",
  "operation": "update",                  // create | update | delete
  "occurredAt": "2026-07-11T04:12:09.123Z",
  "actor": { "type": "api_key", "id": "key_123" },  // user | api_key | agent | system
  "source": "api",                        // api | agent | flow | system
  "changedFields": ["title", "status"],  // update only
  "data": { "title": "…" },              // ONLY in snapshot mode; pii/phi masked
  "cursor": "MTc1MT…"                     // this event's keyset token — ack/resume marker
}
```

- `payloadMode: 'reference'` (default) omits `data` — the consumer re-fetches `GET /items/:collection/:id` with its own token, so its RBAC decides what it sees. `snapshot` inlines the post-mutation record with `pii`/`phi` fields already replaced by `[masked]` **before** the event was stored.
- **Resource kinds**: `items.*` are content-row changes (the default). Schema DDL emits `collections.*` (with `collection`/`itemId` = the collection name) and `fields.*` (`collection` = owning collection, `itemId` = field name); their `data` is the definition, stored verbatim (schema metadata carries no per-field pii/phi classification, so masking is item-only). A consumer that only wants content changes filters on the `items.` prefix. (`settings.*` is a planned follow-up — see `docs/legacy/kiro-specs/cdc-feed-roadmap/`.)
- Versioning: additive fields keep `schemaVersion: 1`; renames/removals bump it, and the previous version stays serializable for at least one minor release. `EventEnvelopeSchema` in `@heopress/contracts/schemas` is the source of truth.

## 3. Pull consumers

```bash
# First page (needs the cdc:subscribe capability — admin implies it)
curl -H "Authorization: Bearer lbk_…" -H "X-HeoPress-Site: s_abc" \
  "https://cms.example.com/api/v1/cdc/events?collections=posts&limit=100"
# → { "data": [...], "meta": { "nextCursor": "…", "hasMore": true } }

# Continue from the cursor; 410 CURSOR_EXPIRED (with earliestCursor) means you
# fell behind retention — resync from scratch or from earliestCursor.
curl … "https://cms.example.com/api/v1/cdc/events?cursor=<nextCursor>"

# Long-poll (avoid tight empty polling): the server holds an empty first read
# for up to `wait` seconds (≤25) and returns as soon as an event arrives.
curl … "https://cms.example.com/api/v1/cdc/events?cursor=<nextCursor>&wait=20"
```

Register a `kind: 'pull'` subscription to get a durable checkpoint + lag metrics, and commit it with `POST /api/v1/cdc/subscriptions/:id/ack {"cursor": "…"}`. Acks are forward-only (409 `ACK_REGRESSION` on rewind) — rewinding is what `replay` is for.

Prefer typed access from JS/TS? `@heopress/sdk` ships command resources for the whole surface (`readCdcEvents`, `ackCdcSubscription`, `replayCdcSubscription`, …); the machine-readable contract lives in `apps/cms/openapi.yaml`:

```ts
import { readCdcEvents, ackCdcSubscription } from '@heopress/sdk';

let cursor: string | undefined;
for (;;) {
  const { data, meta } = await client.request(readCdcEvents({ collections: ['posts'], cursor }));
  for (const event of data) await handle(event); // dedupe on event.id
  cursor = meta.nextCursor ?? cursor;
  if (!meta.hasMore) break;
}
await client.request(ackCdcSubscription(subId, cursor!)); // durable checkpoint
```

## 4. Webhook consumers

Create a webhook (Settings → Webhooks) **with a secret** — unsigned delivery is refused — then a subscription with `kind: 'webhook'` and `webhook_id`. Batches arrive as:

```
POST <webhook.url>
Content-Type: application/json
X-HeoPress-Signature: t=<unix_seconds>,v1=<hmac_sha256_hex>

{ "events": [<envelope>…], "subscription": { "id": "…", "name": "…" } }
```

Verify before trusting (constant-time compare; reject stale timestamps):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(secret: string, header: string, rawBody: string, toleranceSec = 300): boolean {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  if (Math.abs(Date.now() / 1000 - Number(m[1])) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(m[2]));
}
```

Failed batches retry with exponential backoff (30s·2ⁿ, 5 attempts); 10 exhausted batches in a row flip the subscription to `dead` (notification emitted). A batch that exhausts its attempts is dead-lettered and the subscription moves on to the next batch; a dead subscription stops at the batch it could not deliver. Resume only via replay.

A timed-out delivery is retried, not held for a person to decide: the receiver may or may not have processed it, and the receiver's dedupe on `event.id` (required above) makes the retry safe. Internal consumers whose side effect cannot be deduplicated report an unknown outcome instead and stop until someone decides ([event consumers](../architecture/event-consumers.md)).

## 5. Build your first sink connector (extension subscriber)

1. **Manifest** (`heopress-extension.json`): type `hook`, and one `cdc:subscribe:<collection>` capability per collection (or `cdc:subscribe:*`):

```json
{
  "name": "acme/algolia-sync",
  "version": "1.0.0",
  "type": "hook",
  "entry": "dist/index.js",
  "capabilities": ["cdc:subscribe:posts", "http:fetch:acme.algolia.net"],
  "compatibleWith": ">=0.21.0"
}
```

2. **Handler** — export `cdcSubscriber` (see `defineCdcSubscriber` in `@heopress/extension-sdk`). Make it **idempotent on `event.id`**; you will occasionally see a batch twice:

```ts
import { defineCdcSubscriber } from '@heopress/extension-sdk';

export const cdcSubscriber = defineCdcSubscriber({
  collections: ['posts'],
  handler: async ({ events, ctx }) => {
    for (const event of events) {
      // Upsert/delete by itemId — naturally idempotent.
      await fetch(`https://acme.algolia.net/1/indexes/posts/${event.itemId}`, {
        method: event.operation === 'delete' ? 'DELETE' : 'PUT',
        body: event.operation === 'delete' ? undefined : JSON.stringify({ id: event.itemId }),
      });
      ctx.logger.info('synced', { id: event.id });
    }
  },
});
```

3. **Ship it**: build the ESM bundle → upload via Studio → admin reviews and **grants** the capabilities → enable. Enabling auto-creates the `ext:<name>` subscription; disabling pauses it (the checkpoint survives). The host filters events to your granted collections **before** the sandbox — declaring more in code grants nothing.


## 6. Operate

- **Studio** → Settings → Change Feed: status/lag per subscription, recent deliveries, pause/resume/replay/dispatch-now (destructive actions confirm first).
- **Replay** (`POST /api/v1/cdc/subscriptions/:id/replay {"occurred_after": "…"}` or `{"cursor": "…"}`) rewinds and resets `dead`/`stale` to `active` — the only path out of those states. Audited. It is refused (out of retention) when anything after the replay point was deleted: for a time, any deleted event that happened at or after it. A replay and a prune of the same site never interleave. The subscription's cursor in responses carries its exact position (`ms:eventId|txid.seq`; after a replay from a time the event id is empty), so a client can always read on from it.
- **Retention** — `cdc_feed.retentionDays` site setting (default 30, range 1–90). An event older than that is removed only when **every registered consumer has confirmed it**: every subscription that is not dead (stale and paused ones included) and every [event consumer](../architecture/event-consumers.md). A consumer that has stopped keeps the events it has not reached, however long ago its checkpoint was. A subscription flips to `stale` only when events after its checkpoint were in fact deleted (one that was not registered), never because the checkpoint is old. Delivery logs are pruned by age.
- **Visibility** — an event becomes readable once its transaction and every older running transaction have finished. A long transaction anywhere in the database holds the feed back until it ends (it does not lose events); watch for idle-in-transaction sessions.
- **Push delivery failures** — a batch is retried with backoff (5 attempts); if every attempt fails, the batch goes to the subscription's dead letter (`lumibase_event_consumer_failures`, state `dead`) and the lane moves on, so one bad batch no longer blocks every later event. After 10 failed batches in a row the subscription is marked `dead`; replay resumes it.
- **End-to-end check** — `apps/cms/src/__tests__/change-feed.e2e.test.ts` creates an item through the API, reads it from `/api/v1/cdc/events`, verifies the next cursor does not repeat it, and verifies the `X-HeoPress-Signature` of a webhook delivery (runs with `DATABASE_URL`, like the other database suites).
- **AI skills** — `listCdcSubscriptions`, `getCdcSubscriptionStatus`, `createCdcSubscription`, `replayCdcSubscription` (capability `cdc:manage`), and `deleteCdcSubscription` (control-plane → HITL approval below autopilot). Same surface over MCP (`cdc_*` tools) — REST passthrough, no guard bypass.

## 7. Multi-tenancy

All three tables (`lumibase_cdc_change_events`, `lumibase_cdc_subscriptions`, `lumibase_cdc_deliveries`) carry `site_id`, are covered by `site_isolation` RLS policies, and every query filters by site. Cache flags and dispatch locks are tenant-prefixed (`cdc:feed:<siteId>:…`, `cdc:dispatch:<siteId>:<subId>`). Property tests pin the two-site smoke: site A's reads and deliveries never contain site B's events.

## 8. Settings & capabilities reference

| Key | Where | Default | Meaning |
|---|---|---|---|
| `cdc_feed.enabled` | `settings` (site) | `false` | Write outbox events even with no active subscription |
| `cdc_feed.retentionDays` | `settings` (site) | `30` | Prune window (1–90) |
| `cdc:subscribe` | role/capability | — | Read `/cdc/events`, ack checkpoints (admin implies) |
| `cdc:manage` | capability (skills) | — | Manage subscriptions via AI skills/MCP |
| `cdc:subscribe:<collection>` | extension manifest | — | Collections an extension subscriber may receive |
