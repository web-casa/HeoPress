import { describe, expect, it } from 'vitest';
import { SetupStateFetchError } from '../setup-state';
import { retryWhenRateLimited } from '../use-setup-state-query';

describe('setup state: a 429 is retried, other failures are not', () => {
  it('retries a 429 up to three times', () => {
    const limited = new SetupStateFetchError('http 429', 429);
    expect([0, 1, 2, 3].map((n) => retryWhenRateLimited(n, limited))).toEqual([true, true, true, false]);
  });

  it('does not retry a network failure or a server error', () => {
    expect(retryWhenRateLimited(0, new SetupStateFetchError('network'))).toBe(false);
    expect(retryWhenRateLimited(0, new SetupStateFetchError('http 503', 503))).toBe(false);
  });
});
