import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every model call goes through the model gateway (HeoPress P04 task 7.4,
 * spec platform/llm-providers "逐次调用账本"; design "统一出口").
 *
 * The ledger can only record attempts it sees. A call site that builds a
 * provider itself, or reaches a model endpoint directly, would spend money
 * nobody reserved, settled or can reconcile. A behavioural test cannot see
 * code that forgot to opt in, so this is a source scan of production code
 * (tests excluded): providers are built, and model endpoints addressed,
 * only in the files below; the decision service is only created with the
 * site's ledger.
 */

const SRC = resolve(__dirname, '..');

function productionFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...productionFiles(path));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

const files = productionFiles(SRC).map((path) => ({ path: relative(SRC, path).split(sep).join('/'), text: readFileSync(path, 'utf8') }));
const offenders = (pattern: RegExp, allowed: string[]) => files.filter((f) => pattern.test(f.text) && !allowed.includes(f.path)).map((f) => f.path);

/** Where provider classes and model endpoints may appear. */
const PROVIDER_FILES = [
  'services/llm-provider.ts', // the adapters themselves
  'services/llm/gateway.ts', // the only place that sends with them
  'services/llm/openai-compatible.ts', // the gateway's OpenAI-compatible client
  'services/decision-provider.ts', // the decision service, sent through the gateway's ledger (see below)
  // Not reachable from production code (no caller): must go through the gateway when wired.
  'services/embedding-service.ts',
];

describe('the model gateway is the only outlet', () => {
  it('the scan sees the code it guards', () => {
    expect(files.some((f) => f.path === 'services/llm/gateway.ts')).toBe(true);
    expect(files.some((f) => f.path === 'routes/ai.ts')).toBe(true);
  });

  it('no call site builds a model provider itself', () => {
    expect(offenders(/\bcreate(?:Configured)?LLMProvider\s*\(/, ['services/llm-provider.ts', 'services/decision-provider.ts'])).toEqual([]);
    expect(offenders(/\bnew\s+(?:OpenAI|Anthropic|Gemini|Nvidia|OpenAIEmbedding)Provider\s*\(/, PROVIDER_FILES)).toEqual([]);
  });

  it('no call site addresses a model endpoint directly', () => {
    expect(
      offenders(/\/chat\/completions|\/systemone|\/embeddings|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.openai\.com/, PROVIDER_FILES),
    ).toEqual([]);
  });

  it('the decision service is created with the site’s ledger, and each retry goes through it', () => {
    const calls = files.flatMap((f) =>
      [...f.text.matchAll(/\bcreateDecisionProvider\s*\(([^;]*?)\)\s*;/gs)].map((m) => ({ path: f.path, args: m[1]! })),
    ).filter((c) => !c.path.endsWith('decision-provider.ts'));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.args, c.path).toMatch(/,\s*\{[^}]*gateway/);
    const decision = files.find((f) => f.path === 'services/decision-provider.ts')!.text;
    const constructions = [...decision.matchAll(/new SystemOneDecisionProvider\(\{([\s\S]*?)\}\)/g)];
    expect(constructions.length).toBeGreaterThan(0);
    for (const m of constructions) expect(m[1]).toMatch(/\bledger:/);
  });
});
