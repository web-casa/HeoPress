/**
 * Per-site storage (HeoPress P04 tasks 6.1–6.2, spec platform/storage-profiles).
 *
 * A site binds one storage profile and writes its new media there; without a
 * binding it uses the instance default (`runtime.storage`). Each media object
 * records where it was written (`lumibase_media_objects`), so switching
 * profiles never breaks existing media, and a profile still holding objects
 * — or bound — cannot be deleted. Objects are always kept under
 * `sites/<site id>/media/<key>`: sites sharing a bucket stay apart, and every
 * lookup is by the caller's own site, so another site's key cannot be named.
 *
 * Secrets are sealed under the runtime KEK with the profile id as AAD and
 * never returned (`SECRET_MASK`). An S3 endpoint is a user-supplied address:
 * the adapter connects through the outbound boundary, so private and
 * metadata addresses are refused unless the operator lists them in
 * HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import { mediaObjects, siteStorage, storageProfiles, type Database } from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import { LocalFileStorageProvider, S3StorageProvider } from '@heopress/runtime/docker';
import {
  SECRET_MASK,
  type StorageProfileCreateInput,
  type StorageProfileResource,
  type StorageProfileUpdateInput,
} from '@heopress/contracts/schemas';
import { openSecret, sealSecret } from '../crypto/secret-vault';

type ProfileRow = typeof storageProfiles.$inferSelect;

export class StorageProfileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 400 | 404 | 409 | 422 | 503 = 400,
  ) {
    super(message);
    this.name = 'StorageProfileError';
  }
}

export interface StorageProfileDeps {
  db: Database;
  siteId: string;
  keys: KeyProvider;
  /** The instance default (`runtime.storage`). */
  defaultStorage: StorageProvider;
  /** HEOPRESS_STORAGE_DIR: local profiles live in `<dir>/profiles/<profile id>`. */
  storageDir?: string;
}

/** Where a media object is, or goes. */
export interface MediaLocation {
  storage: StorageProvider;
  objectKey: string;
  /** null: the instance default. */
  profileId: string | null;
  publicBaseUrl: string | null;
  /** The profile's driver; null for the instance default. */
  driver: 'local' | 's3' | null;
}

/** The object key of `key` on `siteId`, in any storage. */
function mediaObjectKey(siteId: string, key: string): string {
  return `sites/${siteId}/media/${key}`;
}

// Providers are rebuilt when a profile changes (its updatedAt is part of the key).
const providerCache = new Map<string, StorageProvider>();

const secretAad = (profileId: string) => `storage-profile|${profileId}`;

export class StorageProfileService {
  constructor(private readonly deps: StorageProfileDeps) {}

  private get db() {
    return this.deps.db;
  }

  // ── profiles ────────────────────────────────────────────────────────────

  async list(): Promise<StorageProfileResource[]> {
    const rows = await this.db.select().from(storageProfiles).where(eq(storageProfiles.siteId, this.deps.siteId));
    const bound = await this.boundProfileId();
    const counts = await this.objectCounts();
    return rows
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((r) => this.toResource(r, bound === r.id, counts.get(r.id) ?? 0));
  }

  async get(id: string): Promise<StorageProfileResource> {
    const row = await this.row(id);
    const counts = await this.objectCounts();
    return this.toResource(row, (await this.boundProfileId()) === id, counts.get(id) ?? 0);
  }

  async create(input: StorageProfileCreateInput): Promise<StorageProfileResource> {
    const id = randomUUID();
    const secretCiphertext = input.secretAccessKey
      ? (await withKey(() => sealSecret(this.deps.keys, input.secretAccessKey!, secretAad(id)))).ciphertext
      : null;
    try {
      const [row] = await this.db
        .insert(storageProfiles)
        .values({
          id,
          siteId: this.deps.siteId,
          name: input.name,
          driver: input.driver,
          ...this.s3Fields(input.driver, input),
          secretCiphertext: input.driver === 's3' ? secretCiphertext : null,
          publicBaseUrl: input.publicBaseUrl ?? null,
        })
        .returning();
      return this.toResource(row!, false, 0);
    } catch (err) {
      throw uniqueName(err) ?? err;
    }
  }

