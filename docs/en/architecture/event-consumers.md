# Event consumers

Everything that reacts to content changes — search sync today; cache
invalidation (P06), translation freshness (P05), IndexNow and the internal link graph (P07) next — is an
**event consumer** of the Change Feed events (HeoPress P04, spec
`platform/event-consumption`, ADR-0011). Consumers are written against one
framework, `apps/cms/src/modules/events/consumer-runner.ts`, instead of each
building its own queue, cursor and retry logic.

## Consistency the writer guarantees

- **Every change has its event, in the same transaction.** Item writes
  (create, edit, publish, hold, delete, bulk), scheduled publishing and
  unpublishing, editorial transitions and dependents resolution write the
  event in the transaction of the change. If the event cannot be written,
  the change rolls back — content never changes without its event.
- **Events carry the item version** they produced (`item_version`), so a
  consumer can tell an older event from a newer one.
- **Late commits are not skipped.** Events are read by position (`txid`,
  `seq`) and never past a transaction that may still commit.
- **Retries of client writes are not repeated** when the client sends an
  `Idempotency-Key` (see [item versions](../api/hono-api-spec.md)); without
  one, version checks still stop a retried update from applying twice.

## What a consumer gets

```ts
import type { EventConsumerDefinition } from '../modules/events/consumer-runner';

export function myConsumer(deps: { db: Database }): EventConsumerDefinition {
  return {
    name: 'my-consumer',          // unique and stable: the position hangs off it
    siteId: null,                 // or one site's id
    startFrom: 'head',            // or 'start' for every retained event
    accepts: (event) => event.resource === 'item',
    maxAttempts: 5,               // then the dead letter
    retryBaseMs: 30_000,          // 30 s, 60 s, 120 s, …
    async handle(event, { idempotencyKey, attempt }) {
      // Re-read state rather than trusting the event payload, or compare
      // event.itemVersion, so an old or repeated event changes nothing.
      // Pass idempotencyKey to anything external that can deduplicate.
    },
  };
}
```

Register it in the worker (`serve.ts`, `registerEventConsumers`). The loop
runs every consumer once per tick (1 s) and when a write wakes it.

| Property | How |
|---|---|
| Own position, in order | `lumibase_event_consumers.cursor_txid/cursor_seq`; events are handled in position order (`txid`, `seq`), and never past a transaction still running |
| At least once, idempotent | an event is recorded as handled (`lumibase_event_consumer_processed`) in the same statement that moves the position; a re-delivered handled event is skipped; handlers get `idempotencyKey = <consumer>:<event id>` for external side effects |
| Crash recovery | a runner that dies holds a lease (2 min) that runs out; the next runner continues from the position — an event in flight is delivered again, with the same key |
| Retries | a failing event is retried in place with exponential backoff; later events wait behind it, so order is kept |
| Dead letter | after `maxAttempts` the event is recorded `dead` in `lumibase_event_consumer_failures` and the consumer moves on — a dead event never blocks the events after it |
| Unknown outcome | throw `UnknownOutcomeError` when a side effect may or may not have happened: the consumer stops at that event until a person decides (`resolveUnknown(consumer, eventId, 'done' \| 'retry')`) |
| Pause | `pauseAfterConsecutiveFailures`, `pause`, `resume`; a paused consumer still holds back retention |
| Isolation | consumers run one after another; a failing consumer only delays itself |
| Retention | events are kept until every registered consumer has passed them ([retention](../features/cdc-change-feed.md)) |

Reconciliation stays as the second line of defence: consumers that maintain
derived state (search, caches) should still be able to rebuild it from the
source tables.

Push subscriptions (webhooks, extensions) are consumers too: their lanes
record their position in `lumibase_event_consumers` (`cdc-subscription:<id>`)
and their dead letters in `lumibase_event_consumer_failures`, and deliver in
batches with their own delivery log ([Change Feed](../features/cdc-change-feed.md)).
