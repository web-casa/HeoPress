---
version: 4
lastUpdated: 2026-10-13T19:46:03.541Z
sourceLang: en
contentHash: 7cbba410d113f4c5
codeVerified: 2026-10-13T19:46:03.541Z
codeVerifiedHash: 7cbba410d113f4c5
codeVerifiedClaims: 8
---

# Asynchronous agent runs

`POST /api/v1/agent/goals` accepts `execution: "async"`, a `task` containing
`skillName` and `arguments`, and a `budget`. It returns `202` with a queued run.
The queue payload carries the budget and the principal reference; the worker
resolves current capabilities when it receives the job. When the `agent-runs` queue is
unavailable the request returns `400 ASYNC_UNAVAILABLE` before a goal or run is created.

## Execution and recovery

The Node process consumes the `agent-runs` queue (`registerAgentRunWorker` in
`apps/cms/src/services/agent-run-worker.ts`, started by `serve.ts` for the
`worker` and `all` roles). Logs identify the job without copying tool arguments
or credentials. (The Cloudflare Queues consumer was removed in HeoPress P02.)

The shared worker atomically claims only a `queued` run. Repeated delivery of an
already claimed, cancelled or completed run does not repeat the skill. The
five-minute scheduled sweep quarantines stale `running` runs; operators must
inspect their tool calls before deciding whether to retry. Expected harness
outcomes such as denied execution or pending approval are persisted and the
message is acknowledged.

New jobs forward the saved budget. Older jobs missing a budget in their payload
fall back to the stored run budget. `maxToolCalls: 0` therefore blocks the first
tool call. Queue transport does not bypass capability or human-approval checks.

The shared `health_check` probe is acknowledged without running an agent or opening a database connection.

## Queue submission failures

`POST /api/v1/agent/goals` returns `503 ENQUEUE_FAILED` with `goalId` and `runId`
when submission fails. Compensation changes only a still-queued run to failed;
it never overwrites a run already claimed by a worker. Retry and reconciler
submission use the same conditional transition.

New asynchronous goals persist the intended task in goal metadata with the same
secret masking used for tool-call audit. `POST /api/v1/agent/runs/:id/retry` can
recover that task even if the original delivery never reached the harness.
Masked arguments cannot be replayed; submit a fresh request with the required
secrets instead. Old goals without a recorded task still require a new request.
Retries re-resolve permissions and preserve the stored budget.

The stale sweep also fails queued runs older than 15 minutes, for every goal
origin, with `queue_timeout`. A delayed message for a failed run cannot claim it.
This timeout may expire work during a long queue backlog; recovery is an explicit
retry, never automatic replay. Running executions retain their separate
`stale_unverified` quarantine because their side effects may have happened.

## Multi-tenancy

Queues and provider credentials are shared by the deployment. Each job retains
its `siteId`, run/goal identifiers, principal and governance limits. Database
operations in the shared worker remain tenant-scoped; principals are resolved
against the payload tenant. Queue bindings and names differ between deployment
profiles so staging cannot consume production jobs.

## Verification

Regression tests cover PATCH omission semantics, budget propagation and
execution, two-tenant isolation and at-least-once redelivery. The PostgreSQL suite uses `DATABASE_URL` and must
run against a disposable test database:

```bash
pnpm -F @heopress/cms exec vitest run src/services/__tests__/p1-governance.db.integration.test.ts
```

