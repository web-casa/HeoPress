import { describe, expect, it } from 'vitest';
import { htmlToMarkdown, textToMarkdown } from '../markdown';

/** Sanitised rich text as Markdown (HeoPress P07 tasks 4.1, 4.2). */
const BASE = 'https://example.com/blog/post/';

describe('htmlToMarkdown', () => {
  it('headings, paragraphs, emphasis, links and images (absolute), lists, quotes, code, rules, tables', () => {
    const html = [
      '<h2>Section</h2>',
      '<p>Plain <strong>bold</strong> and <em>it</em>, a <a href="/x/">link</a>, <code>a`b</code>.</p>',
      '<p><img src="../i.png" alt="Pic"></p>',
      '<ul><li>One</li><li>Two <a href="https://other.example.org/">out</a></li></ul>',
      '<ol><li>First</li><li>Second</li></ol>',
      '<blockquote><p>Quoted</p><p>twice</p></blockquote>',
      '<pre><code>const x = 1;\nreturn x;</code></pre>',
      '<hr>',
      '<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    ].join('');
    expect(htmlToMarkdown(html, BASE)).toBe(
      [
        '## Section',
        'Plain **bold** and *it*, a [link](https://example.com/x/), ``a`b``.',
        '![Pic](https://example.com/blog/i.png)',
        '- One\n- Two [out](https://other.example.org/)',
        '1. First\n2. Second',
        '> Quoted\n>\n> twice',
        '```\nconst x = 1;\nreturn x;\n```',
        '---',
        '| A | B |\n| --- | --- |\n| 1 | 2 |',
      ].join('\n\n'),
    );
  });

  it('text that would read as Markdown is escaped; unsafe links are dropped to their text', () => {
    expect(htmlToMarkdown('<p># not a heading *nor* [a](link)</p><p>1. not a list</p>', BASE)).toBe('\\# not a heading \\*nor\\* \\[a\\](link)\n\n1\\. not a list');
    expect(htmlToMarkdown('<p><a href="javascript:alert(1)">x</a></p>', BASE)).toBe('x');
    expect(htmlToMarkdown('<p><a href="/a b(c)">sp</a></p>', BASE)).toBe('[sp](https://example.com/a%20b%28c%29)');
  });

  it('plain text bodies: paragraphs kept, escaped — every line start too', () => {
    expect(textToMarkdown('First *line*\nnext\n\n- second')).toBe('First \\*line\\*  \nnext\n\n\\- second');
    expect(textToMarkdown('Intro\n# not a heading\n2. nor a list')).toBe('Intro  \n\\# not a heading  \n2\\. nor a list');
    // Codex review of batch 9, round 2: a quote needs no space; rules, setext underlines and tilde fences are lines of their own.
    expect(textToMarkdown('Intro\n>quoted\n---\n===\n~~~\n+x\n~~gone~~')).toBe('Intro  \n\\>quoted  \n\\---  \n\\===  \n\\~\\~\\~  \n\\+x  \n\\~\\~gone\\~\\~');
    expect(htmlToMarkdown('<p>Intro<br>---<br>===<br>~~~</p>', BASE)).toBe('Intro  \n\\---  \n\\===  \n\\~\\~\\~');
  });

  it('a line break inside a heading: the next line escaped too (Codex review of batch 9, round 3)', () => {
    expect(htmlToMarkdown('<h2>Title<br>---<br>&gt;quoted<br>1. item<br>+ item</h2>', BASE)).toBe('## Title  \n\\---  \n\\>quoted  \n1\\. item  \n\\+ item');
  });

  it('an empty link shows its address as escaped text (Codex review of batch 9, round 2)', () => {
    const md = htmlToMarkdown('<p><a href="https://example.com/](javascript:alert(1))"></a></p>', BASE);
    expect(md).toBe('[https://example.com/\\](javascript:alert(1))](https://example.com/]%28javascript:alert%281%29%29)');
    expect(md).not.toMatch(/(?<!\\)\]\(javascript:/);
  });

  it('code is kept as it is: inline code delimited past its backticks, a fence that cannot close early (Codex review of batch 9)', () => {
    expect(htmlToMarkdown('<p><code>SELECT `id` FROM t</code></p>', BASE)).toBe('``SELECT `id` FROM t``');
    expect(htmlToMarkdown('<p><code>`x`</code></p>', BASE)).toBe('`` `x` ``');
    const md = htmlToMarkdown('<pre><code>a\n```\n~~~~\nb</code></pre><p>after</p>', BASE);
    expect(md).toBe('````\na\n```\n~~~~\nb\n````\n\nafter');
  });
});
