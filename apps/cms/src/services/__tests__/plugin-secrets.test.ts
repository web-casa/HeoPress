import { describe, expect, it, vi } from 'vitest';
import type { KeyProvider } from '@heopress/runtime';
import { secretNamesOf } from '@heopress/contracts/extensions';
import {
  PLUGIN_SECRET_MAX_CHARS,
  PluginSecretError,
  PluginSecretsService,
  isValidSecretName,
  pluginSecretAad,
} from '../plugin-secrets-service';

/**
 * Plugin secrets (HeoPress v1.2, spec extensions/plugin-secrets): the declaration parser, the AAD binding, and the
 * no-leak contract. The store is exercised against a small in-memory stand-in for the two Drizzle shapes the service
 * uses (a scoped select and a site transaction), so this runs without a database; the SQL itself is covered by
 * `plugin-secrets.db.integration.test.ts`.
 */

const KEY_ID = 'v1';
const KEY_BASE64 = Buffer.alloc(32, 7).toString('base64');
const SECRET_VALUE = 'deepl-secret-DO-NOT-LEAK-123456';

const keys: KeyProvider = {
  getActiveKey: async () => ({ keyId: KEY_ID, key: KEY_BASE64 }),
  getKey: async (keyId: string) => {
    if (keyId !== KEY_ID) throw new Error('unknown key');
    return KEY_BASE64;
  },
  listKeys: async () => [{ keyId: KEY_ID, status: 'active', algo: 'AES-GCM' }],
} as KeyProvider;

interface Row {
  siteId: string;
  extensionName: string;
  name: string;
  secretCiphertext: string;
  keyId: string;
  setByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AuditRow {
  siteId: string | null;
  event: string;
  metadata: Record<string, unknown>;
}

/**
 * The bound values of a Drizzle condition (`eq` params), so the stand-in can filter like the real SQL would. Only
 * `Param` chunks count: walking the whole condition would also collect column names and table metadata.
 */
function paramsOf(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== 'object') return out;
  if ((node as { constructor?: { name?: string } }).constructor?.name === 'Param') {
    const value = (node as { value?: unknown }).value;
    if (typeof value === 'string') out.push(value);
    return out;
  }
  const chunks = (node as { queryChunks?: unknown }).queryChunks;
  if (Array.isArray(chunks)) for (const chunk of chunks) paramsOf(chunk, out);
  return out;
}

function fakeDb() {
  const secrets: Row[] = [];
  const audits: AuditRow[] = [];
  const matches = (row: Row, params: string[]) =>
    params.includes(row.siteId) &&
    params.includes(row.extensionName) &&
    (params.length < 3 || params.includes(row.name));

  /** `select(...).from(...).where(...)` — thenable for the list, `.limit()` for the resolve. */
  const select = () => ({
    from: () => ({
      where: (condition: unknown) => {
        const params = paramsOf(condition);
        const hits = secrets.filter((row) => matches(row, params));
        return Object.assign(Promise.resolve(hits), { limit: async (n: number) => hits.slice(0, n) });
      },
    }),
  });

  const insert = (table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      const isAudit = 'event' in values;
      if (isAudit) {
        audits.push(values as unknown as AuditRow);
        return Promise.resolve();
      }
      const row = values as unknown as Row;
      return {
        onConflictDoUpdate: async () => {
          const at = secrets.findIndex(
            (r) => r.siteId === row.siteId && r.extensionName === row.extensionName && r.name === row.name,
          );
          if (at === -1) secrets.push(row);
          else secrets[at] = row;
        },
      };
    },
  });

  const deleteFrom = () => ({
    where: (condition: unknown) => {
      const params = paramsOf(condition);
      const removed = secrets.filter((row) => matches(row, params));
      for (const row of removed) secrets.splice(secrets.indexOf(row), 1);
      return { returning: async () => removed.map((r) => ({ name: r.name })) };
    },
  });

  const execute = async () => [];
  const tx = { execute, insert, delete: deleteFrom };
  const db = {
    select,
    insert,
    delete: deleteFrom,
    transaction: async <T>(fn: (t: typeof tx) => Promise<T>) => fn(tx),
    execute,
  };
  return { db: db as never, secrets, audits };
}

function service(db: never, plugin: string, siteId = 'site-a') {
  return new PluginSecretsService({ db, siteId, plugin, keys, actor: { userId: 'user_1', email: 'admin@example.com' } });
}

