/**
 * Plugin permissions (HeoPress P12 tasks 1.2–1.5, spec extensions/permissions): approval of requested
 * capabilities on install, the permission diff of an upgrade, signed-only installs outside development mode, the
 * migration of installed plugins, and the marketplace's manifest + build-provenance requirements.
 */
import { generateKeyPairSync, sign as nodeSign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { extensions, publisherKeys, sites, type Database } from '@heopress/database';
import { canonicalProvenance, migrateLegacyCapabilities, sha256Hex } from '@heopress/contracts/extensions';
import type { AppEnv } from '../env';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { extensionsRouter } from '../routes/extensions';
import { marketplaceRouter } from '../routes/marketplace';
import { PermissionService } from '../services/permission-service';
import { buildSandboxVerifyOptions } from '../services/extension-verifier';

const SITE = 'p12-perm-a';
const KEYS = ['p12-key-good', 'p12-key-revoked'];
const PROD = { HEOPRESS_ENV: 'production', HEOPRESS_VERSION: '1.2.0' };
const DEV = { HEOPRESS_ENV: 'development', HEOPRESS_VERSION: '1.2.0' };
const REPO = 'https://git.example.com/acme/glossary';

type Body = { data?: Record<string, unknown> & { status?: string; extension?: Record<string, unknown> }; errors?: Array<{ code: string; details?: Record<string, unknown> }> };

function keypair(): { pem: string; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), key: privateKey };
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const signBytes = (bytes: Uint8Array, key: KeyObject) => b64(new Uint8Array(nodeSign(null, bytes, key)));

/** An inline bundle and its signature fields. */
async function bundle(source: string, key: KeyObject, keyId: string) {
  const bytes = new TextEncoder().encode(source);
  return {
    bundleUrl: `data:text/javascript,${encodeURIComponent(source)}`,
    bundleSha256: await sha256Hex(bytes),
    signature: signBytes(bytes, key),
    publisherKeyId: keyId,
    signatureAlg: 'ed25519' as const,
  };
}