  async update(id: string, input: StorageProfileUpdateInput): Promise<StorageProfileResource> {
    const current = await this.row(id);
    const next: Partial<ProfileRow> = { updatedAt: new Date() };
    if (input.name !== undefined) next.name = input.name;
    if (input.publicBaseUrl !== undefined) next.publicBaseUrl = input.publicBaseUrl;
    if (current.driver === 's3') {
      Object.assign(next, this.s3Fields('s3', input, true));
      if (input.secretAccessKey !== undefined) {
        next.secretCiphertext = input.secretAccessKey
          ? (await withKey(() => sealSecret(this.deps.keys, input.secretAccessKey!, secretAad(id)))).ciphertext
          : null;
      }
    }
    try {
      const [row] = await this.db
        .update(storageProfiles)
        .set(next)
        .where(and(eq(storageProfiles.id, id), eq(storageProfiles.siteId, this.deps.siteId)))
        .returning();
      return this.get(row!.id);
    } catch (err) {
      throw uniqueName(err) ?? err;
    }
  }

  /** Refused while the site writes to it or objects are stored in it. */
  async remove(id: string): Promise<void> {
    await this.row(id);
    try {
      await this.db.delete(storageProfiles).where(and(eq(storageProfiles.id, id), eq(storageProfiles.siteId, this.deps.siteId)));
    } catch (err) {
      if (pgCode(err) === '23503') {
        throw new StorageProfileError('PROFILE_IN_USE', 'The profile is bound to the site or still holds media; move them first.', 409);
      }
      throw err;
    }
  }

  // ── binding ─────────────────────────────────────────────────────────────

  async boundProfileId(): Promise<string | null> {
    const [row] = await this.db.select().from(siteStorage).where(eq(siteStorage.siteId, this.deps.siteId));
    return row?.storageProfileId ?? null;
  }

  /** New media goes to `profileId` (null: the default). Existing media stays where it is. */
  async bind(profileId: string | null): Promise<void> {
    if (profileId === null) {
      await this.db.delete(siteStorage).where(eq(siteStorage.siteId, this.deps.siteId));
      return;
    }
    await this.row(profileId);
    await this.db
      .insert(siteStorage)
      .values({ siteId: this.deps.siteId, storageProfileId: profileId })
      .onConflictDoUpdate({ target: siteStorage.siteId, set: { storageProfileId: profileId, updatedAt: new Date() } });
  }

  /** Write, read back and delete a probe object. Never reveals the secret. */
  async test(id: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const row = await this.row(id);
    const started = Date.now();
    const key = `sites/${this.deps.siteId}/__probe__/${randomUUID()}`;
    try {
      const storage = await this.provider(row);
      await storage.put(key, Buffer.from('heopress storage probe'), { contentType: 'text/plain' });
      const back = await storage.get(key);
      await storage.delete(key);
      if (!back) throw new Error('The probe object could not be read back.');
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      // A setting of this instance (no encryption key, incomplete profile)
      // is not a connection result: the route answers it as such.
      if (err instanceof StorageProfileError) throw err;
      return { ok: false, latencyMs: Date.now() - started, error: safeMessage(err) };
    }
  }

  // ── media locations ─────────────────────────────────────────────────────

  /** Where new media of this site goes. */
  async writeLocation(key: string): Promise<MediaLocation> {
    const profileId = await this.boundProfileId();
    return this.location(profileId, mediaObjectKey(this.deps.siteId, key));
  }

  /** Where `key` of this site is: its recorded location, or the default for media from before profiles. */
  async readLocation(key: string): Promise<MediaLocation> {
    const [row] = await this.db
      .select()
      .from(mediaObjects)
      .where(and(eq(mediaObjects.siteId, this.deps.siteId), eq(mediaObjects.key, key)));
    if (!row) return this.location(null, mediaObjectKey(this.deps.siteId, key));
    return this.location(row.storageProfileId, row.objectKey);
  }

  /** Record a written object; an object rewritten elsewhere is removed from where it was. */
  async recordWrite(key: string, at: MediaLocation, meta: { contentType: string; size: number }): Promise<void> {
    const before = await this.readRecorded(key);
    await this.db
      .insert(mediaObjects)
      .values({ siteId: this.deps.siteId, key, storageProfileId: at.profileId, objectKey: at.objectKey, ...meta })
      .onConflictDoUpdate({
        target: [mediaObjects.siteId, mediaObjects.key],
        set: {
          storageProfileId: at.profileId,
          objectKey: at.objectKey,
          ...meta,
          previousStorageProfileId: null,
          previousOnDefault: false,
          updatedAt: new Date(),
        },
      });
    if (before && before.storageProfileId !== at.profileId) {
      const old = await this.location(before.storageProfileId, before.objectKey).catch(() => null);
      await old?.storage.delete(before.objectKey).catch(() => undefined);
    }
  }

