/**
 * Best-effort account emails (HeoPress P04 self-service spec; P14 task 8.2).
 *
 * The three helpers that send a verification, reset or invite message share one contract: never throw, report what
 * happened, use the site's stored template when it exists and a built-in message otherwise, and degrade to
 * `email-not-configured` when the runtime has no transport. Those are the branches that decide whether a registration
 * or an invite is quietly broken, so they get pinned here; the transport and the template engine have their own tests.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../../env';

const emailService = { id: 'transport' };
const fromEnv = vi.fn((_env: unknown): { id: string } | null => emailService);
vi.mock('../../../services/email/email-service', () => ({
  EmailService: { fromEnv: (env: unknown) => fromEnv(env) },
}));

const listTemplates = vi.fn(async () => [] as Array<{ key: string; enabled: boolean }>);
const send = vi.fn(async (_input: Record<string, unknown>) => ({ result: { ok: true } }) as { result: { ok: boolean; error?: string } });
vi.mock('../service', () => ({
  EmailModuleService: class {
    listTemplates = listTemplates;
    send = send;
  },
}));

const { sendVerificationEmail } = await import('../verify-email');
const { sendPasswordResetEmail } = await import('../password-reset');
const { sendTeammateInvite } = await import('../invite');

const env = {} as AppEnv['Bindings'];

function db(site: { siteUrl: string | null; displayTitle: string | null } | null, options: { throws?: boolean } = {}) {
  return {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => {
        if (options.throws) return Promise.reject(new Error('db down'));
        return Promise.resolve(site ? [site] : []);
      };
      chain.then = (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) =>
        (options.throws ? Promise.reject(new Error('db down')) : Promise.resolve(site ? [site] : [])).then(resolve, reject);
      return chain;
    },
  } as never;
}

const accept = (input: Record<string, unknown>) => (input as { inline?: { subject: string; html: string; text: string } }).inline;

describe.each([
  ['verification', sendVerificationEmail, 'email_verification', 'token-1', 'verify-email?token=token-1'],
  ['password reset', sendPasswordResetEmail, 'password_reset', 'token-2', 'reset-password?token=token-2'],
] as const)('%s email', (_name, sendMail, templateKey, token, pathFragment) => {
  const base = { siteId: 'site_a', env, email: 'user@example.test', token } as const;

  it('reports email-not-configured without reading the site or sending', async () => {
    fromEnv.mockReturnValueOnce(null);
    const select = vi.fn();
    await expect(sendMail({ ...base, db: { select } as never })).resolves.toEqual({ attempted: false, ok: false, reason: 'email-not-configured' });
    expect(select).not.toHaveBeenCalled();
  });

  it('uses a stored template when one is enabled, with the site link', async () => {
    listTemplates.mockResolvedValueOnce([{ key: templateKey, enabled: true }]);
    send.mockClear();
    const result = await sendMail({ ...base, db: db({ siteUrl: 'https://site.example.test', displayTitle: 'My Site' }) });
    expect(result).toEqual({ attempted: true, ok: true, reason: undefined });
    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0] as Record<string, unknown>;
    expect(input.templateKey).toBe(templateKey);
    expect(input.to).toEqual(['user@example.test']);
    expect(JSON.stringify(input.variables)).toContain(pathFragment);
  });

  it('falls back to the built-in message, escaping the site title and omitting the link without a site URL', async () => {
    listTemplates.mockResolvedValueOnce([{ key: templateKey, enabled: false }]);
    send.mockClear();
    await sendMail({ ...base, db: db({ siteUrl: null, displayTitle: '<Script>&' }) });
    const inline = accept(send.mock.calls[0]![0] as Record<string, unknown>)!;
    expect(inline.html).toContain('&lt;Script&gt;&amp;');
    expect(inline.text).not.toContain('http');

    listTemplates.mockResolvedValueOnce([]);
    send.mockClear();
    await sendMail({ ...base, db: db({ siteUrl: 'https://site.example.test', displayTitle: 'Site' }) });
    expect(accept(send.mock.calls[0]![0] as Record<string, unknown>)!.text).toContain(pathFragment);
  });

  it('copes with a failing site lookup and with a failed send', async () => {
    listTemplates.mockResolvedValueOnce([]);
    send.mockResolvedValueOnce({ result: { ok: false, error: 'smtp down' } });
    const failed = await sendMail({ ...base, db: db(null, { throws: true }) });
    expect(failed).toEqual({ attempted: true, ok: false, reason: 'smtp down' });

    send.mockRejectedValueOnce(new Error('transport exploded'));
    const thrown = await sendMail({ ...base, db: db(null) });
    expect(thrown).toEqual({ attempted: true, ok: false, reason: 'transport exploded' });

    send.mockRejectedValueOnce('not an error');
    const odd = await sendMail({ ...base, db: db(null) });
    expect(odd).toEqual({ attempted: true, ok: false, reason: 'unknown-error' });
  });
});

describe('teammate invite email', () => {
  const base = { siteId: 'site_a', env, email: 'teammate@example.test', invitedBy: 'Ada' } as const;

  it('reports email-not-configured', async () => {
    fromEnv.mockReturnValueOnce(null);
    await expect(sendTeammateInvite({ ...base, db: db(null) })).resolves.toEqual({ attempted: false, ok: false, reason: 'email-not-configured' });
  });

  it('prefers the stored template and otherwise explains who invited the person', async () => {
    listTemplates.mockResolvedValueOnce([{ key: 'teammate_invite', enabled: true }]);
    send.mockClear();
    expect(await sendTeammateInvite({ ...base, db: db({ siteUrl: 'https://site.example.test', displayTitle: 'Site' }) })).toEqual({
      attempted: true,
      ok: true,
      reason: undefined,
    });
    expect((send.mock.calls[0]![0] as Record<string, unknown>).templateKey).toBe('teammate_invite');

    listTemplates.mockResolvedValueOnce([]);
    send.mockClear();
    await sendTeammateInvite({ ...base, invitedBy: undefined, db: db({ siteUrl: null, displayTitle: 'Site' }) });
    const inline = accept(send.mock.calls[0]![0] as Record<string, unknown>)!;
    expect(inline.html).toContain('Site');
  });

  it('never throws when the send fails', async () => {
    listTemplates.mockResolvedValueOnce([]);
    send.mockResolvedValueOnce({ result: { ok: false, error: 'quota' } });
    await expect(sendTeammateInvite({ ...base, db: db(null) })).resolves.toEqual({ attempted: true, ok: false, reason: 'quota' });
  });
});
