import { describe, expect, it } from 'vitest';
import { computeHealth, type HealthInput } from '../health';

const now = new Date('2026-10-24T12:00:00Z');
const base: HealthInput = { reachability: { errors: 0, warnings: 0 }, audit: { lastRunStatus: 'done', errorIssues: 0 }, domains: [], primaryDomainState: 'set', now };

describe('computeHealth (p07a task 3.2)', () => {
  it('ok when nothing applies', () => {
    expect(computeHealth(base)).toEqual({ status: 'ok', reasons: [] });
  });

  it('scenario 审计有错误级问题: reachable, 2 error issues → warning with that reason', () => {
    expect(computeHealth({ ...base, audit: { lastRunStatus: 'done', errorIssues: 2 } })).toEqual({ status: 'warn', reasons: [{ code: 'audit_errors', count: 2 }] });
  });

  it('scenario 无数据: never checked → unknown, "not checked"', () => {
    expect(computeHealth({ ...base, reachability: null, audit: null })).toEqual({ status: 'unknown', reasons: [{ code: 'not_checked' }] });
  });

  it('unreadable inputs → unknown', () => {
    expect(computeHealth({ ...base, reachability: 'unreadable' }).status).toBe('unknown');
  });

  it('bad: reachability errors, a recorded failed domain (even not primary), a domain pending over 24 hours', () => {
    expect(computeHealth({ ...base, reachability: { errors: 1, warnings: 3 } }).status).toBe('bad');
    const failed = computeHealth({ ...base, domains: [{ hostname: 'www.example.com', status: 'failed', statusReason: 'DNS', createdAt: now }] });
    expect(failed).toEqual({ status: 'bad', reasons: [{ code: 'domain_failed', host: 'www.example.com', detail: 'DNS' }] });
    const old = new Date(now.getTime() - 25 * 3_600_000);
    expect(computeHealth({ ...base, domains: [{ hostname: 'a.example.com', status: 'pending', statusReason: null, createdAt: old }] }).status).toBe('bad');
    expect(computeHealth({ ...base, domains: [{ hostname: 'a.example.com', status: 'pending', statusReason: null, createdAt: now }] }).status).toBe('ok');
    expect(computeHealth({ ...base, domains: [{ hostname: 'a.example.com', status: 'disabled', statusReason: null, createdAt: old }] }).status).toBe('ok');
  });

  it('warn: reachability warnings, a failed audit run, active domains but no primary', () => {
    expect(computeHealth({ ...base, reachability: { errors: 0, warnings: 2 } }).reasons).toEqual([{ code: 'reachability_warnings', count: 2 }]);
    expect(computeHealth({ ...base, audit: { lastRunStatus: 'failed', errorIssues: 0 } }).reasons).toEqual([{ code: 'audit_failed' }]);
    expect(computeHealth({ ...base, primaryDomainState: 'unset' })).toEqual({ status: 'warn', reasons: [{ code: 'no_primary_domain' }] });
  });

  it('at most three reasons, the serious ones first', () => {
    const h = computeHealth({
      ...base,
      reachability: { errors: 2, warnings: 0 },
      audit: { lastRunStatus: 'failed', errorIssues: 4 },
      primaryDomainState: 'unset',
      domains: [{ hostname: 'x.example.com', status: 'failed', statusReason: null, createdAt: now }],
    });
    expect(h.status).toBe('bad');
    expect(h.reasons.map((r) => r.code)).toEqual(['reachability_errors', 'domain_failed', 'audit_errors']);
  });
});
