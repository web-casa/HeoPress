/**
 * Which translation service a site's translations use (HeoPress v1.2, spec extensions/translation-services
 * "站点选择与宿主接线").
 *
 * The site's model settings name a plugin-provided service (`translationService = "<plugin name>:<service id>"`,
 * `PUT /api/v1/llm/settings`). On every translation this router reads that setting:
 *
 *   - none → `LlmTranslationService`, unchanged: one model call through the gateway, priced by tokens, in the ledger;
 *   - a service → the plugin's `translate`, recorded in the same ledger but priced by characters (`plugin-translation.ts`).
 *
 * A selected service that is not offered (the plugin was disabled, the id is not declared any more, permissions await
 * re-confirmation) is an error, never a silent fall back to the model: falling back would turn a translation the operator
 * expected from one engine into a billed model call with different wording.
 */
import { eq } from 'drizzle-orm';
import { llmSiteSettings, type Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import { DUAL_MODEL_TRANSLATION_SERVICE, isBuiltinTranslationService } from '@heopress/contracts/extensions';
import { LlmTranslationService, TranslationError, type TranslationRequest, type TranslationResult, type TranslationService } from './translation-service';
import { translateWithPlugin, type TranslationGateway } from './plugin-translation';
import { DualModelTranslationService, siteDualModelSettings } from './dual-model-translation';
import type { LlmGateway } from './gateway';
import { PluginTranslationServices, type LoadedTranslationService } from '../../extensions/runtime/translation-services';
import { PluginHost } from '../../extensions/runtime/plugin-host';

/** Resolves a site's selected plugin service; `plugin-translation.ts` never loads plugins itself. */
export type { TranslationGateway };

export interface TranslationServiceRegistry {
  resolve(siteId: string, ref: string): Promise<LoadedTranslationService | null>;
}

export interface TranslationServiceRouterDeps {
  db: Database;
  gateway: TranslationGateway;
  /** Tests: the plugin registry (default: the site's plugins through `PluginHost`). */
  plugins?: TranslationServiceRegistry;
  /** The bindings to load plugins with (default: `PluginHost`'s, which reads `process.env`). */
  env?: Record<string, unknown>;
  /** Opens the site's plugin secrets for the selected service (spec extensions/plugin-secrets). */
  keys?: KeyProvider;
  /** Tests: the LLM implementation (default: `LlmTranslationService` over `gateway`). */
  llm?: TranslationService;
  /** Tests: the built-in two-model implementation (default: `DualModelTranslationService` over the gateway and settings). */
  dualModel?: TranslationService;
}

/** The site's selection (`"<plugin name>:<service id>"`), or null for the LLM path. */
async function selectedTranslationService(db: Database, siteId: string): Promise<string | null> {
  const [row] = await db
    .select({ translationService: llmSiteSettings.translationService })
    .from(llmSiteSettings)
    .where(eq(llmSiteSettings.siteId, siteId))
    .limit(1);
  return row?.translationService ?? null;
}

export class TranslationServiceRouter implements TranslationService {
  private llmService: TranslationService | null = null;
  private dualModelService: TranslationService | null = null;
  private registry: TranslationServiceRegistry | null = null;

  constructor(private readonly deps: TranslationServiceRouterDeps) {}

  private llm(): TranslationService {
    this.llmService ??= this.deps.llm ?? new LlmTranslationService(this.deps.gateway);
    return this.llmService;
  }

  private dualModel(): TranslationService {
    this.dualModelService ??=
      this.deps.dualModel ??
      new DualModelTranslationService({
        // The gateway must be able to call one explicit binding; without it a selected built-in service fails clearly.
        gateway: this.deps.gateway as Pick<LlmGateway, 'chatWithProvider'>,
        settings: siteDualModelSettings(this.deps.db),
      });
    return this.dualModelService;
  }

  private plugins(): TranslationServiceRegistry {
    this.registry ??=
      this.deps.plugins ??
      new PluginTranslationServices(new PluginHost({ db: this.deps.db, env: this.deps.env, keys: this.deps.keys }));
    return this.registry;
  }

  async translate(req: TranslationRequest): Promise<TranslationResult> {
    // Nothing to translate is refused before a service is loaded or a call is recorded, whichever path would answer.
    if (!req.segments.length) throw new TranslationError('EMPTY_REQUEST', 'Nothing to translate.');
    const selection = await selectedTranslationService(this.deps.db, req.siteId);
    if (!selection) return this.llm().translate(req);
    if (isBuiltinTranslationService(selection)) {
      // The `heopress` namespace is the host's: a built-in selection is never resolved as a plugin.
      if (selection !== DUAL_MODEL_TRANSLATION_SERVICE) {
        throw new TranslationError('SERVICE_UNAVAILABLE', `The built-in translation service "${selection}" is not available.`);
      }
      if (!this.deps.dualModel && !this.deps.gateway.chatWithProvider) {
        throw new TranslationError('SERVICE_UNAVAILABLE', `The built-in translation service "${selection}" is not available.`);
      }
      return this.dualModel().translate(req);
    }
    const service = await this.plugins().resolve(req.siteId, selection);
    if (!service) {
      throw new TranslationError(
        'SERVICE_UNAVAILABLE',
        `The selected translation service "${selection}" is not offered by an enabled, approved plugin of this site.`,
      );
    }
    if (!this.deps.gateway.external || !this.deps.gateway.currency) {
      throw new TranslationError('SERVICE_UNAVAILABLE', 'The model ledger is not available to record a plugin translation.');
    }
    return translateWithPlugin(this.deps.gateway as Pick<LlmGateway, 'external' | 'currency'>, service, req);
  }
}
