import { z } from 'zod';

/**
 * The structured brief of the briefing-style rewrite (HeoPress v1.1 backlog P09; spec ai/content-pipeline
 * "简报式改写"): what the article will argue before a word of it is written.
 *
 * The model produces it as JSON, the pipeline validates it against this schema (§"brief" capability) and then writes
 * the article from it — sections in order, their key points, the sources that support each one. The schema is
 * deliberately small: every field is something the writer needs, and nothing is optional, so a brief that passes is a
 * usable outline. `sourceIds` refer to the production's own source documents; the pipeline rejects ids it does not
 * know instead of silently dropping them.
 */

const text = (max: number) => z.string().trim().min(1).max(max);

/** One section of the article: what it covers, and which sources support it. */
const ArticleBriefSectionSchema = z
  .object({
    heading: text(200),
    /** The points the section must make, in order. */
    keyPoints: z.array(text(500)).min(1).max(8),
    /** Ids of the production's source documents this section rests on (empty: analysis of its own). */
    sourceIds: z.array(text(64)).max(10).default([]),
  })
  .strict();

const ArticleBriefSeoSchema = z
  .object({
    /** At most 70 characters: the article's search title. */
    title: text(70),
    /** At most 170 characters: its meta description. */
    description: text(170),
    keywords: z.array(text(60)).min(1).max(10),
  })
  .strict();

export const ArticleBriefSchema = z
  .object({
    /** What the article claims, in one or two sentences. */
    thesis: text(1000),
    /** Who it is written for. */
    audience: text(500),
    /** The point of view that makes it this site's article, not a reprint. */
    angle: text(1000),
    /** The body, in the order the article will follow it. */
    sections: z.array(ArticleBriefSectionSchema).min(1).max(12),
    tone: text(200),
    /** The body's target length, in words. */
    wordBudget: z.number().int().min(200).max(5000),
    seo: ArticleBriefSeoSchema,
  })
  .strict();

export type ArticleBrief = z.infer<typeof ArticleBriefSchema>;

/** Every source id a brief rests on, deduplicated (the sources its citations may name). */
export function briefSourceIds(brief: ArticleBrief): string[] {
  return [...new Set(brief.sections.flatMap((s) => s.sourceIds))];
}