function plain(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

describe('plugin secret declaration (v1.2, spec extensions/plugin-secrets)', () => {
  it('reads the declared secret names from the capability list, ignoring everything else', () => {
    expect(
      secretNamesOf([
        'ext:translation-services',
        'http:fetch:api.deepl.com',
        'secrets:deepl_api_key',
        'secrets:deepl_api_key',
        'secrets:bad name',
        'kv:read',
      ]),
    ).toEqual(['deepl_api_key']);
    expect(secretNamesOf([])).toEqual([]);
  });

  it('accepts only the capability grammar for names', () => {
    expect(isValidSecretName('deepl_api_key')).toBe(true);
    expect(isValidSecretName('a-b_9')).toBe(true);
    expect(isValidSecretName('')).toBe(false);
    expect(isValidSecretName('has space')).toBe(false);
    expect(isValidSecretName('x'.repeat(65))).toBe(false);
  });

  it('binds the AAD to site, plugin and name', () => {
    expect(pluginSecretAad('site-a', 'acme-deepl', 'deepl_api_key')).toBe(
      'plugin-secret|site-a|acme-deepl|deepl_api_key',
    );
    expect(pluginSecretAad('site-b', 'acme-deepl', 'deepl_api_key')).not.toBe(
      pluginSecretAad('site-a', 'acme-deepl', 'deepl_api_key'),
    );
    expect(pluginSecretAad('site-a', 'acme-other', 'deepl_api_key')).not.toBe(
      pluginSecretAad('site-a', 'acme-deepl', 'deepl_api_key'),
    );
  });
});

describe('plugin secret store without a database (v1.2, spec extensions/plugin-secrets)', () => {
  it('seals the value, returns names only, and resolves through the same AAD', async () => {
    const { db, secrets, audits } = fakeDb();
    const store = service(db, 'acme-deepl');
    const logged: string[] = [];
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(plain(args))),
    );

    try {
      const set = await store.set('deepl_api_key', SECRET_VALUE, ['deepl_api_key']);
      const list = await store.list(['deepl_api_key']);
      expect(await store.resolve('deepl_api_key')).toBe(SECRET_VALUE);

      // No response, audit entry or log line carries the value (asserted before the shape, so a careless read path
      // fails this line and not only a shape comparison).
      const surfaces = [plain(set), plain(list), plain(audits.map((a) => a.metadata)), ...logged];
      for (const surface of surfaces) expect(surface).not.toContain(SECRET_VALUE);

      // The API shapes carry the name and a flag; the ciphertext is not plaintext.
      expect(set).toEqual({ name: 'deepl_api_key', configured: true, declared: true });
      expect(list).toEqual([{ name: 'deepl_api_key', configured: true, declared: true }]);
      expect(secrets[0]?.secretCiphertext).not.toContain(SECRET_VALUE);
      expect(secrets[0]?.secretCiphertext).toMatch(new RegExp(`^${KEY_ID}:`));

      expect(await store.delete('deepl_api_key')).toBe(true);
      expect(await store.resolve('deepl_api_key')).toBeNull();

      // The audit names the site, plugin and secret only.
      expect(audits.map((a) => ({ event: a.event, metadata: a.metadata }))).toEqual([
        { event: 'plugin_secret_set', metadata: { siteId: 'site-a', extensionName: 'acme-deepl', secretName: 'deepl_api_key' } },
        { event: 'plugin_secret_deleted', metadata: { siteId: 'site-a', extensionName: 'acme-deepl', secretName: 'deepl_api_key' } },
      ]);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('rotates in place: one row, new ciphertext, the new value resolves', async () => {
    const { db, secrets } = fakeDb();
    const store = service(db, 'acme-deepl');
    await store.set('deepl_api_key', 'first-value', ['deepl_api_key']);
    const first = secrets[0]!.secretCiphertext;
    await store.set('deepl_api_key', 'second-value', ['deepl_api_key']);
    expect(secrets).toHaveLength(1);
    expect(secrets[0]!.secretCiphertext).not.toBe(first);
    expect(await store.resolve('deepl_api_key')).toBe('second-value');
  });

  it('does not open a ciphertext copied to another plugin or site', async () => {
    const { db, secrets } = fakeDb();
    await service(db, 'acme-deepl').set('deepl_api_key', SECRET_VALUE, ['deepl_api_key']);
    const sealed = secrets[0]!.secretCiphertext;

    // The same envelope under another plugin name never opens: the AAD names the plugin.
    const otherPlugin = service(db, 'acme-other');
    const copied: Row = { ...secrets[0]!, extensionName: 'acme-other' };
    secrets.push(copied);
    await expect(otherPlugin.resolve('deepl_api_key')).rejects.toThrow();
    // And the original still opens.
    expect(await service(db, 'acme-deepl').resolve('deepl_api_key')).toBe(SECRET_VALUE);

    // Moving the row to another site fails the same way.
    secrets.length = 0;
    secrets.push({ ...copied, siteId: 'site-b' });
    await expect(service(db, 'acme-other', 'site-b').resolve('deepl_api_key')).rejects.toThrow();
    expect(sealed).not.toContain(SECRET_VALUE);
  });

  it('refuses an empty or oversized value and an illegal name without writing anything', async () => {
    const { db, secrets, audits } = fakeDb();
    const store = service(db, 'acme-deepl');
    await expect(store.set('deepl_api_key', '   ', [])).rejects.toMatchObject({ code: 'INVALID_SECRET', status: 400 });
    await expect(store.set('deepl_api_key', 'x'.repeat(PLUGIN_SECRET_MAX_CHARS + 1), [])).rejects.toMatchObject({ code: 'INVALID_SECRET' });
    await expect(store.set('bad name', 'value', [])).rejects.toMatchObject({ code: 'INVALID_SECRET_NAME' });
    expect(secrets).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('fails closed without a key provider instead of storing a plaintext value', async () => {
    const { db, secrets } = fakeDb();
    const store = new PluginSecretsService({ db, siteId: 'site-a', plugin: 'acme-deepl' });
    await expect(store.set('deepl_api_key', SECRET_VALUE, [])).rejects.toBeInstanceOf(PluginSecretError);
    await expect(store.set('deepl_api_key', SECRET_VALUE, [])).rejects.toMatchObject({ code: 'SECRETS_UNAVAILABLE', status: 503 });
    expect(secrets).toEqual([]);
  });
});
