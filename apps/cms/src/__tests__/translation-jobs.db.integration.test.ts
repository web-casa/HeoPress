/**
 * Durable translation jobs (HeoPress v1.4, spec `ai/translation-jobs`): the operator surface through the whole app, the
 * retry policy against the real database, lease recovery, cancellation and the enqueue path.
 *
 * The HTTP suite runs against the application role with the cross-site fixture (row-level security and the request's
 * site are the boundary being proved). The worker suites use a stub translator for the policy table and the real
 * two-model service with a mock OpenAI-compatible server for the one thing a stub cannot prove: a job that resumes
 * after a crash replays the draft and review calls it already paid for, so each phase keeps exactly one ledger attempt.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import {
  auditLog,
  llmAttempts,
  llmCalls,
  llmProviders,
  llmSiteSettings,
  scopedDatabase,
  sites,
  translationJobs,
  type Database,
  type TranslationJobRow,
} from '@heopress/database';
import { createRuntime, outboundFetch, parseTrustedEndpoints } from '@heopress/runtime/node';
import type { JobOptions, QueueProvider } from '@heopress/runtime';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { LlmGateway } from '../services/llm/gateway';
import { LlmDeferredError, ModelCallGovernor } from '../services/llm/governance';
import { LlmProviderService } from '../services/llm/provider-service';
import { TranslationError, type TranslationResult, type TranslationService } from '../services/llm/translation-service';
import {
  TranslationJobService,
  translationJobCallKey,
  type TranslationJobActor,
} from '../services/translation-job-service';
import { runTranslationJob, sweepDueTranslationJobs } from '../services/translation-job-worker';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

const JWT_SECRET = 'translation-jobs-secret';
const ENV = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' } as unknown as Record<string, unknown>;
const KEK = Buffer.alloc(32, 7).toString('base64');
const ACTOR: TranslationJobActor = { email: 'operator@example.com', userId: null, ip: null, userAgent: null, requestId: 'req-1' };

const SEGMENTS = [
  { id: 's1', text: 'Hello ⟦P0⟧' },
  { id: 's2', text: 'World 2024' },
];

interface Queued {
  queue: string;
  name: string;
  data: { siteId: string; jobId: string };
  options?: JobOptions;
}

/** A queue that records messages and can be made to fail once (the create path must survive that). */
function recordingQueue(): { queue: QueueProvider; enqueued: Queued[]; failNext: () => void } {
  const enqueued: Queued[] = [];
  let fail = false;
  const queue: QueueProvider = {
    enqueue: async (queueName, jobName, data, options) => {
      if (fail) {
        fail = false;
        throw new Error('queue unavailable');
      }
      enqueued.push({ queue: queueName, name: jobName, data: data as Queued['data'], options });
      return `job-${enqueued.length}`;
    },
    process: () => undefined,
    getStatus: async () => null,
  };
  return { queue, enqueued, failNext: () => (fail = true) };
}

const deferred = (retryAt: Date) => new LlmDeferredError('RATE_LIMITED', retryAt);

