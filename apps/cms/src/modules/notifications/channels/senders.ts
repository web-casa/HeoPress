/**
 * Outbound notification channel senders (HeoPress P10 tasks 5.2, 5.5; spec agents/notifications).
 *
 * One function per platform turns a summary message into that platform's request and reports the outcome without
 * ever echoing the target: WeCom (企业微信) and DingTalk (钉钉) group robots, Feishu (飞书) custom bots, Telegram bots and
 * a generic webhook signed like the security webhook (`X-HeoPress-Signature: sha256=<hex>` over `${timestamp}.${body}`).
 *
 * Every request goes through the platform outbound boundary (`outboundFetch`, purpose `user`): the address is
 * checked at connect time, each redirect hop is checked again, body and time are capped. Failures are reported as a
 * short redacted code (`http_502`, `platform_310000`, `blocked`, `network`) — never the URL, the token or the
 * response body — so the delivery row and the logs hold nothing secret.
 */
import { outboundBlockOf, outboundFetch, type OutboundFetchOptions } from '@heopress/runtime/node';
import type { NotificationChannelKind, NotificationChannelTarget } from '@heopress/contracts/schemas';
import { hmacSha256Hex, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../webhook-channel';

/** What a channel message may contain: a summary and a link, nothing else. */
export interface ChannelMessage {
  /** Delivery id: the receiver's dedupe key. */
  id: string;
  event: string;
  title: string;
  severity: string;
  siteName: string;
  /** Absolute Studio link, or null when no base URL is known. */
  link: string | null;
  ts: string;
}

export type SendOutcome = { ok: true } | { ok: false; retryable: boolean; error: string };

export interface SenderOptions {
  /** Test hooks forwarded to the outbound boundary (resolver / address classifier). */
  outbound?: Pick<OutboundFetchOptions, 'resolve' | 'classify'>;
  /** Telegram Bot API origin (tests point it at a mock server). */
  telegramApiBase?: string;
  timeoutMs?: number;
  now?: () => Date;
}

const SEVERITY_LABEL: Record<string, string> = { info: 'ℹ️', warning: '⚠️', critical: '🚨' };

/** Plain-text rendering shared by every platform: severity, title, site, link. */
export function renderText(m: ChannelMessage): string {
  const lines = [`${SEVERITY_LABEL[m.severity] ?? ''} ${m.title}`.trim(), `站点 / Site: ${m.siteName}`];
  if (m.link) lines.push(m.link);
  return lines.join('\n');
}

function renderMarkdown(m: ChannelMessage): string {
  const lines = [`**${escapeMd(m.title)}**`, `> 站点 / Site: ${escapeMd(m.siteName)}`];
  if (m.link) lines.push(`[打开后台 / Open in Studio](${m.link})`);
  return lines.join('\n\n');
}

function escapeMd(s: string): string {
  return s.replace(/[[\]()*_`>#]/g, (c) => `\\${c}`);
}

async function hmacBase64(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)));
  return Buffer.from(sig).toString('base64');
}

async function post(url: string, body: string, headers: Record<string, string>, opts: SenderOptions, maxRedirects = 3): Promise<Response | SendOutcome> {
  try {
    return await outboundFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      purpose: 'user',
      maxRedirects,
      timeoutMs: opts.timeoutMs ?? 10_000,
      maxResponseBytes: 64 * 1024,
      ...opts.outbound,
    });
  } catch (err) {
    if (outboundBlockOf(err)) return { ok: false, retryable: false, error: 'blocked' };
    return { ok: false, retryable: true, error: (err as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'network' };
  }
}

/** HTTP status first, then the platform's own error code in a JSON body (`errcode` / `code` / `ok`). */
async function judge(res: Response, platformCode: (j: Record<string, unknown>) => number | null): Promise<SendOutcome> {
  if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true, error: `http_${res.status}` };
  if (res.status < 200 || res.status >= 300) return { ok: false, retryable: false, error: `http_${res.status}` };
  let json: Record<string, unknown> | null = null;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = null;
  }
  const code = json ? platformCode(json) : null;
  if (code && code !== 0) return { ok: false, retryable: true, error: `platform_${String(code).replace(/[^0-9-]/g, '').slice(0, 12)}` };
  return { ok: true };
}

function asWebhook(t: NotificationChannelTarget): { url: string; secret?: string } {
  if (!('url' in t)) throw new Error('channel target is not a webhook target');
  return t;
}

export async function sendToChannel(
  kind: NotificationChannelKind,
  target: NotificationChannelTarget,
  m: ChannelMessage,
  opts: SenderOptions = {},
): Promise<SendOutcome> {
  const now = opts.now?.() ?? new Date();
  switch (kind) {
    case 'wecom': {
      // 企业微信群机器人: the key is in the URL; markdown message.
      const { url } = asWebhook(target);
      const res = await post(url, JSON.stringify({ msgtype: 'markdown', markdown: { content: renderMarkdown(m) } }), {}, opts);
      return res instanceof Response ? judge(res, (j) => numberOr(j.errcode)) : res;
    }
    case 'feishu': {
      // 飞书自定义机器人: optional signature — base64(HMAC-SHA256(key = `${ts}\n${secret}`, data = '')).
      const { url, secret } = asWebhook(target);
      const payload: Record<string, unknown> = { msg_type: 'text', content: { text: renderText(m) } };
      if (secret) {
        const ts = String(Math.floor(now.getTime() / 1000));
        payload.timestamp = ts;
        payload.sign = await hmacBase64(`${ts}\n${secret}`, '');
      }
      const res = await post(url, JSON.stringify(payload), {}, opts);
      return res instanceof Response ? judge(res, (j) => numberOr(j.code ?? j.StatusCode)) : res;
    }
    case 'dingtalk': {
      // 钉钉群机器人: optional signature in the query — base64(HMAC-SHA256(key = secret, `${ts}\n${secret}`)).
      const { url, secret } = asWebhook(target);
      let full = url;
      if (secret) {
        const ts = String(now.getTime());
        const sign = await hmacBase64(secret, `${ts}\n${secret}`);
        const u = new URL(url);
        u.searchParams.set('timestamp', ts);
        u.searchParams.set('sign', sign);
        full = u.toString();
      }
      const body = JSON.stringify({ msgtype: 'markdown', markdown: { title: m.title.slice(0, 64), text: renderMarkdown(m) } });
      const res = await post(full, body, {}, opts);
      return res instanceof Response ? judge(res, (j) => numberOr(j.errcode)) : res;
    }
    case 'telegram': {
      if (!('token' in target)) throw new Error('channel target is not a Telegram target');
      const base = (opts.telegramApiBase ?? 'https://api.telegram.org').replace(/\/+$/, '');
      // The token is in the path: no redirect is followed, so it is never sent anywhere else.
      const res = await post(
        `${base}/bot${target.token}/sendMessage`,
        JSON.stringify({ chat_id: target.chatId, text: renderText(m), disable_web_page_preview: true }),
        {},
        opts,
        0,
      );
      return res instanceof Response ? judge(res, (j) => (j.ok === false ? numberOr(j.error_code) ?? -1 : null)) : res;
    }
    case 'webhook': {
      const { url, secret } = asWebhook(target);
      const body = JSON.stringify({
        id: m.id,
        event: m.event,
        title: m.title,
        severity: m.severity,
        site: m.siteName,
        link: m.link,
        ts: m.ts,
      });
      const headers: Record<string, string> = {};
      if (secret) {
        const ts = String(Math.floor(now.getTime() / 1000));
        headers[TIMESTAMP_HEADER] = ts;
        headers[SIGNATURE_HEADER] = `sha256=${await hmacSha256Hex(secret, `${ts}.${body}`)}`;
      }
      const res = await post(url, body, headers, opts);
      return res instanceof Response ? judge(res, () => null) : res;
    }
  }
}

function numberOr(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return null;
}