  async recordDelete(key: string): Promise<void> {
    await this.db.delete(mediaObjects).where(and(eq(mediaObjects.siteId, this.deps.siteId), eq(mediaObjects.key, key)));
  }

  /** Keys recorded for this site under `prefix`. */
  async recordedKeys(prefix: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: mediaObjects.key })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.siteId, this.deps.siteId), sql`starts_with(${mediaObjects.key}, ${prefix})`));
    return rows.map((r) => r.key);
  }

  /** The public URL of `key`, when its storage has a public base URL. */
  async publicUrl(key: string): Promise<string | null> {
    const at = await this.readLocation(key);
    return at.publicBaseUrl ? `${at.publicBaseUrl}/${at.objectKey}` : null;
  }

  // ── explicit migration ──────────────────────────────────────────────────

  /**
   * Move every recorded media object of the site to `targetId` (null: the
   * default): copy, read back and compare, then switch the record. The old
   * copy is kept and its location remembered, so `undoMigration` can switch
   * back. An object that fails stays where it was and is reported.
   */
  async migrate(targetId: string | null): Promise<{ moved: number; skipped: number; failed: Array<{ key: string; error: string }> }> {
    if (targetId) await this.row(targetId);
    const target = await this.location(targetId, '');
    const rows = await this.db.select().from(mediaObjects).where(eq(mediaObjects.siteId, this.deps.siteId));
    const result = { moved: 0, skipped: 0, failed: [] as Array<{ key: string; error: string }> };
    for (const row of rows) {
      if (row.storageProfileId === targetId) {
        result.skipped += 1;
        continue;
      }
      try {
        const from = await this.location(row.storageProfileId, row.objectKey);
        const obj = await from.storage.get(row.objectKey);
        if (!obj) throw new Error('The object is missing from its storage.');
        const bytes = Buffer.from(await new Response(obj.body as BodyInit).arrayBuffer());
        await target.storage.put(row.objectKey, bytes, obj.metadata ?? (obj.contentType ? { contentType: obj.contentType } : {}));
        const copy = await target.storage.get(row.objectKey);
        const copied = copy ? Buffer.from(await new Response(copy.body as BodyInit).arrayBuffer()) : null;
        if (!copied || !copied.equals(bytes)) throw new Error('The copy does not match the original.');
        await this.db
          .update(mediaObjects)
          .set({
            storageProfileId: targetId,
            previousStorageProfileId: row.storageProfileId,
            previousOnDefault: row.storageProfileId === null,
            updatedAt: new Date(),
          })
          .where(and(eq(mediaObjects.siteId, this.deps.siteId), eq(mediaObjects.key, row.key)));
        result.moved += 1;
      } catch (err) {
        result.failed.push({ key: row.key, error: safeMessage(err) });
      }
    }
    return result;
  }

  /** Point every migrated object back to where it was before the last migration. */
  async undoMigration(): Promise<{ restored: number }> {
    const rows = await this.db
      .update(mediaObjects)
      .set({
        storageProfileId: sql`${mediaObjects.previousStorageProfileId}`,
        previousStorageProfileId: null,
        previousOnDefault: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(mediaObjects.siteId, this.deps.siteId),
          sql`(${mediaObjects.previousStorageProfileId} IS NOT NULL OR ${mediaObjects.previousOnDefault})`,
        ),
      )
      .returning({ key: mediaObjects.key });
    return { restored: rows.length };
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async readRecorded(key: string) {
    const [row] = await this.db
      .select()
      .from(mediaObjects)
      .where(and(eq(mediaObjects.siteId, this.deps.siteId), eq(mediaObjects.key, key)));
    return row ?? null;
  }

  private async row(id: string): Promise<ProfileRow> {
    const [row] = await this.db
      .select()
      .from(storageProfiles)
      .where(and(eq(storageProfiles.id, id), eq(storageProfiles.siteId, this.deps.siteId)));
    if (!row) throw new StorageProfileError('NOT_FOUND', 'Storage profile not found.', 404);
    return row;
  }

  private async location(profileId: string | null, objectKey: string): Promise<MediaLocation> {
    if (profileId === null) return { storage: this.deps.defaultStorage, objectKey, profileId: null, publicBaseUrl: null, driver: null };
    const row = await this.row(profileId);
    return { storage: await this.provider(row), objectKey, profileId, publicBaseUrl: row.publicBaseUrl, driver: row.driver === 's3' ? 's3' : 'local' };
  }

  private async provider(row: ProfileRow): Promise<StorageProvider> {
    const cacheKey = `${row.id}@${row.updatedAt.getTime()}`;
    const cached = providerCache.get(cacheKey);
    if (cached) return cached;
    let provider: StorageProvider;
    if (row.driver === 'local') {
      const root = path.resolve(this.deps.storageDir || './data/storage', 'profiles', row.id);
      provider = new LocalFileStorageProvider(root);
    } else {
      if (!row.bucket || !row.accessKeyId || !row.secretCiphertext) {
        throw new StorageProfileError('PROFILE_INCOMPLETE', 'The S3 profile needs a bucket, an access key and a secret.', 422);
      }
      provider = new S3StorageProvider({
        endpoint: row.endpoint ?? undefined,
        region: row.region ?? undefined,
        forcePathStyle: row.forcePathStyle ?? undefined,
        bucket: row.bucket,
        accessKeyId: row.accessKeyId,
        secretAccessKey: await withKey(() => openSecret(this.deps.keys, row.secretCiphertext!, secretAad(row.id))),
      });
    }
    for (const k of providerCache.keys()) if (k.startsWith(`${row.id}@`)) providerCache.delete(k);
    providerCache.set(cacheKey, provider);
    return provider;
  }

  private async objectCounts(): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ profileId: mediaObjects.storageProfileId, n: count() })
      .from(mediaObjects)
      .where(and(eq(mediaObjects.siteId, this.deps.siteId), sql`${mediaObjects.storageProfileId} IS NOT NULL`))
      .groupBy(mediaObjects.storageProfileId);
    return new Map(rows.map((r) => [r.profileId!, Number(r.n)]));
  }

  private s3Fields(driver: string, input: StorageProfileUpdateInput, partial = false): Partial<ProfileRow> {
    if (driver !== 's3') return { bucket: null, endpoint: null, region: null, forcePathStyle: null, accessKeyId: null };
    const out: Partial<ProfileRow> = {};
    for (const key of ['bucket', 'endpoint', 'region', 'forcePathStyle', 'accessKeyId'] as const) {
      if (input[key] !== undefined || !partial) (out as Record<string, unknown>)[key] = input[key] ?? null;
    }
    return out;
  }

  private toResource(row: ProfileRow, bound: boolean, objectCount: number): StorageProfileResource {
    return {
      id: row.id,
      name: row.name,
      driver: row.driver as StorageProfileResource['driver'],
      bucket: row.bucket,
      endpoint: row.endpoint,
      region: row.region,
      forcePathStyle: row.forcePathStyle,
      accessKeyId: row.accessKeyId,
      secretAccessKey: row.secretCiphertext ? SECRET_MASK : null,
      publicBaseUrl: row.publicBaseUrl,
      bound,
      objectCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/**
 * A secret cannot be sealed or opened without the instance key: say so
 * (an operator setting), instead of an internal error. See
 * `docs/en/operations/encryption-keys.md`.
 */
async function withKey<T>(op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (err instanceof Error && /no encryption key configured/i.test(err.message)) {
      throw new StorageProfileError(
        'ENCRYPTION_NOT_CONFIGURED',
        'Storage secrets need the instance encryption key (ENCRYPTION_KEY, or the version the secret was sealed with): configure it and restart.',
        503,
      );
    }
    throw err;
  }
}

function pgCode(err: unknown): string | undefined {
  for (let e: unknown = err, depth = 0; e && depth < 3; e = (e as { cause?: unknown }).cause, depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function uniqueName(err: unknown): StorageProfileError | null {
  return pgCode(err) === '23505' ? new StorageProfileError('NAME_TAKEN', 'A storage profile with this name exists.', 409) : null;
}

/** An error message for the caller: never a credential, never a stack. */
function safeMessage(err: unknown): string {
  const name = (err as { name?: string })?.name;
  const message = err instanceof Error ? err.message : String(err);
  const text = name && name !== 'Error' ? `${name}: ${message}` : message;
  return text.replace(/(secret|signature|credential)[^\s,;]*[=:]\s*\S+/gi, '$1=[redacted]').slice(0, 300);
}

