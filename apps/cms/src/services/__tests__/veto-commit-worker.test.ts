import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';

/**
 * The veto-window commit runner (Content OS task 14.2 / Req 13.3, 13.5) without a database: an early job is put back
 * for the deadline, a failure is recorded and retried with backoff until the attempts run out, and the sweep commits
 * every due staging it finds. `VetoService.commit` itself is covered by the veto DB suites.
 */

const commit = vi.fn();
const recordCommitFailure = vi.fn();
const constructed: unknown[] = [];

vi.mock('../veto-service', () => ({
  VETO_COMMIT_MAX_ATTEMPTS: 3,
  VetoService: class {
    constructor(opts: unknown) {
      constructed.push(opts);
    }
    commit = commit;
    recordCommitFailure = recordCommitFailure;
  },
}));
vi.mock('../item-service-factory', () => ({ itemServiceForSystem: () => ({ system: true }) }));

const { processVetoCommitJob, registerVetoCommitWorker, sweepDueVetoCommits, VETO_COMMITS_QUEUE } = await import('../veto-commit-worker');

function fakeQueue() {
  const enqueued: Array<{ queue: string; name: string; data: unknown; opts: unknown }> = [];
  let handler: ((job: { data: unknown }) => Promise<void>) | null = null;
  const queue = {
    enqueue: async (queue: string, name: string, data: unknown, opts: unknown) => {
      enqueued.push({ queue, name, data, opts });
    },
    process: (_q: string, fn: (job: { data: unknown }) => Promise<void>) => {
      handler = fn;
    },
  } as unknown as QueueProvider;
  return { queue, enqueued, run: (data: unknown) => handler!({ data }) };
}

const db = {} as Database;

beforeEach(() => {
  commit.mockReset();
  recordCommitFailure.mockReset();
  constructed.length = 0;
});

describe('veto commit worker', () => {
  it('commits through the veto service in the payload site; an early job is put back for the deadline', async () => {
    const q = fakeQueue();
    commit.mockResolvedValueOnce({ outcome: 'committed' });
    await processVetoCommitJob({ db, queue: q.queue }, { siteId: 'site_a', approvalId: 'ap1' });
    expect(constructed).toEqual([{ db, siteId: 'site_a' }]);
    expect(commit).toHaveBeenCalledWith('ap1', { system: true });
    expect(q.enqueued).toEqual([]);

    commit.mockResolvedValueOnce({ outcome: 'waiting' });
    await processVetoCommitJob({ db, queue: q.queue }, { siteId: 'site_a', approvalId: 'ap1', attempt: 2 });
    expect(q.enqueued).toEqual([{ queue: VETO_COMMITS_QUEUE, name: 'commit', data: { siteId: 'site_a', approvalId: 'ap1', attempt: 2 }, opts: { delay: 60_000 } }]);

    // Without a queue the sweep picks it up later.
    commit.mockResolvedValueOnce({ outcome: 'waiting' });
    await expect(processVetoCommitJob({ db }, { siteId: 'site_a', approvalId: 'ap1' })).resolves.toBeUndefined();
  });

  it('records a failure and retries with growing backoff until the attempts are exhausted', async () => {
    const q = fakeQueue();
    commit.mockRejectedValue(new Error('boom'));
    await processVetoCommitJob({ db, queue: q.queue }, { siteId: 'site_a', approvalId: 'ap2' });
    await processVetoCommitJob({ db, queue: q.queue }, { siteId: 'site_a', approvalId: 'ap2', attempt: 2 });
    await processVetoCommitJob({ db, queue: q.queue }, { siteId: 'site_a', approvalId: 'ap2', attempt: 3 });
    expect(recordCommitFailure.mock.calls).toEqual([
      ['ap2', 1, 'boom'],
      ['ap2', 2, 'boom'],
      ['ap2', 3, 'boom'],
    ]);
    expect(q.enqueued.map((e) => [(e.data as { attempt: number }).attempt, (e.opts as { delay: number }).delay])).toEqual([
      [2, 30_000],
      [3, 60_000],
    ]);

    commit.mockRejectedValueOnce('plain');
    await processVetoCommitJob({ db }, { siteId: 'site_a', approvalId: 'ap3' });
    expect(recordCommitFailure).toHaveBeenLastCalledWith('ap3', 1, 'plain');
  });

  it('the long-lived consumer and the sweep both run the job; no queue registers nothing', async () => {
    const q = fakeQueue();
    registerVetoCommitWorker({ db, queue: q.queue });
    registerVetoCommitWorker({ db });
    commit.mockResolvedValue({ outcome: 'committed' });
    await q.run({ siteId: 'site_b', approvalId: 'ap4' });
    expect(commit).toHaveBeenCalledWith('ap4', { system: true });

    const due = [
      { id: 'ap5', siteId: 'site_a' },
      { id: 'ap6', siteId: 'site_b' },
    ];
    const chain = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => due };
    const sweepDb = { select: () => chain } as unknown as Database;
    expect(await sweepDueVetoCommits({ db: sweepDb }, new Date('2026-01-01T00:00:00Z'))).toBe(2);
    expect(commit.mock.calls.slice(-2).map((c) => c[0])).toEqual(['ap5', 'ap6']);
    expect(constructed.slice(-2)).toEqual([
      { db: sweepDb, siteId: 'site_a' },
      { db: sweepDb, siteId: 'site_b' },
    ]);
  });
});
