/**
 * Pipeline extensions of a plugin (HeoPress P12 tasks 4.1–4.3; spec extensions/pipeline-extensions; ADR-0015): the
 * manifest declarations of the plugin's source adapters, quality-gate checks and build steps. The declarations are data
 * the CMS reads without loading the plugin (what to list, what the gate must run, what a build may run); the source
 * adapters and gate checks themselves are code the plugin registers at load time on the declared extension point
 * (`ctx.extensionPoints.register('source-adapters' | 'gate-checks', …)`), under the same ids.
 *
 *   - `sourceAdapters` (needs `ext:source-adapters`): new source types. An adapter only **discovers**: it reads a listing
 *     through the plugin's host-bound `fetch` (its `http:fetch:<host>` capabilities and the platform outbound boundary)
 *     and returns links; each link is recorded, de-duplicated and fetched by the core like a feed item's. A source of a
 *     plugin type starts with the default terms (licence `unknown`, usage `discovery_only`) like any other.
 *   - `gateChecks` (needs `ext:gate-checks`): extra quality-gate checks. A check's verdict is `passed`, `blocked` or
 *     `needs_review` with evidence; it is added to the core checks and can only make the overall verdict stricter. A
 *     declared check that is not registered, throws or times out counts as `needs_review`.
 *   - `buildSteps` (needs `ext:build-steps`): steps of the static (Astro) build, e.g. a PDF or social-image generator.
 *     A build step is trusted build code: it runs only for a plugin the operator marked as trusted, with the build's
 *     limits (no CMS secrets or admin credentials, only the package registry and the read-only page data interface).
 *
 * Pure functions and Zod schemas: shared by the CMS (install, upgrade, runtime), Studio and the build.
 */
import { z } from 'zod';
import { declaresExtensionPoint } from './capabilities';

/** An adapter, check or step id: lowercase words joined by `_` or `-`. */
const ID = /^[a-z][a-z0-9_-]{0,39}$/;

export const ExtensionSourceAdapterSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
});

export const ExtensionGateCheckSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  /** Collections (machine names) the check looks at; absent: every collection the gate checks. */
  collections: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)).max(32).optional(),
  /** How long one check may take (default 5 s, at most 30 s); longer counts as `needs_review`. */
  timeoutMs: z.number().int().min(100).max(30_000).optional(),
});

/** Upper bound of one build step's wall time. */
export const MAX_BUILD_STEP_MS = 10 * 60_000;
export const DEFAULT_BUILD_STEP_MS = 2 * 60_000;

export const ExtensionBuildStepSchema = z.object({
  id: z.string().regex(ID),
  label: z.string().min(1).max(80).optional(),
  /**
   * The step's program: an ES module run with Node in the build's restricted child process. It reads the page data
   * interface (`HEOPRESS_PAGE_DATA_URL` / `HEOPRESS_PAGE_DATA_TOKEN`) and the built pages, and writes its assets under
   * `HEOPRESS_BUILD_STEP_OUT_DIR` (published with the build at `/_build/<namespace>/<step>/`).
   */
  source: z.string().min(1).max(200_000),
  timeoutMs: z.number().int().min(1000).max(MAX_BUILD_STEP_MS).optional(),
});

/** The pipeline-extension declarations of a manifest (all optional). */
export const PipelineDeclarationsSchema = z.object({
  sourceAdapters: z.array(ExtensionSourceAdapterSchema).max(8).optional(),
  gateChecks: z.array(ExtensionGateCheckSchema).max(16).optional(),
  buildSteps: z.array(ExtensionBuildStepSchema).max(8).optional(),
});

export type ExtensionSourceAdapter = z.infer<typeof ExtensionSourceAdapterSchema>;
export type ExtensionGateCheck = z.infer<typeof ExtensionGateCheckSchema>;
export type ExtensionBuildStep = z.infer<typeof ExtensionBuildStepSchema>;
export type PipelineDeclarations = z.infer<typeof PipelineDeclarationsSchema>;

export const PIPELINE_DECLARATION_KEYS = ['sourceAdapters', 'gateChecks', 'buildSteps'] as const;

const POINT_OF: Record<(typeof PIPELINE_DECLARATION_KEYS)[number], 'source-adapters' | 'gate-checks' | 'build-steps'> = {
  sourceAdapters: 'source-adapters',
  gateChecks: 'gate-checks',
  buildSteps: 'build-steps',
};

export interface PipelineDeclarationIssue {
  path: string;
  message: string;
}

/**
 * Check the pipeline declarations against themselves and the capabilities (requested or granted): each kind needs its
 * extension point; ids are unique within a kind.
 */
export function pipelineDeclarationIssues(decl: PipelineDeclarations, capabilities: readonly string[]): PipelineDeclarationIssue[] {
  const issues: PipelineDeclarationIssue[] = [];
  for (const key of PIPELINE_DECLARATION_KEYS) {
    const list = (decl[key] ?? []) as Array<{ id: string }>;
    if (list.length === 0) continue;
    const point = POINT_OF[key];
    if (!declaresExtensionPoint(capabilities, point)) issues.push({ path: key, message: `${key} need the ext:${point} capability` });
    const ids = list.map((x) => x.id);
    if (new Set(ids).size !== ids.length) issues.push({ path: key, message: 'ids repeat' });
  }
  return issues;
}

/** The pipeline declarations of a stored manifest (anything malformed: none). */
export function pipelineDeclarationsOf(manifest: unknown): PipelineDeclarations {
  const parsed = PipelineDeclarationsSchema.safeParse(manifest && typeof manifest === 'object' ? manifest : {});
  return parsed.success ? parsed.data : {};
}

// ---------- source adapters ----------

/**
 * A source's adapter reference: `<plugin name>#<adapter id>` (the plugin's stable name, so the reference survives an
 * upgrade). Sources of type `plugin` carry one.
 */
export function sourceAdapterRef(pluginName: string, adapterId: string): string {
  return `${pluginName}#${adapterId}`;
}

export function parseSourceAdapterRef(ref: string): { plugin: string; adapter: string } | null {
  const i = ref.lastIndexOf('#');
  if (i <= 0) return null;
  const plugin = ref.slice(0, i);
  const adapter = ref.slice(i + 1);
  return /^[a-z0-9][a-z0-9-_/]*$/.test(plugin) && ID.test(adapter) ? { plugin, adapter } : null;
}

// ---------- gate checks ----------

/** The rule name a plugin gate check's result carries: `ext:<namespace>:<check id>`. */
export function pluginGateRule(namespace: string, checkId: string): `ext:${string}` {
  return `ext:${namespace}:${checkId}`;
}

export function isPluginGateRule(rule: string): rule is `ext:${string}` {
  return /^ext:[a-z][a-z0-9_]*:[a-z][a-z0-9_-]*$/.test(rule);
}

/** The verdicts a plugin gate check may give. */
export const PLUGIN_GATE_VERDICTS = ['passed', 'blocked', 'needs_review'] as const;
export type PluginGateVerdict = (typeof PLUGIN_GATE_VERDICTS)[number];
