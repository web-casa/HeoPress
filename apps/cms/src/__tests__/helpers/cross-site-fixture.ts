/**
 * Cross-site test fixture (HeoPress P04 task 9.3, ADR-0017).
 *
 * Two sites that look the same from the outside: the same collection
 * (`articles`), an item with the same slug and path, the same theme name and
 * a file with the same name. Isolation has to come from the site, never from
 * a name being different. Around them, the principals a site network has:
 *
 *   - `onlyA` / `onlyB` — editors of one site;
 *   - `both`            — editor of A and reader of B (one person, two roles);
 *   - `adminA` / `adminB` — administrators of one site;
 *   - API keys          — A editor, A reader, B editor. The same keys
 *                         authenticate `/api/v1/mcp`, so they double as MCP
 *                         tokens.
 *
 * Users sign in with real session tokens (the same claims `/auth/login`
 * signs, verified by `withAuth`), so a test drives the whole app
 * (`app.request(path, init, env)`) with `fixture.headers(site, principal)`.
 *
 * Later phases reuse it for every new surface: a request with A's principal
 * against B's resources must answer 401/403/404 and change nothing.
 */
import { SignJWT } from 'jose';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  apiKeyRoles,
  apiKeys,
  authSessions,
  collections,
  fields,
  files,
  items,
  permissions,
  policies,
  rolePolicies,
  roles,
  settings,
  sites,
  userSites,
  users,
  type Database,
} from '@heopress/database';
import { createPlaintextToken } from '../../services/api-key-token';
import { TOKEN_AUDIENCE } from '../../services/auth/token-audience';
import { __resetSetupCompleteCache } from '../../middleware/setup-required';
import { createLoginSession } from '../../services/auth/login-sessions';

export const SHARED = {
  collection: 'articles',
  slug: 'hello-world',
  path: '/blog/hello-world',
  theme: 'aurora',
  fileName: 'cover.jpg',
} as const;

type SiteKey = 'a' | 'b';
type UserKey = 'onlyA' | 'onlyB' | 'both' | 'adminA' | 'adminB';
type ApiKeyKey = 'aEditor' | 'aReader' | 'bEditor';

interface FixtureUser {
  id: string;
  email: string;
}

interface FixtureApiKey {
  id: string;
  siteId: string;
  /** Plaintext bearer token (also an MCP token). */
  token: string;
}

export interface CrossSiteFixture {
  sites: Record<SiteKey, string>;
  /** The item with the shared slug and path, per site. */
  items: Record<SiteKey, string>;
  /** The file with the shared name, per site. */
  files: Record<SiteKey, string>;
  users: Record<UserKey, FixtureUser>;
  apiKeys: Record<ApiKeyKey, FixtureApiKey>;
  /**
   * A session token for `user`, signed for `site` (as `/auth/login` would),
   * belonging to the person's login (`sid`). By default one login per person
   * covers all their sites — as a site switch produces; pass `{ login: 'other' }`
   * for a separate login.
   */
  session(user: UserKey, site: SiteKey, opts?: { login?: string }): Promise<string>;
  /** The login session id behind `session(user, …, opts)`. */
  loginOf(user: UserKey, opts?: { login?: string }): Promise<string>;
  /** Request headers addressing `site` with `bearer` (a session token or API key). */
  headers(site: SiteKey, bearer: string): Record<string, string>;
  /** Remove everything the fixture created. */
  teardown(): Promise<void>;
}

export interface CrossSiteFixtureOptions {
  /** Distinguishes this suite's rows (ids, emails); letters, digits and `_`. */
  prefix: string;
  /** The JWT_SECRET the app under test verifies sessions with. */
  jwtSecret: string;
}

type Grant = 'editor' | 'reader' | 'admin';

