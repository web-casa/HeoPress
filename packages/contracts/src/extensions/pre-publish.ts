/**
 * Pre-publish hook declarations of a plugin (HeoPress P12 task 3.4, narrowed by the maintainer decision of 2026-10-28;
 * spec extensions/runtime-extensions "内容事件订阅与发布前钩子").
 *
 * A pre-publish hook can only veto, and the hooks fail closed: a plugin whose hooks cannot be asked (its bundle does not
 * load, or it did not register a hook it declared) refuses the publishes they would have looked at. To keep that from
 * blocking a site because of a plugin that never meant to guard publishing, a plugin says in its manifest which hooks it
 * registers:
 *
 * ```json
 * { "capabilities": ["ext:events"], "prePublishHooks": [{ "name": "require-summary", "collections": ["articles"] }] }
 * ```
 *
 *   - only a plugin that declares hooks blocks publishing when it fails to load, and only for the collections its hooks
 *     cover (all collections when a hook names none);
 *   - a hook registered at load time under a name the manifest does not declare is refused (recorded, never run);
 *   - a declared hook that the loaded plugin did not register is a veto too (the plugin cannot be asked);
 *   - a plugin with `ext:events` that only subscribes to events declares nothing and never blocks a publish.
 *
 * Declaring hooks needs the `ext:events` capability. Pure functions and Zod schemas: shared by the CMS (install, upgrade,
 * runtime), Studio and the SDK documentation.
 */
import { z } from 'zod';
import { declaresExtensionPoint } from './capabilities';
import { RUNTIME_NAME } from './runtime';

export const ExtensionPrePublishHookSchema = z.object({
  /** The name the bundle registers the hook under (`definePrePublishHook({ name })`). */
  name: z.string().regex(RUNTIME_NAME),
  label: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  /** Collections (machine names) the hook looks at; absent: every collection. A failed load blocks only these. */
  collections: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,127}$/)).min(1).max(32).optional(),
});

/** The pre-publish declarations of a manifest (optional). */
export const PrePublishDeclarationsSchema = z.object({
  prePublishHooks: z.array(ExtensionPrePublishHookSchema).max(8).optional(),
});

export type ExtensionPrePublishHook = z.infer<typeof ExtensionPrePublishHookSchema>;
export type PrePublishDeclarations = z.infer<typeof PrePublishDeclarationsSchema>;

export interface PrePublishDeclarationIssue {
  path: string;
  message: string;
}

/** Check the declarations against themselves and the capabilities (requested or granted). */
export function prePublishDeclarationIssues(decl: PrePublishDeclarations, capabilities: readonly string[]): PrePublishDeclarationIssue[] {
  const hooks = decl.prePublishHooks ?? [];
  if (hooks.length === 0) return [];
  const issues: PrePublishDeclarationIssue[] = [];
  if (!declaresExtensionPoint(capabilities, 'events')) issues.push({ path: 'prePublishHooks', message: 'prePublishHooks need the ext:events capability' });
  const names = hooks.map((h) => h.name);
  if (new Set(names).size !== names.length) issues.push({ path: 'prePublishHooks', message: 'hook names repeat' });
  return issues;
}

/** The pre-publish hooks a stored manifest declares (anything malformed: none). */
export function prePublishHooksOf(manifest: unknown): ExtensionPrePublishHook[] {
  const parsed = PrePublishDeclarationsSchema.safeParse(manifest && typeof manifest === 'object' ? manifest : {});
  return parsed.success ? (parsed.data.prePublishHooks ?? []) : [];
}

/** Whether a declared hook looks at `collection`. */
export function prePublishHookCovers(hook: Pick<ExtensionPrePublishHook, 'collections'>, collection: string): boolean {
  return !hook.collections || hook.collections.includes(collection);
}
