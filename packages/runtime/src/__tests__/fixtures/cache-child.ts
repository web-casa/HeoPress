/**
 * A second application process for the cross-process cache tests. Reads
 * commands from stdin, one per line, and answers each with one JSON line:
 *   get <key>      -> {"value": <parsed value or null>}
 *   mute           -> stop handling notifications, as when they are lost -> {"ok": true}
 *   relisten       -> handle them again and run the (re)subscribe hook that
 *                     postgres.js calls after reconnecting               -> {"ok": true}
 * Prints {"ready": true} once its LISTEN subscription is up.
 */
import readline from 'node:readline';
import postgres from 'postgres';
import { likeDrizzle } from '../helpers/pg';
import { PostgresCacheProvider } from '../../adapters/postgres/cache';

const sql = likeDrizzle(postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {}, prepare: false }));
const cache = new PostgresCacheProvider(sql, { purgeIntervalMs: 0 });

await cache.start();
process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const [cmd, key] = line.trim().split(' ');
  if (cmd === 'get' && key) {
    process.stdout.write(`${JSON.stringify({ value: await cache.get(key) })}\n`);
  } else if (cmd === 'mute') {
    (cache as unknown as { active: boolean }).active = false;
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  } else if (cmd === 'relisten') {
    const internals = cache as unknown as { active: boolean; onListen: () => void };
    internals.active = true;
    internals.onListen();
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
  } else if (cmd === 'exit') {
    break;
  }
}
await cache.close();
await sql.end({ timeout: 1 });
