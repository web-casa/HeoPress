// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Generic email transport layer.
 *
 * This is the single byte-pushing implementation for the whole CMS. It
 * generalises the two transports that previously lived (security-only) in
 * `apps/cms/src/modules/notifications/email-channel.ts`:
 *
 *   - {@link NodemailerTransport} — drives `nodemailer` against an SMTP URL
 *     (`HEOPRESS_SMTP_URL`). The MailChannels transport used by the Cloudflare
 *     Workers build was removed in HeoPress P02.
 *
 * It accepts a provider-agnostic {@link EmailMessage} (arbitrary subject,
 * recipients, and HTML/text bodies) and return a {@link DeliveryResult} from
 * the notifications module — expected delivery failures (SMTP 4xx/5xx, network
 * refusal, timeout) round-trip through the result rather than throwing, so the
 * callers stay branch-free for the common case.
 *
 * The security notification channel now composes these transports rather than
 * owning its own copy; its spec-pinned subject/body templates (Req 13.2) stay
 * in `modules/notifications/email-channel.ts`.
 */

import type { DeliveryResult } from '../../modules/notifications/types';

// ── Message contract ───────────────────────────────────────────────────

/**
 * A single outbound email. `html` and `text` are both optional but at least
 * one must be present; the transports fall back to whichever is supplied.
 * Recipients are pre-resolved by the caller (the email module renders +
 * de-duplicates before handing the message over).
 */
export interface EmailMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly replyTo?: string;
  readonly subject: string;
  readonly html?: string;
  readonly text?: string;
}

/**
 * Transport abstraction. Mirrors the `NotificationChannelAdapter.send`
 * contract so the security channel can wrap a transport directly.
 */
export interface EmailTransport {
  readonly kind: 'smtp';
  send(message: EmailMessage): Promise<DeliveryResult>;
}

// ── Nodemailer (self-hosted Node / Docker) ─────────────────────────────

type NodemailerTransportHandle = {
  sendMail(opts: {
    from: string;
    to: string;
    cc?: string;
    replyTo?: string;
    subject: string;
    text?: string;
    html?: string;
  }): Promise<unknown>;
};

type NodemailerModule = {
  createTransport(url: string): NodemailerTransportHandle;
};

/**
 * SMTP transport for the Docker / self-hosted Node runtime.
 *
 * The underlying `nodemailer` transport is created lazily on first send so
 * (1) importing this module on a Workers build doesn't crash on a missing
 * `nodemailer` install, and (2) a misconfigured `HEOPRESS_SMTP_URL` fails at
 * first send rather than at boot. Mirrors the seam in the original
 * `NodemailerChannel`.
 */
export class NodemailerTransport implements EmailTransport {
  readonly kind = 'smtp' as const;

  private handle: NodemailerTransportHandle | null = null;
  private handleInit: Promise<NodemailerTransportHandle | null> | null = null;

  constructor(private readonly smtpUrl: string) {}

  async send(message: EmailMessage): Promise<DeliveryResult> {
    const handle = await this.ensureHandle();
    if (!handle) {
      return { ok: false, error: 'nodemailer-unavailable', retryable: false };
    }

    const recipients = dedupeAddresses(message.to);
    if (recipients.length === 0) {
      return { ok: false, error: 'no-recipients', retryable: false };
    }
    const cc = message.cc ? dedupeAddresses(message.cc) : [];

    // SMTP servers commonly reject multi-recipient sends; loop one `to` at a
    // time so a single bad address can't poison the others. `ok: true` only
    // when *every* recipient accepted.
    for (const to of recipients) {
      try {
        await handle.sendMail({
          from: message.from,
          to,
          cc: cc.length > 0 ? cc.join(', ') : undefined,
          replyTo: message.replyTo,
          subject: message.subject,
          text: message.text,
          html: message.html,
        });
      } catch (err) {
        return { ok: false, error: errorMessage(err), retryable: true };
      }
    }
    return { ok: true };
  }

  private async ensureHandle(): Promise<NodemailerTransportHandle | null> {
    if (this.handle) return this.handle;
    if (!this.handleInit) {
      this.handleInit = this.loadHandle();
      this.handleInit
        .then((h) => {
          this.handle = h;
        })
        .catch(() => {
          this.handle = null;
        });
    }
    return this.handleInit;
  }

  private async loadHandle(): Promise<NodemailerTransportHandle | null> {
    let mod: NodemailerModule;
    try {
      mod = (await import('nodemailer')) as unknown as NodemailerModule;
    } catch {
      // eslint-disable-next-line no-console
      console.warn('[email/transport] nodemailer module unavailable; SMTP disabled');
      return null;
    }
    try {
      return mod.createTransport(this.smtpUrl);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[email/transport] nodemailer createTransport failed:', errorMessage(err));
      return null;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Trim, drop blanks, de-duplicate (case-insensitive) while preserving the
 * caller's original casing for the `To:` header.
 */
export function dedupeAddresses(addrs: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of addrs) {
    const trimmed = addr.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 256);
  if (typeof err === 'string') return err.slice(0, 256);
  return 'unknown-error';
}

async function safeReadShortText(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 1024);
  } catch {
    return '';
  }
}
