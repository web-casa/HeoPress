import { describe, expect, it } from 'vitest';
import { RemovedServiceConfigError, assertNoRemovedServices } from '../removed-services';

/** Settings of removed services fail startup loudly (P03 task 7.2). */
describe('removed services', () => {
  it('starts without any of them', () => {
    expect(() => assertNoRemovedServices({ DATABASE_URL: 'postgresql://x', REDIS_URL: '  ' })).not.toThrow();
  });

  it('refuses REDIS_URL and imgproxy settings, naming each', () => {
    let err: unknown;
    try {
      assertNoRemovedServices({ REDIS_URL: 'redis://redis:6379', IMGPROXY_URL: 'http://imgproxy:8080' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RemovedServiceConfigError);
    expect((err as RemovedServiceConfigError).variables).toEqual(['REDIS_URL', 'IMGPROXY_URL']);
    expect(String((err as Error).message)).toMatch(/REDIS_URL: Redis is no longer used/);
  });
});
