import { z } from 'zod';
import { LocaleTagSchema } from './locale-tag';

/**
 * A site's translation glossary (HeoPress v1.4, spec ai/site-glossary).
 *
 * The glossary is the site's own terminology for a language pair (`lumibase_glossary`, `site_id NOT NULL`): every entry
 * says what a term must be rendered as, and one of three rules says how it binds:
 *
 *   - `prefer`          the source term must be rendered with the entry's translation;
 *   - `do-not-translate` the source term must stay verbatim in the target (translation === term);
 *   - `forbidden`       the entry's translation must not appear in the target at all.
 *
 * `rule` is optional wherever a glossary travels (a plugin request, a model prompt, `TranslationRequest.glossary`) so the
 * original `{ source, target }` shape keeps working; an absent or unrecognized rule means `prefer`. `glossaryRuleOf` is
 * the one coercion every reader uses — never re-implement it at a call site.
 */

/** The three rules, in the order the Studio help text presents them. */
export const GLOSSARY_RULES = ['prefer', 'do-not-translate', 'forbidden'] as const;
export type GlossaryRule = (typeof GLOSSARY_RULES)[number];

/** What a missing (or unrecognized) rule means: today's behaviour, unchanged. */
export const DEFAULT_GLOSSARY_RULE: GlossaryRule = 'prefer';

/** One glossary entry as the translation pipeline and the mechanical gates see it. */
export interface TranslationGlossaryTerm {
  source: string;
  target: string;
  /** Absent means {@link DEFAULT_GLOSSARY_RULE}; an old caller/plugin keeps working unchanged. */
  rule?: GlossaryRule;
}

/**
 * The rule of a stored or requested entry: the three accepted strings, anything else (including `null`/`undefined`)
 * means {@link DEFAULT_GLOSSARY_RULE}. The single coercion point for the whole codebase.
 */
export function glossaryRuleOf(rule: string | null | undefined): GlossaryRule {
  return rule === 'do-not-translate' || rule === 'forbidden' ? rule : DEFAULT_GLOSSARY_RULE;
}

/** Length limits of one entry (term/translation 200 characters, note 500). */
export const GLOSSARY_LIMITS = {
  termChars: 200,
  translationChars: 200,
  noteChars: 500,
  /** The most branches (`?from=&to=`) one site may keep — the selector is per language pair. */
  entries: 500,
} as const;

const TermSchema = z.string().trim().min(1).max(GLOSSARY_LIMITS.termChars);
const TranslationSchema = z.string().trim().min(1).max(GLOSSARY_LIMITS.translationChars);
const NoteSchema = z.string().trim().max(GLOSSARY_LIMITS.noteChars);

/** Fields every create (and the merged result of an update) must satisfy. */
const glossaryEntryFields = {
  sourceLang: LocaleTagSchema,
  targetLang: LocaleTagSchema,
  term: TermSchema,
  translation: TranslationSchema,
  rule: z.enum(GLOSSARY_RULES).default(DEFAULT_GLOSSARY_RULE),
  note: NoteSchema.nullish(),
} as const;

/**
 * One entry to store, with the cross-field rules:
 *
 *   - the language pair must be two different languages (a glossary for `en → en` says nothing);
 *   - `do-not-translate` keeps the source spelling, so `translation` must equal `term`;
 *   - `prefer`/`forbidden` need a rendering different from the term (an identical pair would make `prefer` a no-op and
 *     `forbidden` self-contradictory).
 *
 * Strings are trimmed; the language tags are canonicalized (`zh-cn` → `zh-CN`) so the unique index sees one spelling.
 */
export const GlossaryEntryInputSchema = z
  .object(glossaryEntryFields)
  .strict()
  .superRefine((value, ctx) => {
    if (value.sourceLang === value.targetLang) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetLang'],
        message: 'The source and target languages must differ.',
      });
    }
    if (value.rule === 'do-not-translate' && value.translation !== value.term) {
      ctx.addIssue({
        code: 'custom',
        path: ['translation'],
        message: 'A do-not-translate term keeps its source spelling: the translation must equal the term.',
      });
    }
    if (value.rule !== 'do-not-translate' && value.translation === value.term) {
      ctx.addIssue({
        code: 'custom',
        path: ['translation'],
        message: `A ${value.rule} term needs a translation different from the term.`,
      });
    }
  });

export type GlossaryEntryInput = z.infer<typeof GlossaryEntryInputSchema>;

/**
 * The patch of one entry. Every field is optional and cross-field rules cannot be checked on a patch alone: the route
 * merges the patch with the stored row and validates the result with {@link GlossaryEntryInputSchema}.
 */
export const GlossaryEntryUpdateSchema = z
  .object({
    sourceLang: LocaleTagSchema.optional(),
    targetLang: LocaleTagSchema.optional(),
    term: TermSchema.optional(),
    translation: TranslationSchema.optional(),
    rule: z.enum(GLOSSARY_RULES).optional(),
    note: NoteSchema.nullish(),
  })
  .strict();

export type GlossaryEntryUpdate = z.infer<typeof GlossaryEntryUpdateSchema>;

/** The list query: an optional language pair plus pagination. */
export const GlossaryListQuerySchema = z.object({
  from: LocaleTagSchema.optional(),
  to: LocaleTagSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type GlossaryListQuery = z.infer<typeof GlossaryListQuerySchema>;
