import { describe, expect, it } from 'vitest';
import { compareEvents, decodeCursor, encodeCursor, redact, sourceOfAuditEvent } from '../event-stream';

describe('event stream adapters (HeoPress P07a task 11.3)', () => {
  // A made-up key, assembled so it does not read as a credential to secret scanners.
  const FAKE_KEY = ['hp', 'live', '1234567890'].join('_');
  it('redacts addresses, agents and tokens; keys keep their last four characters', () => {
    expect(
      redact({ ip: '203.0.113.9', userAgent: 'Mozilla', token: 'abc', nested: { refresh_token: 'x', password: 'p', ok: 1 }, apiKey: FAKE_KEY, list: [{ authorization: 'Bearer y', keep: true }] }),
    ).toEqual({ nested: { ok: 1 }, apiKey: '…7890', list: [{ keep: true }] });
  });

  it('sorts audit events into sources', () => {
    expect(sourceOfAuditEvent('site_job_run')).toBe('run');
    expect(sourceOfAuditEvent('access_role_changed')).toBe('access');
    expect(sourceOfAuditEvent('api_key_created')).toBe('api_key');
    expect(sourceOfAuditEvent('login_failed')).toBe('security');
  });

  it('cursor: time + source + id round-trips; junk is ignored', () => {
    const c = { at: '2026-10-24T10:00:00.000Z', source: 'content', id: 'review:r1:submitted' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it('orders newest first, then by source and id, so a page boundary is stable', () => {
    const e = (at: string, source: string, id: string) => ({ at, source: source as 'content', id });
    const sorted = [e('2026-10-24T10:00:00Z', 'content', 'a'), e('2026-10-24T11:00:00Z', 'run', 'b'), e('2026-10-24T10:00:00Z', 'run', 'c'), e('2026-10-24T10:00:00Z', 'run', 'd')].sort(compareEvents);
    expect(sorted.map((x) => x.id)).toEqual(['b', 'd', 'c', 'a']);
  });
});
