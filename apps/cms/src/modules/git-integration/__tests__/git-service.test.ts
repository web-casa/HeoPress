/**
 * Git-integration CRUD and credential lifecycle (HeoPress P12; P14 task 8.2).
 *
 * Every method is site-scoped, tokens and webhook secrets are encrypted before they are stored and never returned, and
 * two integrations for the same repository are refused. A fake database records the write it was asked for; the
 * encryption is the real one so the ciphertext round-trips.
 */
import { describe, expect, it } from 'vitest';
import { gitIntegrations } from '@heopress/database';
import { decryptSecretValue } from '../crypto';
import { GitIntegrationConflictError, GitIntegrationService } from '../service';

const KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'int_1',
  siteId: 'site_a',
  provider: 'github',
  repoFullName: 'acme/site',
  displayName: 'Acme',
  authMethod: 'token',
  status: 'connected',
  statusReason: null,
  scopes: ['repo'],
  encryptedToken: 'cipher',
  webhookSecretEnc: 'secret-cipher',
  installationId: null,
  syncConfig: {},
  lastSyncAt: null,
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: new Date('2026-06-01T00:00:00Z'),
  ...overrides,
});

function harness(options: { rows?: Array<Record<string, unknown>>; existing?: boolean; insertResult?: Record<string, unknown> | null } = {}) {
  const rows = [...(options.rows ?? [])];
  const updates: Array<Record<string, unknown>> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const db = {
    select: (projection?: Record<string, unknown>) => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(options.existing ? [{ id: 'int_existing' }] : rows.slice(0, 1));
      chain.then = (resolve: (v: unknown) => void) =>
        Promise.resolve(projection ? rows.map((r) => ({ id: r.id })) : rows.slice()).then(resolve);
      return chain;
    },
    insert: () => {
      const chain: Record<string, unknown> = {};
      chain.values = (values: Record<string, unknown>) => {
        inserts.push(values);
        return chain;
      };
      chain.returning = () => {
        if (options.insertResult === null) return Promise.resolve([]);
        const created = row({ ...(options.insertResult ?? {}), ...(inserts.at(-1) ?? {}) });
        return Promise.resolve([created]);
      };
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    update: () => {
      const chain: Record<string, unknown> = {};
      chain.set = (set: Record<string, unknown>) => {
        updates.push(set);
        return chain;
      };
      chain.where = () => chain;
      chain.returning = () => Promise.resolve([row({ ...rows[0], ...(updates.at(-1) ?? {}) })]);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    delete: () => {
      const chain: Record<string, unknown> = {};
      chain.where = () => chain;
      chain.returning = () => Promise.resolve(rows.length ? [{ id: 'int_1' }] : []);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
  } as never;
  const service = new GitIntegrationService({ db, siteId: 'site_a', encryptionKey: KEY, publicBaseUrl: 'https://cms.example.test/' });
  return { service, updates, inserts };
}

describe('reading integrations', () => {
  it('lists the site’s integrations and exposes no secret material', async () => {
    const { service } = harness({ rows: [row(), row({ id: 'int_2', provider: 'gitlab', repoFullName: 'acme/other', installationId: '42' })] });
    const list = await service.list();
    expect(list.map((r) => r.id)).toEqual(['int_1', 'int_2']);
    expect(list[0]).toMatchObject({ hasToken: true, webhookUrl: 'https://cms.example.test/api/v1/integrations/git/webhook/github/site_a/int_1', lastSyncAt: null });
    expect(list[0]).not.toHaveProperty('encryptedToken');
    expect(list[1]!.hasToken).toBe(true); // an installation id is also a credential
  });

  it('answers null for an unknown integration', async () => {
    const { service } = harness({ rows: [] });
    await expect(service.get('missing')).resolves.toBeNull();
    await expect(service.getRow('missing')).resolves.toBeNull();
  });
});

describe('create', () => {
  it('refuses a second integration for the same provider and repository', async () => {
    const { service } = harness({ existing: true });
    await expect(
      service.create({ provider: 'github', repoFullName: 'acme/site', displayName: 'Acme', authMethod: 'token' } as never),
    ).rejects.toBeInstanceOf(GitIntegrationConflictError);
  });

  it('encrypts the webhook secret and the token, and derives the status from the credential', async () => {
    const { service, inserts } = harness();
    const created = await service.create({ provider: 'github', repoFullName: 'acme/site', displayName: 'Acme', authMethod: 'token', token: 'gh-token', scopes: ['repo'] } as never);
    expect(created.status).toBe('connected');
    expect(inserts[0]).toMatchObject({ siteId: 'site_a', provider: 'github', repoFullName: 'acme/site', scopes: ['repo'], syncConfig: {} });
    const stored = inserts[0]! as { encryptedToken: string; webhookSecretEnc: string; id: string };
    expect(stored.encryptedToken).not.toContain('gh-token');
    await expect(
      decryptSecretValue(KEY, stored.encryptedToken, { siteId: 'site_a', integrationId: stored.id }, 'token'),
    ).resolves.toBe('gh-token');
    await expect(
      decryptSecretValue(KEY, stored.webhookSecretEnc, { siteId: 'site_a', integrationId: stored.id }, 'webhook_secret'),
    ).resolves.toEqual(expect.any(String));

    // No token and no installation → disconnected, and no token row is written.
    const plain = harness();
    const disconnected = await plain.service.create({ provider: 'gitlab', repoFullName: 'acme/other', displayName: 'Other', authMethod: 'oauth' } as never);
    expect(disconnected.status).toBe('disconnected');
    expect(plain.inserts[0]).toMatchObject({ encryptedToken: null, installationId: null });
  });
});

describe('update and rotate', () => {
  it('updates only the fields it was given, and a token reconnects the integration', async () => {
    const { service, updates } = harness({ rows: [row({ status: 'error', statusReason: 'token expired' })] });
    await service.update('int_1', { displayName: 'Renamed' } as never);
    expect(updates[0]).toMatchObject({ displayName: 'Renamed' });
    expect(updates[0]).not.toHaveProperty('status');
    expect(updates[0]).not.toHaveProperty('encryptedToken');

    await service.update('int_1', { token: 'new-token' } as never);
    expect(updates[1]).toMatchObject({ status: 'connected', statusReason: null });
    expect(String(updates[1]!.encryptedToken)).not.toContain('new-token');
  });

  it('answers null when the integration is gone', async () => {
    const { service } = harness({ rows: [] });
    await expect(service.update('missing', { displayName: 'x' } as never)).resolves.toBeNull();
    await expect(service.rotateSecret('missing')).resolves.toBeNull();
  });

  it('rotates the webhook secret without touching the token', async () => {
    const { service, updates } = harness({ rows: [row()] });
    const rotated = await service.rotateSecret('int_1');
    expect(rotated).toMatchObject({ id: 'int_1' });
    expect(updates[0]).toHaveProperty('webhookSecretEnc');
    expect(updates[0]).not.toHaveProperty('encryptedToken');
  });
});

describe('delete', () => {
  it('reports whether a row was removed', async () => {
    expect(await harness({ rows: [row()] }).service.delete('int_1')).toBe(true);
    expect(await harness({ rows: [] }).service.delete('int_1')).toBe(false);
  });
});

// The table is the only thing the service writes; naming it keeps the fixture honest.
void gitIntegrations;
