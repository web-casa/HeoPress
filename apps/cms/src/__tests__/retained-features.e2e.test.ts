import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  auditLog,
  createDb,
  deletionLedger,
  extensions,
  items,
  publisherKeys,
  sites,
  systemState,
  users,
  type Database,
} from '@heopress/database';

import app from '../index';
import { STANDARD_LOCKOUT_POLICY } from '../modules/setup/policy-codec';

/**
 * Smoke tests for features P02 keeps (tasks 5.3 and 5.4; spec
 * platform/feature-surface "保留功能可用" and "保留轻后台与插件开发契约"),
 * through the real app on PostgreSQL:
 *   0. the light admin: a draft is edited and then published, and it is
 *      listed as published only after that;
 *   1. GDPR: an admin exports a data subject's records (audited
 *      `sar_exported`) and runs an erasure request to completion (the item is
 *      gone, `data_erased` is audited);
 *   2. Insights: a dashboard panel computes a metric over live content;
 *   3. Marketplace: a catalog extension whose bundle is Ed25519-signed by a
 *      registered publisher key installs; the same listing with a tampered
 *      bundle is refused.
 *
 * The bundle URL is public-looking (the verifier's SSRF check refuses
 * loopback); `fetch` is stubbed for that one URL only, so signature
 * verification runs for real. Needs DATABASE_URL (disposable),
 * HEOPRESS_ENV=development and JWT_SECRET, like the golden-path E2E.
 */

const TEST_DATABASE_URL = process.env.DATABASE_URL?.trim() || undefined;
const SITE = '__default__';
const ADMIN_EMAIL = 'retained-admin@example.test';
const ADMIN_PASSWORD = 'Retained-Features-E2E-1!';
const COLLECTION = 'subjects';
const BUNDLE_URL = 'https://extensions.example.com/retained-e2e/bundle.js';
const SLUG = 'retained-e2e-plugin';
const KEY_ID = 'retained-e2e-key';
// HeoPress P13: the erasure below writes the external deletion ledger; keep it out of the working tree.
const LEDGER_DIR = mkdtempSync(path.join(os.tmpdir(), 'heopress-retained-ledger-'));
const ENV = { ...process.env, HEOPRESS_DELETION_LEDGER_DIR: LEDGER_DIR } as unknown as Record<string, unknown>;

let bearer = '';
const request = (path: string, init?: RequestInit) => app.request(path, init, ENV);
const headers = () => ({ 'content-type': 'application/json', 'x-heopress-site': SITE, authorization: bearer });
const post = (path: string, body: unknown) => request(path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });

