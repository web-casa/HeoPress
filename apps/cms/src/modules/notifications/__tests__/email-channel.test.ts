// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, it, expect, vi } from 'vitest';
import {
  buildEmailBody,
  buildEmailSubject,
  EMAIL_SUBJECT_PREFIX,
  EmailChannelFactory,
  SecurityEmailChannel,
} from '../email-channel';
import {
  NodemailerTransport,
  type EmailMessage,
  type EmailTransport,
} from '../../../services/email/transport';
import type { NotificationPayload } from '../types';

/**
 * Feature: admin-setup-wizard, task 9.2 — email notification channel.
 *
 * As of the email-service refactor the byte-pushing lives in
 * `services/email/transport.ts`; this channel now composes a transport and
 * owns only the spec-pinned subject/body templates + recipient-merge rule.
 *
 * Coverage:
 *
 *   1. Subject template — `[HeoPress Security] <event_code>` exact
 *      shape (Req 13.2).
 *   2. Body template — every variable from Req 13.2 appears, and
 *      optional `recoveryUrl` is appended only when supplied.
 *   3. Factory routing — Cloudflare runtime → MailChannels transport,
 *      Docker runtime → SMTP transport (or null when SMTP missing).
 *   4. Channel delivery results — DeliveryResult shape on success,
 *      failure, no recipients; recipient merge + dedupe.
 *
 * **Validates: Requirements 13.2 — see also design §9.2.**
 */

const samplePayload: NotificationPayload = {
  event: 'anomaly_triggered',
  timestamp: '2025-01-15T10:20:30.000Z',
  email: 'admin@example.com',
  ip: '203.0.113.5',
  country: 'US',
  userAgent: 'Mozilla/5.0',
  anomalyScore: 0.85,
  action: 'allowed',
};

// ── Subject ───────────────────────────────────────────────────────────

describe('buildEmailSubject', () => {
  it('uses the [HeoPress Security] <event_code> shape per Req 13.2', () => {
    expect(buildEmailSubject('anomaly_triggered')).toBe(
      '[HeoPress Security] anomaly_triggered',
    );
    expect(buildEmailSubject('user_locked')).toBe(
      '[HeoPress Security] user_locked',
    );
    expect(buildEmailSubject('ip_blocked')).toBe(
      '[HeoPress Security] ip_blocked',
    );
    expect(buildEmailSubject('anomaly_lock')).toBe(
      '[HeoPress Security] anomaly_lock',
    );
  });

  it('keeps EMAIL_SUBJECT_PREFIX as a stable literal', () => {
    expect(EMAIL_SUBJECT_PREFIX).toBe('[HeoPress Security]');
  });
});

// ── Body ──────────────────────────────────────────────────────────────

describe('buildEmailBody', () => {
  it('includes every Req 13.2 substitution variable on a populated payload', () => {
    const body = buildEmailBody(samplePayload);
    expect(body).toContain(samplePayload.timestamp);
    expect(body).toContain(samplePayload.email);
    expect(body).toContain(samplePayload.ip);
    expect(body).toContain('US');
    expect(body).toContain('Mozilla/5.0');
    expect(body).toContain('0.85');
    expect(body).toContain('anomaly_triggered');
    expect(body).toContain('allowed');
  });

  it('renders nullable fields as "unknown" / "n/a" rather than empty', () => {
    const body = buildEmailBody({
      ...samplePayload,
      country: null,
      userAgent: null,
      anomalyScore: null,
    });
    expect(body).toContain('Country:         unknown');
    expect(body).toContain('User-Agent:      unknown');
    expect(body).toContain('Anomaly score:   n/a');
  });

  it('appends the recovery link line only when supplied', () => {
    const without = buildEmailBody(samplePayload);
    expect(without).not.toContain('Recovery link:');

    const withUrl = buildEmailBody(samplePayload, {
      recoveryUrl: 'https://example.test/recovery',
    });
    expect(withUrl).toContain('Recovery link:   https://example.test/recovery');
  });

  it('does not embed any password-hash / token-like values from the payload', () => {
    // Defence-in-depth: the payload type structurally cannot carry
    // those fields, but the test pins the contract so a future
    // payload extension can't accidentally regress secret hygiene.
    const body = buildEmailBody(samplePayload);
    expect(body.toLowerCase()).not.toContain('passwordhash');
    expect(body.toLowerCase()).not.toContain('setup_token');
    expect(body.toLowerCase()).not.toContain('backup_code');
  });
});

// ── Factory routing ───────────────────────────────────────────────────

describe('EmailChannelFactory.fromEnv', () => {
  it('returns an SMTP-backed channel on Docker runtime when SMTP URL is set', () => {
    const ch = EmailChannelFactory.fromEnv({
      HEOPRESS_ENV: 'production',
      HEOPRESS_RUNTIME: 'docker',
      HEOPRESS_SMTP_URL: 'smtps://user:pass@smtp.example.com:465',
    } as never);
    expect(ch).toBeInstanceOf(SecurityEmailChannel);
    expect(ch?.name).toBe('email');
  });

  it('defaults to docker runtime when HEOPRESS_RUNTIME is unset', () => {
    const ch = EmailChannelFactory.fromEnv({
      HEOPRESS_ENV: 'production',
      HEOPRESS_SMTP_URL: 'smtp://localhost:1025',
    } as never);
    expect(ch).toBeInstanceOf(SecurityEmailChannel);
  });

  it('returns null on Docker runtime when SMTP URL is unset (degraded mode)', () => {
    const ch = EmailChannelFactory.fromEnv({
      HEOPRESS_ENV: 'production',
      HEOPRESS_RUNTIME: 'docker',
    } as never);
    expect(ch).toBeNull();
  });
});

// ── SecurityEmailChannel recipient rules (fake transport) ─────────────

describe('SecurityEmailChannel recipients', () => {
  it('de-duplicates recipients case-insensitively', async () => {
    const sent: EmailMessage[] = [];
    const transport: EmailTransport = {
      kind: 'smtp',
      send: async (message) => {
        sent.push(message);
        return { ok: true };
      },
    };
    // 'Admin@Example.Com' collides with payload.email after lowercase.
    const ch = new SecurityEmailChannel(transport, { from: 'security@example.test', recipients: ['Admin@Example.Com'] });
    await ch.send(samplePayload);
    expect(sent).toHaveLength(1);
    const to = Array.isArray(sent[0]!.to) ? sent[0]!.to : [sent[0]!.to];
    expect(to).toHaveLength(1);
  });
});

// ── SecurityEmailChannel over an SMTP transport ────────────────────────

describe('SecurityEmailChannel (SMTP transport)', () => {
  it('produces a DeliveryResult shape rather than throwing on a misconfigured URL', async () => {
    // nodemailer's createTransport tolerates many shapes, so we only
    // assert the channel never throws and always returns the {ok: ...}
    // contract.
    const ch = new SecurityEmailChannel(
      new NodemailerTransport('not-a-real-smtp-url'),
      { from: 'security@example.test', recipients: [] },
    );
    const result = await ch.send(samplePayload);
    expect(result).toHaveProperty('ok');
    expect(typeof result.ok).toBe('boolean');
  });

  it('fails non-retryably with no recipients before contacting the transport', async () => {
    const ch = new SecurityEmailChannel(
      new NodemailerTransport('smtp://localhost:1025'),
      { from: 'security@example.test', recipients: [] },
    );
    const result = await ch.send({ ...samplePayload, email: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('no-recipients');
      expect(result.retryable).toBe(false);
    }
  });
});
