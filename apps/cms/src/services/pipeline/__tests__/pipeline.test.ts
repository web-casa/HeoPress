import { describe, expect, it } from 'vitest';
import { listOperations, registerHandler } from '../../flow-service';
import type { ChatCallInput, ChatCallResult } from '../../llm/gateway';
import type { TranslationRequest, TranslationResult, TranslationService } from '../../llm/translation-service';
import { protectTerms, restoreTerms, translateBlocks, type TranslationMemoryStore } from '../block-translation';
import { publishProposer, qualityGateRunner, setPublishProposer, setQualityGateRunner } from '../extension-points';
import { ResearchTerminatedError, runResearch } from '../research';
import { isForbiddenOperationKey, keepOnlyLinks, productionKey, sanitizeModelHtml, sanitizeModelText } from '../safety';

/** HeoPress P09 tasks 1.1–1.3, 1.5, 1.6, 1.8, 1.9: the pipeline's pure parts, with fixed model answers. */

class Memory implements TranslationMemoryStore {
  learned: Array<{ source: string; target: string }> = [];
  constructor(private readonly rows: Record<string, string> = {}) {}
  async exact(texts: string[]) {
    return new Map(texts.filter((t) => t in this.rows).map((t) => [t, this.rows[t]!]));
  }
  async fuzzy() {
    return null;
  }
  async learn(pairs: Array<{ source: string; target: string }>) {
    this.learned.push(...pairs);
  }
  async hit() {}
}

class Translator implements TranslationService {
  requests: TranslationRequest[] = [];
  async translate(req: TranslationRequest): Promise<TranslationResult> {
    this.requests.push(req);
    return { segments: req.segments.map((s) => ({ id: s.id, text: `ZH:${s.text}` })), engine: 'llm', provider: 'mock', model: 'm', callId: 'c1' };
  }
}

describe('idempotency key (1.2, 1.8)', () => {
  const base = { siteId: 's', sources: ['source_document:a@h1', 'source_document:b@h2'], targetLocale: 'zh-CN', mode: 'rewrite', promptVersion: 'rewrite@1', editorialProfileVersion: 3 };
  it('ignores source order; changes with version, language, mode, prompt and policy', () => {
    expect(productionKey(base)).toBe(productionKey({ ...base, sources: [...base.sources].reverse() }));
    for (const change of [
      { sources: ['source_document:a@h1b', 'source_document:b@h2'] },
      { targetLocale: 'ja' },
      { mode: 'write' },
      { promptVersion: 'rewrite@2' },
      { editorialProfileVersion: 4 },
      { siteId: 't' },
    ]) {
      expect(productionKey({ ...base, ...change })).not.toBe(productionKey(base));
    }
  });
});

describe('output sanitisation (1.6)', () => {
  it('drops scripts, handlers and invisible characters; keeps block ids', () => {
    const out = sanitizeModelHtml('<p data-block-id="b1" onclick="x()">Hi​ there<script>publish()</script></p><iframe src="https://example.com"></iframe>');
    expect(out).toBe('<p data-block-id="b1">Hi there</p>');
    expect(sanitizeModelText('<b>Title</b>‍\n now', 100)).toBe('Title now');
  });
  it('unwraps links that are not the production\'s sources (a model cannot swap a source URL)', () => {
    const out = keepOnlyLinks('<p><a href="https://evil.example.net/x">a</a> <a href="https://wire.example.com/a#x">b</a></p>', ['https://wire.example.com/a']);
    expect(out).toBe('<p><span>a</span> <a href="https://wire.example.com/a#x" rel="nofollow noopener noreferrer">b</a></p>');
  });
});

describe('block translation (1.3)', () => {
  it('memory first: an exact match calls no model', async () => {
    const t = new Translator();
    const out = await translateBlocks({ siteId: 's', from: 'en', to: 'zh-CN', blocks: [{ key: 'b1', text: '<p>Hello</p>' }], memory: new Memory({ '<p>Hello</p>': '<p>你好</p>' }), glossary: [], service: t, context: 'x' });
    expect(t.requests).toHaveLength(0);
    expect(out.blocks).toEqual([{ key: 'b1', text: '<p>你好</p>', origin: 'memory' }]);
  });
  it('glossary terms become placeholders and come back as the glossary says; model output is learned', async () => {
    const t = new Translator();
    const m = new Memory();
    const out = await translateBlocks({
      siteId: 's',
      from: 'en',
      to: 'zh-CN',
      blocks: [{ key: 'b1', text: '<p>Example Harbour and HeoPress</p>' }],
      memory: m,
      glossary: [
        { term: 'Example Harbour', translation: '示例港', rule: 'prefer' },
        { term: 'HeoPress', translation: 'HeoPress', rule: 'do-not-translate' },
      ],
      service: t,
      context: 'x',
    });
    expect(t.requests[0]!.segments[0]!.text).toBe('<p>⟦T0⟧ and ⟦T1⟧</p>');
    expect(out.blocks[0]!.text).toBe('ZH:<p>示例港 and HeoPress</p>');
    expect(m.learned).toEqual([{ source: '<p>Example Harbour and HeoPress</p>', target: 'ZH:<p>示例港 and HeoPress</p>' }]);
  });
  it('whole words only for Latin terms; a lost placeholder is refused', () => {
    expect(protectTerms('cats and cat', [{ term: 'cat', translation: '猫', rule: 'prefer' }]).text).toBe('cats and ⟦T0⟧');
    expect(restoreTerms('no token', [{ token: '⟦T0⟧', value: '猫' }])).toBeNull();
  });
});

