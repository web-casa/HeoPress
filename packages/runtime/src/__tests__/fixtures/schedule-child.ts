/**
 * A worker process for the scheduled-job tests: fires at each slot given on
 * the command line (ISO timestamps on whole seconds, in the near future) under one schedule
 * key, as node-cron would, racing any other worker; records each
 * slot it runs in `heopress_test_schedule_effects`. Prints one JSON line with
 * its outcomes, then exits.
 */
import postgres from 'postgres';
import { likeDrizzle } from '../helpers/pg';
import { runScheduledSlot } from '../../leader-lock';

const [scheduleKey, ...slots] = process.argv.slice(2);
const sql = likeDrizzle(postgres(process.env.DATABASE_URL!, { max: 4, onnotice: () => {}, prepare: false }));
// Like node-cron: fire at each slot's wall-clock time, one slot after another.
const outcomes: string[] = [];
for (const iso of slots) {
  const wait = new Date(iso).getTime() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  outcomes.push(
    await runScheduledSlot(
      scheduleKey!,
      new Date(iso),
      async () => {
        await sql`INSERT INTO heopress_test_schedule_effects (slot, pid) VALUES (${iso}, ${process.pid})`;
        await new Promise((r) => setTimeout(r, 50));
      },
      { sql, instanceId: `child-${process.pid}` },
    ),
  );
}
process.stdout.write(`${JSON.stringify(outcomes)}\n`);
await sql.end({ timeout: 1 });
