/**
 * Plugin secrets (HeoPress v1.2, spec extensions/plugin-secrets): the site administrator's API, the encrypted store, the
 * runtime resolver `PluginHost` gives the default sandbox, and the two boundaries that matter — a ciphertext does not
 * open under another plugin or site, and no surface carries the value.
 *
 * The routes run as the application role in the site's scope (HeoPress P14); test data and database checks use the
 * owner's fixtures connection.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { auditLog, extensions, pluginSecrets, scopedDatabase, sites, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import type { AppEnv } from '../env';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { extensionsRouter } from '../routes/extensions';
import { PermissionService } from '../services/permission-service';
import { ExtensionSandbox } from '../extensions/sandbox';
import { PluginHost } from '../extensions/runtime/plugin-host';
import { PluginSecretsService } from '../services/plugin-secrets-service';

const A = 'site_v12_secrets_a';
const B = 'site_v12_secrets_b';
const PLUGIN = 'acme-deepl';
const SECRET = 'deepl_api_key';
const VALUE = 'deepl-key-DO-NOT-LEAK-123456';
const ROTATED = 'deepl-key-ROTATED-654321';
const KEK = Buffer.alloc(32, 7).toString('base64');
const ENV = { HEOPRESS_ENV: 'development', HEOPRESS_VERSION: '1.2.0' } as Record<string, unknown>;

/** A bundle that closes over its sandbox and reports what `ctx.secrets.get` returns for the declared name. */
const PROBE = `export default (ctx) => {
  ctx.extensionPoints.register('translation-services', {
    id: 'probe',
    translate: async (request) => ({ segments: await Promise.all(request.segments.map(async (s) => ({ id: s.id, text: await ctx.secrets.get('${SECRET}') }))) }),
  });
  return {};
}`;
const BUNDLE_URL = `data:text/javascript,${encodeURIComponent(PROBE)}`;
const MANIFEST = {
  translationServices: [{ id: 'probe', displayName: 'Probe', engine: 'probe' }],
  extensionPoints: { 'translation-services': '^1.0.0', context: '^1.0.0' },
};
const CAPABILITIES = ['ext:translation-services', `secrets:${SECRET}`];

