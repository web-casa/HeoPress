import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LlmProviderCreateSchema, LlmRouteSetSchema, LlmSettingsSchema } from '@heopress/contracts/schemas';

/**
 * The model provider guide's examples are the API's own inputs (HeoPress P04
 * task 7.5): every JSON block of `docs/en/deployment/model-providers.md` is
 * validated by the schema the API uses for it, so a renamed or retyped field
 * fails here rather than in a reader's request.
 */

const DOC = resolve(__dirname, '../../../../docs/en/deployment/model-providers.md');
const blocks = [...readFileSync(DOC, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]!) as Record<string, unknown>);

/** Keys of `raw` (at any depth) that the parsed value no longer has. */
function droppedKeys(raw: unknown, parsed: unknown, path = ''): string[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const kept = (parsed ?? {}) as Record<string, unknown>;
  return Object.entries(raw as Record<string, unknown>).flatMap(([k, v]) =>
    k in kept ? droppedKeys(v, kept[k], `${path}${k}.`) : [`${path}${k}`],
  );
}

const schemaFor = (block: Record<string, unknown>) =>
  'baseUrl' in block ? LlmProviderCreateSchema : 'providerIds' in block ? LlmRouteSetSchema : 'monthlyBudgetMicros' in block ? LlmSettingsSchema : null;

describe('the model provider guide', () => {
  it('has an example for DeepSeek, Qwen, Kimi and GLM, plus a route and the settings', () => {
    const names = blocks.filter((b) => 'baseUrl' in b).map((b) => b.name);
    expect(names).toEqual(['DeepSeek', 'Qwen Plus', 'Kimi', 'GLM']);
    expect(blocks.some((b) => 'providerIds' in b)).toBe(true);
    expect(blocks.some((b) => 'monthlyBudgetMicros' in b)).toBe(true);
  });

  it('every example is a valid API input, with nothing the API would ignore', () => {
    for (const block of blocks) {
      const schema = schemaFor(block);
      expect(schema, JSON.stringify(block)).not.toBeNull();
      const parsed = schema!.safeParse(block);
      expect(parsed.success, `${JSON.stringify(block)}: ${parsed.success ? '' : JSON.stringify(parsed.error.issues)}`).toBe(true);
      // Unknown keys, at any depth, would be dropped silently by the schema: a misspelt field must fail here instead.
      expect(droppedKeys(block, parsed.data), JSON.stringify(block)).toEqual([]);
    }
  });

  it('every endpoint it names is one the model router registers (method and path)', () => {
    const router = readFileSync(resolve(__dirname, '../routes/llm.ts'), 'utf8');
    const registered = new Set([...router.matchAll(/llmRouter\.(get|post|put|patch|delete)\('([^']+)'/g)].map((m) => `${m[1]!.toUpperCase()} ${m[2]}`));
    const named = [...readFileSync(DOC, 'utf8').matchAll(/`(GET|POST|PUT|PATCH|DELETE) \/api\/v1\/llm(\/[^`?\s]*)/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(named.length).toBeGreaterThanOrEqual(10);
    for (const endpoint of named) expect(registered, endpoint).toContain(endpoint);
  });

  it('sets the site currency before creating providers priced in it (a new site has the instance currency)', () => {
    const settings = blocks.findIndex((b) => 'monthlyBudgetMicros' in b);
    const firstProvider = blocks.findIndex((b) => 'baseUrl' in b);
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(settings).toBeLessThan(firstProvider);
  });

  it('the providers of one site share its currency', () => {
    const currencies = new Set(blocks.map((b) => b.currency).filter(Boolean));
    expect(currencies).toEqual(new Set(['CNY']));
  });
});
