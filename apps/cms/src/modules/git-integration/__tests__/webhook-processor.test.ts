/**
 * Git webhook event projection (HeoPress P12 git-integration; P14 task 8.1).
 *
 * `processEvent` turns a verified GitHub/GitLab payload into the cached pull-request / CI-run rows. The branches are
 * what a webhook can actually deliver: a pull request or merge request in each state, a workflow or pipeline in each
 * status, an event without its inner object, an event of another type — and re-delivery, which must upsert onto the
 * same row rather than duplicate it. The database is a stand-in that records the upsert it was asked for.
 */
import { describe, expect, it } from 'vitest';
import { gitCiRuns, gitPullRequests } from '@heopress/database';
import { processEvent, type ProcessEventArgs } from '../webhook/processor';

interface Recorded {
  table: unknown;
  values: Record<string, unknown>;
  conflict: Record<string, unknown> | null;
}

function fakeDb(): { db: ProcessEventArgs['db']; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const db = {
    insert: (table: unknown) => {
      const entry: Recorded = { table, values: {}, conflict: null };
      const chain: Record<string, unknown> = {};
      chain.values = (values: Record<string, unknown>) => {
        entry.values = values;
        recorded.push(entry);
        return chain;
      };
      chain.onConflictDoUpdate = (config: Record<string, unknown>) => {
        entry.conflict = config;
        return chain;
      };
      chain.returning = () => Promise.resolve([{ id: `pr_${recorded.length}` }]);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
  } as unknown as ProcessEventArgs['db'];
  return { db, recorded };
}

const base = { siteId: 'site_a', integrationId: 'int_1' } as const;

const run = async (provider: 'github' | 'gitlab', event: string, payload: Record<string, unknown>) => {
  const { db, recorded } = fakeDb();
  const result = await processEvent({ ...base, db, provider, event, payload });
  return { result, recorded };
};

describe('GitHub', () => {
  const pullRequest = (overrides: Record<string, unknown> = {}) => ({
    number: 7,
    title: 'Fix the thing',
    state: 'open',
    merged_at: null,
    head: { sha: 'abc123' },
    user: { login: 'octocat' },
    ...overrides,
  });

  it('projects an open pull request with its head and author', async () => {
    const { result, recorded } = await run('github', 'pull_request', { action: 'opened', pull_request: pullRequest() });
    expect(result.pr).toEqual({ id: 'pr_1', number: 7, state: 'open', action: 'opened' });
    expect(recorded[0]!.table).toBe(gitPullRequests);
    expect(recorded[0]!.values).toMatchObject({ siteId: 'site_a', integrationId: 'int_1', number: 7, title: 'Fix the thing', state: 'open', headSha: 'abc123', author: 'octocat' });
    expect(recorded[0]!.conflict).toMatchObject({ target: [gitPullRequests.integrationId, gitPullRequests.number] });
  });

  it('reads merged and closed states, and tolerates a payload without fields', async () => {
    const merged = await run('github', 'pull_request', { action: 'closed', pull_request: pullRequest({ merged_at: '2026-06-01T00:00:00Z' }) });
    expect(merged.result.pr!.state).toBe('merged');
    const closed = await run('github', 'pull_request', { pull_request: pullRequest({ state: 'closed' }) });
    expect(closed.result.pr!.state).toBe('closed');

    const bare = await run('github', 'pull_request', { pull_request: { number: 3 } });
    expect(bare.result.pr).toMatchObject({ number: 3, state: 'closed', action: '' });
    expect(bare.recorded[0]!.values).toMatchObject({ title: '', headSha: '', author: null });
  });

  it('ignores a pull_request event without its object, and any other event', async () => {
    expect((await run('github', 'pull_request', {})).result).toEqual({});
    expect((await run('github', 'issues', { issue: { number: 1 } })).result).toEqual({});
    expect((await run('github', 'issues', {})).recorded).toEqual([]);
  });

  it('maps every workflow conclusion and skips a workflow_run without its object', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ status: 'queued', conclusion: null }, 'queued'],
      [{ status: 'in_progress', conclusion: null }, 'in_progress'],
      [{ status: 'completed', conclusion: 'success' }, 'success'],
      [{ status: 'completed', conclusion: 'cancelled' }, 'cancelled'],
      [{ status: 'completed', conclusion: 'failure' }, 'failure'],
      [{ status: 'completed', conclusion: 'timed_out' }, 'failure'],
      [{ status: 'completed', conclusion: 'skipped' }, 'in_progress'],
      [{ status: 'waiting', conclusion: null }, 'in_progress'],
    ];
    for (const [workflow, status] of cases) {
      const { result, recorded } = await run('github', 'workflow_run', { workflow_run: { id: 42, ...workflow } });
      expect(result.ci, JSON.stringify(workflow)).toEqual({ providerRunId: '42', status });
      expect(recorded[0]!.table).toBe(gitCiRuns);
      expect(recorded[0]!.conflict).toMatchObject({ target: [gitCiRuns.integrationId, gitCiRuns.providerRunId] });
    }
    expect((await run('github', 'workflow_run', {})).result).toEqual({});
  });
});

describe('GitLab', () => {
  it('projects a merge request in each state, preferring the last commit', async () => {
    const opened = await run('gitlab', 'Merge Request Hook', {
      object_attributes: { iid: 9, title: 'MR', state: 'opened', action: 'open', last_commit: { id: 'sha1' }, sha: 'sha0' },
    });
    expect(opened.result.pr).toEqual({ id: 'pr_1', number: 9, state: 'open', action: 'open' });
    expect(opened.recorded[0]!.values).toMatchObject({ number: 9, headSha: 'sha1', author: null });

    const merged = await run('gitlab', 'merge request', { object_attributes: { iid: 9, state: 'merged' } });
    expect(merged.result.pr!.state).toBe('merged');
    const closed = await run('gitlab', 'merge request', { object_attributes: { iid: 9, state: 'closed', sha: 'sha0' } });
    expect(closed.result.pr!.state).toBe('closed');
    expect(closed.recorded[0]!.values).toMatchObject({ headSha: 'sha0', title: '' });
    expect((await run('gitlab', 'merge request', {})).result).toEqual({});
  });

  it('maps every pipeline status and skips a pipeline without its object', async () => {
    const cases: Array<[string, string]> = [
      ['success', 'success'],
      ['failed', 'failure'],
      ['canceled', 'cancelled'],
      ['running', 'in_progress'],
      ['pending', 'queued'],
      ['created', 'queued'],
    ];
    for (const [status, mapped] of cases) {
      const { result, recorded } = await run('gitlab', 'Pipeline Hook', { object_attributes: { id: 5, status } });
      expect(result.ci, status).toEqual({ providerRunId: '5', status: mapped });
      expect(recorded[0]!.table).toBe(gitCiRuns);
    }
    expect((await run('gitlab', 'Pipeline Hook', {})).result).toEqual({});
    expect((await run('gitlab', 'Push Hook', {})).result).toEqual({});
  });

  it('re-processing the same delivery upserts the same keys', async () => {
    const payload = { pull_request: { number: 7, title: 't', state: 'open', head: { sha: 's' }, user: { login: 'u' } } };
    const first = await run('github', 'pull_request', payload);
    const second = await run('github', 'pull_request', payload);
    expect(first.recorded[0]!.values).toEqual(second.recorded[0]!.values);
    expect(first.recorded[0]!.conflict).toMatchObject({ target: [gitPullRequests.integrationId, gitPullRequests.number] });
  });
});
