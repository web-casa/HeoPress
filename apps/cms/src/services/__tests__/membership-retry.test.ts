import { describe, expect, it } from 'vitest';
import { MEMBERSHIP_ATTEMPTS, MembershipChangedError, RetryExhaustedError, retryTransaction } from '../rls-transaction';
import { withTransactionRetry } from '../site-network/translation-groups';

/**
 * The retry boundary of a transaction (HeoPress P06 R30; P07, Codex review of batch 4a): the outermost boundary starts
 * the transaction over on a moved translation-group membership — and, when it is the outermost transaction, on a
 * deadlock or serialization failure — at most `MEMBERSHIP_ATTEMPTS` runs in all, then 409 `RETRY_EXHAUSTED`.
 * Boundaries nested inside it do not retry on their own, so the runs never multiply.
 */
const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

describe('retryTransaction', () => {
  it('runs the attempt again on a moved membership, up to the limit, then 409 RETRY_EXHAUSTED', async () => {
    let runs = 0;
    await expect(
      retryTransaction(async () => {
        if (++runs < MEMBERSHIP_ATTEMPTS) throw new MembershipChangedError();
        return 'done';
      }, { conflicts: false }),
    ).resolves.toBe('done');
    expect(runs).toBe(MEMBERSHIP_ATTEMPTS);
    runs = 0;
    expect(
      await codeOf(
        retryTransaction(async () => {
          runs++;
          throw new MembershipChangedError();
        }, { conflicts: false }),
      ),
    ).toBe('RETRY_EXHAUSTED');
    expect(runs).toBe(MEMBERSHIP_ATTEMPTS);
    await expect(retryTransaction(async () => { throw new MembershipChangedError(); }, { conflicts: false })).rejects.toBeInstanceOf(RetryExhaustedError);
  });

  it('a deadlock is retried only where the attempt is the outermost transaction (`conflicts`); any other error never', async () => {
    let runs = 0;
    expect(await codeOf(retryTransaction(async () => { runs++; throw deadlock(); }, { conflicts: false }))).toBe('40P01');
    expect(runs).toBe(1);
    runs = 0;
    expect(await codeOf(retryTransaction(async () => { runs++; throw deadlock(); }, { conflicts: true }))).toBe('RETRY_EXHAUSTED');
    expect(runs).toBe(MEMBERSHIP_ATTEMPTS);
    runs = 0;
    const other = new Error('other');
    await expect(retryTransaction(async () => { runs++; throw other; }, { conflicts: true })).rejects.toBe(other);
    expect(runs).toBe(1);
  });

  it('nested boundaries (a service\'s withTransactionRetry around a site transaction) run the transaction at most MEMBERSHIP_ATTEMPTS times in all', async () => {
    let runs = 0;
    const inner = () =>
      retryTransaction(async () => {
        runs++;
        throw new MembershipChangedError();
      }, { conflicts: true });
    expect(await codeOf(withTransactionRetry({}, inner))).toBe('RETRY_EXHAUSTED');
    expect(runs).toBe(MEMBERSHIP_ATTEMPTS);
    // Two levels deep, the same.
    runs = 0;
    expect(await codeOf(withTransactionRetry({}, () => withTransactionRetry({}, inner)))).toBe('RETRY_EXHAUSTED');
    expect(runs).toBe(MEMBERSHIP_ATTEMPTS);
  });

  it('work started inside an attempt that runs after it is over owns its own retries', async () => {
    let later!: Promise<string>;
    await retryTransaction(async () => {
      let runs = 0;
      later = new Promise<void>((r) => setImmediate(r)).then(() =>
        retryTransaction(async () => {
          if (++runs < 2) throw new MembershipChangedError();
          return `retried after ${runs} runs`;
        }, { conflicts: false }),
      );
    }, { conflicts: false });
    expect(await later).toBe('retried after 2 runs');
  });

  it('separate boundaries (one after the other, or side by side) each own their retries', async () => {
    const counts = [0, 0];
    const flaky = (k: 0 | 1) =>
      retryTransaction(async () => {
        if (++counts[k]! < 2) throw new MembershipChangedError();
        return k;
      }, { conflicts: false });
    expect(await Promise.all([flaky(0), flaky(1)])).toEqual([0, 1]);
    expect(counts).toEqual([2, 2]);
  });
});
