import { describe, expect, it } from 'vitest';
import { HONEYPOT_FIELD, NEUTRAL_ANSWER, pagePathProblem, parseReport, REPORT_LIMITS } from '../report';

const valid = {
  page_path: '/notes/one/',
  excerpt: 'The bridge was built in 1998.',
  correction: 'The bridge was built in 1989.',
  comment: 'I walked past the plaque today.',
  name: 'A Reader',
  email: 'reader@example.com',
};

describe('the correction form', () => {
  it('reads a complete submission', () => {
    const parsed = parseReport(valid);
    expect(parsed).toEqual({
      ok: true,
      trapped: false,
      fields: {
        pagePath: '/notes/one/',
        excerpt: 'The bridge was built in 1998.',
        correction: 'The bridge was built in 1989.',
        comment: 'I walked past the plaque today.',
        reporterName: 'A Reader',
        reporterEmail: 'reader@example.com',
      },
    });
  });

  it('requires the page, the quote and the correction; the comment, name and e-mail are optional', () => {
    const parsed = parseReport({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      { field: 'page_path', code: 'required' },
      { field: 'excerpt', code: 'required' },
      { field: 'correction', code: 'required' },
    ]);
    const bare = parseReport({ page_path: '/a/', excerpt: 'a', correction: 'b' });
    expect(bare).toMatchObject({ ok: true, fields: { comment: '', reporterName: '', reporterEmail: '' } });
  });

  it('refuses a page path that is not a path on this site', () => {
    for (const path of [
      'https://example.com/notes/one/',
      '//example.com/notes/one/',
      'notes/one',
      '/notes/../etc/passwd',
      '/notes/%2e%2e/secret',
      '/notes/one/?page=2',
      '/notes/one/#top',
      '/notes\\one',
      '/notes/one page',
      '/_ext/heopress-corrections/report',
      '/api/v1/items',
      `/${'a'.repeat(REPORT_LIMITS.pagePath)}`,
      '/notes/one\u0000',
    ]) {
      expect(pagePathProblem(path), path).not.toBeNull();
    }
  });

  it('accepts a root path and ordinary nested paths, including percent-encoded segments', () => {
    for (const path of ['/', '/notes/one', '/notes/one/', '/2026/11/notes', '/notes/%E4%B8%AD%E6%96%87/']) {
      expect(pagePathProblem(path), path).toBeNull();
    }
  });

  it('refuses markup in the quote, the correction, the comment and the name', () => {
    const parsed = parseReport({ ...valid, excerpt: '<img src=x onerror=alert(1)>', correction: '<b>no</b>', comment: '<script>', name: '<i>' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      { field: 'excerpt', code: 'contains_markup' },
      { field: 'correction', code: 'contains_markup' },
      { field: 'comment', code: 'contains_markup' },
      { field: 'name', code: 'contains_markup' },
    ]);
  });

  it('strips control characters and bidi overrides instead of storing them', () => {
    const parsed = parseReport({ ...valid, excerpt: 'a\u0000b\u202ec', correction: '\u0007c\u2066d' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fields?.excerpt).toBe('abc');
    expect(parsed.fields?.correction).toBe('cd');
  });

  it('caps every length', () => {
    const parsed = parseReport({
      ...valid,
      page_path: `/${'a'.repeat(REPORT_LIMITS.pagePath)}`,
      excerpt: 'a'.repeat(REPORT_LIMITS.excerpt + 1),
      correction: 'b'.repeat(REPORT_LIMITS.correction + 1),
      comment: 'c'.repeat(REPORT_LIMITS.comment + 1),
      name: 'd'.repeat(REPORT_LIMITS.name + 1),
      email: `${'e'.repeat(REPORT_LIMITS.email)}@example.com`,
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual([
      { field: 'page_path', code: 'too_long' },
      { field: 'excerpt', code: 'too_long' },
      { field: 'correction', code: 'too_long' },
      { field: 'comment', code: 'too_long' },
      { field: 'name', code: 'too_long' },
      { field: 'email', code: 'invalid_email' },
    ]);
  });

  it('checks an optional e-mail address', () => {
    expect(parseReport({ ...valid, email: 'reader@example' })).toMatchObject({ ok: false, errors: [{ field: 'email', code: 'invalid_email' }] });
    expect(parseReport({ ...valid, email: 'not an address' })).toMatchObject({ ok: false, errors: [{ field: 'email', code: 'invalid_email' }] });
    expect(parseReport({ ...valid, email: '' })).toMatchObject({ ok: true, fields: { reporterEmail: '' } });
  });

  it('turns a filled honeypot into a trap, not an error: a bot learns nothing', () => {
    expect(parseReport({ ...valid, [HONEYPOT_FIELD]: 'https://spam.example' })).toEqual({ ok: true, trapped: true, fields: null });
    expect(parseReport({ [HONEYPOT_FIELD]: 'x' })).toEqual({ ok: true, trapped: true, fields: null });
  });

  it('refuses a body that is not an object', () => {
    expect(parseReport('x')).toMatchObject({ ok: false, errors: [{ field: 'body', code: 'unexpected_type' }] });
    expect(parseReport(null)).toMatchObject({ ok: false });
  });

  it('answers with one sentence that says neither whether the page exists nor whether a report was recorded', () => {
    expect(NEUTRAL_ANSWER).not.toMatch(/recorded|received|exists|not found|unknown|-1|404/i);
  });
});
