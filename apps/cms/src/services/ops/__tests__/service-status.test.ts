import { describe, expect, it } from 'vitest';
import { servicesWithin } from '../service-status';

/** Status cards (HeoPress P07a task 11.5): a health check that cannot be read in time is unknown, never OK. */
describe('servicesWithin', () => {
  it('answers in time: each service as reported, a missing one unknown', async () => {
    expect(await servicesWithin(async () => ({ database: 'ok', cache: 'degraded' }), ['database', 'cache', 'queue'], 1000)).toEqual({ database: 'ok', cache: 'degraded', queue: 'unknown' });
  });

  it('a check that never answers: every service unknown once the time is up', async () => {
    const started = Date.now();
    expect(await servicesWithin(() => new Promise(() => undefined), ['database', 'queue'], 50)).toEqual({ database: 'unknown', queue: 'unknown' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a check that fails: unknown', async () => {
    expect(await servicesWithin(async () => Promise.reject(new Error('down')), ['database'], 1000)).toEqual({ database: 'unknown' });
  });
});
