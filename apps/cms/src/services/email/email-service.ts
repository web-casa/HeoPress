// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * EmailService — the reusable, CMS-wide "send any email" service.
 *
 * Sits on top of the generic {@link EmailTransport} layer in `transport.ts`:
 * SMTP via `HEOPRESS_SMTP_URL` (nodemailer), or `null` when it is unset.
 *
 * `fromEnv` returns `null` in degraded mode (no transport available on this
 * runtime/config) so callers can detect "email not configured" without
 * try/catch. The email module surfaces that as a capability flag in the UI,
 * and the invite/notification flows degrade silently + audit-log.
 *
 * The default `from` falls back to a fixed mailbox so a misconfigured deploy
 * still has a valid envelope sender; operators override with
 * `HEOPRESS_MAIL_FROM`.
 */

import type { AppEnv } from '../../env';
import type { DeliveryResult } from '../../modules/notifications/types';
import {
  NodemailerTransport,
  type EmailMessage,
  type EmailTransport,
} from './transport';

const DEFAULT_FROM_FALLBACK = 'no-reply@heopress.local';

/**
 * A message handed to {@link EmailService.send}. `from` and `replyTo` are
 * optional — the service fills them from env defaults when omitted, so the
 * common caller only needs `{ to, subject, html|text }`.
 */
export interface OutboundEmail {
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly from?: string;
  readonly replyTo?: string;
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
}

export class EmailService {
  constructor(
    private readonly transport: EmailTransport,
    private readonly defaults: { from: string; replyTo?: string },
  ) {}

  /** Which transport backs this service (for capability reporting). */
  get transportKind(): EmailTransport['kind'] {
    return this.transport.kind;
  }

  /** Default envelope sender (for capability reporting / UI display). */
  get defaultFrom(): string {
    return this.defaults.from;
  }

  async send(email: OutboundEmail): Promise<DeliveryResult> {
    const message: EmailMessage = {
      from: email.from ?? this.defaults.from,
      to: email.to,
      cc: email.cc,
      replyTo: email.replyTo ?? this.defaults.replyTo,
      subject: email.subject,
      html: email.html,
      text: email.text,
    };
    return this.transport.send(message);
  }

  /**
   * Build a service from the Hono `Bindings`. Returns `null` when email
   * cannot be sent on this runtime (degraded mode). An explicit
   * `HEOPRESS_MAIL_ENABLED='false'` forces the disabled state regardless of
   * other config — an operator kill switch.
   */
  static fromEnv(env: AppEnv['Bindings']): EmailService | null {
    if (readStringEnv(env, 'HEOPRESS_MAIL_ENABLED') === 'false') {
      return null;
    }

    const from = readStringEnv(env, 'HEOPRESS_MAIL_FROM') ?? DEFAULT_FROM_FALLBACK;
    const replyTo = readStringEnv(env, 'HEOPRESS_MAIL_REPLY_TO');

    const smtpUrl = readStringEnv(env, 'HEOPRESS_SMTP_URL');
    if (!smtpUrl) {
      return null; // degraded mode — no SMTP configured.
    }
    return new EmailService(new NodemailerTransport(smtpUrl), { from, replyTo });
  }
}

function readStringEnv(env: AppEnv['Bindings'], key: string): string | undefined {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