describe.skipIf(!TEST_DATABASE_URL)('retained features (PostgreSQL)', () => {
  let db: Database;
  const realFetch = globalThis.fetch;

  async function resetFixture(): Promise<void> {
    await db.delete(extensions).where(and(isNull(extensions.siteId), eq(extensions.marketplaceSlug, SLUG))).catch(() => undefined);
    await db.delete(publisherKeys).where(eq(publisherKeys.keyId, KEY_ID)).catch(() => undefined);
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    // The deletion ledger outlives a deleted site by design (HeoPress P13); this suite's rows go with its fixture.
    await db.delete(deletionLedger).where(eq(deletionLedger.siteId, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.isBootstrap, true)).catch(() => undefined);
    await db.delete(systemState).catch(() => undefined);
  }

  beforeAll(async () => {
    db = createDb(TEST_DATABASE_URL!);
    await db.execute(sql`SELECT 1`);
    await resetFixture();

    const setup = await request('/api/v1/setup/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, firstName: 'Retained', lastName: 'Admin' },
        adminPath: '/retained-e2e-admin',
        policy: STANDARD_LOCKOUT_POLICY,
        project: { defaultLanguage: 'en', siteUrl: 'https://retained.example.test', displayTitle: 'Retained E2E' },
      }),
    });
    expect(setup.status, await setup.clone().text()).toBe(201);
    const login = await request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-heopress-site': SITE },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    bearer = `Bearer ${((await login.json()) as { data: { token: string } }).data.token}`;

    expect((await post('/api/v1/collections', { name: COLLECTION })).status).toBe(201);
    for (const [email, score] of [['alice@example.com', 3], ['bob@example.com', 5]] as const) {
      const res = await post(`/api/v1/items/${COLLECTION}`, { data: { email, score }, status: 'published' });
      expect(res.status).toBe(201);
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    if (db) await resetFixture();
    if (LEDGER_DIR.startsWith(os.tmpdir())) rmSync(LEDGER_DIR, { recursive: true, force: true });
  });

  it('light admin: a draft is edited, then published', async () => {
    const created = await post(`/api/v1/items/${COLLECTION}`, { data: { email: 'draft@example.com', score: 1 }, status: 'draft' });
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { data: { id: string } }).data.id;
    const listPublished = async () =>
      ((await (await request(`/api/v1/items/${COLLECTION}?status=published`, { headers: headers() })).json()) as {
        data: Array<{ id: string; data: { score?: number } }>;
      }).data;
    expect((await listPublished()).some((r) => r.id === id)).toBe(false);

    const patch = (body: unknown) =>
      request(`/api/v1/items/${COLLECTION}/${id}`, { method: 'PATCH', headers: headers(), body: JSON.stringify(body) });
    // Every update names the version it is based on (P04).
    expect((await patch({ data: { email: 'draft@example.com', score: 2 }, expectedVersion: 1 })).status).toBe(200);
    expect((await patch({ status: 'published', expectedVersion: 2 })).status).toBe(200);
    expect((await listPublished()).find((r) => r.id === id)?.data.score).toBe(2);

    // Keep the later cases' fixture as they expect it (two subjects).
    expect((await request(`/api/v1/items/${COLLECTION}/${id}`, { method: 'DELETE', headers: headers() })).status).toBeLessThan(300);
  });

  it('GDPR: subject export is audited and an erasure request removes the subject', async () => {
    const exported = await post('/api/v1/admin/sar/export', {
      scope: { collection: COLLECTION, filter: { email: 'alice@example.com' } },
    });
    expect(exported.status, await exported.clone().text()).toBe(200);
    expect(JSON.stringify(await exported.json())).toContain('alice@example.com');
    const sarAudit = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'sar_exported')));
    expect(sarAudit.length).toBeGreaterThanOrEqual(1);

    const created = await post('/api/v1/admin/erasure', {
      scope: { collection: COLLECTION, filter: { email: 'alice@example.com' } },
      reason: 'GDPR art. 17 request (smoke test)',
    });
    expect(created.status, await created.clone().text()).toBe(201);
    const requestId = ((await created.json()) as { data: { id: string } }).data.id;
    expect((await post(`/api/v1/admin/erasure/${requestId}/confirm`, {})).status).toBe(200);
    const executed = await post(`/api/v1/admin/erasure/${requestId}/execute`, {});
    expect(executed.status, await executed.clone().text()).toBe(200);
    expect(((await executed.json()) as { data: { status: string; recordCount: number } }).data).toMatchObject({
      status: 'completed',
      recordCount: 1,
    });

    const remaining = await db.select({ data: items.data }).from(items).where(eq(items.siteId, SITE));
    expect(JSON.stringify(remaining)).not.toContain('alice@example.com');
    expect(JSON.stringify(remaining)).toContain('bob@example.com');
    const erased = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'data_erased')));
    expect(erased.length).toBe(1);
  });

  it('Insights: a metric panel aggregates live content', async () => {
    const dash = await post('/api/v1/dashboards', { name: 'Smoke dashboard' });
    expect(dash.status, await dash.clone().text()).toBe(201);
    const dashId = ((await dash.json()) as { data: { id: string } }).data.id;
    const panel = await post(`/api/v1/dashboards/${dashId}/panels`, {
      name: 'Subjects',
      type: 'metric',
      position: { x: 0, y: 0, w: 2, h: 2 },
      query: { collection: COLLECTION, aggregate: 'count' },
    });
    expect(panel.status, await panel.clone().text()).toBe(201);
    const panelId = ((await panel.json()) as { data: { id: string } }).data.id;
    const data = await post(`/api/v1/dashboards/${dashId}/panels/${panelId}/data`, {});
    expect(data.status, await data.clone().text()).toBe(200);
    // Only bob is left after the erasure above (tests run in file order).
    expect(JSON.stringify(await data.json())).toMatch(/"value":1\b/);
  });

  it('Marketplace: a signed extension installs and a tampered bundle is refused', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const bundle = Buffer.from('export default { name: "retained-e2e-plugin" };\n');
    const sha256 = createHash('sha256').update(bundle).digest('hex');
    const signature = sign(null, bundle, privateKey).toString('base64');
    await db.insert(publisherKeys).values({
      keyId: KEY_ID,
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      publisher: 'Retained E2E',
    });
    await db.insert(extensions).values({
      siteId: null,
      name: 'retained-e2e-plugin',
      version: '1.0.0',
      type: 'hook',
      bundleUrl: BUNDLE_URL,
      bundleSha256: sha256,
      signature,
      signatureAlg: 'ed25519',
      publisherKeyId: KEY_ID,
      publisher: 'Retained E2E',
      marketplaceSlug: SLUG,
      publishedAt: new Date(),
    });

    const serve = (body: Buffer) =>
      vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === BUNDLE_URL ? new Response(new Uint8Array(body)) : realFetch(input, init),
      );

    serve(Buffer.concat([bundle, Buffer.from('// tampered\n')]));
    const refused = await post(`/api/v1/marketplace/extensions/${SLUG}/install`, {});
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('SIGNATURE_INVALID');

    serve(bundle);
    const installed = await post(`/api/v1/marketplace/extensions/${SLUG}/install`, {});
    expect(installed.status, await installed.clone().text()).toBe(201);
    const row = ((await installed.json()) as { data: { siteId: string; verifiedAt: string | null; isOfficial: boolean } }).data;
    expect(row.siteId).toBe(SITE);
    expect(row.verifiedAt).toBeTruthy();
    expect(row.isOfficial).toBe(false);
  });
});
