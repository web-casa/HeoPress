/**
 * A worker that claims a slot and then hangs inside the job, so the test can
 * kill the process mid-slot (a real crash). Prints "inside" once the job runs.
 */
import postgres from 'postgres';
import { likeDrizzle } from '../helpers/pg';
import { runScheduledSlot } from '../../leader-lock';

const [scheduleKey, iso] = process.argv.slice(2);
const sql = likeDrizzle(postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {}, prepare: false }));
await runScheduledSlot(
  scheduleKey!,
  new Date(iso!),
  async () => {
    process.stdout.write('inside\n');
    await new Promise(() => {});
  },
  { sql, instanceId: `doomed-${process.pid}`, lockCheckMs: 300 },
);
