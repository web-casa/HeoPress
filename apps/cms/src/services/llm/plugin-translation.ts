/**
 * A translation served by a plugin-provided machine-translation service (HeoPress v1.2, spec
 * extensions/translation-services "按字符计费").
 *
 * The service is called exactly once per translation, inside the gateway's ledger path: the attempt (and its reservation,
 * priced by characters) exists before the plugin is asked, so a site whose budget is used up never pays a provider, and the
 * call is settled with the characters it translated. `input_tokens`/`output_tokens` stay null — this is not a token call —
 * and `billed_characters` carries what the price applies to.
 *
 * The plugin only returns segments; the host fills in what a plugin cannot know: `engine`/`provider` (`plugin:<plugin>`),
 * `model` (the declared engine) and `callId` (the ledger call). The answer must be exactly the requested segments, in the
 * requested order; anything else is refused after the call is recorded, like a model answer that is not JSON.
 */
import { translationAnswerSegments } from '@heopress/contracts/extensions';
import { digest, type Candidate } from './ledger';
import { TranslationError, type TranslationRequest, type TranslationResult } from './translation-service';
import type { LlmGateway } from './gateway';
import { runTranslationService, translationFailureCode, type LoadedTranslationService } from '../../extensions/runtime/translation-services';

/** A gateway a translation needs: the model path (`chat`) and, for a plugin service, the ledger (`external`, `currency`). */
export type TranslationGateway = Pick<LlmGateway, 'chat'> & Partial<Pick<LlmGateway, 'external' | 'currency'>>;

/** The gateway methods the plugin path needs, once they are known to be present. */
type LedgerGateway = Pick<LlmGateway, 'external' | 'currency'>;

/** The ledger candidate of one plugin service: named after the plugin, modelled by its declared engine, priced per character. */
export function pluginTranslationCandidate(service: LoadedTranslationService, currency: string): Candidate {
  return {
    // The ledger's two sources are "a site provider row" and "a service without one"; a plugin service is the latter. Its
    // `instanceRef` and snapshot name say exactly what it is, and no provider key is involved.
    source: 'instance',
    instanceRef: `plugin:${service.plugin}/${service.id}`,
    name: `plugin:${service.plugin}`,
    protocol: 'plugin',
    baseUrl: null,
    model: service.engine,
    pricing: { kind: 'per_1m_chars', charsMicros: service.charsMicros },
    currency,
    // The attempt's lease has to cover the plugin's own deadline plus the gateway's grace.
    timeoutMs: Math.max(1_000, service.durationMs + 5_000),
    capabilities: { tools: false, json: true, maxContext: null },
    fingerprint: digest({
      protocol: 'plugin',
      plugin: service.plugin,
      service: service.id,
      engine: service.engine,
      charsMicros: service.charsMicros,
    }),
  };
}

/** Translate `req` with `service`, recorded through the ledger and priced by characters. */
export async function translateWithPlugin(
  gateway: LedgerGateway,
  service: LoadedTranslationService,
  req: TranslationRequest,
): Promise<TranslationResult> {
  if (!req.segments.length) throw new TranslationError('EMPTY_REQUEST', 'Nothing to translate.');
  const characters = req.segments.reduce((n, s) => n + s.text.length, 0);
  const currency = await gateway.currency(req.siteId);
  const out = await gateway.external({
    siteId: req.siteId,
    taskType: 'translation',
    capability: req.capability ?? 'translate',
    origin: req.origin ?? { kind: 'translation' },
    callKey: req.callKey,
    candidate: pluginTranslationCandidate(service, currency),
    attempts: 1,
    characters,
    request: {
      service: service.id,
      sourceLocale: req.sourceLocale,
      targetLocale: req.targetLocale,
      segments: req.segments.map((s) => s.id),
    },
    deadlineMs: Math.max(1_000, service.durationMs + 10_000),
    signal: req.signal,
    send: async (signal) => {
      try {
        const answer = await runTranslationService(
          service,
          {
            sourceLocale: req.sourceLocale,
            targetLocale: req.targetLocale,
            segments: req.segments,
            glossary: req.glossary ?? [],
            memory: req.memory ?? [],
          },
          { siteId: req.siteId, signal },
        );
        return {
          kind: 'ok',
          content: JSON.stringify({ answer }),
          toolCalls: [],
          // Characters are the usage of a plugin translation; tokens do not exist here.
          usage: { complete: false, inputTokens: null, outputTokens: null, characters },
        };
      } catch (err) {
        // The plugin was called and failed (timeout, request budget, its own throw): one attempt, no failover.
        return { kind: 'failed', errorCode: translationFailureCode(err) };
      }
    },
    transferable: () => false,
    between: async () => undefined,
  });
  const answer = (out.value as { answer: unknown } | null)?.answer;
  const segments = translationAnswerSegments(answer, req.segments);
  if (!segments) {
    throw new TranslationError('BAD_TRANSLATION', `The service ${service.plugin}:${service.id} did not translate exactly the requested segments.`);
  }
  return {
    segments,
    engine: `plugin:${service.plugin}`,
    provider: `plugin:${service.plugin}`,
    model: service.engine,
    callId: out.callId,
  };
}
