/**
 * Billing a plugin translation by characters (HeoPress v1.2, spec extensions/translation-services "按字符计费").
 *
 * The arithmetic and the shape of the ledger entry are checked here; the recorded row (one settled attempt, tokens null,
 * `billed_characters` set, visible in the usage report) is checked against a real database in
 * `apps/cms/src/__tests__/translation-services.db.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { charsMicrosOf } from '@heopress/contracts/extensions';
import { reservationOf, type Candidate } from '../ledger';
import { pluginTranslationCandidate } from '../plugin-translation';
import type { LoadedTranslationService } from '../../../extensions/runtime/translation-services';

const service = (charsMicros: number): LoadedTranslationService => ({
  plugin: 'heopress-deepl',
  pluginName: 'DeepL',
  id: 'deepl',
  displayName: 'DeepL',
  engine: 'deepl',
  charsMicros,
  durationMs: 5_000,
  maxRequests: 5,
  translate: async (req) => ({ segments: req.segments.map((s) => ({ id: s.id, text: s.text })) }),
});

const tokenCandidate: Candidate = {
  source: 'instance',
  instanceRef: 'llm-default',
  name: 'Instance default (openai)',
  protocol: 'openai',
  baseUrl: 'https://api.openai.example/v1',
  model: 'gpt-test',
  pricing: { kind: 'per_1m_tokens', inputMicros: 1_000_000, outputMicros: 2_000_000 },
  currency: 'USD',
  timeoutMs: 60_000,
  capabilities: { tools: true, json: true, maxContext: null },
  fingerprint: 'f',
};

describe('a plugin translation is priced by characters', () => {
  it('converts the declaration to micro-units per million characters; omitted means zero', () => {
    expect(charsMicrosOf(20)).toBe(20_000_000);
    expect(charsMicrosOf(0.5)).toBe(500_000);
    expect(charsMicrosOf(undefined)).toBe(0);
  });

  it('reserves price × characters, rounded up to the micro-unit', () => {
    // 20 currency units per million characters: 12 characters cost 240 micro-units.
    expect(reservationOf(pluginTranslationCandidate(service(charsMicrosOf(20)), 'USD'), 0, 0, 12)).toBe(240);
    // A declared price of 0 is still a reservation of 0 (a recorded, explicitly free call).
    expect(reservationOf(pluginTranslationCandidate(service(0), 'USD'), 0, 0, 12)).toBe(0);
    // Rounding: 0.5 per million, 3 characters → 1.5 → 2 micro-units.
    expect(reservationOf(pluginTranslationCandidate(service(charsMicrosOf(0.5)), 'USD'), 0, 0, 3)).toBe(2);
    expect(reservationOf(pluginTranslationCandidate(service(charsMicrosOf(20)), 'USD'), 0, 0, 0)).toBe(0);
  });

  it('leaves a token-priced call untouched: its characters are not part of the reservation', () => {
    expect(reservationOf(tokenCandidate, 1_000, 100, 12)).toBe(1_000 + 200);
    expect(reservationOf(tokenCandidate, 1_000, 100)).toBe(1_200);
  });

  it('the candidate says what the call is, in the ledger and in the usage report', () => {
    const candidate = pluginTranslationCandidate(service(charsMicrosOf(20)), 'USD');
    expect(candidate).toMatchObject({
      name: 'plugin:heopress-deepl',
      instanceRef: 'plugin:heopress-deepl/deepl',
      model: 'deepl',
      pricing: { kind: 'per_1m_chars', charsMicros: 20_000_000 },
    });
  });
});
