import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resultOfSiteRuns } from '../site-runs';

describe('site runs → scheduled result (HeoPress P07a task 11.1)', () => {
  it('mixed: any failure or interruption fails the run, with the counts', () => {
    expect(resultOfSiteRuns([{ siteId: 'a', status: 'done' }, { siteId: 'b', status: 'failed', error: 'x' }, { siteId: 'c', status: 'partial' }])).toEqual({
      status: 'failed',
      reason: '1 site(s) failed, 0 interrupted',
      sites: { done: 1, failed: 1, partial: 1 },
    });
  });

  it('all interrupted: failed', () => {
    expect(resultOfSiteRuns([{ siteId: 'a', status: 'lost' }, { siteId: 'b', status: 'lost' }])).toMatchObject({ status: 'failed', sites: { lost: 2 } });
  });

  it('only work left: incomplete; all done or nothing to do: succeeded', () => {
    expect(resultOfSiteRuns([{ siteId: 'a', status: 'partial' }])).toMatchObject({ status: 'incomplete', sites: { partial: 1 } });
    expect(resultOfSiteRuns([{ siteId: 'a', status: 'done' }])).toEqual({ status: 'succeeded', sites: { done: 1 } });
    expect(resultOfSiteRuns([])).toEqual({ status: 'succeeded', sites: {} });
  });
});

/**
 * Guard (task 11.1): no job registered through `scheduledJob` in `serve.ts` swallows an error — a dependency failing
 * must make every job's run failed, never succeeded.
 */
describe('serve.ts scheduled jobs do not swallow failures', () => {
  const source = readFileSync(join(__dirname, '../../../serve.ts'), 'utf8');
  const jobs: Array<{ key: string; body: string }> = [];
  for (const m of source.matchAll(/scheduledJob\(\s*'([^']+)'/g)) {
    let depth = 0;
    let i = source.indexOf('(', m.index);
    const start = i;
    for (; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')' && (depth -= 1) === 0) break;
    }
    jobs.push({ key: m[1]!, body: source.slice(start, i) });
  }

  it('finds the registered jobs', () => {
    expect(jobs.map((j) => j.key)).toEqual(expect.arrayContaining(['site-audit', 'link-scan', 'reachability-check', 'audit-triage-purge', 'crawl-hits-purge']));
  });

  it('every .catch in a job rethrows', () => {
    for (const job of jobs) {
      for (const c of job.body.matchAll(/\.catch\(\(?(\w+)/g)) {
        const after = job.body.slice(c.index, c.index + 400);
        expect(after, `${job.key} swallows ${c[1]}`).toMatch(new RegExp(`throw ${c[1]}`));
      }
    }
  });

  it('the P07 per-site workers return their site runs as the result', () => {
    for (const key of ['site-audit', 'link-scan', 'reachability-check']) {
      expect(jobs.find((j) => j.key === key)!.body).toContain(`reportSiteRuns(rotatorDb, '${key}', runs)`);
    }
  });
});
