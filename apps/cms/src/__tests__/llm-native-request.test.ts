import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The native adapters (Anthropic, Gemini) as the model gateway uses them
 * (HeoPress P04 task 7.4; Codex review of the gateway #2, #6): the output
 * cap the gateway reserved for is the one sent, and an error response
 * keeps its status and usage (it may be billed).
 */

const sent = vi.hoisted(() => ({ bodies: [] as Array<Record<string, unknown>>, reply: null as Response | null }));
vi.mock('../services/service-fetch', () => ({
  serviceFetch: async (_url: string, init: RequestInit) => {
    sent.bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return sent.reply ?? new Response('{}', { status: 500 });
  },
}));

import { AnthropicProvider, GeminiProvider, ProviderHttpError } from '../services/llm-provider';

describe('native adapters', () => {
  beforeEach(() => {
    sent.bodies.length = 0;
  });

  it('send the output cap they are given (default 1024)', async () => {
    sent.reply = new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
    await new AnthropicProvider('k').chat([{ role: 'user', content: 'x' }], { tools: false, maxTokens: 7 });
    sent.reply = new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    await new GeminiProvider('k').chat([{ role: 'user', content: 'x' }], { tools: false, maxTokens: 9 });
    sent.reply = new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }));
    await new AnthropicProvider('k').chat([{ role: 'user', content: 'x' }], { tools: false });
    expect(sent.bodies[0]).toMatchObject({ max_tokens: 7 });
    expect(sent.bodies[1]).toMatchObject({ generationConfig: { maxOutputTokens: 9 } });
    expect(sent.bodies[2]).toMatchObject({ max_tokens: 1024 });
  });

  it('an error response keeps its status and usage', async () => {
    sent.reply = new Response(JSON.stringify({ error: { message: 'overloaded' }, usage: { input_tokens: 12, output_tokens: 3 } }), { status: 529 });
    const anthropic = await new AnthropicProvider('k').chat([{ role: 'user', content: 'x' }], { tools: false }).catch((e: unknown) => e);
    expect(anthropic).toBeInstanceOf(ProviderHttpError);
    expect(anthropic).toMatchObject({ status: 529, usage: { inputTokens: 12, outputTokens: 3 } });
    sent.reply = new Response(JSON.stringify({ error: {}, usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 } }), { status: 500 });
    const gemini = await new GeminiProvider('k').chat([{ role: 'user', content: 'x' }], { tools: false }).catch((e: unknown) => e);
    expect(gemini).toMatchObject({ status: 500, usage: { inputTokens: 5, outputTokens: 0 } });
    sent.reply = new Response('not json', { status: 503 });
    expect(await new GeminiProvider('k').chat([{ role: 'user', content: 'x' }], { tools: false }).catch((e: unknown) => e)).toMatchObject({ status: 503, usage: undefined });
  });
});
