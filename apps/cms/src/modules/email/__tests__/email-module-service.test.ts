/**
 * Email module: template/layout storage, render and send, and the suppression list (HeoPress P04/P07; P14 task 8.2).
 *
 * The module is the only path from a stored template to a delivered message, so the branches that matter are the
 * refusals: an unknown template key, a degraded runtime without a transport, a marketing send whose recipients are all
 * suppressed, and the suppression list's idempotent writes. A fake database records what was asked of it; the render
 * engine and transport are boundaries.
 */
import { describe, expect, it, vi } from 'vitest';
import { emailLayouts, emailSuppressions, emailTemplates } from '@heopress/database';
import { EmailModuleService, EmailNotConfiguredError, TemplateNotFoundError, AllRecipientsSuppressedError } from '../service';
import {
  buildUnsubscribeUrl,
  createUnsubscribeToken,
  SuppressionService,
  verifyUnsubscribeToken,
} from '../suppression';

interface State {
  layouts: Array<Record<string, unknown>>;
  templates: Array<Record<string, unknown>>;
  suppressions: Array<Record<string, unknown>>;
  inserts: Array<{ table: unknown; values: Record<string, unknown> }>;
}

function fakeDb(state: Partial<State> = {}) {
  const s: State = { layouts: [], templates: [], suppressions: [], inserts: [], ...state };
  const rowsFor = (table: unknown) => (table === emailSuppressions ? s.suppressions : table === emailLayouts ? s.layouts : s.templates);
  /** Bound values of a predicate, enough to filter the suppression list by address. */
  const paramsOf = (predicate: unknown): unknown[] => {
    const out: unknown[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== 'object') return;
      const chunk = node as { constructor?: { name?: string }; value?: unknown; queryChunks?: unknown[] };
      if (chunk.constructor?.name === 'Param') {
        out.push(chunk.value);
        return;
      }
      if (Array.isArray(chunk.queryChunks)) chunk.queryChunks.forEach(walk);
    };
    walk(predicate);
    return out;
  };
  const db = {
    select: () => {
      let table: unknown;
      let params: unknown[] = [];
      const rows = () => {
        const all = rowsFor(table);
        // A predicate names a row by its key, id or suppressed address; match those.
        if (params.length === 0) return all;
        return all.filter((row) => [row.key, row.id, row.emailLower].some((value) => params.includes(value)));
      };
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = t;
        return chain;
      };
      chain.where = (predicate: unknown) => {
        params = paramsOf(predicate);
        return chain;
      };
      chain.orderBy = () => chain;
      chain.limit = () => Promise.resolve(rows().slice(0, 1));
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(rows()).then(resolve);
      return chain;
    },
    insert: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.values = (values: Record<string, unknown>) => {
        s.inserts.push({ table, values });
        return chain;
      };
      chain.onConflictDoNothing = () => chain;
      chain.returning = () => Promise.resolve([{ id: 'row_1', ...(s.inserts.at(-1)?.values ?? {}) }]);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    update: () => {
      const chain: Record<string, unknown> = {};
      chain.set = () => chain;
      chain.where = () => chain;
      chain.returning = () => Promise.resolve([{ id: 'layout_1', name: 'updated' }]);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    delete: () => {
      const chain: Record<string, unknown> = {};
      chain.where = () => chain;
      chain.returning = () => Promise.resolve(s.layouts.length ? [{ id: 'layout_1' }] : []);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
  } as never;
  return { db, state: s };
}

const transport = { transportKind: 'smtp', defaultFrom: 'cms@example.test', send: vi.fn(async () => ({ ok: true })) };

