import { describe, expect, it } from 'vitest';

import { WebhookSender, classifyHttpStatus, classifySendError } from '../webhook-sender';

/**
 * Change Feed webhook outcomes (P03 task 3.5; spec "外部动作结果状态"):
 * `failed` only when the consumer certainly did not process the batch;
 * timeouts, dropped connections and 5xx are `unknown`.
 */

const target = { url: 'https://hooks.example.com/feed', secret: 's'.repeat(32), headers: {} };
const sub = { id: 'sub_1', name: 'feed' };

describe('webhook outcome classification', () => {
  it('maps HTTP answers', () => {
    expect(classifyHttpStatus(204)).toBe('succeeded');
    expect(classifyHttpStatus(400)).toBe('failed');
    expect(classifyHttpStatus(429)).toBe('failed');
    expect(classifyHttpStatus(408)).toBe('unknown');
    expect(classifyHttpStatus(502)).toBe('unknown');
  });

  it('maps transport errors: nothing sent is failed, anything else unknown', () => {
    expect(classifySendError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }))).toBe('failed');
    expect(classifySendError(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))).toBe('failed');
    expect(classifySendError(Object.assign(new Error('blocked'), { name: 'OutboundBlockedError' }))).toBe('failed');
    expect(classifySendError(new DOMException('This operation was aborted', 'AbortError'))).toBe('unknown');
    expect(classifySendError(new Error('socket hang up'))).toBe('unknown');
  });

  it('a delivery that times out is unknown, not failed', async () => {
    const sender = new WebhookSender({
      timeoutMs: 20,
      fetchImpl: (_url, init) =>
        new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    const outcome = await sender.deliver(target as never, [], sub);
    expect(outcome).toMatchObject({ ok: false, outcome: 'unknown' });
  });

  it('a rejected delivery is failed', async () => {
    const sender = new WebhookSender({ fetchImpl: async () => new Response('nope', { status: 422 }) });
    expect(await sender.deliver(target as never, [], sub)).toMatchObject({ ok: false, httpStatus: 422, outcome: 'failed' });
  });
});
