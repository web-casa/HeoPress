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
import { eq, inArray, like, sql } from 'drizzle-orm';
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
  const links = await seedLinks();
  writeFileSync(out, JSON.stringify({ sites: SITES, articles, people, password: PASSWORD, links }, null, 2));
}

/**
 * The change-impact site: the bootstrap administrator administers it; an active domain; articles at `/:slug`, published —
 * `impact-source` links to `impact-delete`, `impact-update` and `impact-move`; `impact-dest` is where they may go. The link
 * graph is scanned here, so the scenarios need not wait for the worker.
 */
async function seedLinks() {
  const siteId = LINKS_SITE;
  await db.insert(sites).values({ id: siteId, name: 'Site Links', defaultLanguage: 'en' });
  await upgradeSitePreset(db, siteId);
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
  const [role] = await db.insert(roles).values({ siteId, name: 'Administrator', adminAccess: true, appAccess: true }).returning({ id: roles.id });
  if (admin) await db.insert(userSites).values({ userId: admin.id, siteId, roleId: role!.id });
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
    '<p><a href="/impact-delete/">delete</a> <a href="/impact-update/">update</a> <a href="/impact-move/">move</a> <a href="/impact-unpublish/">unpublish</a></p>',
  );
  await requestLinkScan(db, siteId);
  await processLinkScans(db);
  // AI traffic (HeoPress P07 task 6.2), recorded through the rendering service's own entry: a crawler and a referred visit.
  for (const [kind, agent, operator, purpose, resource, path] of [
    ['crawler', 'gptbot', 'OpenAI', 'training', 'llms', '/llms.txt'],
    ['crawler', 'perplexity-user', 'Perplexity', 'user-fetch', 'page', '/impact-dest/'],
    ['crawler', 'perplexity-user', 'Perplexity', 'user-fetch', 'page', '/impact-dest/'],
    ['referral', 'chatgpt', 'OpenAI', null, 'page', '/impact-dest/'],
  ] as const) {
    await db.execute(sql`SELECT public.lumibase_record_crawl_hit(${LINKS_HOST}, ${kind}, ${agent}, ${operator}, ${purpose}, ${resource}, ${path}, NULL, 200)`);
  }
  return { site: siteId, host: LINKS_HOST, source, ...ids };
}

const [command, out] = process.argv.slice(2);
try {
  if (command === 'reset') await reset();
  else if (command === 'seed' && out) await seed(out);
  else throw new Error('usage: e2e-studio-seed.ts reset | seed <out.json>');
} finally {
  await (db as unknown as { $client?: { end?: () => Promise<void> } }).$client?.end?.();
}
