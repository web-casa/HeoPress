import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { outboundFetch, parseTrustedEndpoints } from '@heopress/runtime/node';
import { judgeProbe, probeRequests, sendChat, type ChatRequest } from '../services/llm/openai-compatible';

/**
 * The OpenAI-compatible client (HeoPress P04 task 7.1): tool calls and JSON
 * mode reach the service and come back; the outcome tells the ledger what it
 * needs — usage evidence (complete, partial, none, also on error responses),
 * whether anything was sent (refused before connecting vs. after a
 * redirect), timeout vs. cancellation vs. a dropped connection — and never
 * carries the service's own error text. The probe judges what actually came
 * back, not a 200 alone.
 */

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;
let handler: Handler = (_req, _body, res) => res.end();
const seen: Array<{ path: string; body: Record<string, unknown>; auth: string | undefined }> = [];
let server: Server;
let origin = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      seen.push({ path: req.url ?? '', body: body ? (JSON.parse(body) as Record<string, unknown>) : {}, auth: req.headers.authorization });
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen.length = 0;
});

/** The platform boundary, with the mock service listed as a trusted internal origin. */
const trustedFetch = (url: string, init: RequestInit) =>
  outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints(origin) });
const send = (req: Partial<ChatRequest> = {}, opts: { timeoutMs?: number; signal?: AbortSignal; fetch?: typeof trustedFetch; baseUrl?: string } = {}) =>
  sendChat(
    { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hello' }], maxTokens: 100, ...req },
    { baseUrl: opts.baseUrl ?? `${origin}/v1`, apiKey: 'sk-test-secret-key', timeoutMs: opts.timeoutMs ?? 2000, signal: opts.signal, fetch: opts.fetch ?? trustedFetch },
  );
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const answer = (message: Record<string, unknown>, usage?: Record<string, unknown>) => ({ choices: [{ message }], ...(usage ? { usage } : {}) });

describe('OpenAI-compatible client', () => {
  it('sends tools and JSON mode as the service expects, with the key only in the header', async () => {
    handler = (_req, _body, res) =>
      json(res, 200, answer({ content: null, tool_calls: [{ function: { name: 'lookup', arguments: '{"q":"x"}' } }] }, { prompt_tokens: 12, completion_tokens: 3 }));
    const out = await send({
      tools: [{ name: 'lookup', description: 'Look up', parameters: { type: 'object', properties: { q: { type: 'string' } } } }],
      responseFormat: 'json_object',
    });
    expect(out).toEqual({
      kind: 'ok',
      content: null,
      toolCalls: [{ name: 'lookup', arguments: { q: 'x' } }],
      usage: { complete: true, inputTokens: 12, outputTokens: 3 },
    });
    expect(seen[0]!.path).toBe('/v1/chat/completions');
    expect(seen[0]!.auth).toBe('Bearer sk-test-secret-key');
    expect(seen[0]!.body).toMatchObject({
      model: 'deepseek-chat',
      max_tokens: 100,
      tool_choice: 'auto',
      response_format: { type: 'json_object' },
      tools: [{ type: 'function', function: { name: 'lookup' } }],
    });
    expect(JSON.stringify(seen[0]!.body)).not.toContain('sk-test-secret-key');
  });

  it('reports usage as evidence: complete, partial or none', async () => {
    handler = (_req, _body, res) => json(res, 200, answer({ content: 'hi' }, { prompt_tokens: 5 }));
    expect(await send()).toMatchObject({ kind: 'ok', usage: { complete: false, inputTokens: 5, outputTokens: null } });
    handler = (_req, _body, res) => json(res, 200, answer({ content: 'hi' }));
    expect(await send()).toMatchObject({ kind: 'ok', usage: { complete: false, inputTokens: null, outputTokens: null } });
  });

  it('an error response gives a safe code, its usage if any, and never the service’s text', async () => {
    handler = (_req, body, res) =>
      json(res, 429, { error: { code: 'rate_limit_exceeded', message: `slow down; you sent ${body} with sk-test-secret-key` }, usage: { prompt_tokens: 7, completion_tokens: 0 } }, { 'retry-after': '3' });
    const out = await send();
    expect(out).toEqual({
      kind: 'http',
      status: 429,
      errorCode: 'PROVIDER_HTTP_429:RATE_LIMITED',
      usage: { complete: true, inputTokens: 7, outputTokens: 0 },
      retryAfterMs: 3000,
    });
    handler = (_req, _body, res) => json(res, 500, { error: { code: 'x y <script>', message: 'boom' } });
    expect(await send()).toMatchObject({ kind: 'http', errorCode: 'PROVIDER_HTTP_500', usage: { complete: false } });
    // The key echoed where a code is expected: still only our own code.
    handler = (_req, _body, res) => json(res, 401, { error: { code: 'sk-test-secret-key', type: 'sk-test-secret-key' } });
    const echoed = await send();
    expect(echoed).toMatchObject({ kind: 'http', errorCode: 'PROVIDER_HTTP_401' });
    expect(JSON.stringify(echoed)).not.toContain('sk-test-secret-key');
    handler = (_req, _body, res) => json(res, 400, { error: { type: 'context_length_exceeded' } });
    expect(await send()).toMatchObject({ errorCode: 'PROVIDER_HTTP_400:CONTEXT_TOO_LONG' });
    // Names of object built-ins are not known codes.
    for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      handler = (_req, _body, res) => json(res, 400, { error: { code } });
      expect(await send(), code).toMatchObject({ errorCode: 'PROVIDER_HTTP_400' });
    }
  });

  it('tells a timeout from a cancellation and from a dropped connection', async () => {
    handler = () => undefined; // never answers
    expect(await send({}, { timeoutMs: 100 })).toEqual({ kind: 'timeout' });
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 50);
    expect(await send({}, { timeoutMs: 5000, signal: stop.signal })).toEqual({ kind: 'cancelled' });
    handler = (req) => req.socket.destroy();
    expect(await send()).toEqual({ kind: 'network' });
  });

  it('a 2xx it cannot understand is a bad response (sent, possibly billed)', async () => {
    handler = (_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('not json');
    };
    expect(await send()).toEqual({ kind: 'bad_response', status: 200, usage: { complete: false, inputTokens: null, outputTokens: null } });
    handler = (_req, _body, res) => json(res, 200, answer({ content: null, tool_calls: [{ function: { name: 'x', arguments: '{oops' } }] }, { prompt_tokens: 1, completion_tokens: 1 }));
    expect(await send()).toMatchObject({ kind: 'bad_response', usage: { complete: true } });
    // Arguments that are not a JSON object in a string are not taken for `{}`.
    for (const args of [42, undefined, '', '[1]', 'null']) {
      handler = (_req, _body, res) => json(res, 200, answer({ content: null, tool_calls: [{ function: { name: 'x', arguments: args } }] }));
      expect((await send()).kind, String(args)).toBe('bad_response');
    }
  });

  it('says whether a refused request was sent: not before connecting, yes after a redirect', async () => {
    // Without the trust entry a loopback service is refused before anything is sent.
    const untrusted = (url: string, init: RequestInit) => outboundFetch(url, { ...init, purpose: 'service', trusted: parseTrustedEndpoints('') });
    expect(await send({}, { fetch: untrusted })).toEqual({ kind: 'blocked', sent: false });
    expect(seen).toHaveLength(0);
    handler = (_req, _body, res) => {
      res.writeHead(307, { location: 'https://elsewhere.example.com/v1/chat/completions' });
      res.end();
    };
    expect(await send()).toEqual({ kind: 'blocked', sent: true });
    expect(seen).toHaveLength(1);
  });

  it('the probe judges what came back: a real tool call, a real JSON object', async () => {
    const req = probeRequests('m');
    handler = (_req, body, res) => {
      const b = JSON.parse(body) as { tools?: unknown; response_format?: unknown };
      if (b.tools) json(res, 200, answer({ content: null, tool_calls: [{ function: { name: 'heopress_probe', arguments: '{"ok":true}' } }] }));
      else json(res, 200, answer({ content: '{"ok": true}' }));
    };
    expect(judgeProbe('tools', await send(req.tools))).toEqual({ ok: true });
    expect(judgeProbe('json', await send(req.json))).toEqual({ ok: true });
    // Not forced by name (thinking models refuse that): `auto`, with the tool and the instruction to call it.
    expect(seen[0]!.body).toMatchObject({ tool_choice: 'auto', tools: [{ type: 'function', function: { name: 'heopress_probe' } }] });
    expect(seen[1]!.body).toMatchObject({ response_format: { type: 'json_object' } });
    // A 200 without the capability: no tool call, prose instead of JSON.
    handler = (_req, _body, res) => json(res, 200, answer({ content: 'Sure! ok: true' }));
    expect(judgeProbe('tools', await send(req.tools))).toEqual({ ok: false, error: 'NO_TOOL_CALL' });
    expect(judgeProbe('json', await send(req.json))).toEqual({ ok: false, error: 'NOT_JSON' });
    handler = (_req, _body, res) => json(res, 200, answer({ content: '[1,2]' }));
    expect(judgeProbe('json', await send(req.json))).toEqual({ ok: false, error: 'NOT_A_JSON_OBJECT' });
    // The tool was called, but not as defined.
    handler = (_req, _body, res) => json(res, 200, answer({ content: null, tool_calls: [{ function: { name: 'heopress_probe', arguments: '{"ok":"yes"}' } }] }));
    expect(judgeProbe('tools', await send(req.tools))).toEqual({ ok: false, error: 'BAD_TOOL_ARGUMENTS' });
    handler = (_req, _body, res) => json(res, 400, { error: { code: 'unsupported_parameter' } });
    expect(judgeProbe('json', await send(req.json))).toEqual({ ok: false, error: 'PROVIDER_HTTP_400' });
  });
});
