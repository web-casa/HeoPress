/**
 * Storage profiles of the current site (HeoPress P04 tasks 6.1–6.2):
 *
 *   GET    /storage-profiles                 list (secrets masked) + the bound profile
 *   POST   /storage-profiles                 create
 *   GET    /storage-profiles/:id             read
 *   PATCH  /storage-profiles/:id             update (secret: omit keeps it, null clears it)
 *   DELETE /storage-profiles/:id             delete (409 while bound or holding media)
 *   POST   /storage-profiles/:id/test        write, read back and delete a probe object
 *   PUT    /storage-profiles/binding         {profileId|null}: where new media goes
 *   POST   /storage-profiles/migration       {profileId|null, confirm: true}: move existing media
 *   POST   /storage-profiles/migration/undo  point migrated media back
 *
 * A control-plane path: site administrators only.
 */
import { Hono, type Context } from 'hono';
import {
  StorageBindingSchema,
  StorageMigrationSchema,
  StorageProfileCreateSchema,
  StorageProfileUpdateSchema,
} from '@heopress/contracts/schemas';
import type { AppEnv } from '../env';
import { StorageProfileError, StorageProfileService } from '../services/storage/storage-profile-service';

export const storageProfilesRouter = new Hono<AppEnv>();

export function storageProfileServiceFor(c: Context<AppEnv>): StorageProfileService {
  const runtime = c.get('runtime');
  const env = c.env as unknown as Record<string, string | undefined>;
  return new StorageProfileService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    keys: runtime.keys,
    defaultStorage: runtime.storage,
    storageDir: env?.HEOPRESS_STORAGE_DIR?.trim() || process.env.HEOPRESS_STORAGE_DIR?.trim() || undefined,
  });
}

async function run(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StorageProfileError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    }
    throw err;
  }
}

async function body<T>(c: Context<AppEnv>, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string; path: PropertyKey[] }> } } }) {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return { error: c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400) };
  }
  return { data: parsed.data };
}

storageProfilesRouter.get('/', (c) =>
  run(c, async () => {
    const svc = storageProfileServiceFor(c);
    return c.json({ data: await svc.list(), meta: { boundProfileId: await svc.boundProfileId() } });
  }),
);

storageProfilesRouter.post('/', (c) =>
  run(c, async () => {
    const input = await body(c, StorageProfileCreateSchema);
    if ('error' in input) return input.error!;
    return c.json({ data: await storageProfileServiceFor(c).create(input.data) }, 201);
  }),
);

storageProfilesRouter.put('/binding', (c) =>
  run(c, async () => {
    const input = await body(c, StorageBindingSchema);
    if ('error' in input) return input.error!;
    const svc = storageProfileServiceFor(c);
    await svc.bind(input.data.profileId);
    return c.json({ data: { profileId: await svc.boundProfileId() } });
  }),
);

storageProfilesRouter.post('/migration', (c) =>
  run(c, async () => {
    const input = await body(c, StorageMigrationSchema);
    if ('error' in input) return input.error!;
    return c.json({ data: await storageProfileServiceFor(c).migrate(input.data.profileId) });
  }),
);

storageProfilesRouter.post('/migration/undo', (c) =>
  run(c, async () => c.json({ data: await storageProfileServiceFor(c).undoMigration() })),
);

storageProfilesRouter.get('/:id', (c) => run(c, async () => c.json({ data: await storageProfileServiceFor(c).get(c.req.param('id')) })));

storageProfilesRouter.patch('/:id', (c) =>
  run(c, async () => {
    const input = await body(c, StorageProfileUpdateSchema);
    if ('error' in input) return input.error!;
    return c.json({ data: await storageProfileServiceFor(c).update(c.req.param('id'), input.data) });
  }),
);

storageProfilesRouter.delete('/:id', (c) =>
  run(c, async () => {
    await storageProfileServiceFor(c).remove(c.req.param('id'));
    return c.body(null, 204);
  }),
);

storageProfilesRouter.post('/:id/test', (c) => run(c, async () => c.json({ data: await storageProfileServiceFor(c).test(c.req.param('id')) })));
