/**
 * A worker's database work while its connections are torn down mid-operation, as when PostgreSQL stops under the
 * cms-worker (image-runtime acceptance, db-outage check). Prints one JSON line per step and exits 0.
 *
 * Without patches/postgres@3.4.9.patch this process dies: postgres.js writes the next statement of a reserved
 * connection (the scheduler's lock session) or of a transaction (its ROLLBACK) to the socket it has already
 * dropped, and the write, deferred to setImmediate, throws "TypeError: Cannot read properties of null (reading
 * 'write')" outside any promise — an uncaught exception.
 */
import postgres from 'postgres';
import { likeDrizzle } from '../helpers/pg';
import { runScheduledSlot } from '../../leader-lock';

const [tag, slotIso] = process.argv.slice(2);
const url = process.env.DATABASE_URL!;
const app = `heopress-loss-${tag}`;
const quiet = { onnotice: () => {}, prepare: false } as const;
const sql = likeDrizzle(postgres(url, { ...quiet, max: 3, connection: { application_name: app } }));
const admin = postgres(url, { ...quiet, max: 1, connection: { application_name: `${app}-admin` } });

const out = (step: string, value: unknown) => process.stdout.write(`${JSON.stringify({ step, value })}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (err: unknown) => String((err as { code?: unknown })?.code ?? (err as Error)?.message ?? err);

/** Terminate every session of the worker's pools, then wait until the driver has seen them close. */
async function dropConnections(): Promise<void> {
  await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE ${`${app}%`} AND application_name <> ${`${app}-admin`}`;
  for (let i = 0; i < 100; i++) {
    const [row] = await admin<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name LIKE ${`${app}%`} AND application_name <> ${`${app}-admin`}`;
    if (row!.n === 0) break;
    await sleep(20);
  }
  await sleep(200);
}

const slot = new Date(slotIso!);

// 1. A scheduled job whose sessions drop while it runs, and which then fails fast (its own queries fail): the
//    outcome is written after the lock connection closed, and the closed reservation is released.
out(
  'scheduled-job',
  await runScheduledSlot(
    `connection-loss-${tag}`,
    slot,
    async () => {
      await dropConnections();
      throw new Error('database unavailable');
    },
    { sql, lockCheckMs: 60_000 },
  ),
);

// 2. The pool afterwards: concurrent queries (the released reservation must not come back as an open connection),
//    and the next slot of the job.
out('pool', (await Promise.all([1, 2, 3, 4, 5].map((n) => sql<{ n: number }[]>`SELECT ${n}::int AS n`))).map((r) => r[0]!.n));
out('next-slot', await runScheduledSlot(`connection-loss-${tag}`, new Date(slot.getTime() + 60_000), async () => {}, { sql, lockCheckMs: 60_000 }));

// 3. A transaction whose statement is running when its session drops: the ROLLBACK that follows must not be written.
out(
  'transaction-busy',
  await sql
    .begin(async (tx) => {
      await tx`SELECT 1`;
      await Promise.all([tx`SELECT pg_sleep(10)`, sleep(100).then(dropConnections)]);
    })
    .then(() => 'committed', codeOf),
);

// 4. A transaction waiting on something else (an upload, a model call) when its session drops, then going on.
out(
  'transaction-idle',
  await sql
    .begin(async (tx) => {
      await tx`SELECT 1`;
      await dropConnections();
      await tx`SELECT 2`;
    })
    .then(() => 'committed', codeOf),
);

// 5. The first statement on a connection that reconnected after a statement was cut off by the server must not fail
//    with the cut-off statement's error (FATAL 57P01).
const one = likeDrizzle(postgres(url, { ...quiet, max: 1, connection: { application_name: `${app}-one` } }));
const cut = await Promise.all([one`SELECT pg_sleep(10)`.then(() => 'finished', codeOf), sleep(100).then(dropConnections)]);
out('cut-off', cut[0]);
out('after-reconnect', await one<{ ok: number }[]>`SELECT 1 AS ok`.then((r) => r[0]!.ok, codeOf));

// 6. Recovered: the job's runs are recorded and new work goes through.
out(
  'runs',
  (
    await sql<{ status: string }[]>`
      SELECT status FROM lumibase_schedule_runs WHERE schedule_key = ${`connection-loss-${tag}`} ORDER BY scheduled_at`
  ).map((r) => r.status),
);

await one.end({ timeout: 1 });
await sql.end({ timeout: 1 });
await admin.end({ timeout: 1 });
