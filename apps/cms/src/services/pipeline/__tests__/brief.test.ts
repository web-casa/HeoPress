import { describe, expect, it } from 'vitest';
import { AI_CAPABILITY_TASK_TYPES, AI_CAPABILITIES, ArticleBriefSchema, briefSourceIds, type ArticleBrief } from '@heopress/contracts/schemas';

/**
 * The structured brief contract (HeoPress v1.1 backlog P09; spec ai/content-pipeline "简报式改写"): the shape the
 * model must answer with before the article is written. Strict enough that a passing brief is a usable outline — every
 * field the writer needs is required, no field is unknown — and small enough to be answered reliably in one call.
 */

/** A valid answer: two sections, the second resting on no source of its own. */
const valid = {
  thesis: 'The harbour reopened after the storm, and the ferry schedule is the proof.',
  audience: 'Commuters in Example Town who read the site on a phone.',
  angle: 'What the timetable change means for the morning crossing, not a storm retrospective.',
  sections: [
    { heading: 'What changed', keyPoints: ['The first ferry leaves at 06:10', 'The last one at 22:40'], sourceIds: ['doc_1'] },
    { heading: 'What it means', keyPoints: ['Ten minutes more at the office'], sourceIds: [] },
  ],
  tone: 'Plain and practical, no drama.',
  wordBudget: 900,
  seo: { title: 'Example Town ferries after the storm', description: 'The new timetable, and what the morning crossing loses.', keywords: ['ferries', 'Example Town'] },
};

describe('article brief contract', () => {
  it('accepts a complete brief, and defaults a section to no source', () => {
    const parsed = ArticleBriefSchema.parse(valid) as ArticleBrief;
    expect(parsed.sections).toHaveLength(2);
    expect(parsed.seo.keywords).toEqual(['ferries', 'Example Town']);
    const withoutSources = {
      ...valid,
      sections: valid.sections.map(({ sourceIds: _sourceIds, ...rest }) => rest),
    };
    expect(ArticleBriefSchema.parse(withoutSources).sections.map((s) => s.sourceIds)).toEqual([[], []]);
  });

  it('rejects answers that are not a usable outline', () => {
    const broken: Array<[string, unknown]> = [
      ['not an object', 'a paragraph of prose'],
      ['no thesis', { ...valid, thesis: '' }],
      ['no sections', { ...valid, sections: [] }],
      ['a section with no key point', { ...valid, sections: [{ heading: 'Empty', keyPoints: [] }] }],
      ['a section with no heading', { ...valid, sections: [{ keyPoints: ['x'] }] }],
      ['a word budget outside the contract', { ...valid, wordBudget: 40 }],
      ['an SEO title over 70 characters', { ...valid, seo: { ...valid.seo, title: 'x'.repeat(71) } }],
      ['no keywords', { ...valid, seo: { ...valid.seo, keywords: [] } }],
      ['an unknown field', { ...valid, publish: true }],
      ['an unknown field inside a section', { ...valid, sections: [{ heading: 'H', keyPoints: ['p'], sourceIds: [], approved: true }] }],
    ];
    for (const [label, answer] of broken) {
      expect(ArticleBriefSchema.safeParse(answer).success, label).toBe(false);
    }
  });

  it('names the sources it rests on, once each', () => {
    const brief = ArticleBriefSchema.parse({
      ...valid,
      sections: [...valid.sections, { heading: 'Again', keyPoints: ['x'], sourceIds: ['doc_1', 'doc_2'] }],
    }) as ArticleBrief;
    expect(briefSourceIds(brief)).toEqual(['doc_1', 'doc_2']);
  });

  it('routes the brief through the generation task type, like the other pipeline capabilities', () => {
    expect(AI_CAPABILITY_TASK_TYPES.brief).toBe('generation');
    expect(AI_CAPABILITIES).toContain('brief');
  });
});
