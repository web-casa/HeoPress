import { describe, expect, it } from 'vitest';
import { isRetryableConflict, MembershipChangedError, withMembershipRetry, withTransactionRetry } from '../translation-groups';

/**
 * The whole-transaction retry (HeoPress P05 R13, P06 R30): a moved membership, a deadlock or a
 * serialization failure starts the outermost transaction over, at most three times; inside a caller's
 * transaction the error goes up unchanged; anything else is thrown.
 */

const pgError = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

describe('withMembershipRetry', () => {
  it('recognises deadlocks and serialization failures, also wrapped by the driver', () => {
    expect(isRetryableConflict(pgError('40P01'))).toBe(true);
    expect(isRetryableConflict(pgError('40001'))).toBe(true);
    expect(isRetryableConflict(new Error('Failed query', { cause: pgError('40P01') }))).toBe(true);
    expect(isRetryableConflict(pgError('23505'))).toBe(false);
    expect(isRetryableConflict(new Error('plain'))).toBe(false);
    expect(isRetryableConflict(undefined)).toBe(false);
  });

  it('retries those, then succeeds; gives up with 409 after three tries', async () => {
    let n = 0;
    await expect(
      withMembershipRetry(async () => {
        n++;
        if (n === 1) throw pgError('40P01');
        if (n === 2) throw new MembershipChangedError();
        return 'ok';
      }, { conflicts: true }),
    ).resolves.toBe('ok');
    expect(n).toBe(3);
    n = 0;
    await expect(
      withMembershipRetry(async () => {
        n++;
        throw new Error('Failed query', { cause: pgError('40001') });
      }, { conflicts: true }),
    ).rejects.toMatchObject({ code: 'RETRY_EXHAUSTED' });
    expect(n).toBe(3);
  });

  it('does not retry other errors', async () => {
    let n = 0;
    await expect(
      withMembershipRetry(async () => {
        n++;
        throw pgError('23505');
      }),
    ).rejects.toThrow('pg 23505');
    expect(n).toBe(1);
  });

  it('conflicts are retried only at the outermost transaction', async () => {
    let n = 0;
    const deadlock = async () => {
      n++;
      throw pgError('40P01');
    };
    // Without `conflicts` (the P05 call sites): no retry.
    await expect(withMembershipRetry(deadlock)).rejects.toThrow('pg 40P01');
    expect(n).toBe(1);
    // On the database: retried. Inside a transaction handle: up unchanged, once.
    n = 0;
    await expect(withTransactionRetry({ transaction: () => undefined }, deadlock)).rejects.toMatchObject({ code: 'RETRY_EXHAUSTED' });
    expect(n).toBe(3);
    n = 0;
    await expect(withTransactionRetry({ rollback: () => undefined }, deadlock)).rejects.toThrow('pg 40P01');
    expect(n).toBe(1);
  });
});
