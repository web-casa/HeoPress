// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, it, expect, vi } from 'vitest';
import { ItemService } from '../item-service';
import type { Database } from '@heopress/database';
import { CryptoService } from '../crypto-service';

const ENCRYPTION_KEY = 'v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g/v8/w2R+g2g=';
const siteId = 'test-site';
const RECORD_ID = 'rec-1';

// Build the AAD context matching what processCrypto derives for `secret_field`.
const ctxFor = (recordId: string) => ({
  siteId,
  collection: 'secure_table',
  field: 'secret_field',
  recordId,
});

// We exercise the private processCrypto directly (through the typed view
// below) with a mocked SchemaService, so no Postgres is needed.
interface CryptoInternals {
  processCrypto(
    collection: string,
    data: Record<string, unknown>,
    mode: 'encrypt' | 'decrypt',
    recordId: string,
    internal: boolean,
    degraded?: boolean,
  ): Promise<Record<string, unknown>>;
  perm(collection: string, action: string): Promise<unknown>;
  auditDecryptionFailure(...args: unknown[]): Promise<void>;
}
const internals = (service: ItemService) => service as unknown as CryptoInternals;
vi.mock('../schema-service', () => {
  return {
    SchemaService: vi.fn().mockImplementation(function () {
      return {
        getCompiled: vi.fn().mockImplementation(async (collectionName: string) => {
          if (collectionName === 'secure_table') {
            return {
              fields: [
                { name: 'id', type: 'uuid' },
                { name: 'public_field', type: 'string' },
                { name: 'secret_field', type: 'string', encrypted: true },
              ],
            };
          }
          return { fields: [] };
        }),
      };
    }),
  };
});

describe('ItemService Encryption (Integration with CryptoService)', () => {
  it('should encrypt sensitive fields defined in schema', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });

    const inputData = { public_field: 'visible_data', secret_field: 'hidden_data' };
    const processed = await internals(service).processCrypto(
      'secure_table',
      inputData,
      'encrypt',
      RECORD_ID,
      true,
    );

    expect(processed.public_field).toBe('visible_data');
    expect(processed.secret_field).not.toBe('hidden_data');
    expect(typeof processed.secret_field).toBe('string');
    expect(String(processed.secret_field).startsWith('v0:')).toBe(true);
  });

  it('should decrypt sensitive fields when internal = true', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });
    const crypto = CryptoService.fromKey(ENCRYPTION_KEY);
    const encryptedSecret = await crypto.encrypt('hidden_data', ctxFor(RECORD_ID));

    const dbRowData = { public_field: 'visible_data', secret_field: encryptedSecret };
    const processed = await internals(service).processCrypto(
      'secure_table',
      dbRowData,
      'decrypt',
      RECORD_ID,
      true,
    );

    expect(processed.public_field).toBe('visible_data');
    expect(processed.secret_field).toBe('hidden_data');
  });

  it('should decrypt when internal = false AND user has read_decrypted perm', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });
    vi.spyOn(internals(service), 'perm').mockResolvedValue({ fields: ['*'], validation: {} });

    const crypto = CryptoService.fromKey(ENCRYPTION_KEY);
    const encryptedSecret = await crypto.encrypt('top_secret_info', ctxFor(RECORD_ID));

    const dbRowData = { public_field: 'visible_data', secret_field: encryptedSecret };
    const processed = await internals(service).processCrypto(
      'secure_table',
      dbRowData,
      'decrypt',
      RECORD_ID,
      false,
    );

    expect(processed.secret_field).toBe('top_secret_info');
  });

  it('should mask with *** when user lacks read_decrypted perm', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });
    vi.spyOn(internals(service), 'perm').mockImplementation(async (_collection: string, action: string) => {
      if (action === 'read_decrypted') return null;
      return { fields: ['*'], validation: {} };
    });

    const crypto = CryptoService.fromKey(ENCRYPTION_KEY);
    const encryptedSecret = await crypto.encrypt('top_secret_info', ctxFor(RECORD_ID));

    const dbRowData = { public_field: 'visible_data', secret_field: encryptedSecret };
    const processed = await internals(service).processCrypto(
      'secure_table',
      dbRowData,
      'decrypt',
      RECORD_ID,
      false,
    );

    expect(processed.secret_field).toBe('***');
  });

  it('should mask with *** when perm check throws', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });
    vi.spyOn(internals(service), 'perm').mockImplementation(async () => {
      throw new Error('Forbidden');
    });

    const crypto = CryptoService.fromKey(ENCRYPTION_KEY);
    const encryptedSecret = await crypto.encrypt('top_secret_info', ctxFor(RECORD_ID));

    const dbRowData = { public_field: 'visible_data', secret_field: encryptedSecret };
    const processed = await internals(service).processCrypto(
      'secure_table',
      dbRowData,
      'decrypt',
      RECORD_ID,
      false,
    );

    expect(processed.secret_field).toBe('***');
  });

  it('fail-closed: single-item decrypt with wrong AAD throws DECRYPTION_FAILED (500)', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });
    // Audit write is fire-and-forget against a mock db — stub it out.
    vi.spyOn(internals(service), 'auditDecryptionFailure').mockResolvedValue(undefined);

    const crypto = CryptoService.fromKey(ENCRYPTION_KEY);
    // Encrypt bound to a DIFFERENT record id → AAD mismatch on decrypt.
    const encryptedSecret = await crypto.encrypt('top_secret_info', ctxFor('other-rec'));
    const dbRowData = { public_field: 'visible_data', secret_field: encryptedSecret };

    await expect(
      internals(service).processCrypto('secure_table', dbRowData, 'decrypt', RECORD_ID, true),
    ).rejects.toMatchObject({ code: 'DECRYPTION_FAILED', status: 500 });
  });

  it('degraded read nulls the failed field and flags _decryptError', async () => {
    const mockDb = {} as Database;
    const service = new ItemService({ db: mockDb, siteId, encryptionKey: ENCRYPTION_KEY });
    vi.spyOn(internals(service), 'auditDecryptionFailure').mockResolvedValue(undefined);

    const crypto = CryptoService.fromKey(ENCRYPTION_KEY);
    const encryptedSecret = await crypto.encrypt('top_secret_info', ctxFor('other-rec'));
    const dbRowData = { public_field: 'visible_data', secret_field: encryptedSecret };

    const processed = await internals(service).processCrypto(
      'secure_table',
      dbRowData,
      'decrypt',
      RECORD_ID,
      true,
      true, // degraded
    );

    expect(processed.secret_field).toBeNull();
    expect(processed._decryptError).toBe(true);
    expect(processed.public_field).toBe('visible_data');
  });
});
