import { describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { runScheduledSlot } from '../leader-lock';

/**
 * The write gate of scheduled jobs (HeoPress P13 upgrade write freeze): while the process is frozen a slot is not
 * claimed — no connection, no row, no lock — and the job does not run. The claiming itself is covered by
 * `scheduled-jobs.db.test.ts`.
 */
describe('scheduled job gate', () => {
  it('skips the slot without touching the database while frozen', async () => {
    const sql = {
      reserve: () => {
        throw new Error('must not reserve a connection while frozen');
      },
    } as unknown as postgres.Sql;
    let ran = false;
    const outcome = await runScheduledSlot('freeze-test', new Date(), async () => void (ran = true), { sql, gate: { enter: () => null } });
    expect(outcome).toBe('paused');
    expect(ran).toBe(false);
  });

  it('counts the run as in flight until it ends', async () => {
    let inflight = 0;
    const gate = {
      enter: () => {
        inflight += 1;
        return () => void (inflight -= 1);
      },
    };
    const sql = {
      reserve: async () => {
        expect(inflight).toBe(1);
        throw new Error('no connection');
      },
    } as unknown as postgres.Sql;
    const outcome = await runScheduledSlot('freeze-test', new Date(), async () => {}, { sql, gate });
    expect(outcome).toBe('claimed-elsewhere');
    expect(inflight).toBe(0);
  });
});
