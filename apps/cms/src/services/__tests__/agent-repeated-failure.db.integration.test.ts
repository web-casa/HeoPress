import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { scopedDatabase, sites, type Database } from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { AgentRunService } from '../agent-run-service';
import { readEvents } from '../ops/event-stream';

/**
 * A goal whose runs keep failing is reported in Logs & monitoring (HeoPress P14 task 5.3, design D5): after the third
 * failed run a warning system event (source `agents`) appears in the event stream. It replaces the `agent-dead-letter`
 * queue, which no process consumed; nothing is queued any more.
 */

const SITE = 'site_agent_repeated_failure';

describe.skipIf(!hasDbIntegrationUrl)('agent runs: repeated failures become a system event', () => {
  let db: Database;
  let fixtures: Database;
  let siteDb: Database;
  const queued: string[] = [];
  const queue = {
    enqueue: async (name: string) => {
      queued.push(name);
      return `job_${queued.length}`;
    },
    process: () => undefined,
    getStatus: async () => null,
  } as unknown as QueueProvider;

  beforeAll(async () => {
    db = await connectDbIntegration('agent-repeated-failure');
    fixtures = await connectDbFixtures('agent-repeated-failure');
    // The service runs as it does in a request: on the application role, in the site's scope.
    siteDb = scopedDatabase(db, { site: SITE });
  });

  afterAll(async () => {
    if (fixtures) await fixtures.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    queued.length = 0;
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.insert(sites).values({ id: SITE, name: 'Repeated failure' });
  });

  const warnings = async (goalId: string) =>
    (await readEvents(db, { siteId: SITE, platform: true }, { sources: ['system'], levels: ['warn'] }, { limit: 200 })).events.filter(
      (e) => e.event === 'agent_run_repeated_failure' && e.data['goalId'] === goalId,
    );

  it('the third failed run of a goal writes one warning event; the first two write none, and nothing is queued', async () => {
    const service = new AgentRunService(siteDb, SITE, queue);
    const first = await service.ensureRun({ title: 'keeps failing' });
    await service.failRun(first.runId, 'first failure', { stopReason: 'error' });
    const second = await service.ensureRun({ goalId: first.goalId });
    await service.failRun(second.runId, 'second failure', { stopReason: 'error' });
    expect(await warnings(first.goalId)).toHaveLength(0);

    const third = await service.ensureRun({ goalId: first.goalId });
    await service.failRun(third.runId, 'third failure', { stopReason: 'budget_exceeded' });

    const events = await warnings(first.goalId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: 'system',
      level: 'warn',
      event: 'agent_run_repeated_failure',
      data: { siteId: SITE, goalId: first.goalId, runId: third.runId, error: 'third failure', stopReason: 'budget_exceeded', failedRuns: 3 },
    });
    expect(queued).toEqual([]);
  });

  it('a site without the instance scope does not see the event (system events are the bootstrap administrator\'s)', async () => {
    const service = new AgentRunService(siteDb, SITE, queue);
    const first = await service.ensureRun({ title: 'scoped' });
    await service.failRun(first.runId, 'x', { stopReason: 'error' });
    for (let i = 0; i < 2; i++) {
      const next = await service.ensureRun({ goalId: first.goalId });
      await service.failRun(next.runId, 'x', { stopReason: 'error' });
    }
    expect(await warnings(first.goalId)).toHaveLength(1);
    const siteOnly = await readEvents(db, { siteId: SITE, platform: false }, { sources: ['system'] });
    expect(siteOnly.events).toHaveLength(0);
  });
});
