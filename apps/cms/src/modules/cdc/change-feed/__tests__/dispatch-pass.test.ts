import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCdcDispatchPass, type SubscriptionDispatchStore } from '../dispatcher';

/**
 * The dispatch pass runs each subscription detached. A failure there — the
 * database going away mid-delivery — is logged and the subscription freed
 * for the next pass; it must never surface as an unhandled rejection, which
 * would stop the worker process (Codex review P04-3 #9).
 */
describe('createCdcDispatchPass', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a failing detached dispatch is caught, logged and retried on the next pass', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const subscriptions = {
      listActiveSiteIds: async () => ['site_a'],
      listDispatchable: async () => [{ id: 'sub_1', siteId: 'site_a' }],
    } as unknown as SubscriptionDispatchStore;
    const pass = createCdcDispatchPass({
      buildDispatcher: () =>
        ({
          dispatchSubscription: async () => {
            calls += 1;
            throw new Error('database unavailable');
          },
        }) as never,
      subscriptions,
    });
    try {
      await pass();
      await new Promise((r) => setTimeout(r, 20));
      await pass();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
    expect(calls).toBe(2); // freed after the failure, so the next pass tries again
    expect(logged.mock.calls.some((c) => String(c[0]).includes('cdc_dispatch_failed'))).toBe(true);
  });
});