export async function createCrossSiteFixture(db: Database, options: CrossSiteFixtureOptions): Promise<CrossSiteFixture> {
  const p = options.prefix;
  const siteIds: Record<SiteKey, string> = { a: `site_${p}_a`, b: `site_${p}_b` };
  const userRows: Record<UserKey, FixtureUser> = {
    onlyA: { id: `usr_${p}_only_a`, email: `${p}.only-a@example.test` },
    onlyB: { id: `usr_${p}_only_b`, email: `${p}.only-b@example.test` },
    both: { id: `usr_${p}_both`, email: `${p}.both@example.test` },
    adminA: { id: `usr_${p}_admin_a`, email: `${p}.admin-a@example.test` },
    adminB: { id: `usr_${p}_admin_b`, email: `${p}.admin-b@example.test` },
  };
  const bootstrapId = `usr_${p}_bootstrap`;

  const cleanup = async () => {
    // The cache lives in PostgreSQL (P03) and outlives a deleted site: a site
    // recreated with the same id would otherwise read the previous run's
    // collection ids and permission bundles.
    for (const siteId of Object.values(siteIds)) {
      await db.execute(sql`DELETE FROM lumibase_cache_entries WHERE key LIKE ${`%${siteId}%`}`);
    }
    await db.delete(sites).where(inArray(sites.id, Object.values(siteIds)));
    await db.delete(users).where(inArray(users.id, [...Object.values(userRows).map((u) => u.id), bootstrapId]));
  };
  await cleanup();

  // The admin API needs first-time setup done (a bootstrap user). Create one
  // only when the database has none, and remove only that one.
  const [existingBootstrap] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
  if (!existingBootstrap) {
    await db.insert(users).values({ id: bootstrapId, email: `${p}.bootstrap@example.test`, status: 'active', isBootstrap: true });
  }
  __resetSetupCompleteCache();

  await db.insert(sites).values([
    { id: siteIds.a, name: `${p} A` },
    { id: siteIds.b, name: `${p} B` },
  ]);
  // Both sites use a theme of the same name (themes arrive in P06; the name lives in settings).
  await db.insert(settings).values(Object.values(siteIds).map((siteId) => ({ siteId, key: 'theme', value: { name: SHARED.theme } })));
  await db.insert(users).values(Object.values(userRows).map((u) => ({ ...u, status: 'active' })));

  const roleIds = {} as Record<SiteKey, Record<Grant, string>>;
  const itemIds = {} as Record<SiteKey, string>;
  const fileIds = {} as Record<SiteKey, string>;
  for (const site of ['a', 'b'] as const) {
    const siteId = siteIds[site];
    const [editorRole, readerRole, adminRole] = await db
      .insert(roles)
      .values([
        { siteId, name: 'Editor', adminAccess: false, appAccess: true },
        { siteId, name: 'Reader', adminAccess: false, appAccess: true },
        { siteId, name: 'Administrator', adminAccess: true, appAccess: true },
      ])
      .returning({ id: roles.id });
    roleIds[site] = { editor: editorRole!.id, reader: readerRole!.id, admin: adminRole!.id };
    const [editorPolicy, readerPolicy] = await db
      .insert(policies)
      .values([
        { siteId, name: 'Editor', key: `${p}-${site}-editor`, adminAccess: false, appAccess: true },
        { siteId, name: 'Reader', key: `${p}-${site}-reader`, adminAccess: false, appAccess: true },
      ])
      .returning({ id: policies.id });
    await db.insert(permissions).values([
      ...(['create', 'read', 'update', 'delete'] as const).map((action) => ({
        siteId,
        policyId: editorPolicy!.id,
        collection: SHARED.collection,
        action,
        fields: ['*'],
      })),
      { siteId, policyId: readerPolicy!.id, collection: SHARED.collection, action: 'read', fields: ['*'] },
    ]);
    await db.insert(rolePolicies).values([
      { roleId: editorRole!.id, policyId: editorPolicy!.id },
      { roleId: readerRole!.id, policyId: readerPolicy!.id },
    ]);

    const [coll] = await db
      .insert(collections)
      .values({ siteId, name: SHARED.collection, label: 'Articles' })
      .returning({ id: collections.id });
    await db.insert(fields).values(
      ['title', 'slug', 'path'].map((name) => ({ siteId, collectionId: coll!.id, name, type: 'string', interface: 'input' })),
    );
    const [item] = await db
      .insert(items)
      .values({
        siteId,
        collectionId: coll!.id,
        status: 'draft',
        data: { title: `Hello from ${site.toUpperCase()}`, slug: SHARED.slug, path: SHARED.path },
      })
      .returning({ id: items.id });
    itemIds[site] = item!.id;
    const [file] = await db
      .insert(files)
      .values({ siteId, storage: 'local', filenameDisk: SHARED.fileName, filenameDownload: SHARED.fileName, mime: 'image/jpeg', filesize: 1 })
      .returning({ id: files.id });
    fileIds[site] = file!.id;
  }

  const memberships: Array<{ user: UserKey; site: SiteKey; grant: Grant }> = [
    { user: 'onlyA', site: 'a', grant: 'editor' },
    { user: 'onlyB', site: 'b', grant: 'editor' },
    { user: 'both', site: 'a', grant: 'editor' },
    { user: 'both', site: 'b', grant: 'reader' },
    { user: 'adminA', site: 'a', grant: 'admin' },
    { user: 'adminB', site: 'b', grant: 'admin' },
  ];
  await db.insert(userSites).values(
    memberships.map((m) => ({ userId: userRows[m.user].id, siteId: siteIds[m.site], roleId: roleIds[m.site][m.grant] })),
  );

  const keySpecs: Record<ApiKeyKey, { site: SiteKey; grant: Grant }> = {
    aEditor: { site: 'a', grant: 'editor' },
    aReader: { site: 'a', grant: 'reader' },
    bEditor: { site: 'b', grant: 'editor' },
  };
  const keys = {} as Record<ApiKeyKey, FixtureApiKey>;
  for (const [name, spec] of Object.entries(keySpecs) as Array<[ApiKeyKey, { site: SiteKey; grant: Grant }]>) {
    const token = await createPlaintextToken();
    const siteId = siteIds[spec.site];
    const [row] = await db
      .insert(apiKeys)
      .values({ siteId, name: `${p} ${name}`, prefix: token.prefix, tokenHash: token.tokenHash })
      .returning({ id: apiKeys.id });
    await db.insert(apiKeyRoles).values({ apiKeyId: row!.id, siteId, roleId: roleIds[spec.site][spec.grant] });
    keys[name] = { id: row!.id, siteId, token: token.token };
  }

  const secret = new TextEncoder().encode(options.jwtSecret);
  const roleOf = (user: UserKey, site: SiteKey) => {
    const m = memberships.find((x) => x.user === user && x.site === site);
    return m ? [roleIds[site][m.grant]] : [];
  };

  const logins = new Map<string, string>();
  const loginOf = async (user: UserKey, opts: { login?: string } = {}) => {
    const key = `${user}:${opts.login ?? 'main'}`;
    if (!logins.has(key)) {
      const row = await createLoginSession(db, { userId: userRows[user].id, mfaVerified: false, amr: ['pwd'], source: 'password' });
      // A live login (normally its refresh tokens set this).
      await db.update(authSessions).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(authSessions.id, row.id));
      logins.set(key, row.id);
    }
    return logins.get(key)!;
  };

  return {
    sites: siteIds,
    loginOf,
    items: itemIds,
    files: fileIds,
    users: userRows,
    apiKeys: keys,
    session: async (user, site, opts) =>
      new SignJWT({
        userId: userRows[user].id,
        email: userRows[user].email,
        roles: roleOf(user, site),
        siteId: siteIds[site],
        tokenVersion: 0,
        sid: await loginOf(user, opts),
        authTime: Math.floor(Date.now() / 1000),
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setAudience(TOKEN_AUDIENCE.studio)
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(secret),
    headers: (site, bearer) => ({
      'content-type': 'application/json',
      'x-heopress-site': siteIds[site],
      authorization: `Bearer ${bearer}`,
    }),
    teardown: async () => {
      await cleanup();
      __resetSetupCompleteCache();
    },
  };
}
