import { describe, expect, it } from 'vitest';
import { appendMarker, hasMarker, isMarkerId, markerBlock, markerIds, withoutMarker } from '../marker';

const block = (reportId: string, correction = 'It was 1989.') =>
  markerBlock({ reportId, label: 'Correction', excerpt: 'It was 1998.', correction, date: '2026-11-14' });

describe('the correction block in an article body', () => {
  it('is a marked aside carrying the report id, the label, the day, the correction and the quote', () => {
    const html = block('r_abc-1');
    expect(html).toContain('<aside data-heopress-correction="r_abc-1">');
    expect(html).toContain('<p><strong>Correction</strong> (2026-11-14): It was 1989.</p>');
    expect(html).toContain('<blockquote><p>It was 1998.</p></blockquote>');
    expect(html.endsWith('</aside>')).toBe(true);
    expect(markerIds(html)).toEqual(['r_abc-1']);
    expect(hasMarker(html, 'r_abc-1')).toBe(true);
    expect(hasMarker(html, 'r_other')).toBe(false);
  });

  it('escapes the text it carries: a quote and a correction never become markup', () => {
    const html = block('r_1', '"<b>x</b>" & more');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&quot;&lt;b&gt;x&lt;/b&gt;&quot; &amp; more');
  });

  it('leaves out the quote when there is none', () => {
    const html = markerBlock({ reportId: 'r_1', label: 'Correction', excerpt: '', correction: 'x', date: '2026-11-14' });
    expect(html).not.toContain('<blockquote>');
  });

  it('is appended at the end and removed again, restoring the body exactly', () => {
    const body = '<p>One.</p>\n<h2>Two</h2>\n<p>Three.</p>';
    const once = appendMarker(body, block('r_1'));
    expect(once.startsWith(body)).toBe(true);
    expect(once.endsWith('</aside>')).toBe(true);
    expect(withoutMarker(once, 'r_1')).toBe(body);
  });

  it('is never duplicated: the second write sees the marker and does nothing', () => {
    const once = appendMarker('<p>Body.</p>', block('r_1'));
    expect(hasMarker(once, 'r_1')).toBe(true);
    // What the plugin does: append only when the marker is absent.
    const twice = hasMarker(once, 'r_1') ? once : appendMarker(once, block('r_1'));
    expect(twice).toBe(once);
    expect(markerIds(twice)).toEqual(['r_1']);
  });

  it('keeps an operator edit inside the block: it is found and not rewritten', () => {
    const edited = appendMarker('<p>Body.</p>', block('r_1')).replace('It was 1989.', 'It was 1989 (edited by the editor).');
    expect(hasMarker(edited, 'r_1')).toBe(true);
    expect(edited).toContain('(edited by the editor)');
    expect(withoutMarker(edited, 'r_1')).toBe('<p>Body.</p>');
  });

  it('removes only its own block when a body carries two corrections', () => {
    const body = appendMarker(appendMarker('<p>Body.</p>', block('r_1')), block('r_2', 'Another.'));
    expect(markerIds(body)).toEqual(['r_1', 'r_2']);
    const after = withoutMarker(body, 'r_1');
    expect(hasMarker(after, 'r_1')).toBe(false);
    expect(hasMarker(after, 'r_2')).toBe(true);
    expect(after).toContain('Another.');
    expect(withoutMarker(after, 'r_2')).toBe('<p>Body.</p>');
  });

  it('does not swallow the rest of the body when the closing tag was removed', () => {
    // The opening tag goes, the content stays: an operator who broke the block keeps their text and the article.
    const body = '<p>Body.</p>\n<aside data-heopress-correction="r_1"><p>Loose block</p><p>After.</p>';
    const after = withoutMarker(body, 'r_1');
    expect(after).toBe('<p>Body.</p><p>Loose block</p><p>After.</p>');
    expect(hasMarker(after, 'r_1')).toBe(false);
  });

  it('ignores a malformed id instead of building a regular expression out of it', () => {
    const body = appendMarker('<p>Body.</p>', block('r_1'));
    expect(withoutMarker(body, '.*')).toBe(body);
    expect(withoutMarker(body, '')).toBe(body);
  });

  it('accepts id-shaped report ids only', () => {
    for (const id of ['r_1', 'abc-DEF_9', '-abc', '_abc', 'a'.repeat(128)]) expect(isMarkerId(id), id).toBe(true);
    for (const id of ['', ' a', 'a b', 'a"b', 'a/b', 'a'.repeat(129), 'ünicode']) expect(isMarkerId(id), id).toBe(false);
  });

  it('appends a block to an empty body without a leading newline', () => {
    expect(appendMarker('', block('r_1'))).toBe(block('r_1'));
    expect(appendMarker('  \n', block('r_1'))).toBe(block('r_1'));
  });
});
