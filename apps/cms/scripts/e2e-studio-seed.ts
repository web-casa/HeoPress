/**
 * Seed data for the Studio Playwright scenarios (HeoPress P04 task 9.4).
 *
 *   tsx scripts/e2e-studio-seed.ts reset         # forget first-time setup and the e2e rows
 *   tsx scripts/e2e-studio-seed.ts seed <out>    # sites A and B, people, an article each
 *
 * People: `editor` and `colleague` write on A only; `traveller` writes on
 * both A and B (site switching, task 9.10).
 *
 * `reset` runs before the scenarios call `POST /api/v1/setup/complete`
 * against the built server (the real first-run path); `seed` runs after it
 * and writes ids and credentials to `<out>` (JSON) for the scenarios.
 *
 * Only for a disposable database: `reset` deletes the bootstrap user and the
 * setup state. It refuses to run unless HEOPRESS_E2E_DISPOSABLE_DB=true.
 */
import { writeFileSync } from 'node:fs';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
  collections,
  createDb,
  fields,
  items,
  permissions,
  policies,
  rolePolicies,
  roles,
  siteContentSettings,
  siteDomains,
  sites,
  systemState,
  userSites,
  users,
} from '@heopress/database';
import { hashPassword } from '../src/services/auth/password';
import { ItemService } from '../src/services/item-service';
import { ContentSettingsService } from '../src/services/site-network/content-settings-service';
import { processLinkScans, requestLinkScan } from '../src/services/site-network/link-graph';
import { upgradeSitePreset } from '../src/services/site-network/preset-installer';
import { rebuildSiteProjection } from '../src/services/site-network/public-projection';
import { runSiteAudit } from '../src/services/site-network/site-audit';
import { EditorialService } from '../src/services/editorial-service';
import { createHash } from 'node:crypto';
import { AutonomyService } from '../src/services/autonomy-service';
import { FlowDraftService } from '../src/services/flow-drafts/flow-draft-service';
import { operationIdFor, registerSourceDocument } from '../src/services/ingest/source-documents';
import { IngestSourceService } from '../src/services/ingest/source-service';
import type { ChatCallInput, ChatCallResult } from '../src/services/llm/gateway';
import { ContentPipeline } from '../src/services/pipeline/content-pipeline';

const SITES = { a: 'e2e_site_a', b: 'e2e_site_b' } as const;
/** A site with published, linked pages and a domain (the change-impact scenarios, HeoPress P07 task 5.5). */
const LINKS_SITE = 'e2e_site_links';
const LINKS_HOST = 'links.e2e.example.test';
const EMAIL_DOMAIN = 'e2e.example.test';
const PASSWORD = 'E2e-Studio-Password-1!';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (process.env.HEOPRESS_E2E_DISPOSABLE_DB !== 'true') {
  throw new Error('Refusing to touch the database: set HEOPRESS_E2E_DISPOSABLE_DB=true for a disposable one.');
}
const db = createDb(url);

async function reset(): Promise<void> {
  await db.execute(sql`DELETE FROM lumibase_cache_entries`);
  await db.delete(sites).where(inArray(sites.id, [...Object.values(SITES), LINKS_SITE, '__default__']));
  await db.delete(users).where(like(users.email, `%@${EMAIL_DOMAIN}`));
  await db.delete(users).where(eq(users.isBootstrap, true));
  await db.delete(systemState);
}

