/**
 * Plugin-provided translation services (HeoPress v1.2, spec extensions/translation-services "站点选择与宿主接线").
 *
 * A plugin with `ext:translation-services` registers one or more services in its bundle, each declared by id in its
 * manifest (`translationServices`) together with the engine it stands for and the price per million characters. A site
 * selects one with `translationService = "<plugin name>:<service id>"`; this module answers which service that is, and runs
 * a call inside the host's per-call limits (a deadline and an outbound-request budget, `TRANSLATION_LIMITS`) — exactly the
 * way `briefing-sections.ts` runs a briefing section.
 *
 * The service only ever sees what a translator needs: the locales, the segments, the glossary and memory references, the
 * site id and an abort signal. Its answer is checked against `PluginTranslationAnswerSchema` by the caller (the ledger
 * path), so an answer that is not exactly the requested segments never reaches content.
 */
import { type PluginTranslationRequest, parseTranslationServiceRef } from '@heopress/contracts/extensions';
import { RunLimitError, withRunScope } from './run-scope';
import type { LoadedPlugin, PluginHost } from './plugin-host';

/** One service a site may translate with: the plugin that offers it and its declaration. */
export interface LoadedTranslationService {
  /** The plugin's name (its manifest's `name`). */
  plugin: string;
  /** The plugin's display name (its manifest's `displayName`, else its name). */
  pluginName: string;
  id: string;
  displayName: string;
  /** The declared upstream engine (`deepl`, `google`, …); it becomes the call's model. */
  engine: string;
  /** Micro-units per million characters (0 when the manifest declares no price). */
  charsMicros: number;
  durationMs: number;
  maxRequests: number;
  translate(request: PluginTranslationRequest): Promise<unknown>;
}

/** `displayName` of a plugin row, else its name. */
function displayNameOf(row: { name: string; manifest: unknown }): string {
  const displayName = (row.manifest as { displayName?: unknown } | null)?.displayName;
  return typeof displayName === 'string' && displayName.length > 0 ? displayName : row.name;
}

export class PluginTranslationServices {
  constructor(private readonly host: PluginHost) {}

  /**
   * Every translation service of the site's enabled, approved plugins holding `ext:translation-services`, in plugin and
   * registration order. A service the manifest declares but the bundle never registered does not appear.
   */
  async list(siteId: string): Promise<LoadedTranslationService[]> {
    const out: LoadedTranslationService[] = [];
    for (const plugin of await this.host.loadAll(siteId, 'translation-services')) {
      const pluginName = displayNameOf(plugin.row);
      for (const service of plugin.translationServices) {
        out.push({
          plugin: plugin.name,
          pluginName,
          id: service.id,
          displayName: service.displayName,
          engine: service.engine,
          charsMicros: service.charsMicros,
          durationMs: service.durationMs,
          maxRequests: service.maxRequests,
          translate: async (request) => service.translate(request),
        });
      }
    }
    return out;
  }

  /** The service a site's selection names, or null when it is not offered here (disabled, undeclared, not registered…). */
  async resolve(siteId: string, ref: string): Promise<LoadedTranslationService | null> {
    const parsed = parseTranslationServiceRef(ref);
    if (!parsed) return null;
    const services = await this.list(siteId);
    return services.find((s) => s.plugin === parsed.plugin && s.id === parsed.service) ?? null;
  }
}

/**
 * Run one `translate` call inside the service's limits: the deadline and the outbound-request budget bound the plugin's own
 * API calls too (`ctx.fetch` charges the scope), and a call that runs out of time is terminated rather than extended.
 * `signal` is the ledger attempt's stop signal (the gateway's deadline and lease); aborting it stops the scope at once.
 */
export async function runTranslationService(
  service: LoadedTranslationService,
  request: Omit<PluginTranslationRequest, 'siteId'>,
  opts: { siteId: string; signal?: AbortSignal },
): Promise<unknown> {
  const { value } = await withRunScope(
    { durationMs: service.durationMs, maxRequests: service.maxRequests, label: `translation ${service.plugin}/${service.id}` },
    async (scope) => {
      const stop = () => scope.stop(new RunLimitError('stopped', `translation ${service.plugin}/${service.id} was stopped`));
      if (opts.signal?.aborted) stop();
      opts.signal?.addEventListener('abort', stop, { once: true });
      try {
        return await service.translate({ ...request, siteId: opts.siteId, signal: scope.signal });
      } finally {
        opts.signal?.removeEventListener('abort', stop);
      }
    },
  );
  return value;
}

/** The refusal code of a plugin call that failed, for the ledger's `errorCode` (never the plugin's text). */
export function translationFailureCode(err: unknown): 'PLUGIN_TIMEOUT' | 'PLUGIN_LIMIT' | 'PLUGIN_ERROR' {
  if (err instanceof RunLimitError) return err.reason === 'timeout' ? 'PLUGIN_TIMEOUT' : 'PLUGIN_LIMIT';
  return 'PLUGIN_ERROR';
}
