/**
 * Measure the cross-site summary on 100 sites (HeoPress P07a task 3.4; spec studio/network-summary "100 个站点").
 *
 *   DATABASE_URL=<owner, disposable> HEOPRESS_BENCH_DISPOSABLE_DB=true npx tsx scripts/bench-network-summary.ts
 *
 * Creates 100 sites (`bench_ns_000`…), each with an article collection of 200 items (150 published), 5 pending
 * reviews, audit issues and 30 days of AI traffic; the bootstrap administrator reads the summary 10 times. Prints
 * the server time per run and how many sites came back unavailable, then removes what it made.
 */
import { inArray, like, sql } from 'drizzle-orm';
import { auditIssues, auditSites, collections, contentReviews, crawlDaily, createDb, items, sites, users } from '@heopress/database';
import { runSiteTransaction } from '../src/services/rls-transaction';
import { networkSummary } from '../src/services/studio/network-summary';

const SITES = 100;
const RUNS = 10;
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
if (process.env.HEOPRESS_BENCH_DISPOSABLE_DB !== 'true') throw new Error('Set HEOPRESS_BENCH_DISPOSABLE_DB=true: this writes and deletes 100 sites.');
const db = createDb(url);
const ids = Array.from({ length: SITES }, (_, i) => `bench_ns_${String(i).padStart(3, '0')}`);

async function seed(): Promise<string> {
  await db.delete(sites).where(like(sites.id, 'bench_ns_%'));
  await db.delete(users).where(like(users.email, 'bench-ns%'));
  const [existing] = await db.select({ id: users.id, email: users.email }).from(users).where(sql`${users.isBootstrap}`).limit(1);
  const admin = existing ?? (await db.insert(users).values({ id: 'bench_ns_admin', email: 'bench-ns@example.test', status: 'active', isBootstrap: true }).returning({ id: users.id, email: users.email }))[0]!;
  await db.insert(sites).values(ids.map((id) => ({ id, name: `Bench ${id}` })));
  const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);
  for (const siteId of ids) {
    await runSiteTransaction(db, siteId, async (tx) => {
      const [coll] = await tx.insert(collections).values({ siteId, name: 'articles', label: 'Articles', meta: { preset: { key: 'articles' } } }).returning({ id: collections.id });
      const rows = await tx
        .insert(items)
        .values(Array.from({ length: 200 }, (_, i) => ({ siteId, collectionId: coll!.id, status: i < 150 ? 'published' : 'draft', data: { title: `Item ${i}` } })))
        .returning({ id: items.id });
      await tx.insert(contentReviews).values(rows.slice(150, 155).map((r) => ({ siteId, itemId: r.id, status: 'pending' })));
      await tx.insert(auditSites).values({ siteId, lastRunAt: new Date(), status: 'done' });
      await tx.insert(auditIssues).values(
        Array.from({ length: 12 }, (_, i) => ({
          siteId,
          rule: 'missing-description',
          severity: i < 3 ? 'error' : 'warning',
          fingerprint: `bench/${i}`,
          itemIds: [rows[i]!.id],
          evidence: {},
        })) as never,
      );
      await tx.insert(crawlDaily).values(
        Array.from({ length: 30 }, (_, back) => [
          { siteId, day: day(back), kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path: '/a/', hits: 5 },
          { siteId, day: day(back), kind: 'referral', agent: 'chatgpt', operator: 'OpenAI', purpose: '', resource: 'page', path: '/a/', hits: 2 },
        ]).flat(),
      );
    });
  }
  return admin.id + '|' + admin.email;
}

async function main(): Promise<void> {
  const seededAt = Date.now();
  const [adminId, adminEmail] = (await seed()).split('|') as [string, string];
  console.log(`seeded ${SITES} sites in ${Date.now() - seededAt} ms`);
  const principal = { user: { id: adminId, email: adminEmail, isBootstrap: true }, mfaVerified: true, currentSiteId: ids[0]!, req: { ip: null, headers: {} } };
  const runs: Array<{ ms: number; sites: number; unavailable: number }> = [];
  for (let i = 0; i < RUNS; i += 1) {
    const r = await networkSummary(db, principal);
    const mine = r.sites.filter((s) => s.id.startsWith('bench_ns_'));
    runs.push({ ms: r.elapsedMs, sites: mine.length, unavailable: mine.filter((s) => s.availability === 'unavailable').length });
  }
  const sorted = runs.map((r) => r.ms).sort((a, b) => a - b);
  console.log(JSON.stringify({ runs, p50: sorted[Math.floor(RUNS / 2)], max: sorted.at(-1) }, null, 2));
  await db.delete(sites).where(inArray(sites.id, ids));
  await db.delete(users).where(like(users.email, 'bench-ns%'));
  process.exit(0);
}

void main();