describe.skipIf(!hasDbIntegrationUrl)('v1.2 plugin secrets — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  const keys = () => createRuntime({ ...process.env, ENCRYPTION_KEY: KEK, HEOPRESS_ENV: 'development' }).keys;

  beforeAll(async () => {
    db = await connectDbIntegration('v12-plugin-secrets');
    fixtures = await connectDbFixtures('v12-plugin-secrets');
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (!fixtures) return;
    await clean();
  });
  async function clean() {
    await fixtures.delete(auditLog).where(inArray(auditLog.siteId, [A, B]));
    await fixtures.delete(pluginSecrets).where(inArray(pluginSecrets.siteId, [A, B]));
    await fixtures.delete(extensions).where(inArray(extensions.siteId, [A, B]));
    await fixtures.delete(sites).where(inArray(sites.id, [A, B]));
  }
  beforeEach(async () => {
    await clean();
    for (const id of [A, B]) await fixtures.insert(sites).values({ id, name: id });
    // Data URLs are the tests' bundles; production loads only the trusted bundle origins.
    vi.spyOn(ExtensionSandbox.prototype as unknown as { isTrustedBundleUrl(url: string): boolean }, 'isTrustedBundleUrl').mockReturnValue(true);
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({
      collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [],
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  /** An installed, approved, enabled plugin row (the install path itself is covered by the P12 suites). */
  async function install(siteId: string, name = PLUGIN) {
    const [row] = await fixtures
      .insert(extensions)
      .values({
        siteId,
        name,
        key: name.replace(/[^a-z0-9]+/g, '_'),
        version: '1.0.0',
        type: 'module',
        enabled: true,
        bundleUrl: BUNDLE_URL,
        manifest: MANIFEST,
        capabilities: CAPABILITIES,
        requestedCapabilities: CAPABILITIES,
        permissionsStatus: 'approved',
      })
      .returning();
    return row!;
  }

  /** The admin API with the active site, the application-role handle and the runtime keys the real request has. */
  function app(roles: string[] = ['admin'], perms = true, siteId = A) {
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', scopedDatabase(db, { site: siteId }));
      c.set('siteId', siteId);
      c.set('auth', { roles, userId: null, email: 'admin@example.com', raw: {} } as never);
      c.set('runtime', { keys: keys() } as never);
      await next();
    });
    if (!perms) vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(null);
    hono.route('/extensions', extensionsRouter);
    return async (method: string, url: string, body?: unknown) => {
      const res = await hono.request(
        url,
        { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) },
        ENV,
      );
      const text = await res.text();
      return { status: res.status, text, body: text ? (JSON.parse(text) as unknown) : null };
    };
  }

  const secretsUrl = (id: string) => `/extensions/${encodeURIComponent(id)}/secrets`;
  const secretUrl = (id: string, name = SECRET) => `${secretsUrl(id)}/${encodeURIComponent(name)}`;

  it('sets, lists names only, rotates and deletes a secret through the admin API', async () => {
    const row = await install(A);
    const call = app();

    const set = await call('PUT', secretUrl(row.id), { value: VALUE });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ data: { name: SECRET, configured: true, declared: true } });
    expect(set.text).not.toContain(VALUE);

    const listed = await call('GET', secretsUrl(row.id));
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ data: [{ name: SECRET, configured: true, declared: true }] });
    expect(listed.text).not.toContain(VALUE);
    // Not even a fragment of the value.
    for (let i = 0; i + 8 <= VALUE.length; i++) expect(listed.text).not.toContain(VALUE.slice(i, i + 8));

    const [stored] = await fixtures.select().from(pluginSecrets).where(and(eq(pluginSecrets.siteId, A), eq(pluginSecrets.extensionName, PLUGIN)));
    expect(stored).toMatchObject({ name: SECRET });
    expect(stored!.secretCiphertext).not.toContain(VALUE);
    expect(stored!.setByUserId).toBeNull(); // the Hono auth stand-in has no database user row

    const rotated = await call('PUT', secretUrl(row.id), { value: ROTATED });
    expect(rotated.status).toBe(200);
    expect(rotated.text).not.toContain(ROTATED);
    const rows = await fixtures.select().from(pluginSecrets).where(eq(pluginSecrets.siteId, A));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.secretCiphertext).not.toBe(stored!.secretCiphertext);
    expect(await new PluginSecretsService({ db, siteId: A, plugin: PLUGIN, keys: keys() }).resolve(SECRET)).toBe(ROTATED);

    const deleted = await call('DELETE', secretUrl(row.id));
    expect(deleted.status).toBe(200);
    expect(deleted.body).toEqual({ data: null });
    expect(await fixtures.select().from(pluginSecrets).where(eq(pluginSecrets.siteId, A))).toEqual([]);

    const after = await call('GET', secretsUrl(row.id));
    expect(after.body).toEqual({ data: [{ name: SECRET, configured: false, declared: true }] });
    expect((await call('DELETE', secretUrl(row.id))).status).toBe(404);
  });

  it('audits the name and the plugin, never the value', async () => {
    const row = await install(A);
    const call = app();
    await call('PUT', secretUrl(row.id), { value: VALUE });
    await call('DELETE', secretUrl(row.id));

    const audit = await fixtures.select().from(auditLog).where(and(eq(auditLog.siteId, A), inArray(auditLog.event, ['plugin_secret_set', 'plugin_secret_deleted'])));
    expect(audit.map((a) => a.event).sort()).toEqual(['plugin_secret_deleted', 'plugin_secret_set']);
    for (const entry of audit) {
      expect(entry.metadata).toEqual({ siteId: A, extensionName: PLUGIN, secretName: SECRET });
      expect(JSON.stringify(entry.metadata)).not.toContain(VALUE);
    }
  });

  it('the default PluginHost sandbox resolves the configured value and a typed null when it is missing', async () => {
    const row = await install(A);
    await new PluginSecretsService({ db, siteId: A, plugin: PLUGIN, keys: keys() }).set(SECRET, VALUE, [SECRET]);
    const host = new PluginHost({ db, env: ENV, keys: keys() });

    const loaded = await host.load(row);
    expect(loaded).not.toBeNull();
    const service = loaded!.translationServices.find((s) => s.id === 'probe');
    expect(service).toBeDefined();
    const request = { siteId: A, sourceLocale: 'en', targetLocale: 'de', segments: [{ id: 's1', text: 'hello' }], glossary: [], memory: [] };
    const out = (await service!.translate(request)) as { segments: Array<{ id: string; text: unknown }> };
    expect(out.segments).toEqual([{ id: 's1', text: VALUE }]);

    // Another site's install of the same plugin has no value: the same call gets `null`, not the other site's secret.
    const other = await install(B, PLUGIN);
    host.clear();
    const otherLoaded = await new PluginHost({ db, env: ENV, keys: keys() }).load(other);
    const otherService = otherLoaded!.translationServices.find((s) => s.id === 'probe')!;
    const otherOut = (await otherService.translate({ ...request, siteId: B })) as { segments: Array<{ id: string; text: unknown }> };
    expect(otherOut.segments).toEqual([{ id: 's1', text: null }]);
  });

  it('a ciphertext moved to another site or plugin does not decrypt (AAD binds all three parts)', async () => {
    const row = await install(A);
    await new PluginSecretsService({ db, siteId: A, plugin: PLUGIN, keys: keys() }).set(SECRET, VALUE, [SECRET]);
    const [stored] = await fixtures.select().from(pluginSecrets).where(eq(pluginSecrets.siteId, A));

    // Same envelope, another plugin name on the same site.
    await fixtures.insert(extensions).values({
      siteId: A, name: 'acme-other', key: 'acme_other', version: '1.0.0', type: 'module', enabled: true,
      bundleUrl: BUNDLE_URL, manifest: MANIFEST, capabilities: ['ext:translation-services'], requestedCapabilities: ['ext:translation-services'], permissionsStatus: 'approved',
    });
    await fixtures.insert(pluginSecrets).values({ ...stored!, extensionName: 'acme-other' });
    await expect(
      new PluginSecretsService({ db, siteId: A, plugin: 'acme-other', keys: keys() }).resolve(SECRET),
    ).rejects.toThrow();

    // Same envelope, same plugin name, another site.
    await fixtures.insert(pluginSecrets).values({ ...stored!, siteId: B });
    await expect(new PluginSecretsService({ db, siteId: B, plugin: PLUGIN, keys: keys() }).resolve(SECRET)).rejects.toThrow();

    // The original row still opens for its own site and plugin.
    expect(await new PluginSecretsService({ db, siteId: A, plugin: PLUGIN, keys: keys() }).resolve(SECRET)).toBe(VALUE);
  });

  it('refuses a non-admin and a member without the extensions permission', async () => {
    const row = await install(A);
    const member = app(['editor']);
    expect((await member('GET', secretsUrl(row.id))).status).toBe(403);
    expect((await member('PUT', secretUrl(row.id), { value: VALUE })).status).toBe(403);
    expect((await member('DELETE', secretUrl(row.id))).status).toBe(403);
    expect(await fixtures.select().from(pluginSecrets).where(eq(pluginSecrets.siteId, A))).toEqual([]);

    const noPermission = app(['admin'], false);
    expect((await noPermission('GET', secretsUrl(row.id))).status).toBe(403);
    expect((await noPermission('PUT', secretUrl(row.id), { value: VALUE })).status).toBe(403);
    expect(await fixtures.select().from(pluginSecrets).where(eq(pluginSecrets.siteId, A))).toEqual([]);
  });

  it('answers 404 for another site’s extension and validates the name and the value', async () => {
    const row = await install(A);
    const otherSite = app(['admin'], true, B);
    expect((await otherSite('GET', secretsUrl(row.id))).status).toBe(404);
    expect((await otherSite('PUT', secretUrl(row.id), { value: VALUE })).status).toBe(404);

    const call = app();
    expect((await call('PUT', secretUrl(row.id, 'bad name'), { value: VALUE })).body).toMatchObject({ errors: [{ code: 'INVALID_SECRET_NAME' }] });
    expect((await call('PUT', secretUrl(row.id), { value: '   ' })).body).toMatchObject({ errors: [{ code: 'INVALID_SECRET' }] });
    expect((await call('PUT', secretUrl(row.id), {})).body).toMatchObject({ errors: [{ code: 'INVALID_SECRET' }] });
    expect(await fixtures.select().from(pluginSecrets).where(eq(pluginSecrets.siteId, A))).toEqual([]);
  });

  it('lists a stored name the manifest no longer declares, so it can be removed', async () => {
    const row = await install(A);
    await new PluginSecretsService({ db, siteId: A, plugin: PLUGIN, keys: keys() }).set('old_key', VALUE, ['old_key']);
    const listed = await app()('GET', secretsUrl(row.id));
    expect(listed.body).toEqual({ data: [{ name: SECRET, configured: false, declared: true }, { name: 'old_key', configured: true, declared: false }] });
    expect(listed.text).not.toContain(VALUE);
  });
});
