# Background jobs, schedules and external actions

Everything here runs on PostgreSQL (HeoPress P03, ADR-0002). Redis, BullMQ and the Redis leader lock are gone.

## Job queue

`runtime.queue` is backed by [pg-boss](https://github.com/timgit/pg-boss) in the `pgboss` schema. The migrate script installs and upgrades that schema as the table owner; the application connects without schema rights.

- **Durable, at least once.** A job queued before a restart runs after it. A job whose worker dies is retried after its expiry. Handlers must therefore be idempotent — see *External actions* below for side effects outside the database.
- **Options:** `priority` (`high` / `normal` / `low`), `delay` (ms), `attempts` and `backoff` (`exponential` or `fixed`).
- **`singletonKey`:** at most one job with the same key is active at a time, across all workers; others wait. Use it for "one ingest per site at a time" (`ingest:<siteId>`). Jobs that carry a key go to a companion queue `<queue>__singleton` with pg-boss's `singleton` policy, so jobs without a key are never serialised.
- Readiness pings the queue instead of enqueueing a probe job. On SIGTERM the workers stop gracefully (active jobs get up to 10 s).

## Scheduled jobs

Every worker runs the same `node-cron` schedules; `scheduledJob(key, fn, { sql })` makes each slot run on exactly one of them:

1. The worker claims the slot by inserting `(schedule_key, scheduled_at)` into `lumibase_schedule_runs`. The slot is the cron's planned time truncated to the second, so workers agree on it regardless of small clock differences. Only one insert succeeds; the others skip the slot.
2. The winner takes a session `pg_try_advisory_lock` for the job on a reserved connection, so a slot never overlaps a still-running previous slot of the same job (recorded `skipped_overlap`). The lock only helps choose a runner; it disappears with the session if the worker dies.
3. The outcome is recorded: `succeeded` or `failed` (with the error).

A worker that crashes mid-slot leaves the row `running`, and that slot is never run again — its side effects cannot happen twice. Work that must not be lost goes on the durable queue. A week of history per job is kept for auditing missed slots.

Job callbacks must `await` their work: the lock is held only until the callback's promise settles (`serve-cron-await.test.ts` enforces this for `serve.ts`).

## External actions

Calls into other systems — webhooks, notifications, deployments, callbacks — can time out after the other side acted. `performExternalAction(sql, ref, target)` records each action in `lumibase_external_actions` under its idempotency key with one of four outcomes:

| State | Meaning | Next attempt |
|---|---|---|
| `not_sent` | never sent (or a manual check confirmed it did not happen) | sends |
| `failed` | the other side confirmed it did not execute | sends again |
| `succeeded` | done | never sends again |
| `unknown` | sent without a reliable answer: timeout, lost receipt, crash mid-send | see below |

The row becomes `unknown` *before* sending, so a crash mid-send reads the same as a lost receipt. For an `unknown` action:

- another attempt still in flight (its lease is live) → wait;
- the target can report the key's status → `succeeded` is recorded, `not executed` / `failed` is sent again, `processing` waits;
- the target deduplicates the key (`idempotencyWindowSeconds`) and the window is still open → sent again with the same key;
- otherwise the action is **paused** for manual reconciliation and never resent automatically. `resolveExternalAction(sql, key, 'succeeded' | 'not_executed', by)` settles it.

A local unique key is not an exactly-once guarantee across systems: only the target's own idempotency or status can settle `unknown`.

### Change Feed webhooks

Change Feed deliveries are recorded in `lumibase_cdc_deliveries` as `success`, `failed` (the consumer certainly did not process the batch: nothing was sent, or it answered 4xx other than 408) or `unknown` (timeout, dropped connection, 408, 5xx). Unknown batches are retried, which is safe only because every event carries its id and Change Feed consumers must deduplicate by it — the at-least-once contract in [Change Feed](../features/cdc-change-feed.md).