describe.skipIf(!hasDbIntegrationUrl)('translation jobs — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let fx: CrossSiteFixture;
  let recorder: ReturnType<typeof recordingQueue>;
  let runtime: ReturnType<typeof createRuntime>;

  beforeAll(async () => {
    db = await connectDbIntegration('translation-jobs');
    fixtures = await connectDbFixtures('translation-jobs');
    recorder = recordingQueue();
    runtime = createRuntime({ ...ENV, ENCRYPTION_KEY: KEK });
    setRuntimeFactory(() => ({ ...runtime, queue: recorder.queue }));
  });

  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'tjb', jwtSecret: JWT_SECRET });
    recorder.enqueued.length = 0;
    await fixtures.delete(translationJobs).where(inArray(translationJobs.siteId, [fx.sites.a, fx.sites.b]));
  });

  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const send = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, ENV);
  const admin = async (site: 'a' | 'b') => fx.headers(site, await fx.session(site === 'a' ? 'adminA' : 'adminB', site));
  const editor = async (site: 'a' | 'b') => fx.headers(site, await fx.session(site === 'a' ? 'onlyA' : 'onlyB', site));
  const create = async (headers: Record<string, string>, body: unknown = { sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }) => {
    const res = await send('/api/v1/translation/jobs', 'POST', headers, body);
    const text = await res.text();
    const json = JSON.parse(text) as { data: TranslationJobRow; errors?: Array<{ code: string }> };
    return { res, job: json.data, json, text };
  };
  const stored = async (id: string) => (await fixtures.select().from(translationJobs).where(eq(translationJobs.id, id)))[0]!;
  const service = (siteId: string, clock?: () => Date, queue: QueueProvider = recorder.queue) =>
    new TranslationJobService({ db, siteId, queue, ...(clock ? { now: clock } : {}) });

  describe('operator surface', () => {
    it('creates a job, enqueues its run, lists it and audits the change', async () => {
      const headers = await admin('a');
      const { res, job, text } = await create(headers);
      expect(res.status, text).toBe(201);
      expect(job).toMatchObject({
        siteId: fx.sites.a,
        status: 'queued',
        sourceLocale: 'en',
        targetLocale: 'zh-CN',
        attempts: 0,
        callEpoch: 0,
        lastErrorCode: null,
      });
      expect(job.segments.map((segment) => segment.id)).toEqual(['s1', 's2']);
      expect(job.segments[0]).toMatchObject({ output: null, state: null });
      expect(recorder.enqueued.filter((entry) => entry.data.jobId === job.id)).toEqual([
        expect.objectContaining({
          queue: 'translation-jobs',
          name: 'translation:job.run',
          data: { siteId: fx.sites.a, jobId: job.id },
        }),
      ]);

      const listed = await send('/api/v1/translation/jobs?status=queued&locale=zh-cn', 'GET', headers);
      expect(listed.status, await listed.clone().text()).toBe(200);
      const body = (await listed.json()) as { data: Array<{ id: string }>; meta: { total: number } };
      expect(body.meta.total).toBe(1);
      expect(body.data.map((row) => row.id)).toEqual([job.id]);

      const detail = await send(`/api/v1/translation/jobs/${job.id}`, 'GET', headers);
      expect(detail.status, await detail.clone().text()).toBe(200);
      expect(((await detail.json()) as { data: { segments: Array<{ text: string }> } }).data.segments).toEqual([
        { id: 's1', text: 'Hello ⟦P0⟧', output: null, state: null, findings: [], reason: null },
        { id: 's2', text: 'World 2024', output: null, state: null, findings: [], reason: null },
      ]);

      const audits = await fixtures
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'translation_job.created')));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.metadata).toMatchObject({ id: job.id, segments: 2 });
      // The audit names the job; it never carries the text being translated.
      expect(JSON.stringify(audits[0]!.metadata)).not.toContain('Hello');
    });

    it('keeps the created job when the queue is unavailable: the sweep is the safety net', async () => {
      recorder.failNext();
      const { res, job, text } = await create(await admin('a'));
      expect(res.status, text).toBe(201);
      expect((await stored(job.id)).status).toBe('queued');
    });

    it('refuses invalid requests before creating anything', async () => {
      const headers = await admin('a');
      const cases: unknown[] = [
        { sourceLocale: 'en', targetLocale: 'zh-CN', segments: [] },
        { sourceLocale: 'en', targetLocale: 'en', segments: SEGMENTS },
        { sourceLocale: 'en', targetLocale: 'zh-CN', segments: [{ id: 'x', text: 'a' }, { id: 'x', text: 'b' }] },
        { sourceLocale: 'en', targetLocale: 'zh-CN', segments: [{ id: 'x', text: '' }] },
        { sourceLocale: 'not a locale', targetLocale: 'zh-CN', segments: SEGMENTS },
        { targetLocale: 'zh-CN', segments: SEGMENTS },
      ];
      for (const body of cases) {
        const res = await send('/api/v1/translation/jobs', 'POST', headers, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VALIDATION');
      }
      expect(await fixtures.select().from(translationJobs).where(eq(translationJobs.siteId, fx.sites.a))).toEqual([]);
      expect(recorder.enqueued).toEqual([]);
    });

    it('members read; only administrators create, retry or cancel', async () => {
      const { job } = await create(await admin('a'));
      const member = await editor('a');
      expect((await send('/api/v1/translation/jobs', 'GET', member)).status).toBe(200);
      expect((await send(`/api/v1/translation/jobs/${job.id}`, 'GET', member)).status).toBe(200);
      expect((await send('/api/v1/translation/jobs', 'POST', member, { sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS })).status).toBe(403);
      expect((await send(`/api/v1/translation/jobs/${job.id}/retry`, 'POST', member)).status).toBe(403);
      expect((await send(`/api/v1/translation/jobs/${job.id}/cancel`, 'POST', member)).status).toBe(403);
      expect((await send('/api/v1/translation/jobs', 'GET', { 'x-heopress-site': fx.sites.a })).status).toBe(401);
    });

    it('keeps one site out of another: its rows, its ids and its audit', async () => {
      const inA = (await create(await admin('a'))).job;
      const inB = (await create(await admin('b'))).job;

      const listedB = (await (await send('/api/v1/translation/jobs', 'GET', await admin('b'))).json()) as { data: Array<{ id: string }> };
      expect(listedB.data.map((row) => row.id)).toEqual([inB.id]);
      expect((await send(`/api/v1/translation/jobs/${inA.id}`, 'GET', await admin('b'))).status).toBe(404);
      expect((await send(`/api/v1/translation/jobs/${inA.id}/cancel`, 'POST', await admin('b'))).status).toBe(404);
      expect((await send(`/api/v1/translation/jobs/${inA.id}/retry`, 'POST', await admin('b'))).status).toBe(404);
      expect((await stored(inA.id)).status).toBe('queued');
      expect(await fixtures.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.b), eq(auditLog.event, 'translation_job.created')))).toHaveLength(1);
    });

    it('cancels a queued job idempotently and refuses a terminal one', async () => {
      const headers = await admin('a');
      const { job } = await create(headers);
      const cancelled = await send(`/api/v1/translation/jobs/${job.id}/cancel`, 'POST', headers);
      expect(cancelled.status, await cancelled.clone().text()).toBe(200);
      expect(((await cancelled.json()) as { data: TranslationJobRow }).data).toMatchObject({ status: 'cancelled', lastErrorCode: 'CANCELLED' });
      expect((await stored(job.id)).finishedAt).not.toBeNull();

      const again = await send(`/api/v1/translation/jobs/${job.id}/cancel`, 'POST', headers);
      expect(again.status).toBe(200);
      expect(((await again.json()) as { data: TranslationJobRow }).data.status).toBe('cancelled');

      await fixtures.update(translationJobs).set({ status: 'succeeded', finishedAt: new Date() }).where(eq(translationJobs.id, job.id));
      const terminal = await send(`/api/v1/translation/jobs/${job.id}/cancel`, 'POST', headers);
      expect(terminal.status).toBe(409);
      expect(((await terminal.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('TRANSLATION_JOB_TERMINAL');
    });

    it('an operator retry resets the budget, the executions and the call-key epoch', async () => {
      const headers = await admin('a');
      const { job } = await create(headers);
      await fixtures
        .update(translationJobs)
        .set({ status: 'failed', attempts: 3, executions: 4, lastErrorCode: 'HTTP_500', callEpoch: 2, finishedAt: new Date() })
        .where(eq(translationJobs.id, job.id));
      recorder.enqueued.length = 0;

      const retried = await send(`/api/v1/translation/jobs/${job.id}/retry`, 'POST', headers);
      expect(retried.status, await retried.clone().text()).toBe(200);
      const row = (await retried.json()) as { data: TranslationJobRow };
      expect(row.data).toMatchObject({
        status: 'queued',
        attempts: 0,
        executions: 0,
        callEpoch: 3,
        lastErrorCode: null,
      });
      expect(recorder.enqueued.filter((entry) => entry.data.jobId === job.id)).toHaveLength(1);
      // A retry is a new call-key epoch: the previous attempt's answered calls are not replayed.
      expect(translationJobCallKey(await stored(job.id))).toBe(`translation-job:${job.id}:a0:e3`);
      expect(await fixtures.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'translation_job.retried')))).toHaveLength(1);

      // A queued or running job is not retryable: only a failed/cancelled one starts over.
      await fixtures.update(translationJobs).set({ status: 'queued' }).where(eq(translationJobs.id, job.id));
      const refused = await send(`/api/v1/translation/jobs/${job.id}/retry`, 'POST', headers);
      expect(refused.status).toBe(409);
      expect(((await refused.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('TRANSLATION_JOB_NOT_RETRYABLE');
    });
  });

  describe('retry policy', () => {
    const stub = (translate: TranslationService['translate']): TranslationService => ({ translate });

    it('a deferral waits for the gateway’s retry-at without spending a business retry', async () => {
      const siteId = fx.sites.a;
      let clock = new Date('2026-11-13T00:00:00.000Z');
      const retryAt = new Date('2026-11-13T00:01:00.000Z');
      let calls = 0;
      const translator = stub(async () => {
        calls += 1;
        if (calls === 1) throw deferred(retryAt);
        return { segments: SEGMENTS, engine: 'stub', provider: 'stub', model: 'stub-1', callId: 'call-1' };
      });
      const jobs = service(siteId, () => clock);
      const deps = {
        db,
        queue: recorder.queue,
        gateway: {} as never,
        translatorFor: () => translator,
        now: () => clock,
      };

      const created = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);
      recorder.enqueued.length = 0;
      await runTranslationJob(deps, { siteId, jobId: created.id });
      const deferredRow = await stored(created.id);
      expect(deferredRow).toMatchObject({ status: 'queued', attempts: 0, lastErrorCode: 'RATE_LIMITED' });
      expect(deferredRow.nextAttemptAt?.toISOString()).toBe(retryAt.toISOString());
      expect(recorder.enqueued).toEqual([
        expect.objectContaining({ data: { siteId, jobId: created.id }, options: { delay: 60_000 } }),
      ]);

      // Not due yet: nothing runs, and the counter stays zero.
      expect(await runTranslationJob(deps, { siteId, jobId: created.id })).toBeNull();
      expect(calls).toBe(1);
      expect((await stored(created.id)).attempts).toBe(0);

      clock = retryAt;
      const settled = await runTranslationJob(deps, { siteId, jobId: created.id });
      expect(settled?.status).toBe('succeeded');
      expect(settled?.attempts).toBe(0);
      expect((await stored(created.id)).segmentsTranslated).toBe(2);
    });

    it('a transient failure spends one business retry per attempt and ends at the budget', async () => {
      const siteId = fx.sites.a;
      let clock = new Date('2026-11-13T00:00:00.000Z');
      let calls = 0;
      // The code is derived from the error type, not the message: a gateway error carries the provider's status code.
      const failing = stub(async () => {
        calls += 1;
        const { LlmGatewayError } = await import('../services/llm/gateway-error');
        throw new LlmGatewayError('HTTP_500', 'provider said no');
      });
      const jobs = service(siteId, () => clock);
      const deps = { db, queue: recorder.queue, gateway: {} as never, translatorFor: () => failing, now: () => clock };
      const created = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);
      recorder.enqueued.length = 0;

      const first = await runTranslationJob(deps, { siteId, jobId: created.id });
      expect(first).toMatchObject({ status: 'queued', attempts: 1, lastErrorCode: 'HTTP_500' });
      expect(first!.nextAttemptAt!.getTime()).toBe(new Date('2026-11-13T00:01:00.000Z').getTime());
      clock = first!.nextAttemptAt!;
      const second = await runTranslationJob(deps, { siteId, jobId: created.id });
      expect(second).toMatchObject({ status: 'queued', attempts: 2 });
      expect(second!.nextAttemptAt!.getTime() - clock.getTime()).toBe(120_000);
      clock = second!.nextAttemptAt!;
      const last = await runTranslationJob(deps, { siteId, jobId: created.id });
      expect(last).toMatchObject({ status: 'failed', attempts: 3, lastErrorCode: 'HTTP_500', nextAttemptAt: null });
      expect(last!.finishedAt).not.toBeNull();
      expect(calls).toBe(3);
      const messagesAfterFailure = recorder.enqueued.length;
      expect(await runTranslationJob(deps, { siteId, jobId: created.id })).toBeNull();
      expect(recorder.enqueued).toHaveLength(messagesAfterFailure);
    });

    it('a permanent failure stops at once without spending a retry', async () => {
      const siteId = fx.sites.a;
      let calls = 0;
      const translator = stub(async () => {
        calls += 1;
        throw new TranslationError('BAD_TRANSLATION', 'the answer was not the requested segments');
      });
      const jobs = service(siteId);
      const deps = { db, queue: recorder.queue, gateway: {} as never, translatorFor: () => translator };
      const created = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);
      recorder.enqueued.length = 0;

      const settled = await runTranslationJob(deps, { siteId, jobId: created.id });
      expect(settled).toMatchObject({ status: 'failed', attempts: 0, lastErrorCode: 'BAD_TRANSLATION' });
      expect(recorder.enqueued).toHaveLength(0);
      expect(calls).toBe(1);
      expect(await runTranslationJob(deps, { siteId, jobId: created.id })).toBeNull();
    });

    it('writes the per-segment states and counters, keeping an unverified draft', async () => {
      const siteId = fx.sites.a;
      const four = [
        { id: 'a', text: 'One ⟦P0⟧' },
        { id: 'b', text: 'Two 2024' },
        { id: 'c', text: 'Three' },
        { id: 'd', text: 'Four' },
      ];
      const result: TranslationResult = {
        segments: [
          { id: 'a', text: '一 ⟦P0⟧' },
          { id: 'b', text: '二 2024' },
          { id: 'c', text: '三' },
          { id: 'd', text: '四' },
        ],
        engine: 'heopress:dual-model',
        provider: 'Draft',
        model: 'draft-model',
        callId: 'draft-call',
        verification: {
          draft: { provider: 'Draft', model: 'draft-model', callId: 'draft-call' },
          review: { provider: 'Review', model: 'review-model', callId: 'review-call', ran: true },
          revisedSegments: 1,
          rejectedSegments: 1,
          segments: [
            { id: 'a', state: 'verified', findings: [] },
            { id: 'b', state: 'revised', findings: [], reason: 'more natural' },
            { id: 'c', state: 'unverified', findings: ['glossary_missing'] },
            { id: 'd', state: 'rejected_verification', findings: ['placeholder_missing'] },
          ],
        },
      };
      const jobs = service(siteId);
      const deps = { db, queue: recorder.queue, gateway: {} as never, translatorFor: () => ({ translate: async () => result }) };
      const created = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: four }, ACTOR);
      const settled = await runTranslationJob(deps, { siteId, jobId: created.id });

      expect(settled).toMatchObject({
        status: 'succeeded',
        serviceId: 'heopress:dual-model',
        draftProvider: 'Draft',
        draftModel: 'draft-model',
        reviewProvider: 'Review',
        reviewModel: 'review-model',
        segmentsTranslated: 4,
        segmentsRevised: 1,
        segmentsUnverified: 1,
        segmentsRejected: 1,
      });
      expect(settled!.results).toEqual([
        { id: 'a', text: '一 ⟦P0⟧', state: 'verified', findings: [] },
        { id: 'b', text: '二 2024', state: 'revised', findings: [], reason: 'more natural' },
        { id: 'c', text: '三', state: 'unverified', findings: ['glossary_missing'] },
        { id: 'd', text: '四', state: 'rejected_verification', findings: ['placeholder_missing'] },
      ]);
      // The API shows the same per-segment states, with the draft text kept for every segment.
      const headers = await admin('a');
      const detail = await send(`/api/v1/translation/jobs/${created.id}`, 'GET', headers);
      const body = (await detail.json()) as { data: { segments: Array<{ id: string; state: string; output: string }>; counters: unknown } };
      expect(body.data.segments.map((segment) => [segment.id, segment.state, segment.output])).toEqual([
        ['a', 'verified', '一 ⟦P0⟧'],
        ['b', 'revised', '二 2024'],
        ['c', 'unverified', '三'],
        ['d', 'rejected_verification', '四'],
      ]);
      expect(body.data.counters).toEqual({ translated: 4, revised: 1, unverified: 1, rejected: 1 });
    });
  });

  describe('lease, recovery and cancellation', () => {
    it('cancelling a running job stops it and the late execution cannot settle', async () => {
      const siteId = fx.sites.a;
      let started!: () => void;
      const entered = new Promise<void>((resolve) => (started = resolve));
      const translator: TranslationService = {
        translate: (req) =>
          new Promise((_resolve, reject) => {
            started();
            req.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
          }),
      };
      const jobs = service(siteId);
      const deps = { db, queue: recorder.queue, gateway: {} as never, translatorFor: () => translator, heartbeatMs: 20, leaseMs: 60_000 };
      const created = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);

      const running = runTranslationJob(deps, { siteId, jobId: created.id });
      await entered;
      expect((await stored(created.id)).status).toBe('running');

      const cancelled = await jobs.cancel(created.id, ACTOR);
      expect(cancelled.status).toBe('cancelled');
      expect(await running).toBeNull();
      expect(await stored(created.id)).toMatchObject({ status: 'cancelled', lastErrorCode: 'CANCELLED' });
    });

    it('the sweep re-enqueues due jobs, expired leases, and ends a job that used up its executions', async () => {
      const siteId = fx.sites.a;
      const jobs = service(siteId);
      const due = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);
      const expired = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);
      const exhausted = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);
      const past = new Date(Date.now() - 60_000);
      await fixtures.update(translationJobs).set({ status: 'running', leaseUntil: past, leaseOwner: 'dead-worker', executions: 1 }).where(eq(translationJobs.id, expired.id));
      await fixtures
        .update(translationJobs)
        .set({ status: 'running', leaseUntil: past, leaseOwner: 'dead-worker', executions: 5, maxExecutions: 5 })
        .where(eq(translationJobs.id, exhausted.id));
      recorder.enqueued.length = 0;

      const swept = await sweepDueTranslationJobs({ db, queue: recorder.queue, gateway: {} as never });
      expect(swept.enqueued).toBeGreaterThanOrEqual(2);
      expect(recorder.enqueued.map((entry) => entry.data.jobId)).toEqual(expect.arrayContaining([due.id, expired.id]));
      expect(recorder.enqueued.map((entry) => entry.data.jobId)).not.toContain(exhausted.id);
      expect(await stored(exhausted.id)).toMatchObject({ status: 'failed', lastErrorCode: 'EXECUTION_LIMIT' });
    });

    it('a cancelled job is not re-enqueued by the sweep', async () => {
      const siteId = fx.sites.a;
      const jobs = service(siteId);
      const job = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);
      await jobs.cancel(job.id, ACTOR);
      recorder.enqueued.length = 0;
      await sweepDueTranslationJobs({ db, queue: recorder.queue, gateway: {} as never });
      expect(recorder.enqueued.map((entry) => entry.data.jobId)).not.toContain(job.id);
    });
  });

  describe('resume after a crash', () => {
    const RESUME_SITE = 'site_v14_tjobs_resume';
    const DRAFT_OK = JSON.stringify({ segments: [{ id: 's1', target: '你好 ⟦P0⟧' }, { id: 's2', target: '世界 2024' }] });
    const REVIEW_OK = JSON.stringify({ segments: [{ id: 's1', verdict: 'ok' }, { id: 's2', verdict: 'ok' }] });
    let server: Server;
    let origin = '';
    const hits: string[] = [];
    const chat = (content: string) => ({
      status: 200,
      body: { choices: [{ message: { content } }], usage: { prompt_tokens: 40, completion_tokens: 10 } },
    });

    beforeAll(async () => {
      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        req.resume();
        req.on('end', () => {
          const [, provider = ''] = (req.url ?? '').split('/');
          hits.push(provider);
          const reply = provider === 'review' ? chat(REVIEW_OK) : chat(DRAFT_OK);
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.body));
        });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fixtures.delete(llmAttempts).where(eq(llmAttempts.siteId, RESUME_SITE));
      await fixtures.delete(llmCalls).where(eq(llmCalls.siteId, RESUME_SITE));
      await fixtures.delete(llmSiteSettings).where(eq(llmSiteSettings.siteId, RESUME_SITE));
      await fixtures.delete(llmProviders).where(eq(llmProviders.siteId, RESUME_SITE));
      await fixtures.delete(translationJobs).where(eq(translationJobs.siteId, RESUME_SITE));
      await fixtures.delete(sites).where(eq(sites.id, RESUME_SITE));
    });

    const keys = () => runtime.keys;
    const trustedFetch = (url: string, init: RequestInit) =>
      outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints(origin) });

    beforeEach(async () => {
      hits.length = 0;
      await fixtures.delete(llmAttempts).where(eq(llmAttempts.siteId, RESUME_SITE));
      await fixtures.delete(llmCalls).where(eq(llmCalls.siteId, RESUME_SITE));
      await fixtures.delete(llmSiteSettings).where(eq(llmSiteSettings.siteId, RESUME_SITE));
      await fixtures.delete(llmProviders).where(eq(llmProviders.siteId, RESUME_SITE));
      await fixtures.delete(translationJobs).where(eq(translationJobs.siteId, RESUME_SITE));
      await fixtures.delete(sites).where(eq(sites.id, RESUME_SITE));
      await fixtures.insert(sites).values({ id: RESUME_SITE, name: RESUME_SITE });

      const providers = new LlmProviderService({ db: scopedDatabase(db, { site: RESUME_SITE }), siteId: RESUME_SITE, keys: keys(), instanceCurrency: 'USD' });
      const make = (name: string, path: string, model: string) =>
        providers.create({
          kind: 'openai_compatible',
          name,
          baseUrl: `${origin}/${path}`,
          model,
          apiKey: `sk-${path}`,
          capabilities: { tools: true, json: true, maxContext: null },
          pricing: { kind: 'per_1m_tokens', inputMicros: 1_000_000, outputMicros: 2_000_000 },
          currency: 'USD',
          timeoutMs: 2000,
        });
      const draft = await make('Draft', 'draft', 'draft-model');
      const review = await make('Review', 'review', 'review-model');
      await providers.updateSettings({
        currency: 'USD',
        monthlyBudgetMicros: null,
        budgetTimezone: 'UTC',
        translationService: 'heopress:dual-model',
        translationDraftProviderId: draft.id,
        translationReviewProviderId: review.id,
      });
    });

    it('replays the draft and the review instead of paying them twice, one ledger attempt per phase', async () => {
      const gateway = new LlmGateway({
        db,
        keys: keys(),
        env: { LLM_PRICE_CURRENCY: 'USD' } as Record<string, string | undefined>,
        fetch: trustedFetch,
        governor: new ModelCallGovernor({ ratePerMinute: 0, breakerFailures: 1000, breakerCooldownMs: 60_000 }),
      });
      const jobs = service(RESUME_SITE);
      const created = await jobs.create({ sourceLocale: 'en', targetLocale: 'zh-CN', segments: SEGMENTS }, ACTOR);
      recorder.enqueued.length = 0;

      let crashed = true;
      const deps = {
        db,
        queue: recorder.queue,
        gateway,
        keys: keys(),
        env: ENV,
        hooks: {
          beforeSettle: () => {
            if (crashed) throw new Error('simulated process death before settlement');
          },
        },
      };

      // First execution: both phases complete, then the process "dies" before the row is settled.
      await expect(runTranslationJob(deps, { siteId: RESUME_SITE, jobId: created.id })).rejects.toThrow(/simulated process death/);
      const interrupted = await stored(created.id);
      expect(interrupted).toMatchObject({ status: 'running', attempts: 0, executions: 0, segmentsTranslated: 0 });
      expect(interrupted.leaseUntil).not.toBeNull();
      expect(hits).toEqual(['draft', 'review']);
      expect(await fixtures.select().from(llmCalls).where(eq(llmCalls.siteId, RESUME_SITE))).toHaveLength(2);
      expect(await fixtures.select().from(llmAttempts).where(eq(llmAttempts.siteId, RESUME_SITE))).toHaveLength(2);

      // The lease expires; the next run (the sweep's or a restart's message) resumes the same business attempt.
      crashed = false;
      await fixtures.update(translationJobs).set({ leaseUntil: new Date(Date.now() - 1000) }).where(eq(translationJobs.id, created.id));
      const settled = await runTranslationJob(deps, { siteId: RESUME_SITE, jobId: created.id });

      expect(settled).toMatchObject({
        status: 'succeeded',
        attempts: 0,
        executions: 1,
        serviceId: 'heopress:dual-model',
        draftModel: 'draft-model',
        reviewModel: 'review-model',
        segmentsTranslated: 2,
        segmentsUnverified: 0,
      });
      expect(settled!.results.map((segment) => segment.state)).toEqual(['verified', 'verified']);
      // No second HTTP call and no second ledger attempt: the recorded answers were replayed.
      expect(hits).toEqual(['draft', 'review']);
      const calls = await fixtures.select().from(llmCalls).where(eq(llmCalls.siteId, RESUME_SITE));
      const attempts = await fixtures.select().from(llmAttempts).where(eq(llmAttempts.siteId, RESUME_SITE));
      expect(calls).toHaveLength(2);
      expect(attempts).toHaveLength(2);
      const models = attempts.map((attempt) => (attempt.snapshot as { model?: string }).model).sort();
      expect(models).toEqual(['draft-model', 'review-model']);
      expect(new Set(attempts.map((attempt) => attempt.callId)).size).toBe(2);
      // The job's call key is derived from the business attempt and the operator epoch; a resume keeps both.
      const row = (await stored(created.id))!;
      expect(translationJobCallKey(row)).toBe(`translation-job:${created.id}:a0:e0`);
      expect(await fixtures.select().from(llmCalls).where(and(eq(llmCalls.siteId, RESUME_SITE), eq(llmCalls.callKey, `${translationJobCallKey(row)}:draft`)))).toHaveLength(1);
      expect(await fixtures.select().from(llmCalls).where(and(eq(llmCalls.siteId, RESUME_SITE), eq(llmCalls.callKey, `${translationJobCallKey(row)}:review`)))).toHaveLength(1);
    });
  });
});