async function seed(out: string): Promise<void> {
  await db.insert(sites).values([
    { id: SITES.a, name: 'Site A' },
    { id: SITES.b, name: 'Site B' },
  ]);
  const passwordHash = await hashPassword(PASSWORD);
  const people = {
    editor: { id: 'e2e_usr_editor', email: `editor@${EMAIL_DOMAIN}` },
    colleague: { id: 'e2e_usr_colleague', email: `colleague@${EMAIL_DOMAIN}` },
    traveller: { id: 'e2e_usr_traveller', email: `traveller@${EMAIL_DOMAIN}` },
  };
  await db.insert(users).values(Object.values(people).map((p) => ({ ...p, passwordHash, status: 'active' })));

  const articles: Record<string, string> = {};
  for (const [key, siteId] of Object.entries(SITES)) {
    // A restricted role: may read and update articles (no publish rule, no admin).
    const [role] = await db.insert(roles).values({ siteId, name: 'Writer', adminAccess: false, appAccess: true }).returning({ id: roles.id });
    const [policy] = await db
      .insert(policies)
      .values({ siteId, name: 'Writer', key: `e2e-writer-${key}`, adminAccess: false, appAccess: true })
      .returning({ id: policies.id });
    await db.insert(permissions).values([
      ...(['read', 'update'] as const).map((action) => ({ siteId, policyId: policy!.id, collection: 'articles', action, fields: ['*'] })),
      // Studio reads the collection's fields to render the editor.
      { siteId, policyId: policy!.id, collection: 'schema', action: 'schema:read', fields: ['*'] },
    ]);
    await db.insert(rolePolicies).values({ roleId: role!.id, policyId: policy!.id });
    const [coll] = await db.insert(collections).values({ siteId, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
    await db.insert(fields).values({ siteId, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' });
    const [item] = await db
      .insert(items)
      .values({ siteId, collectionId: coll!.id, status: 'draft', data: { title: `Draft on ${key.toUpperCase()}` } })
      .returning({ id: items.id });
    articles[key] = item!.id;
    // Editor and colleague write on A only; the traveller on both.
    const members = key === 'a' ? Object.values(people) : [people.traveller];
    await db.insert(userSites).values(members.map((p) => ({ userId: p.id, siteId, roleId: role!.id })));
  }
  const links = await seedLinks(people.colleague.id, people.editor.id);
  await seedConsumer(LINKS_SITE);
  // Batch plans (HeoPress P10 task 3.2): a person who administers the links site and enrolls an authenticator in the
  // solo-mode scenario — nobody else signs in as them.
  const planner = { id: 'e2e_usr_planner', email: `planner@${EMAIL_DOMAIN}` };
  await db.insert(users).values({ ...planner, passwordHash, status: 'active' });
  const [linksAdmin] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, LINKS_SITE), eq(roles.name, 'Administrator'))).limit(1);
  await db.insert(userSites).values({ userId: planner.id, siteId: LINKS_SITE, roleId: linksAdmin!.id });
  writeFileSync(out, JSON.stringify({ sites: SITES, articles, people, password: PASSWORD, links, plans: { planner } }, null, 2));
}

/**
 * An event consumer for the operations screen (HeoPress P11 task 1.1): the links site's `e2e-replay`, not run by the worker —
 * its first event dead-lettered, its position after the second, a third waiting for 20 minutes (over the threshold).
 */
async function seedConsumer(siteId: string) {
  const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  await db.transaction(async (tx) => {
    for (const [id, min] of [['e2e_ev_dead', 40], ['e2e_ev_done', 30], ['e2e_ev_waiting', 20]] as const) {
      await tx.execute(sql`INSERT INTO lumibase_cdc_change_events (id, site_id, collection, item_id, operation, actor_type, source, occurred_at)
                           VALUES (${id}, ${siteId}, 'articles', ${`item_${id}`}, 'update', 'system', 'system', ${ago(min)}::timestamptz)`);
    }
  });
  await db.execute(sql`
    INSERT INTO lumibase_event_consumers (name, site_id, cursor_txid, cursor_seq)
    SELECT 'e2e-replay', ${siteId}, txid, seq FROM lumibase_cdc_change_events WHERE id = 'e2e_ev_done'`);
  await db.execute(sql`
    INSERT INTO lumibase_event_consumer_failures (consumer, event_id, state, attempts, last_error)
    VALUES ('e2e-replay', 'e2e_ev_dead', 'dead', 5, 'downstream refused the request')`);
  await db.execute(sql`INSERT INTO lumibase_event_consumer_processed (consumer, event_id) VALUES ('e2e-replay', 'e2e_ev_done')`);
}

/**
 * The change-impact site: the bootstrap administrator administers it; an active domain; articles at `/:slug`, published —
 * `impact-source` links to `impact-delete`, `impact-update` and `impact-move`; `impact-dest` is where they may go. The link
 * graph is scanned here, so the scenarios need not wait for the worker.
 */
async function seedLinks(coEditor: string, member: string) {
  const siteId = LINKS_SITE;
  await db.insert(sites).values({ id: siteId, name: 'Site Links', defaultLanguage: 'en' });
  await upgradeSitePreset(db, siteId);
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
  const [role] = await db.insert(roles).values({ siteId, name: 'Administrator', adminAccess: true, appAccess: true }).returning({ id: roles.id });
  if (admin) await db.insert(userSites).values({ userId: admin.id, siteId, roleId: role!.id });
  // The article editor's presence scenario (task 6.3) needs a second person here.
  await db.insert(userSites).values({ userId: coEditor, siteId, roleId: role!.id });
  // The SEO / GEO module's read-only scenario (task 8.2): a member without site administration.
  const [memberRole] = await db.insert(roles).values({ siteId, name: 'Member', adminAccess: false, appAccess: true }).returning({ id: roles.id });
  await db.insert(userSites).values({ userId: member, siteId, roleId: memberRole!.id });
  await db.insert(siteDomains).values({ siteId, hostname: LINKS_HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
  const [cs] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
  await new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
    availableLocales: cs!.availableLocales, timezone: cs!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
    localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { ...cs!.permalinks, articles: '/:slug' },
    allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: cs!.version,
  } as never);
  await rebuildSiteProjection(db, siteId);
  const service = new ItemService({ db, siteId });
  const make = async (slug: string, body: string) =>
    ((await service.create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', body }, status: 'published' })) as { id: string }).id;
  const ids = {
    dest: await make('impact-dest', '<p>Where links may go.</p>'),
    delete: await make('impact-delete', '<p>To be deleted.</p>'),
    update: await make('impact-update', '<p>To be replaced.</p>'),
    move: await make('impact-move', '<p>To be moved.</p>'),
    unpublish: await make('impact-unpublish', '<p>To be unpublished.</p>'),
  };
  const source = await make(
    'impact-source',
    '<p><a href="/impact-delete/">delete</a> <a href="/impact-update/">update</a> <a href="/impact-move/">move</a> <a href="/impact-unpublish/">unpublish</a> <a href="/impact-gone/">gone</a></p>',
  );
  await requestLinkScan(db, siteId);
  await processLinkScans(db);
  // The review workspace (HeoPress P07a tasks 5.3–5.6): two drafts waiting for review, submitted by an editor.
  await db.update(collections).set({ meta: sql`coalesce(${collections.meta}, '{}'::jsonb) || '{"editorialWorkflow": true}'::jsonb` }).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
  const reviewer = new EditorialService({ db, siteId, userId: admin?.id ?? null });
  const reviews: string[] = [];
  for (const slug of ['review-one', 'review-two', 'review-three']) {
    const id = ((await service.create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', body: '<p>Waiting for a decision.</p>' } })) as { id: string }).id;
    await reviewer.submitReview('articles', id, {});
    reviews.push(id);
  }
  // The article editor (HeoPress P07a tasks 6.1–6.4): a draft with an outline and a short description.
  const editor = ((await service.create('articles', {
    data: { title: 'Title editor-one', slug: 'editor-one', locale: 'en', seo_description: 'Too short.', body: '<h2>First part</h2><p>One.</p><h3>A detail</h3><p>Two.</p><h2>Second part</h2><p>Three.</p>' },
  })) as { id: string }).id;
  // The site audit (HeoPress P07a task 10.4): run here so the audit workspace has a broken link to triage at once.
  await runSiteAudit(db, siteId);
  // AI traffic (HeoPress P07 task 6.2), recorded through the rendering service's own entry: a crawler and a referred visit.
  for (const [kind, agent, operator, purpose, resource, path] of [
    ['crawler', 'gptbot', 'OpenAI', 'training', 'llms', '/llms.txt'],
    ['crawler', 'perplexity-user', 'Perplexity', 'user-fetch', 'page', '/impact-dest/'],
    ['crawler', 'perplexity-user', 'Perplexity', 'user-fetch', 'page', '/impact-dest/'],
    ['referral', 'chatgpt', 'OpenAI', null, 'page', '/impact-dest/'],
  ] as const) {
    await db.execute(sql`SELECT public.lumibase_record_crawl_hit(${LINKS_HOST}, ${kind}, ${agent}, ${operator}, ${purpose}, ${resource}, ${path}, NULL, 200)`);
  }
  const ai = await seedAi(siteId);
  return { site: siteId, host: LINKS_HOST, source, ...ids, reviews, editor, ai };
}

/**
 * The AI pipeline screens (HeoPress P09 tasks 2.3, 4.1, 5.1): two licensed source documents translated by a stand-in
 * model, gated and proposed — no publish tier, so both wait in the review queue; the first source's terms then narrow,
 * so its gate needs a person. A flow drafted by an agent waits for approval. Returns the sample document id.
 */
async function seedAi(siteId: string) {
  const day = 86_400_000;
  const objects = new Map<string, Buffer>();
  const storage = {
    put: async (key: string, data: ReadableStream | Buffer) => void objects.set(key, Buffer.isBuffer(data) ? data : Buffer.from(await new Response(data).arrayBuffer())),
    get: async (key: string) => (objects.has(key) ? { key, body: objects.get(key)!, size: objects.get(key)!.byteLength } : null),
    delete: async (key: string) => void objects.delete(key),
    list: async (prefix = '') => ({ keys: [...objects.keys()].filter((k) => k.startsWith(prefix)) }),
  };
  const gateway = {
    chat: async (req: ChatCallInput): Promise<ChatCallResult> => {
      const payload = JSON.parse(String(req.messages[0]!.content)) as { segments: Array<{ id: string; text: string }> };
      const content = JSON.stringify({ segments: payload.segments.map((x) => ({ id: x.id, text: x.text.replace(/>/, '>EN: ') })) });
      return { response: { content, toolCalls: [], usage: { inputTokens: 10, outputTokens: 5 } }, provider: 'mock', model: 'mock-1', callId: `seed_${Math.random()}`, attemptIds: [] };
    },
  };
  const sources = new IngestSourceService({ db, siteId, actor: { isAdmin: true, userId: null } });
  const terms = { licenceStatus: 'licensed', usageMode: 'licensed_derivative', commercialUse: true, trustLevel: 'high', reviewDueAt: new Date(Date.now() + 300 * day).toISOString() };
  const docs: Array<{ src: string; doc: string }> = [];
  for (const [n, text] of [
    ['one', 'Der Hafen von Example Town meldete eine Rekordsaison für Fähren und Fischerboote mit so vielen Fahrgästen wie nie zuvor.'],
    ['two', 'Fishing crews said the cold spring delayed the first catches, but prices recovered by early summer across the coast.'],
  ] as const) {
    const src = await sources.create({ name: `Wire ${n}`, type: 'url', url: `https://wire-${n}.example.com/`, scheduleTimes: ['08:00'], timezone: 'UTC' });
    await sources.reviseLicence(src.id, { evidence: 'Signed agreement EX-1', ...terms } as never);
    const url = `https://wire.example.com/e2e-harbour-${n}`;
    const body = `<p>${text}</p>`;
    const res = await registerSourceDocument({ db, storage } as never, {
      siteId,
      sourceId: src.id,
      run: null,
      operationId: operationIdFor(src.id, 'manual', url),
      url,
      page: { url, finalUrl: url, status: 200, contentType: 'text/html', headers: new Headers(), body: Buffer.from(`<html><body>${body}</body></html>`), durationMs: 3 },
      extracted: { title: `Hafen ${n}`, author: null, publishedAt: new Date(Date.now() - 2 * day), language: 'de', canonicalCandidate: null, bodyHtml: body, bodyText: text, contentHash: createHash('sha256').update(body).digest('hex'), hiddenContent: [], linkDensity: 0, ruleVersion: 'e2e@1' },
      startedAt: new Date(),
    } as never);
    docs.push({ src: src.id, doc: res.documentId });
  }
  const pipeline = new ContentPipeline({ db, siteId, gateway, urlChecker: async () => ({ ok: true, status: 200 }) });
  const service = new ItemService({ db, siteId });
  const productions: string[] = [];
  for (const [i, d] of docs.entries()) {
    const res = await pipeline.produce({ mode: 'translate', sourceDocumentIds: [d.doc], targetLocale: 'en', sourceLocale: 'de' });
    if (res.status !== 'drafted' || !res.itemId) throw new Error(`AI seed: production ${res.status} ${res.reason ?? ''}`);
    const [row] = await db.select().from(items).where(eq(items.id, res.itemId));
    await service.patch('articles', res.itemId, { data: { title: `AI harbour ${i + 1}`, slug: `ai-harbour-${i + 1}`, seo_title: 'Harbour season report 2026', seo_description: 'Ferry and fishing figures from the Example Town harbour this season, with the record passenger numbers explained.' }, expectedVersion: row!.version });
    productions.push(res.productionId);
  }
  await sources.reviseLicence(docs[0]!.src, { evidence: 'Leads only from now on', ...terms, usageMode: 'discovery_only' } as never);
  await new AutonomyService({ db, siteId }).setGrant('content-pipeline', 'publish', 2);
  for (const p of productions) {
    await pipeline.runGate(p);
    await pipeline.proposePublish(p);
  }
  await new FlowDraftService({ db, siteId }).submit(
    { name: 'Agent nightly log', description: 'Drafted by an agent', triggerType: 'manual', graph: { entry: 'a', nodes: [{ id: 'a', key: 'log', options: { message: 'hello' } }] } },
    { userId: null, apiKeyId: null },
    'agent',
  );
  return { sampleDocument: docs[1]!.doc, reviewTitles: ['AI harbour 1', 'AI harbour 2'] };
}

const [command, out] = process.argv.slice(2);
try {
  if (command === 'reset') await reset();
  else if (command === 'seed' && out) await seed(out);
  else throw new Error('usage: e2e-studio-seed.ts reset | seed <out.json>');
} finally {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}
