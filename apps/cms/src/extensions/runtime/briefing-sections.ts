/**
 * The Studio overview's briefing, from the site's plugins (HeoPress v1.1, spec extensions/briefing-sections
 * "简报分节").
 *
 * A plugin with `ext:briefing-sections` registers one or more sections in its bundle, each declared by id in its manifest
 * (`briefingSections`). Every request computes them: `compute` is called inside the host's per-call limits (a deadline
 * and a request budget, `BRIEFING_LIMITS`), and its answer is checked against `BriefingSectionPayloadSchema` — a count
 * and at most ten site-relative links.
 *
 * One section is isolated from the others and from the request: a compute that throws, times out or returns something
 * the contract does not allow is left out (and logged), and the remaining sections — of that plugin and of every other —
 * are returned. The list is read for the active site only; a plugin on another site is never asked.
 */
import { BriefingSectionPayloadSchema, type BriefingSectionItem } from '@heopress/contracts/extensions';
import { formatSafeError } from '@heopress/contracts/utils';
import { RunLimitError, withRunScope } from './run-scope';
import type { PluginHost } from './plugin-host';

/** One section as the Studio receives it. */
export interface BriefingSectionView {
  /** The plugin that contributed it. */
  plugin: string;
  /** The plugin's display name (its manifest's `displayName`, else its name). */
  pluginName: string;
  id: string;
  title: string;
  description: string | null;
  /** How many things there are (may be more than `items` lists). */
  count: number;
  items: BriefingSectionItem[];
}

/** `displayName` of a plugin row, else its name. */
function displayNameOf(row: { name: string; manifest: unknown }): string {
  const displayName = (row.manifest as { displayName?: unknown } | null)?.displayName;
  return typeof displayName === 'string' && displayName.length > 0 ? displayName : row.name;
}

export class PluginBriefing {
  constructor(private readonly host: PluginHost) {}

  /**
   * The briefing of `siteId`: every section of every enabled, approved plugin holding `ext:briefing-sections`, in plugin
   * and registration order. A section that cannot be computed in time, throws or answers outside the contract is omitted.
   */
  async list(siteId: string): Promise<BriefingSectionView[]> {
    const out: BriefingSectionView[] = [];
    for (const plugin of await this.host.loadAll(siteId, 'briefing-sections')) {
      const pluginName = displayNameOf(plugin.row);
      for (const section of plugin.briefingSections) {
        try {
          const { value } = await withRunScope(
            { durationMs: section.durationMs, maxRequests: section.maxRequests, label: `briefing ${plugin.name}/${section.id}` },
            (scope) => section.compute({ siteId, signal: scope.signal }),
          );
          const payload = BriefingSectionPayloadSchema.safeParse(value ?? {});
          if (!payload.success) {
            console.warn(
              `[plugin-briefing] "${plugin.name}/${section.id}" on ${siteId}: its answer is not a briefing payload`,
              payload.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            );
            continue;
          }
          out.push({
            plugin: plugin.name,
            pluginName,
            id: section.id,
            title: section.title,
            description: section.description,
            count: payload.data.count,
            items: payload.data.items,
          });
        } catch (err) {
          // A section that cannot answer is left out; the others — and the request — carry on (HeoPress P12 task 9.1).
          const why = err instanceof RunLimitError ? err.message : formatSafeError(err);
          console.warn(`[plugin-briefing] "${plugin.name}/${section.id}" on ${siteId}: its section was left out`, why);
        }
      }
    }
    return out;
  }
}
