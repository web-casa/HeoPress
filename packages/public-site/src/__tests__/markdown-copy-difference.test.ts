import { describe, expect, it } from 'vitest';
import { markdownCopyDifference, markdownUrlOf } from '../markdown';

/** Whether a Markdown copy says what its page says (HeoPress P07 task 5.1, rule `markdown/inconsistent`). */
const BASE = 'https://example.com/blog/post/';

describe('markdownCopyDifference', () => {
  it('consistent: what the converter writes keeps every letter a reader sees', () => {
    const html = [
      '<h2>Section</h2><p>Plain <strong>bold</strong>, a <a href="/x/">link</a>, <code>a`b</code>, ~tilde, 1. not a list.</p>',
      '<p><img src="i.png" alt="Pic one"> <a href="/empty/"></a></p>',
      '<ul><li>One</li><li>Two</li></ul><ol><li>First</li><li>Second <em>it</em></li></ol>',
      '<blockquote><ol><li>Quoted</li></ol></blockquote><pre><code>const x = 1;</code></pre><hr>',
      '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p>Ünïcödé 文字</p>',
    ].join('');
    expect(markdownCopyDifference(html, BASE)).toBeNull();
  });

  it('what the copy cannot carry is named; text the converter would lose is shown where it parts', () => {
    expect(markdownCopyDifference('<p>Watch</p><iframe src="https://example.org/v"></iframe><video></video>', BASE)).toEqual({ opaque: ['iframe', 'video'], at: null });
    // A link whose scheme is not kept: its text stays; an element of unknown kind keeps its text too — consistent.
    expect(markdownCopyDifference('<p><a href="javascript:x()">kept</a><span>also</span></p>', BASE)).toBeNull();
    // An image the copy leaves out (no address it may keep): its alternative text is missing from the copy.
    const diff = markdownCopyDifference('<p>Before <img src="data:image/png;base64,AAAA" alt="Lost caption"> after</p>', BASE);
    expect(diff?.opaque).toEqual([]);
    expect(diff?.at).toContain('lostcaption');
  });

  it('the copy address', () => {
    expect(markdownUrlOf('https://example.com/a/b/?q=1#x')).toBe('https://example.com/a/b.md');
    expect(markdownUrlOf('https://example.com/')).toBeNull();
  });
});
