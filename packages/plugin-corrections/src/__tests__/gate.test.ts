import { describe, expect, it } from 'vitest';
import { judgeMalformedMarkers, judgeNoticeLinks, judgeUnreadable } from '../gate';

describe('the gate check of the correction blocks', () => {
  it('passes when every block points at a published notice', () => {
    expect(judgeNoticeLinks([{ report: 'r_1', notice: { id: 'n_1', status: 'published' } }])).toEqual({
      verdict: 'passed',
      evidence: { corrections: ['r_1'] },
    });
  });

  it('blocks a block whose notice is gone: a public page cannot claim a record readers cannot see', () => {
    const verdict = judgeNoticeLinks([{ report: 'r_1', notice: null }]);
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.evidence).toEqual({ missing: ['r_1'] });
    expect(verdict.suggestions?.join(' ')).toMatch(/publish|remove/i);
  });

  it('blocks a block whose notice is still a draft or was unpublished', () => {
    const verdict = judgeNoticeLinks([
      { report: 'r_1', notice: { id: 'n_1', status: 'published' } },
      { report: 'r_2', notice: { id: 'n_2', status: 'draft' } },
    ]);
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.evidence).toEqual({ unpublished: [{ report: 'r_2', notice: 'n_2', status: 'draft' }] });
  });

  it('reports both kinds of failure at once', () => {
    const verdict = judgeNoticeLinks([
      { report: 'r_1', notice: null },
      { report: 'r_2', notice: { id: 'n_2', status: 'draft' } },
    ]);
    expect(verdict.evidence).toEqual({ missing: ['r_1'], unpublished: [{ report: 'r_2', notice: 'n_2', status: 'draft' }] });
  });

  it('blocks a marker the plugin did not write', () => {
    const verdict = judgeMalformedMarkers(['not a report id']);
    expect(verdict.verdict).toBe('blocked');
    expect(verdict.evidence).toEqual({ malformed: ['not a report id'] });
  });

  it('asks for a person when the notices could not be read: it never passes on a guess', () => {
    expect(judgeUnreadable().verdict).toBe('needs_review');
  });

  it('passes an empty look-up: an article without a block is not this check\'s business', () => {
    expect(judgeNoticeLinks([])).toEqual({ verdict: 'passed', evidence: { corrections: [] } });
  });
});
