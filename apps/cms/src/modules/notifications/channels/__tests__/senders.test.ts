import { createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { classifyAddress } from '@heopress/runtime/node';
import { renderText, sendToChannel, type ChannelMessage, type SenderOptions } from '../senders';

/**
 * Channel senders against a mock HTTP server (HeoPress P10 tasks 5.2, 5.5): each platform's request shape and
 * signature; outcomes as redacted codes; the outbound boundary refuses internal targets and redirects into them.
 *
 * The mock listens on 127.0.0.1 under the name `hooks.example.com`; the test classifier treats exactly that address
 * as public, so every other internal address keeps the real classification.
 */

interface Seen {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let server: Server;
let port = 0;
const seen: Seen[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void = (_q, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end('{"errcode":0,"code":0,"ok":true}');
};

const opts = (): SenderOptions => ({
  outbound: {
    resolve: async (host) => (host === 'hooks.example.com' ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.8', family: 4 }]),
    classify: (ip) => (ip === '127.0.0.1' ? 'public' : classifyAddress(ip)),
  },
  telegramApiBase: `http://hooks.example.com:${port}`,
  now: () => new Date('2026-10-27T08:00:00Z'),
});
const hook = (path: string) => `http://hooks.example.com:${port}${path}`;

const message: ChannelMessage = {
  id: 'dlv_1',
  event: 'veto',
  title: 'Veto window open',
  severity: 'warning',
  siteName: 'Example News',
  link: 'https://cms.example.com/console/mission-control/inbox?entry=veto:a1',
  ts: '2026-10-27T08:00:00.000Z',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
afterEach(() => {
  seen.length = 0;
  handler = (_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"errcode":0,"code":0,"ok":true}');
});

describe('channel senders (mock server)', () => {
  it('WeCom: markdown message to the robot URL, summary and link only', async () => {
    const out = await sendToChannel('wecom', { url: hook('/cgi-bin/webhook/send?key=wk-1') }, message, opts());
    expect(out).toEqual({ ok: true });
    expect(seen[0]!.url).toBe('/cgi-bin/webhook/send?key=wk-1');
    const body = JSON.parse(seen[0]!.body);
    expect(body.msgtype).toBe('markdown');
    expect(body.markdown.content).toContain('Veto window open');
    expect(body.markdown.content).toContain('Example News');
    expect(body.markdown.content).toContain(message.link);
  });

  it('Feishu: text message with the documented signature', async () => {
    const out = await sendToChannel('feishu', { url: hook('/open-apis/bot/v2/hook/fs-1'), secret: 'hook-secret' }, message, opts());
    expect(out).toEqual({ ok: true });
    const body = JSON.parse(seen[0]!.body);
    expect(body.msg_type).toBe('text');
    expect(body.content.text).toBe(renderText(message));
    const ts = String(Date.parse('2026-10-27T08:00:00Z') / 1000);
    expect(body.timestamp).toBe(ts);
    expect(body.sign).toBe(createHmac('sha256', `${ts}\nhook-secret`).update('').digest('base64'));
    expect(seen[0]!.body).not.toContain('hook-secret');
  });

  it('DingTalk: markdown with timestamp and sign in the query', async () => {
    const out = await sendToChannel('dingtalk', { url: hook('/robot/send?access_token=dt-1'), secret: 'hook-secret' }, message, opts());
    expect(out).toEqual({ ok: true });
    const url = new URL(seen[0]!.url, 'http://x');
    const ts = String(Date.parse('2026-10-27T08:00:00Z'));
    expect(url.searchParams.get('access_token')).toBe('dt-1');
    expect(url.searchParams.get('timestamp')).toBe(ts);
    expect(url.searchParams.get('sign')).toBe(createHmac('sha256', 'hook-secret').update(`${ts}\nhook-secret`).digest('base64'));
    expect(JSON.parse(seen[0]!.body).msgtype).toBe('markdown');
  });

  it('Telegram: sendMessage with chat id and plain text', async () => {
    const out = await sendToChannel('telegram', { token: '123456:fake-token-for-tests-only', chatId: '-1001' }, message, opts());
    expect(out).toEqual({ ok: true });
    expect(seen[0]!.url).toBe('/bot123456:fake-token-for-tests-only/sendMessage');
    expect(JSON.parse(seen[0]!.body)).toEqual({ chat_id: '-1001', text: renderText(message), disable_web_page_preview: true });
  });

  it('generic webhook: HMAC-SHA256 over `${timestamp}.${body}`', async () => {
    const out = await sendToChannel('webhook', { url: hook('/hooks/heopress'), secret: 'hook-secret' }, message, opts());
    expect(out).toEqual({ ok: true });
    const s = seen[0]!;
    const ts = s.headers['x-heopress-timestamp'] as string;
    expect(s.headers['x-heopress-signature']).toBe(`sha256=${createHmac('sha256', 'hook-secret').update(`${ts}.${s.body}`).digest('hex')}`);
    expect(Object.keys(JSON.parse(s.body)).sort()).toEqual(['event', 'id', 'link', 'severity', 'site', 'title', 'ts']);
  });

  it('reports failures as redacted codes: 5xx and 429 retry, 4xx does not, platform codes retry', async () => {
    handler = (_q, res) => res.writeHead(502).end('upstream down: key=wk-1');
    expect(await sendToChannel('wecom', { url: hook('/send?key=wk-1') }, message, opts())).toEqual({ ok: false, retryable: true, error: 'http_502' });
    handler = (_q, res) => res.writeHead(429).end();
    expect(await sendToChannel('webhook', { url: hook('/h') }, message, opts())).toEqual({ ok: false, retryable: true, error: 'http_429' });
    handler = (_q, res) => res.writeHead(403).end();
    expect(await sendToChannel('webhook', { url: hook('/h') }, message, opts())).toEqual({ ok: false, retryable: false, error: 'http_403' });
    handler = (_q, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"code":19021,"msg":"sign match fail"}');
    expect(await sendToChannel('feishu', { url: hook('/f'), secret: 'hook-secret' }, message, opts())).toEqual({ ok: false, retryable: true, error: 'platform_19021' });
  });
});

describe('malicious webhook targets', () => {
  it.each([
    ['a private address', 'http://10.0.0.5/hook'],
    ['loopback', 'http://127.0.0.1:9/hook'],
    ['localhost', 'http://localhost/hook'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data'],
    ['a name resolving to a private address', 'http://internal.example.com/hook'],
    ['a non-http scheme', 'file:///etc/passwd'],
  ])('refuses %s without sending', async (_label, url) => {
    // Real classifier here: even 127.0.0.1 is internal.
    const out = await sendToChannel('webhook', { url }, message, {
      outbound: { resolve: async () => [{ address: '10.0.0.8', family: 4 }] },
    });
    expect(out).toEqual({ ok: false, retryable: false, error: 'blocked' });
  });

  it('refuses a redirect into an internal address', async () => {
    handler = (_q, res) => res.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data' }).end();
    expect(await sendToChannel('webhook', { url: hook('/redir') }, message, opts())).toEqual({ ok: false, retryable: false, error: 'blocked' });
    handler = (_q, res) => res.writeHead(307, { location: 'http://10.1.2.3/hook' }).end();
    expect(await sendToChannel('wecom', { url: hook('/redir?key=wk-1') }, message, opts())).toEqual({ ok: false, retryable: false, error: 'blocked' });
    handler = (_q, res) => res.writeHead(307, { location: 'http://internal.example.com/hook' }).end();
    expect(await sendToChannel('webhook', { url: hook('/redir') }, message, opts())).toEqual({ ok: false, retryable: false, error: 'blocked' });
  });

  it('Telegram follows no redirect, so the token in the path goes nowhere else', async () => {
    handler = (_q, res) => res.writeHead(302, { location: `http://hooks.example.com:${port}/elsewhere` }).end();
    const out = await sendToChannel('telegram', { token: '123456:fake-token-for-tests-only', chatId: '-1001' }, message, opts());
    expect(out).toEqual({ ok: false, retryable: false, error: 'blocked' });
    expect(seen.map((s) => s.url)).toEqual(['/bot123456:fake-token-for-tests-only/sendMessage']);
  });

  it('never logs the target or the secret', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      handler = (_q, res) => res.writeHead(500).end();
      await sendToChannel('dingtalk', { url: hook('/robot/send?access_token=dt-leak'), secret: 'hook-secret' }, message, opts());
      await sendToChannel('webhook', { url: 'http://10.0.0.5/hook?token=dt-leak' }, message, {});
      const logged = spies.flatMap((s) => s.mock.calls.flat()).map((a) => String(a instanceof Error ? a.stack : JSON.stringify(a))).join('\n');
      expect(logged).not.toContain('dt-leak');
      expect(logged).not.toContain('hook-secret');
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
