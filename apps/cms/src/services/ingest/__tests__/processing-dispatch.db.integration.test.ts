import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';
import { dispatchProcessingJobs, processingFlows } from '../processing-dispatch';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from '../../../__tests__/helpers/cross-site-fixture';

/**
 * The processing outbox's consumer (P15; spec ops/ingest-processing-outbox). Rows written in a fetched document's
 * transaction are handed to the site's own processing flows — the active ones whose first step is
 * `pipeline:fetch-source` — through the `flow-events` queue; a site without such a flow keeps its rows pending.
 */

function recordingQueue() {
  const jobs: Array<{ queue: string; name: string; data: unknown }> = [];
  const queue: QueueProvider = {
    enqueue: async (queueName, name, data) => {
      jobs.push({ queue: queueName, name, data });
      return `job_${jobs.length}`;
    },
    process: () => undefined,
    getStatus: async () => null,
  };
  return { jobs, queue };
}

describe('processingFlows', () => {
  const flow = (id: string, status: string, graph: unknown) => ({ id, status, graph });

  it('takes active flows whose first step is pipeline:fetch-source', () => {
    expect(
      processingFlows([
        flow('a', 'active', { nodes: [{ id: 'f', key: 'pipeline:fetch-source' }, { id: 't', key: 'pipeline:translate' }] }),
        flow('b', 'inactive', { nodes: [{ id: 'f', key: 'pipeline:fetch-source' }] }),
        flow('c', 'active', { nodes: [{ id: 'x', key: 'pipeline:translate' }, { id: 'f', key: 'pipeline:fetch-source' }] }),
        flow('d', 'active', { nodes: [] }),
        flow('e', 'active', {}),
      ]),
    ).toEqual(['a']);
  });
});

describe.skipIf(!hasDbIntegrationUrl)('processing dispatch: the outbox reaches the site\'s processing flows', () => {
  let db: Database;
  let fixtures: Database;
  let fx: CrossSiteFixture;
  const rec = recordingQueue();

  beforeAll(async () => {
    db = await connectDbIntegration('processing-dispatch');
    fixtures = await connectDbFixtures('processing-dispatch');
    fx = await createCrossSiteFixture(fixtures, { prefix: 'pd', jwtSecret: 'processing-dispatch-secret' });
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  const document = async (siteId: string, id: string) => {
    await fixtures.execute(
      sql`INSERT INTO lumibase_ingest_sources (id, site_id, name, type, url, schedule_times, timezone) VALUES (${`src_${id}`}, ${siteId}, ${`S-${id}`}, 'url', 'https://example.test/feed', '{08:00}'::text[], 'UTC')`,
    );
    await fixtures.execute(
      sql`INSERT INTO lumibase_ingest_snapshots (id, site_id, sha256, storage_key, byte_size, content_type) VALUES (${`snap_${id}`}, ${siteId}, ${`sha-${id}`}, ${`k/${id}`}, 10, 'text/html')`,
    );
    await fixtures.execute(
      sql`INSERT INTO lumibase_ingest_source_documents (id, site_id, source_id, operation_id, url, normalized_url, final_url, title, body_html, body_text, content_hash, snapshot_id, extraction_rule_version, fetch_method, fetch_provider, licence_status, usage_mode, commercial_use, fetched_at) VALUES (${id}, ${siteId}, ${`src_${id}`}, ${`op_${id}`}, 'https://example.test/a', 'https://example.test/a', 'https://example.test/a', 'T', '<p>body</p>', 'body', ${`hash-${id}`}, ${`snap_${id}`}, 'r1', 'http', 'direct', 'unknown', 'discovery_only', false, now())`,
    );
  };
  const job = async (siteId: string, documentId: string, kind = 'process', status = 'pending') => {
    await fixtures.execute(
      sql`INSERT INTO lumibase_ingest_processing_jobs (id, site_id, source_document_id, kind, status) VALUES (${`job_${documentId}`}, ${siteId}, ${documentId}, ${kind}, ${status})`,
    );
  };
  const flow = async (siteId: string, id: string, firstStep: string) => {
    await fixtures.execute(
      sql`INSERT INTO lumibase_flows (id, site_id, name, status, trigger_type, graph) VALUES (${id}, ${siteId}, 'Processing', 'active', 'manual', ${JSON.stringify({ nodes: [{ id: 'n', key: firstStep }] })}::jsonb)`,
    );
  };
  const status = async (documentId: string) =>
    ((await fixtures.execute(
      sql`SELECT status, enqueued_at IS NOT NULL AS enqueued FROM lumibase_ingest_processing_jobs WHERE id = ${`job_${documentId}`}`,
    )) as unknown as Array<{ status: string; enqueued: boolean }>)[0];

  it('enqueues one flow:event job per row and processing flow, and marks the row enqueued', async () => {
    await document(fx.sites.a, 'pd_doc_a');
    await job(fx.sites.a, 'pd_doc_a');
    await flow(fx.sites.a, 'flow_pd_a', 'pipeline:fetch-source');
    rec.jobs.length = 0;

    const result = await dispatchProcessingJobs({ db, queue: rec.queue });
    expect(result.dispatched).toBeGreaterThanOrEqual(1);
    const events = rec.jobs.filter((j) => j.queue === 'flow-events' && j.name === 'flow:event');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.data).toMatchObject({ siteId: fx.sites.a, flowId: 'flow_pd_a', input: { sourceDocumentIds: ['pd_doc_a'] } });
    expect(await status('pd_doc_a')).toEqual({ status: 'enqueued', enqueued: true });

    // A second tick does not dispatch it again.
    const before = rec.jobs.length;
    await dispatchProcessingJobs({ db, queue: rec.queue });
    expect(rec.jobs.length).toBe(before);
  });

  it('leaves a site without a processing flow pending, and never dispatches leads', async () => {
    await document(fx.sites.b, 'pd_doc_b');
    await job(fx.sites.b, 'pd_doc_b');
    await flow(fx.sites.b, 'flow_pd_b', 'pipeline:translate');
    await document(fx.sites.a, 'pd_doc_lead');
    await job(fx.sites.a, 'pd_doc_lead', 'lead');
    rec.jobs.length = 0;

    await dispatchProcessingJobs({ db, queue: rec.queue });
    expect(rec.jobs.filter((j) => (j.data as { siteId?: string }).siteId === fx.sites.b)).toEqual([]);
    expect(await status('pd_doc_b')).toEqual({ status: 'pending', enqueued: false });
    expect(rec.jobs.some((j) => JSON.stringify(j.data).includes('pd_doc_lead'))).toBe(false);
    expect(await status('pd_doc_lead')).toEqual({ status: 'pending', enqueued: false });
  });
});
