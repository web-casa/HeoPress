/**
 * Briefing sections (HeoPress v1.1, spec extensions/briefing-sections): a plugin's contribution to the Studio overview's
 * briefing ("what should I do today?").
 *
 * A section is small and computed: a count and a few links the plugin hands the host on request — never stored, never
 * rendered into content. Two declarations are checked before anything runs:
 *
 * ```json
 * {
 *   "capabilities": ["ext:briefing-sections"],
 *   "briefingSections": [{ "id": "stale-drafts", "title": "Stale drafts" }]
 * }
 * ```
 *
 *   - the manifest declares each section by id (and the capability), so the admin approves the contribution before it
 *     can appear, exactly like the other extension points;
 *   - the bundle registers each section under the same id
 *     (`ctx.extensionPoints.register('briefing-sections', defineBriefingSection({ id, compute }))`); one registered
 *     under an undeclared id is refused and recorded, and a declared one that is not registered simply does not appear.
 *
 * The host, not the plugin, owns what a section may return (`BriefingSectionPayloadSchema`) and how long it may take
 * (`BRIEFING_LIMITS`): an invalid payload or a failed/timed-out compute leaves that one section out, never the others.
 *
 * Pure functions and Zod schemas: shared by the CMS (install, load, endpoint), Studio and the SDK documentation.
 */
import { z } from 'zod';
import { declaresExtensionPoint } from './capabilities';
import { BRIEFING_LIMITS, RUNTIME_NAME } from './runtime';

/** One section a manifest declares: its stable id and the title the Studio shows. */
export const ExtensionBriefingSectionSchema = z.object({
  /** The id the bundle registers the section under (`defineBriefingSection({ id })`). */
  id: z.string().regex(RUNTIME_NAME),
  title: z.string().min(1).max(BRIEFING_LIMITS.titleChars),
  /** An optional one-line explanation under the title. */
  description: z.string().min(1).max(BRIEFING_LIMITS.descriptionChars).optional(),
});

/** The briefing-section declarations of a manifest (optional). */
export const BriefingDeclarationsSchema = z.object({
  briefingSections: z.array(ExtensionBriefingSectionSchema).max(BRIEFING_LIMITS.sections.max).optional(),
});

export type ExtensionBriefingSection = z.infer<typeof ExtensionBriefingSectionSchema>;
export type BriefingDeclarations = z.infer<typeof BriefingDeclarationsSchema>;

export interface BriefingDeclarationIssue {
  path: string;
  message: string;
}

/** Check the declarations against themselves and the capabilities (requested or granted). */
export function briefingDeclarationIssues(decl: BriefingDeclarations, capabilities: readonly string[]): BriefingDeclarationIssue[] {
  const sections = decl.briefingSections ?? [];
  if (sections.length === 0) return [];
  const issues: BriefingDeclarationIssue[] = [];
  if (!declaresExtensionPoint(capabilities, 'briefing-sections')) {
    issues.push({ path: 'briefingSections', message: 'briefing sections need the ext:briefing-sections capability' });
  }
  const ids = sections.map((s) => s.id);
  if (new Set(ids).size !== ids.length) issues.push({ path: 'briefingSections', message: 'briefing section ids repeat' });
  return issues;
}

/** The briefing sections a stored manifest declares (anything malformed: none). */
export function briefingSectionsOf(manifest: unknown): ExtensionBriefingSection[] {
  const declared = (manifest as { briefingSections?: unknown } | null)?.briefingSections;
  const parsed = z.array(ExtensionBriefingSectionSchema).max(BRIEFING_LIMITS.sections.max).safeParse(declared ?? []);
  return parsed.success ? parsed.data : [];
}

/**
 * One link of a section's payload: a label and a site-relative path. Absolute URLs are refused: a briefing link is a
 * place in this Studio, never somewhere a plugin sends the operator.
 */
export const BriefingSectionItemSchema = z.object({
  label: z.string().min(1).max(BRIEFING_LIMITS.labelChars),
  href: z.string().min(1).max(BRIEFING_LIMITS.hrefChars).regex(/^\/(?!\/)/, 'href must be a site-relative path ("/content/…")'),
});

/** What a registered section's `compute` returns: a count and at most `BRIEFING_LIMITS.items.max` links. */
export const BriefingSectionPayloadSchema = z.object({
  count: z.number().int().min(0).max(1_000_000_000),
  items: z.array(BriefingSectionItemSchema).max(BRIEFING_LIMITS.items.max).default([]),
});

export type BriefingSectionItem = z.infer<typeof BriefingSectionItemSchema>;
export type BriefingSectionPayload = z.infer<typeof BriefingSectionPayloadSchema>;
