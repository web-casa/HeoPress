import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, glossary, type Database } from '@heopress/database';
import app from '../index';
import { loadGlossary } from '../services/pipeline/block-translation';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The site glossary through the whole app (HeoPress v1.4, spec `ai/site-glossary`): CRUD under `/api/v1/glossary` with
 * the request's site (never the body), validation of the three rules, the duplicate constraint as a `409`, the audit
 * trail of every change, and the rule reaching the translation pipeline (`loadGlossary`).
 *
 * Tenant isolation is proved with the cross-site fixture: the same pair and term may exist in two sites, and one site's
 * administrator cannot read, change or delete the other's entry — the site condition is on every statement and the
 * unique index is per site.
 */

const JWT_SECRET = 'glossary-test-secret';
const ENV = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' } as unknown as Record<string, unknown>;

const ENTRY = { sourceLang: 'en', targetLang: 'zh-CN', term: 'HeoPress', translation: '禾普', rule: 'prefer' };

/** A Postgres SQLSTATE anywhere in the driver's error chain (postgres-js nests it under `cause`). */
function codeOfDb(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (code) return String(code);
  }
  return undefined;
}

describe.skipIf(!hasDbIntegrationUrl)('site glossary — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let fx: CrossSiteFixture;

  const send = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, ENV);

  const admin = async (site: 'a' | 'b') =>
    fx.headers(site, await fx.session(site === 'a' ? 'adminA' : 'adminB', site));
  const editor = async (site: 'a' | 'b') =>
    fx.headers(site, await fx.session(site === 'a' ? 'onlyA' : 'onlyB', site));

  const storedGlossary = (siteId: string) => fixtures.select().from(glossary).where(eq(glossary.siteId, siteId));

  beforeAll(async () => {
    db = await connectDbIntegration('glossary');
    fixtures = await connectDbFixtures('glossary');
  });

  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'gls', jwtSecret: JWT_SECRET });
  });

  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  it('creates entries, lists them by language pair, and audits every change', async () => {
    const headers = await admin('a');

    const preferred = await send('/api/v1/glossary', 'POST', headers, ENTRY);
    expect(preferred.status, await preferred.clone().text()).toBe(201);
    const preferredEntry = ((await preferred.json()) as { data: { id: string; siteId: string; rule: string } }).data;
    expect(preferredEntry).toMatchObject({ siteId: fx.sites.a, rule: 'prefer' });

    const keep = await send('/api/v1/glossary', 'POST', headers, { ...ENTRY, term: 'API', translation: 'API', rule: 'do-not-translate' });
    expect(keep.status, await keep.clone().text()).toBe(201);
    const banned = await send('/api/v1/glossary', 'POST', headers, { ...ENTRY, term: 'Cloud', translation: '云', rule: 'forbidden' });
    expect(banned.status, await banned.clone().text()).toBe(201);

    // `?from=&to=` filters the pair; the tags are canonicalized, so the lowercase spelling finds the same rows.
    const listed = await send('/api/v1/glossary?from=EN&to=zh-cn', 'GET', headers);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const body = (await listed.json()) as { data: Array<{ term: string; rule: string }>; meta: { total: number } };
    expect(body.meta.total).toBe(3);
    expect(body.data.map((entry) => [entry.term, entry.rule])).toEqual([
      ['API', 'do-not-translate'],
      ['Cloud', 'forbidden'],
      ['HeoPress', 'prefer'],
    ]);
    expect(((await (await send('/api/v1/glossary?to=de', 'GET', headers)).json()) as { data: unknown[] }).data).toEqual([]);

    // Every change left an audit row of its own, naming the entry it changed.
    const audits = await fixtures
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'glossary.created')));
    expect(audits).toHaveLength(3);
    expect(audits.map((row) => (row.metadata as { id: string }).id)).toEqual(expect.arrayContaining([preferredEntry.id]));

    // Reading is a member's right, changing is not.
    const memberRead = await send('/api/v1/glossary', 'GET', await editor('a'));
    expect(memberRead.status, await memberRead.clone().text()).toBe(200);
    const memberWrite = await send('/api/v1/glossary', 'POST', await editor('a'), { ...ENTRY, term: 'Denied' });
    expect(memberWrite.status).toBe(403);
    const anonymous = await send('/api/v1/glossary', 'GET', { 'x-heopress-site': fx.sites.a });
    expect(anonymous.status).toBe(401);
  });

  it('keeps one site out of another: its rows, its ids and its own duplicate space', async () => {
    const aHeaders = await admin('a');
    const bHeaders = await admin('b');

    // The same pair and term in each site: uniqueness is per site, never global.
    const inA = await send('/api/v1/glossary', 'POST', aHeaders, ENTRY);
    expect(inA.status, await inA.clone().text()).toBe(201);
    const inB = await send('/api/v1/glossary', 'POST', bHeaders, ENTRY);
    expect(inB.status, await inB.clone().text()).toBe(201);
    const bEntry = ((await inB.json()) as { data: { id: string } }).data;

    const aList = (await (await send('/api/v1/glossary', 'GET', aHeaders)).json()) as { data: Array<{ id: string }> };
    expect(aList.data.map((entry) => entry.id)).not.toContain(bEntry.id);
    expect(await storedGlossary(fx.sites.b)).toHaveLength(1);

    // A's administrator can neither change nor delete B's entry by id; B's row keeps its values.
    const viaA = await send(`/api/v1/glossary/${bEntry.id}`, 'PATCH', aHeaders, { translation: '被改了' });
    expect(viaA.status).toBe(404);
    const deleteViaA = await send(`/api/v1/glossary/${bEntry.id}`, 'DELETE', aHeaders);
    expect(deleteViaA.status).toBe(404);
    expect((await storedGlossary(fx.sites.b))[0]).toMatchObject({ id: bEntry.id, term: 'HeoPress', translation: '禾普' });

    // B's own administrator can.
    const own = await send(`/api/v1/glossary/${bEntry.id}`, 'PATCH', bHeaders, { translation: '禾普科技' });
    expect(own.status, await own.clone().text()).toBe(200);
    expect((await storedGlossary(fx.sites.b))[0]).toMatchObject({ translation: '禾普科技' });
  });

  it('refuses a duplicate (site, pair, term) with a 409 naming the existing entry, and the database enforces it', async () => {
    const headers = await admin('a');
    const first = await send('/api/v1/glossary', 'POST', headers, ENTRY);
    const firstEntry = ((await first.json()) as { data: { id: string } }).data;

    const duplicate = await send('/api/v1/glossary', 'POST', headers, { ...ENTRY, translation: '别的译法' });
    expect(duplicate.status, await duplicate.clone().text()).toBe(409);
    const errors = ((await duplicate.json()) as { errors: Array<{ code: string; existingId: string }> }).errors;
    expect(errors[0]).toMatchObject({ code: 'GLOSSARY_DUPLICATE', existingId: firstEntry.id });

    // A different language pair is a different entry.
    expect((await send('/api/v1/glossary', 'POST', headers, { ...ENTRY, targetLang: 'de', translation: 'HeoPress DE' })).status).toBe(201);

    // An update that would collide with another entry is the same 409.
    const second = await send('/api/v1/glossary', 'POST', headers, { ...ENTRY, term: 'Other' });
    const secondEntry = ((await second.json()) as { data: { id: string } }).data;
    const clash = await send(`/api/v1/glossary/${secondEntry.id}`, 'PATCH', headers, { term: 'HeoPress' });
    expect(clash.status, await clash.clone().text()).toBe(409);

    // The unique index is the authority, independent of the route's pre-check.
    let duplicateError: unknown;
    try {
      await fixtures
        .insert(glossary)
        .values({ siteId: fx.sites.a, sourceLang: 'en', targetLang: 'zh-CN', term: 'HeoPress', translation: 'x' });
    } catch (err) {
      duplicateError = err;
    }
    expect(codeOfDb(duplicateError)).toBe('23505');
  });

  it('validates the three rules, the language tags and the length limits before anything is stored', async () => {
    const headers = await admin('a');
    const cases: Array<[string, unknown]> = [
      ['unknown rule', { ...ENTRY, rule: 'sometimes' }],
      ['do-not-translate with a different translation', { ...ENTRY, rule: 'do-not-translate' }],
      ['prefer with the term as its translation', { ...ENTRY, translation: 'HeoPress' }],
      ['forbidden with the term as its translation', { ...ENTRY, translation: 'HeoPress', rule: 'forbidden' }],
      ['malformed source language', { ...ENTRY, sourceLang: 'en_US' }],
      ['unknown target language', { ...ENTRY, targetLang: 'not a tag' }],
      ['the same language on both sides', { ...ENTRY, targetLang: 'en' }],
      ['a term over the limit', { ...ENTRY, term: 'x'.repeat(201) }],
      ['a body field that is not part of an entry', { ...ENTRY, siteId: fx.sites.b }],
    ];
    for (const [name, body] of cases) {
      const response = await send('/api/v1/glossary', 'POST', headers, body);
      expect(response.status, `${name}: ${await response.clone().text()}`).toBe(400);
      expect(((await response.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VALIDATION');
    }
    expect(await storedGlossary(fx.sites.a)).toEqual([]);
  });

  it('merges a patch with the stored entry before validating it', async () => {
    const headers = await admin('a');
    const created = await send('/api/v1/glossary', 'POST', headers, { ...ENTRY, term: 'API', translation: 'API', rule: 'do-not-translate' });
    const entry = ((await created.json()) as { data: { id: string } }).data;

    // Changing only the rule would leave translation === term, which `forbidden` does not allow.
    const invalid = await send(`/api/v1/glossary/${entry.id}`, 'PATCH', headers, { rule: 'forbidden' });
    expect(invalid.status, await invalid.clone().text()).toBe(400);

    const fixed = await send(`/api/v1/glossary/${entry.id}`, 'PATCH', headers, { rule: 'forbidden', translation: '接口' });
    expect(fixed.status, await fixed.clone().text()).toBe(200);
    expect(((await fixed.json()) as { data: { rule: string; translation: string } }).data).toMatchObject({ rule: 'forbidden', translation: '接口' });

    // `note: null` clears the note; an omitted note keeps it.
    const noted = await send(`/api/v1/glossary/${entry.id}`, 'PATCH', headers, { note: 'kept' });
    expect(((await noted.json()) as { data: { note: string } }).data.note).toBe('kept');
    const cleared = await send(`/api/v1/glossary/${entry.id}`, 'PATCH', headers, { note: null });
    expect(((await cleared.json()) as { data: { note: string | null } }).data.note).toBeNull();

    const deleted = await send(`/api/v1/glossary/${entry.id}`, 'DELETE', headers);
    expect(deleted.status, await deleted.clone().text()).toBe(200);
    expect(await storedGlossary(fx.sites.a)).toEqual([]);
    const audits = await fixtures
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'glossary.deleted')));
    expect(audits).toHaveLength(1);
  });

  it('hands the stored rules to the translation pipeline', async () => {
    const headers = await admin('a');
    for (const entry of [
      ENTRY,
      { ...ENTRY, term: 'API', translation: 'API', rule: 'do-not-translate' },
      { ...ENTRY, term: 'Cloud', translation: '云', rule: 'forbidden' },
    ]) {
      expect((await send('/api/v1/glossary', 'POST', headers, entry)).status).toBe(201);
    }

    // `loadGlossary` is what the content pipeline and the gates are fed from: it must carry each rule through unchanged.
    const terms = await loadGlossary(db, fx.sites.a, 'en', 'zh-CN');
    expect(terms).toEqual(
      expect.arrayContaining([
        { term: 'HeoPress', translation: '禾普', rule: 'prefer' },
        { term: 'API', translation: 'API', rule: 'do-not-translate' },
        { term: 'Cloud', translation: '云', rule: 'forbidden' },
      ]),
    );
    // Another site sees none of them.
    expect(await loadGlossary(db, fx.sites.b, 'en', 'zh-CN')).toEqual([]);
  });
});