describe('research agent (1.5)', () => {
  const reply = (content: unknown, n: number): ChatCallResult => ({ response: { content: JSON.stringify(content), toolCalls: [] }, provider: 'p', model: 'm', callId: `c${n}`, attemptIds: [] });
  const run = (answers: unknown[], limits = { maxSteps: 3, maxMs: 60_000, maxCostMicros: 1_000 }, cost = 0) => {
    const ran: string[] = [];
    let n = 0;
    const promise = runResearch(
      {
        chat: async (_req: ChatCallInput) => reply(answers[Math.min(n, answers.length - 1)], n++),
        tools: { read_source: async () => (ran.push('read_source'), { text: 'x' }), site_search: async () => (ran.push('site_search'), []) },
        costOf: async () => cost,
        onCall: async () => {},
      },
      { siteId: 's', productionId: 'p', brief: {}, limits, editorialProfileVersion: null, promptVersion: 'write@1' },
    );
    return { promise, ran };
  };
  it('refuses tools outside the whitelist and stops at the step cap', async () => {
    const { promise, ran } = run([{ action: 'tool', tool: 'publish', args: {} }]);
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResearchTerminatedError);
    expect((err as ResearchTerminatedError).reason).toBe('max_steps');
    expect((err as ResearchTerminatedError).steps.map((s) => s.outcome)).toEqual(['refused', 'refused', 'refused']);
    expect(ran).toEqual([]);
  });
  it('stops at the money cap', async () => {
    const { promise } = run([{ action: 'tool', tool: 'site_search', args: {} }], { maxSteps: 10, maxMs: 60_000, maxCostMicros: 1_000 }, 600);
    expect(((await promise.catch((e: unknown) => e)) as ResearchTerminatedError).reason).toBe('max_cost');
  });
  it('runs whitelisted tools and finishes', async () => {
    const { promise, ran } = run([{ action: 'tool', tool: 'read_source', args: {} }, { action: 'finish', notes: 'done' }]);
    expect((await promise).notes).toBe('done');
    expect(ran).toEqual(['read_source']);
  });
});

describe('operations (1.1, 1.9)', () => {
  it('registers the pipeline operations and no detection-evasion or cross-site linking operation', () => {
    const keys = listOperations().map((o) => o.key);
    for (const k of ['pipeline:fetch-source', 'pipeline:translate', 'pipeline:rewrite', 'pipeline:write', 'pipeline:seo-copy', 'pipeline:run-gate', 'pipeline:propose-publish']) {
      expect(keys).toContain(k);
    }
    expect(keys.filter(isForbiddenOperationKey)).toEqual([]);
    for (const bad of ['humanize', 'ai-detection-bypass', 'evade-ai-detector', 'cross-site-auto-link', 'link-farm']) {
      expect(() => registerHandler(bad, async () => ({}))).toThrow(/not allowed/);
    }
    expect(isForbiddenOperationKey('pipeline:translate')).toBe(false);
  });
  it('no runner installed means the built-in gate; the default publish proposer never publishes', async () => {
    expect(qualityGateRunner()).toBeNull();
    const gate = { status: 'passed' as const, itemVersion: 2, checks: [] };
    expect(await publishProposer().propose({ siteId: 's', productionId: 'p', collection: 'articles', itemId: 'i', itemVersion: 2, gate })).toMatchObject({ decision: 'review_queue' });
  });
  it('later slices install the gate and the publish decision; null restores the defaults', async () => {
    setQualityGateRunner({ run: async (req) => ({ status: 'passed', itemVersion: req.itemVersion, checks: [] }) });
    setPublishProposer({ propose: async (req) => ({ decision: 'veto_window', reason: 'l3', itemVersion: req.itemVersion }) });
    expect((await qualityGateRunner()!.run({ siteId: 's', productionId: 'p', collection: 'a', itemId: 'i', itemVersion: 1 })).status).toBe('passed');
    expect((await publishProposer().propose({ siteId: 's', productionId: 'p', collection: 'a', itemId: 'i', itemVersion: 1, gate: null })).decision).toBe('veto_window');
    setQualityGateRunner(null);
    setPublishProposer(null);
    expect(qualityGateRunner()).toBeNull();
  });
});
