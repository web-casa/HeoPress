import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { scopedDatabase, sites, type Database } from '@heopress/database';

import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { SchemaService } from '../schema-service';

/**
 * Content field encryption is off by default (P02 task 5.2; ADR-0004
 * "字段级加密（保留用于密钥存储，不对内容字段启用）"):
 * - a new content field carries no encryption flag;
 * - turning encryption on — directly or via a pii/phi classification — is
 *   refused with FIELD_ENCRYPTION_DISABLED until HEOPRESS_ENABLE_FIELD_ENCRYPTION
 *   is set, and then works as upstream did;
 * - turning it off again is always allowed.
 *
 * The site is created through the owner's fixtures connection; the schema service runs as the application role in the
 * site's scope (HeoPress P14).
 */

const SITE = 'site_field_encryption_switch';

describe.skipIf(!hasDbIntegrationUrl)('content field encryption switch (PostgreSQL)', () => {
  let fixtures: Database;
  let schema: SchemaService;

  beforeAll(async () => {
    const db = await connectDbIntegration('field-encryption-switch');
    fixtures = await connectDbFixtures('field-encryption-switch');
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.insert(sites).values({ id: SITE, name: 'Field encryption switch' });
    schema = new SchemaService({ db: scopedDatabase(db, { site: SITE }), siteId: SITE });
    await schema.createCollection({ name: 'secrets_demo' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await fixtures?.delete(sites).where(eq(sites.id, SITE));
  });

  it('a new content field is not encrypted', async () => {
    vi.stubEnv('HEOPRESS_ENABLE_FIELD_ENCRYPTION', '');
    const field = await schema.createField('secrets_demo', { name: 'title', type: 'string', interface: 'input' });
    expect(field?.encrypted).toBe(false);
  });

  it('refuses to encrypt a content field while the switch is off', async () => {
    vi.stubEnv('HEOPRESS_ENABLE_FIELD_ENCRYPTION', '');
    await expect(
      schema.createField('secrets_demo', { name: 'ssn', type: 'string', interface: 'input', encrypted: true, classification: 'pii' }),
    ).rejects.toMatchObject({ code: 'FIELD_ENCRYPTION_DISABLED', status: 422 });
    await expect(schema.updateField('secrets_demo', 'title', { encrypted: true })).rejects.toMatchObject({
      code: 'FIELD_ENCRYPTION_DISABLED',
    });
  });

  it('encrypts as before once enabled, and allows turning it off again while disabled', async () => {
    vi.stubEnv('HEOPRESS_ENABLE_FIELD_ENCRYPTION', 'true');
    const field = await schema.createField('secrets_demo', {
      name: 'ssn',
      type: 'string',
      interface: 'input',
      encrypted: true,
      classification: 'pii',
    });
    expect(field).toMatchObject({ encrypted: true, classification: 'pii' });

    vi.stubEnv('HEOPRESS_ENABLE_FIELD_ENCRYPTION', '');
    const off = await schema.updateField('secrets_demo', 'ssn', { encrypted: false, classification: 'none' });
    expect(off?.encrypted).toBe(false);
  });
});
