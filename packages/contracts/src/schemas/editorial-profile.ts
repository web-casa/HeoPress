import { z } from 'zod';

/**
 * A site's editorial profile (HeoPress P05 task 2.1; spec
 * content/editorial-profiles "编辑策略版本化"): who the site writes for, how
 * it sounds, its terms, how it cites, how pieces are built, what quality and
 * publishing rules apply, and what it does not write about. AI tasks and
 * external agents read the version in effect; runs record its number.
 */

const rules = (max: number) => z.array(z.string().trim().min(1).max(1000)).max(max).default([]);

const GlossaryEntrySchema = z
  .object({
    term: z.string().trim().min(1).max(200),
    /** What the term means here. */
    definition: z.string().max(2000).default(''),
    /** The spelling or translation to use. */
    preferred: z.string().max(200).optional(),
    /** Spellings or synonyms to avoid. */
    avoid: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  })
  .strict();

export const EditorialProfileContentSchema = z
  .object({
    audience: z.string().max(2000).default(''),
    tone: z.string().max(2000).default(''),
    glossary: z.array(GlossaryEntrySchema).max(500).default([]),
    citationPolicy: z.string().max(4000).default(''),
    structureRules: rules(100),
    qualityRules: rules(100),
    publishRules: rules(100),
    forbiddenTopics: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
  })
  .strict();

export type EditorialProfileContent = z.infer<typeof EditorialProfileContentSchema>;
