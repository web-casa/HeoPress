import { describe, expect, it } from 'vitest';
import { HeoPressError, type SiteLinkImpactResource } from '@heopress/sdk';
import { checkImpact } from '../link-impact-check';

/** Whether Studio asks before a change of a published page (HeoPress P07 task 5.5; Codex review, round 2). */
const impact = (n: number) => ({ links: Array.from({ length: n }, () => ({})) }) as unknown as SiteLinkImpactResource;

describe('checkImpact', () => {
  it('nothing links to it, or it is not public: goes on; links: asks with them', async () => {
    expect(await checkImpact(async () => impact(0))).toEqual({ kind: 'proceed' });
    expect(await checkImpact(() => Promise.reject(new HeoPressError(404, { errors: [{ code: 'NOT_PUBLIC', message: 'x' }] })))).toEqual({ kind: 'proceed' });
    expect(await checkImpact(async () => impact(2))).toMatchObject({ kind: 'ask', impact: { links: [{}, {}] } });
  });

  it('a failure — a 500, a time-out, a 404 that is not NOT_PUBLIC — asks, without the pages', async () => {
    expect(await checkImpact(() => Promise.reject(new HeoPressError(500, { errors: [{ code: 'INTERNAL' }] })))).toEqual({ kind: 'ask', impact: null });
    expect(await checkImpact(() => Promise.reject(new Error('timeout')))).toEqual({ kind: 'ask', impact: null });
    expect(await checkImpact(() => Promise.reject(new HeoPressError(404, { errors: [{ code: 'NOT_FOUND' }] })))).toEqual({ kind: 'ask', impact: null });
  });
});