describe.skipIf(!hasDbIntegrationUrl)('P12 plugin permissions — DB integration', () => {
  let db: Database;
  const good = keypair();
  const revoked = keypair();
  const stranger = keypair();

  beforeAll(async () => {
    db = await connectDbIntegration('p12-permissions');
  });
  async function clean() {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.delete(extensions).where(sql`${extensions.siteId} IS NULL AND ${extensions.marketplaceSlug} LIKE 'p12-%'`);
    await db.delete(publisherKeys).where(inArray(publisherKeys.keyId, KEYS));
  }
  beforeEach(async () => {
    await clean();
    await db.insert(sites).values({ id: SITE, name: 'P12 A' });
    await db.insert(publisherKeys).values([
      { keyId: 'p12-key-good', publicKeyPem: good.pem, publisher: 'Acme', repository: REPO },
      { keyId: 'p12-key-revoked', publicKeyPem: revoked.pem, publisher: 'Gone', revoked: true },
    ]);
    vi.spyOn(PermissionService.prototype, 'canAccess').mockImplementation(async (collection, action) => ({
      collection, action, rule: null, fields: ['*'], presets: {}, validation: {}, sources: [],
    }));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (db) await clean();
  });

  function app(env: Record<string, string>) {
    const hono = new Hono<AppEnv>();
    hono.use('*', async (c, next) => {
      c.set('db', db);
      c.set('siteId', SITE);
      c.set('auth', { roles: ['admin'], raw: {} } as never);
      c.set('runtime', { cache: undefined } as never);
      await next();
    });
    hono.route('/extensions', extensionsRouter);
    hono.route('/marketplace', marketplaceRouter);
    return async (method: string, url: string, body?: unknown) => {
      const res = await hono.request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
      return { status: res.status, body: (await res.json()) as Body };
    };
  }

  const plugin = { name: 'acme-glossary', version: '1.0.0', type: 'hook' as const, capabilities: ['items:read:posts', 'ext:events'], manifest: { outboundHosts: ['api.example.com'], heopress: '^1.0.0' } };
  const requested = ['items:read:posts', 'http:fetch:api.example.com', 'ext:events'];

  describe('install and upgrade approval (task 1.2)', () => {
    it('install shows every requested capability and needs the admin to approve all of them', async () => {
      const call = app(PROD);
      const signed = await bundle('export default {};', good.key, 'p12-key-good');
      const pending = await call('POST', '/extensions', { ...plugin, ...signed });
      expect(pending.status).toBe(409);
      expect(pending.body.errors![0]).toMatchObject({ code: 'PERMISSION_APPROVAL_REQUIRED' });
      expect([...(pending.body.errors![0]!.details!.requested as string[])].sort()).toEqual([...requested].sort());
      const partial = await call('POST', '/extensions', { ...plugin, ...signed, approvedCapabilities: ['items:read:posts'] });
      expect(partial.status).toBe(409);
      expect(await db.select().from(extensions).where(eq(extensions.siteId, SITE))).toEqual([]);

      const ok = await call('POST', '/extensions', { ...plugin, ...signed, approvedCapabilities: requested });
      expect(ok.status).toBe(200);
      expect([...(ok.body.data!.capabilities as string[])].sort()).toEqual([...requested].sort());
      expect(ok.body.data).toMatchObject({ permissionsStatus: 'approved', verifiedAt: expect.any(String) });
    });

    it('an upgrade adding an outbound host waits for approval; the old version keeps running', async () => {
      const call = app(DEV);
      const installed = await call('POST', '/extensions', { ...plugin, bundleUrl: 'https://example.com/v1.js', approvedCapabilities: requested });
      const id = installed.body.data!.id as string;
      const v2 = { version: '1.1.0', bundleUrl: 'https://example.com/v2.js', capabilities: plugin.capabilities, manifest: { ...plugin.manifest, outboundHosts: ['api.example.com', 'cdn.example.com'] } };

      const staged = await call('POST', `/extensions/${id}/upgrade`, v2);
      expect(staged.status).toBe(200);
      expect(staged.body.data).toMatchObject({ status: 'pending-approval', diff: { added: ['http:fetch:cdn.example.com'], removed: [] } });
      const [row] = await db.select().from(extensions).where(eq(extensions.id, id));
      expect(row).toMatchObject({ version: '1.0.0', bundleUrl: 'https://example.com/v1.js' });
      expect(row!.capabilities).not.toContain('http:fetch:cdn.example.com');
      expect(row!.pendingUpgrade).toMatchObject({ version: '1.1.0' });

      // Approving less than the new version requests is refused.
      expect((await call('POST', `/extensions/${id}/upgrade/approve`, { approvedCapabilities: requested })).status).toBe(409);
      const approved = await call('POST', `/extensions/${id}/upgrade/approve`, { approvedCapabilities: [...requested, 'http:fetch:cdn.example.com'] });
      expect(approved.status).toBe(200);
      const [after] = await db.select().from(extensions).where(eq(extensions.id, id));
      expect(after).toMatchObject({ version: '1.1.0', bundleUrl: 'https://example.com/v2.js', pendingUpgrade: null });
      expect(after!.capabilities).toContain('http:fetch:cdn.example.com');
    });

    it('an upgrade that only drops capabilities applies at once; a staged one can be rejected', async () => {
      const call = app(DEV);
      const id = (await call('POST', '/extensions', { ...plugin, bundleUrl: 'https://example.com/v1.js', approvedCapabilities: requested })).body.data!.id as string;
      const narrower = await call('POST', `/extensions/${id}/upgrade`, { version: '1.0.1', bundleUrl: 'https://example.com/v101.js', capabilities: ['ext:events'], manifest: { heopress: '^1.0.0' } });
      expect(narrower.body.data).toMatchObject({ status: 'upgraded', diff: { added: [] } });
      expect((await db.select().from(extensions).where(eq(extensions.id, id)))[0]!.capabilities).toEqual(['ext:events']);

      await call('POST', `/extensions/${id}/upgrade`, { version: '2.0.0', bundleUrl: 'https://example.com/v2.js', capabilities: ['ext:events', 'items:write:posts'] });
      expect((await call('DELETE', `/extensions/${id}/upgrade`)).status).toBe(200);
      expect((await db.select().from(extensions).where(eq(extensions.id, id)))[0]).toMatchObject({ version: '1.0.1', pendingUpgrade: null });
      expect((await call('POST', `/extensions/${id}/upgrade/approve`, { approvedCapabilities: [] })).body.errors![0]!.code).toBe('NO_PENDING_UPGRADE');
    });

    it('PATCH can revoke but never grant, and cannot swap the version', async () => {
      const call = app(DEV);
      const id = (await call('POST', '/extensions', { ...plugin, bundleUrl: 'https://example.com/v1.js', approvedCapabilities: requested })).body.data!.id as string;
      expect((await call('PATCH', `/extensions/${id}`, { capabilities: [...requested, 'items:write:posts'] })).body.errors![0]!.code).toBe('CAPABILITY_NOT_APPROVED');
      expect((await call('PATCH', `/extensions/${id}`, { version: '9.0.0' })).body.errors![0]!.code).toBe('USE_UPGRADE');
      expect((await call('PATCH', `/extensions/${id}`, { capabilities: ['ext:events'] })).status).toBe(200);
    });
  });

  describe('signed plugins only, outside development mode (task 1.3 / 1.4)', () => {
    it('refuses unsigned, wrongly signed, unknown-publisher and revoked-publisher plugins', async () => {
      const call = app(PROD);
      const base = { ...plugin, approvedCapabilities: requested };
      const unsigned = await call('POST', '/extensions', { ...base, bundleUrl: 'https://example.com/v1.js' });
      expect(unsigned.body.errors![0]!.code).toBe('SIGNATURE_REQUIRED');

      const signed = await bundle('export default {};', good.key, 'p12-key-good');
      const tampered = await call('POST', '/extensions', { ...base, ...signed, signature: (await bundle('other', good.key, 'p12-key-good')).signature });
      expect(tampered.body.errors![0]!.code).toBe('SIGNATURE_INVALID');
      const unknown = await call('POST', '/extensions', { ...base, ...(await bundle('export default {};', stranger.key, 'p12-key-unknown')) });
      expect(unknown.body.errors![0]!.code).toBe('UNKNOWN_PUBLISHER');
      const gone = await call('POST', '/extensions', { ...base, ...(await bundle('export default {};', revoked.key, 'p12-key-revoked')) });
      expect(gone.body.errors![0]!.code).toBe('PUBLISHER_REVOKED');
      expect(await db.select().from(extensions).where(eq(extensions.siteId, SITE))).toEqual([]);

      // Development mode accepts an unsigned plugin, but never a bad signature.
      const dev = app(DEV);
      expect((await dev('POST', '/extensions', { ...base, bundleUrl: 'https://example.com/v1.js' })).status).toBe(200);
      expect((await dev('POST', '/extensions', { ...base, name: 'acme-two', ...(await bundle('x', revoked.key, 'p12-key-revoked')) })).body.errors![0]!.code).toBe('PUBLISHER_REVOKED');
    });

    it('the load path refuses a revoked publisher too (sandbox verify gate)', async () => {
      const signed = await bundle('export default {};', revoked.key, 'p12-key-revoked');
      const opts = buildSandboxVerifyOptions({ name: 'acme-glossary', isOfficial: false, ...signed }, db, PROD as never);
      expect(opts.requireSignature).toBe(true);
      expect(await opts.verify()).toBe(false);
      const ok = buildSandboxVerifyOptions({ name: 'acme-glossary', isOfficial: false, ...(await bundle('export default {};', good.key, 'p12-key-good')) }, db, PROD as never);
      expect(await ok.verify()).toBe(true);
    });

    it('marketplace install of an unsigned listing is refused outside development mode', async () => {
      await db.insert(extensions).values({ siteId: null, name: 'p12-unsigned', version: '1.0.0', type: 'hook', bundleUrl: 'https://example.com/u.js', marketplaceSlug: 'p12-unsigned', publishedAt: new Date(), requestedCapabilities: ['ext:events'] });
      const res = await app(PROD)('POST', '/marketplace/extensions/p12-unsigned/install', { approvedCapabilities: ['ext:events'] });
      expect(res.body.errors![0]!.code).toBe('SIGNATURE_REQUIRED');
    });

    it('marketplace install needs approval of the listing\'s capabilities', async () => {
      const signed = await bundle('export default {};', good.key, 'p12-key-good');
      await db.insert(extensions).values({ siteId: null, name: 'p12-signed', version: '1.0.0', type: 'hook', marketplaceSlug: 'p12-signed', publishedAt: new Date(), requestedCapabilities: ['ext:events', 'items:read:posts'], ...signed });
      const call = app(PROD);
      const pending = await call('POST', '/marketplace/extensions/p12-signed/install', {});
      expect(pending.status).toBe(409);
      const ok = await call('POST', '/marketplace/extensions/p12-signed/install', { approvedCapabilities: ['ext:events', 'items:read:posts'] });
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ capabilities: ['items:read:posts', 'ext:events'], permissionsStatus: 'approved' });
    });

    it('migration p12_permissions maps installed plugins like migrateLegacyCapabilities and asks for re-confirmation', async () => {
      const legacy = [
        { type: 'hook', capabilities: ['db:read', 'db:write', 'service-account', 'env:read', 'items:read', 'items:write:posts', 'http:fetch', 'http:fetch:api.example.com', 'cdc:subscribe:posts', 'read_items'] },
        { type: 'endpoint', capabilities: ['queue:enqueue', 'kv:read', 'seo:structured-data'] },
        { type: 'panel', capabilities: [] },
      ];
      const rows = await db.insert(extensions).values(legacy.map((l, i) => ({ siteId: SITE, name: `legacy-${i}`, version: '1', type: l.type, bundleUrl: 'https://example.com/l.js', enabled: i === 0, capabilities: l.capabilities }))).returning();
      const file = readFileSync(path.resolve(import.meta.dirname, '../../../../packages/database/drizzle/0114_p12_permissions.sql'), 'utf8');
      const statement = file.slice(file.indexOf('WITH mapped AS'));
      await db.execute(sql.raw(statement.replace('WHERE mapped.id = x.id', `WHERE mapped.id = x.id AND x.site_id = '${SITE}'`)));
      for (const [i, l] of legacy.entries()) {
        const [row] = await db.select().from(extensions).where(eq(extensions.id, rows[i]!.id));
        expect([...(row!.capabilities as string[])].sort()).toEqual([...migrateLegacyCapabilities(l.capabilities, l.type).capabilities].sort());
        expect(row!.permissionsStatus).toBe('reconfirm');
      }
      expect((await db.select().from(extensions).where(eq(extensions.id, rows[0]!.id)))[0]!.capabilities).not.toContain('db:read');

      // A reconfirm plugin cannot be (re-)enabled until an admin confirms what it holds.
      const call = app(DEV);
      const disabled = rows[1]!;
      expect((await call('PATCH', `/extensions/${disabled.id}`, { enabled: true })).body.errors![0]!.code).toBe('PERMISSIONS_RECONFIRM_REQUIRED');
      const [migrated] = await db.select().from(extensions).where(eq(extensions.id, disabled.id));
      expect((await call('POST', `/extensions/${disabled.id}/permissions/confirm`, { approvedCapabilities: [] })).status).toBe(409);
      expect((await call('POST', `/extensions/${disabled.id}/permissions/confirm`, { approvedCapabilities: migrated!.capabilities })).status).toBe(200);
      expect((await call('PATCH', `/extensions/${disabled.id}`, { enabled: true })).status).toBe(200);
    });
  });

  describe('plugin manifest and build provenance (task 1.5)', () => {
    it('refuses a plugin that requires a newer HeoPress, naming the required version', async () => {
      const res = await app(DEV)('POST', '/extensions', { ...plugin, bundleUrl: 'https://example.com/v1.js', manifest: { heopress: '>=2.0.0' }, approvedCapabilities: requested });
      expect(res.body.errors![0]).toMatchObject({ code: 'INCOMPATIBLE_VERSION', details: { required: '>=2.0.0', current: '1.2.0' } });
    });

    it('refuses capabilities outside the grammar (raw db / env, host-less fetch)', async () => {
      const res = await app(DEV)('POST', '/extensions', { ...plugin, bundleUrl: 'https://example.com/v1.js', capabilities: ['db:read', 'env:read', 'http:fetch'] });
      expect(res.body.errors![0]!.code).toBe('INVALID_CAPABILITY');
    });

    async function draft(slug: string, manifest: Record<string, unknown>) {
      const source = `export default {}; // ${slug}`;
      const signed = await bundle(source, good.key, 'p12-key-good');
      const [row] = await db.insert(extensions).values({ siteId: null, name: slug, version: '1.0.0', type: 'hook', marketplaceSlug: slug, bundleUrl: signed.bundleUrl, manifest, capabilities: ['ext:events'] }).returning();
      return { id: row!.id, signed };
    }
    function provenance(sha: string, overrides: Partial<{ repository: string; commit: string; workflow: string; bundleSha256: string }> = {}, key = good.key) {
      const statement = { repository: REPO, commit: 'a'.repeat(40), workflow: '.github/workflows/release.yml', bundleSha256: sha, ...overrides };
      return { ...statement, signature: signBytes(canonicalProvenance(statement), key) };
    }
    const complete = { heopress: '^1.0.0', security: { contact: 'security@example.com' } };

    it('publishing needs build provenance that matches the signature and the registered repository', async () => {
      const call = app(PROD);
      const a = await draft('p12-prov-a', complete);
      const body = (id: string, slug: string, signed: typeof a.signed, prov?: unknown) => ({ extensionId: id, marketplaceSlug: slug, publisher: 'Acme', bundleSha256: signed.bundleSha256, signature: signed.signature, publisherKeyId: signed.publisherKeyId, signatureAlg: 'ed25519', ...(prov === undefined ? {} : { provenance: prov }) });
      const missing = await call('POST', '/marketplace/publish', body(a.id, 'p12-prov-a', a.signed));
      expect(missing.body.errors![0]).toMatchObject({ code: 'PROVENANCE_INVALID', details: { reason: 'missing' } });
      const otherRepo = await call('POST', '/marketplace/publish', body(a.id, 'p12-prov-a', a.signed, provenance(a.signed.bundleSha256, { repository: 'https://git.example.com/evil/fork' })));
      expect(otherRepo.body.errors![0]!.details).toMatchObject({ reason: 'repository-mismatch' });
      const otherDigest = await call('POST', '/marketplace/publish', body(a.id, 'p12-prov-a', a.signed, provenance('b'.repeat(64))));
      expect(otherDigest.body.errors![0]!.details).toMatchObject({ reason: 'digest-mismatch' });
      const forged = await call('POST', '/marketplace/publish', body(a.id, 'p12-prov-a', a.signed, provenance(a.signed.bundleSha256, {}, stranger.key)));
      expect(forged.body.errors![0]!.details).toMatchObject({ reason: 'bad-signature' });

      const ok = await call('POST', '/marketplace/publish', body(a.id, 'p12-prov-a', a.signed, provenance(a.signed.bundleSha256)));
      expect(ok.status).toBe(200);
      const [row] = await db.select().from(extensions).where(and(eq(extensions.id, a.id)));
      expect(row).toMatchObject({ requestedCapabilities: ['ext:events'], provenance: expect.objectContaining({ repository: REPO }) });

      // An incomplete manifest (no security contact) is refused before anything else.
      const b = await draft('p12-prov-b', { heopress: '^1.0.0' });
      const incomplete = await call('POST', '/marketplace/publish', body(b.id, 'p12-prov-b', b.signed, provenance(b.signed.bundleSha256)));
      expect(incomplete.body.errors![0]!.code).toBe('INVALID_MANIFEST');
    });
  });
});
