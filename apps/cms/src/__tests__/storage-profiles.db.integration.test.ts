import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { storageProfiles, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { S3StorageProvider } from '@heopress/runtime/docker';
import { SECRET_MASK } from '@heopress/contracts/schemas';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Per-site storage profiles (HeoPress P04 tasks 6.1–6.2, spec
 * platform/storage-profiles), through the whole app: sites with different
 * storage keep their media apart; secrets never come back; switching keeps
 * old media readable; another site cannot reach an object by guessing its
 * key; a profile in use cannot be deleted; an explicit migration moves media
 * and can be undone; only a site's administrators manage its profiles; an
 * S3 endpoint is an outbound request under the platform boundary.
 */

const JWT_SECRET = 'storage-profiles-test-secret';
/**
 * An S3-compatible store for the R2-style case (CI: SeaweedFS, with an existing
 * bucket); without it that case is skipped and the rest run on local storage.
 */
const S3 = process.env.HEOPRESS_TEST_S3_ENDPOINT?.trim()
  ? {
      endpoint: process.env.HEOPRESS_TEST_S3_ENDPOINT.trim(),
      accessKeyId: process.env.HEOPRESS_TEST_S3_ACCESS_KEY ?? '',
      secretAccessKey: process.env.HEOPRESS_TEST_S3_SECRET_KEY ?? '',
      bucket: process.env.HEOPRESS_TEST_S3_BUCKET ?? 'heopress-cms-test',
    }
  : null;
const KEK = Buffer.alloc(32, 7).toString('base64');

describe.skipIf(!hasDbIntegrationUrl)('storage profiles — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let dir = '';
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('storage-profiles');
    dir = mkdtempSync(path.join(tmpdir(), 'heopress-storage-'));
    env = {
      ...process.env,
      JWT_SECRET,
      HEOPRESS_ENV: 'development',
      HEOPRESS_STORAGE: 'local',
      HEOPRESS_STORAGE_DIR: dir,
      ENCRYPTION_KEY: KEK,
    };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'stp', jwtSecret: JWT_SECRET });
    // The sites are recreated with the same ids: start each case with empty storage.
    for (const sub of ['objects', 'profiles']) rmSync(path.join(dir, sub), { recursive: true, force: true });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const as = async (who: 'adminA' | 'adminB' | 'onlyA', site: 'a' | 'b') => fx.headers(site, await fx.session(who, site));
  const call = (pathname: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(pathname, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  // A real PNG per name (the upload policy checks the bytes), told apart by colour.
  const pngs = new Map<string, Buffer>();
  const png = async (name: string) => {
    if (!pngs.has(name)) {
      const n = pngs.size + 1;
      pngs.set(name, await sharp({ create: { width: 1, height: 1, channels: 3, background: { r: n * 20, g: 255 - n * 20, b: n } } }).png().toBuffer());
    }
    return pngs.get(name)!;
  };
  const upload = async (headers: Record<string, string>, key: string, name: string) =>
    app.request(`/api/v1/media/${key}`, { method: 'POST', headers: { ...headers, 'content-type': 'image/png' }, body: new Uint8Array(await png(name)) }, env);
  /** status, and which uploaded image came back. */
  const read = async (headers: Record<string, string>, key: string) => {
    const res = await app.request(`/api/v1/media/${key}`, { headers }, env);
    if (res.status !== 200) return { status: res.status, body: null };
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: 200, body: [...pngs].find(([, b]) => b.equals(bytes))?.[0] ?? 'unknown bytes' };
  };
  const createLocal = async (headers: Record<string, string>, name: string, extra: Record<string, unknown> = {}) => {
    const res = await call('/api/v1/storage-profiles', 'POST', headers, { name, driver: 'local', ...extra });
    expect(res.status, await res.clone().text()).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data;
  };
  const bind = (headers: Record<string, string>, profileId: string | null) =>
    call('/api/v1/storage-profiles/binding', 'PUT', headers, { profileId });

  it('two sites with different storage keep their media apart', async () => {
    const a = await as('adminA', 'a');
    const b = await as('adminB', 'b');
    const profile = await createLocal(a, 'A bucket');
    expect((await bind(a, profile.id)).status).toBe(200);
    expect((await upload(a, 'cover.png', 'bytes of A')).status).toBe(201);
    expect((await upload(b, 'cover.png', 'bytes of B')).status).toBe(201);

    expect(existsSync(path.join(dir, 'profiles', profile.id, 'objects', 'sites', fx.sites.a, 'media', 'cover.png'))).toBe(true);
    expect(existsSync(path.join(dir, 'objects', 'sites', fx.sites.b, 'media', 'cover.png'))).toBe(true);
    expect(existsSync(path.join(dir, 'objects', 'sites', fx.sites.a, 'media', 'cover.png'))).toBe(false);
    expect(await read(a, 'cover.png')).toEqual({ status: 200, body: 'bytes of A' });
    expect(await read(b, 'cover.png')).toEqual({ status: 200, body: 'bytes of B' });
  });

  it.skipIf(!S3)('site A on an S3-compatible profile and site B on local storage: each upload lands in its own store, and only its site reads it', async () => {
    const trustedBefore = process.env.HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS;
    // The store is an internal address: listed for the profile's connection, as an operator would.
    process.env.HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS = new URL(S3!.endpoint).origin;
    try {
      const a = await as('adminA', 'a');
      const b = await as('adminB', 'b');
      const res = await call('/api/v1/storage-profiles', 'POST', a, {
        name: 'R2-style',
        driver: 's3',
        endpoint: S3!.endpoint,
        region: 'us-east-1',
        forcePathStyle: true,
        bucket: S3!.bucket,
        accessKeyId: S3!.accessKeyId,
        secretAccessKey: S3!.secretAccessKey,
      });
      expect(res.status, await res.clone().text()).toBe(201);
      const profile = ((await res.json()) as { data: { id: string } }).data;
      expect((await bind(a, profile.id)).status).toBe(200);
      expect((await upload(a, 'cover.png', 'bytes of A')).status).toBe(201);
      expect((await upload(b, 'cover.png', 'bytes of B')).status).toBe(201);

      // A's bytes are in the bucket under A's namespace, not on local disk; B's are local only.
      const bucket = new S3StorageProvider({ ...S3!, forcePathStyle: true });
      const inBucket = (await bucket.list(`sites/${fx.sites.a}/media/`)).keys;
      expect(inBucket).toContain(`sites/${fx.sites.a}/media/cover.png`);
      const stored = await bucket.get(`sites/${fx.sites.a}/media/cover.png`);
      expect(Buffer.from(stored!.body as Buffer).equals(await png('bytes of A'))).toBe(true);
      expect((await bucket.list(`sites/${fx.sites.b}/`)).keys).toEqual([]);
      expect(existsSync(path.join(dir, 'objects', 'sites', fx.sites.a, 'media', 'cover.png'))).toBe(false);
      expect(existsSync(path.join(dir, 'objects', 'sites', fx.sites.b, 'media', 'cover.png'))).toBe(true);

      // Each site reads its own; B cannot reach A's object by its key.
      expect(await read(a, 'cover.png')).toEqual({ status: 200, body: 'bytes of A' });
      expect(await read(b, 'cover.png')).toEqual({ status: 200, body: 'bytes of B' });
      expect((await read(b, `sites/${fx.sites.a}/media/cover.png`)).status).toBe(404);
      await bucket.delete(`sites/${fx.sites.a}/media/cover.png`);
    } finally {
      if (trustedBefore === undefined) delete process.env.HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS;
      else process.env.HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS = trustedBefore;
    }
  });

  it('secrets are stored encrypted and never returned', async () => {
    const a = await as('adminA', 'a');
    const secret = 'super-secret-value-1234567890';
    const res = await call('/api/v1/storage-profiles', 'POST', a, {
      name: 'R2',
      driver: 's3',
      endpoint: 'https://account.r2.example.com',
      region: 'auto',
      bucket: 'site-a-media',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: secret,
    });
    const text = await res.text();
    expect(res.status, text).toBe(201);
    expect(text).not.toContain(secret);
    const created = (JSON.parse(text) as { data: { id: string; secretAccessKey: string } }).data;
    expect(created.secretAccessKey).toBe(SECRET_MASK);
    const list = await (await call('/api/v1/storage-profiles', 'GET', a)).text();
    expect(list).not.toContain(secret);
    const [row] = await db.select().from(storageProfiles).where(eq(storageProfiles.id, created.id));
    expect(row!.secretCiphertext).toBeTruthy();
    expect(row!.secretCiphertext).not.toContain(secret);
    // Updating without the secret keeps it; null clears it.
    expect(((await (await call(`/api/v1/storage-profiles/${created.id}`, 'PATCH', a, { region: 'eu' })).json()) as { data: { secretAccessKey: string } }).data.secretAccessKey).toBe(SECRET_MASK);
    expect(((await (await call(`/api/v1/storage-profiles/${created.id}`, 'PATCH', a, { secretAccessKey: null })).json()) as { data: { secretAccessKey: string | null } }).data.secretAccessKey).toBeNull();
  });

  it('switching storage keeps old media readable; another site cannot reach it by guessing the key', async () => {
    const a = await as('adminA', 'a');
    const b = await as('adminB', 'b');
    expect((await upload(a, 'old.png', 'old bytes')).status).toBe(201); // default storage
    const profile = await createLocal(a, 'New bucket');
    await bind(a, profile.id);
    expect((await upload(a, 'new.png', 'new bytes')).status).toBe(201);
    expect(await read(a, 'old.png')).toEqual({ status: 200, body: 'old bytes' });
    expect(await read(a, 'new.png')).toEqual({ status: 200, body: 'new bytes' });
    await bind(a, null);
    expect(await read(a, 'new.png')).toEqual({ status: 200, body: 'new bytes' });
    const listed = ((await (await call('/api/v1/media', 'GET', a)).json()) as { data: string[] }).data;
    expect(listed).toEqual(expect.arrayContaining(['old.png', 'new.png']));

    // B names A's keys, the object key, or a path out of its namespace: nothing.
    expect((await read(b, 'new.png')).status).toBe(404);
    expect((await read(b, `sites/${fx.sites.a}/media/new.png`)).status).toBe(404);
    // A path out of the namespace: resolved away by URL parsing, or refused by the route.
    expect([400, 404]).toContain((await read(b, '../a/new.png')).status);
    expect([400, 404]).toContain((await read(b, '%2e%2e/%2e%2e/sites/new.png')).status);
    expect(((await (await call('/api/v1/media', 'GET', b)).json()) as { data: string[] }).data).toEqual([]);
  });

  it('a profile in use cannot be deleted; a migration moves media and can be undone', async () => {
    const a = await as('adminA', 'a');
    const profile = await createLocal(a, 'Target');
    expect((await upload(a, 'm1.png', 'one')).status).toBe(201);
    expect((await upload(a, 'm2.png', 'two')).status).toBe(201);

    // Explicit confirmation is required.
    expect((await call('/api/v1/storage-profiles/migration', 'POST', a, { profileId: profile.id })).status).toBe(400);
    const moved = (await (await call('/api/v1/storage-profiles/migration', 'POST', a, { profileId: profile.id, confirm: true })).json()) as {
      data: { moved: number; failed: unknown[] };
    };
    expect(moved.data).toMatchObject({ moved: 2, failed: [] });
    expect(existsSync(path.join(dir, 'profiles', profile.id, 'objects', 'sites', fx.sites.a, 'media', 'm1.png'))).toBe(true);
    expect(await read(a, 'm1.png')).toEqual({ status: 200, body: 'one' });

    // Holding media: refused.
    const del = await call(`/api/v1/storage-profiles/${profile.id}`, 'DELETE', a);
    expect(del.status).toBe(409);
    expect(((await del.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('PROFILE_IN_USE');

    // Undo: back to where they were (the old copies were kept).
    expect(((await (await call('/api/v1/storage-profiles/migration/undo', 'POST', a)).json()) as { data: { restored: number } }).data.restored).toBe(2);
    expect(await read(a, 'm2.png')).toEqual({ status: 200, body: 'two' });
    expect((await call(`/api/v1/storage-profiles/${profile.id}`, 'DELETE', a)).status).toBe(204);
  });

  it('media URLs use the profile public base URL', async () => {
    const a = await as('adminA', 'a');
    const profile = await createLocal(a, 'Public', { publicBaseUrl: 'https://img.example.com/' });
    await bind(a, profile.id);
    const res = await upload(a, 'photos/hero.png', 'hero');
    const body = (await res.json()) as { data: { url: string | null } };
    expect(body.data.url).toBe(`https://img.example.com/sites/${fx.sites.a}/media/photos/hero.png`);
  });

  it("only the site's administrators manage its profiles, and only its own", async () => {
    const a = await as('adminA', 'a');
    const profile = await createLocal(a, 'Private');
    expect((await call('/api/v1/storage-profiles', 'GET', await as('onlyA', 'a'))).status).toBe(403);
    const b = await as('adminB', 'b');
    expect(((await (await call('/api/v1/storage-profiles', 'GET', b)).json()) as { data: unknown[] }).data).toEqual([]);
    expect((await call(`/api/v1/storage-profiles/${profile.id}`, 'GET', b)).status).toBe(404);
    expect((await bind(b, profile.id)).status).toBe(404);
    expect((await call(`/api/v1/storage-profiles/${profile.id}`, 'DELETE', b)).status).toBe(404);
  });

  it('an S3 endpoint is an outbound request: a metadata address is refused, and the error carries no secret', async () => {
    const a = await as('adminA', 'a');
    const secret = 'another-secret-value-0987654321';
    const created = (await (
      await call('/api/v1/storage-profiles', 'POST', a, {
        name: 'Metadata',
        driver: 's3',
        endpoint: 'http://169.254.169.254',
        bucket: 'probe',
        accessKeyId: 'AKIAEXAMPLE',
        secretAccessKey: secret,
      })
    ).json()) as { data: { id: string } };
    const res = await call(`/api/v1/storage-profiles/${created.data.id}/test`, 'POST', a);
    const text = await res.text();
    expect(res.status).toBe(200);
    const result = (JSON.parse(text) as { data: { ok: boolean; error?: string } }).data;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/blocked|refused|not allowed/i);
    expect(text).not.toContain(secret);
  });
});