describe('EmailModuleService', () => {
  it('reports whether a transport is configured', () => {
    const withTransport = new EmailModuleService({ db: fakeDb().db, siteId: 'site_a', emailService: transport as never });
    expect(withTransport.capabilities()).toEqual({ configured: true, transport: 'smtp', from: 'cms@example.test' });
    const degraded = new EmailModuleService({ db: fakeDb().db, siteId: 'site_a', emailService: null });
    expect(degraded.capabilities()).toEqual({ configured: false, transport: null, from: null });
  });

  it('creates, updates and deletes a layout, returning null when nothing matched', async () => {
    const { db, state } = fakeDb();
    const service = new EmailModuleService({ db, siteId: 'site_a', emailService: transport as never });
    const created = await service.createLayout({ key: 'layout', name: 'Layout', html: '<p>{{body}}</p>' });
    expect(created).toMatchObject({ key: 'layout', siteId: 'site_a' });
    expect(state.inserts[0]!.values).toMatchObject({ siteId: 'site_a' });

    expect(await service.updateLayout('layout_1', { name: 'updated' })).toMatchObject({ name: 'updated' });

    const empty = new EmailModuleService({ db: fakeDb().db, siteId: 'site_a', emailService: transport as never });
    expect(await empty.deleteLayout('missing')).toBeNull();

    const one = fakeDb();
    one.state.layouts.push({ id: 'layout_1' });
    const withLayout = new EmailModuleService({ db: one.db, siteId: 'site_a', emailService: transport as never });
    expect(await withLayout.deleteLayout('layout_1')).toMatchObject({ id: 'layout_1' });
  });

  it('reads a template’s layout and refuses an unknown key', async () => {
    const { db, state } = fakeDb();
    state.templates.push({ key: 'welcome', subject: 'Hi', bodyHtml: '<p>{{name}}</p>', bodyText: null, layoutId: 'layout_1' });
    state.layouts.push({ id: 'layout_1', html: '<main>{{body}}</main>' });
    const service = new EmailModuleService({ db, siteId: 'site_a', emailService: transport as never });
    const rendered = await service.render('welcome', { name: 'Ada' });
    expect(rendered.subject).toBe('Hi');
    expect(rendered.html).toContain('<main>');
    await expect(service.render('missing', {})).rejects.toBeInstanceOf(TemplateNotFoundError);
  });

  it('refuses to send without a transport, and a marketing send with every recipient suppressed', async () => {
    const degraded = new EmailModuleService({ db: fakeDb().db, siteId: 'site_a', emailService: null });
    await expect(degraded.send({ to: ['a@example.test'], inline: { subject: 'Hi', text: 'Hi' }, variables: {} })).rejects.toBeInstanceOf(EmailNotConfiguredError);

    const { db, state } = fakeDb();
    state.suppressions.push({ siteId: 'site_a', emailLower: 'a@example.test' });
    const service = new EmailModuleService({ db, siteId: 'site_a', emailService: transport as never });
    await expect(
      service.send({ to: ['a@example.test'], inline: { subject: 'Sale', text: 'Sale' }, variables: {}, category: 'marketing' }),
    ).rejects.toBeInstanceOf(AllRecipientsSuppressedError);
    // A transactional send is not filtered.
    const ok = await service.send({ to: ['a@example.test'], inline: { subject: 'Receipt', text: 'Receipt' }, variables: {} });
    expect(ok.result).toEqual({ ok: true });
  });
});

describe('suppression', () => {
  const secret = 'suppression-secret';

  it('signs and verifies an unsubscribe token, normalising the address and refusing forgeries', async () => {
    const token = await createUnsubscribeToken({ siteId: 'site_a', email: 'Ada@Example.test' }, secret);
    await expect(verifyUnsubscribeToken(token, secret)).resolves.toEqual({ siteId: 'site_a', email: 'ada@example.test' });
    await expect(verifyUnsubscribeToken(token, 'another-secret')).resolves.toBeNull();
    await expect(verifyUnsubscribeToken('not-a-token', secret)).resolves.toBeNull();

    const wrongPurpose = await createUnsubscribeToken({ siteId: 'site_a', email: 'a@example.test' }, secret);
    // Tamper a middle character, never the last one: base64url's final character carries only the signature's top bits,
    // so several replacements there decode to the same signature (a 1-in-16 flake). A middle character always changes it.
    const middle = Math.floor(wrongPurpose.length / 2);
    const tampered = `${wrongPurpose.slice(0, middle)}${wrongPurpose[middle] === 'A' ? 'B' : 'A'}${wrongPurpose.slice(middle + 1)}`;
    expect(await verifyUnsubscribeToken(tampered, secret)).toBeNull();
    expect(buildUnsubscribeUrl('https://site.example.test/', token)).toBe(
      `https://site.example.test/api/v1/email/unsubscribe?token=${encodeURIComponent(token)}`,
    );
  });

  it('asks whether one address is suppressed and filters a recipient list', async () => {
    const { db, state } = fakeDb();
    state.suppressions.push({ siteId: 'site_a', emailLower: 'blocked@example.test' });
    const service = new SuppressionService({ db });
    expect(await service.isSuppressed({ siteId: 'site_a', email: 'Blocked@Example.test' })).toBe(true);
    expect(await service.isSuppressed({ siteId: 'site_a', email: '   ' })).toBe(false);

    const filtered = await service.filter({ siteId: 'site_a', emails: ['Blocked@Example.test', 'ok@example.test', '   '] });
    expect(filtered).toEqual(['ok@example.test']);
    expect(await service.filter({ siteId: 'site_a', emails: ['   '] })).toEqual([]);
  });

  it('records an opt-out idempotently and removes it', async () => {
    const { db, state } = fakeDb();
    state.suppressions.push({ siteId: 'site_a', emailLower: 'already@example.test' });
    const service = new SuppressionService({ db, now: () => new Date('2026-06-01T00:00:00Z') });
    await expect(service.suppress({ siteId: 'site_a', email: 'Already@Example.test' })).resolves.toEqual({
      emailLower: 'already@example.test',
      alreadySuppressed: true,
    });
    await expect(service.suppress({ siteId: 'site_a', email: 'new@example.test', reason: 'complaint', source: 'webhook' })).resolves.toEqual({
      emailLower: 'new@example.test',
      alreadySuppressed: false,
    });
    expect(state.inserts.at(-1)!.values).toMatchObject({ reason: 'complaint', source: 'webhook' });
    expect(await service.unsuppress({ siteId: 'site_a', email: 'new@example.test' })).toBe(false);
  });
});
