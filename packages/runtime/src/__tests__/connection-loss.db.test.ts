import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

import { PG_URL } from './helpers/pg';

/**
 * PostgreSQL connections torn down mid-operation (cms-worker crash in the image-runtime db-outage check). The
 * worker's database work runs in a child process, so an uncaught exception kills that process instead of the test
 * runner, and the test sees the exit. Before patches/postgres@3.4.9.patch the child died with
 * "TypeError: Cannot read properties of null (reading 'write')" at the first step: postgres.js wrote the scheduler's
 * outcome on its reserved lock connection, and a transaction's ROLLBACK, to a socket it had already dropped.
 */

const run = promisify(execFile);
const CHILD = path.resolve(__dirname, 'fixtures/connection-loss-child.ts');

describe.skipIf(!PG_URL)('connection loss mid-operation (PostgreSQL)', () => {
  it('a worker whose sessions are terminated mid-operation keeps running and recovers', async () => {
    const tag = `${process.pid}-${Date.now()}`;
    // A slot on yesterday's date: within the 7 days the scheduler keeps, and unique to this run.
    const slot = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 86_400_000).toISOString();
    let stdout: string;
    try {
      ({ stdout } = await run(process.execPath, ['--import', 'tsx', CHILD, tag, slot], {
        cwd: path.resolve(__dirname, '../..'),
        env: process.env,
        timeout: 60_000,
      }));
    } catch (err) {
      const e = err as { code?: unknown; stdout?: string; stderr?: string };
      throw new Error(`the worker process died (exit ${String(e.code)}):\n${e.stdout ?? ''}\n${(e.stderr ?? '').slice(-2000)}`);
    }
    const steps = Object.fromEntries(
      stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { step: string; value: unknown })
        .map(({ step, value }) => [step, value]),
    );

    // The job failed with its sessions; its outcome was still recorded (through the pool once the lock connection
    // was known closed), and the closed reservation did not go back into the pool as an open connection.
    expect(steps['scheduled-job']).toBe('failed');
    expect(steps.pool).toEqual([1, 2, 3, 4, 5]);
    expect(steps['next-slot']).toBe('succeeded');
    expect(steps.runs).toEqual(['failed', 'succeeded']);
    // Transactions whose session dropped, busy or waiting, fail with a connection error instead of killing the process.
    expect(steps['transaction-busy']).toBe('CONNECTION_CLOSED');
    expect(steps['transaction-idle']).toBe('CONNECTION_CLOSED');
    // The cut-off statement fails; the first statement of the reconnected session does not inherit its error.
    expect(steps['cut-off']).toBe('CONNECTION_CLOSED');
    expect(steps['after-reconnect']).toBe(1);
  }, 90_000);
});
