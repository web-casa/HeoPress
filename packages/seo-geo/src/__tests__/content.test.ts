import { describe, expect, it } from 'vitest';
import { normalizedBody, normalizedContent } from '../index';

/** The normalised content the real modification time follows (task 2.5; spec seo/page-metadata "真实修改时间"). */
describe('normalizedContent', () => {
  const base = { title: 'A title', excerpt: 'An excerpt', bodies: ['<p>First block.</p><p>Second <a href="https://example.com/x">link</a>.</p>'] };
  const same = (over: Partial<typeof base>) => normalizedContent({ ...base, ...over }) === normalizedContent(base);

  it('ignores what only shapes how the content looks: whitespace, inline formatting, attributes, entity spelling, comments', () => {
    expect(same({ title: '  A   title ' })).toBe(true);
    expect(same({ excerpt: 'An\nexcerpt' })).toBe(true);
    expect(same({ bodies: ['<p>First   block.</p>\n\n<p>Second <a href="https://example.com/x" rel="noopener" target="_blank">link</a>.</p>'] })).toBe(true);
    expect(same({ bodies: ['<p data-block-id="b1"><strong>First</strong> block.</p><!-- note --><p class="x">Second <a href=\'https://example.com/x\'><em>link</em></a>.</p>'] })).toBe(true);
    expect(normalizedBody('<p>Fish &amp; chips&#32;&#x21;</p>')).toEqual(normalizedBody('<p>Fish &#38; chips !</p>'));
  });

  it('changes with a word, an address, an image, the block order, the title or the excerpt', () => {
    expect(same({ bodies: ['<p>First block!</p><p>Second <a href="https://example.com/x">link</a>.</p>'] })).toBe(false);
    expect(same({ bodies: ['<p>First block.</p><p>Second <a href="https://example.com/y">link</a>.</p>'] })).toBe(false);
    expect(same({ bodies: ['<p>Second <a href="https://example.com/x">link</a>.</p><p>First block.</p>'] })).toBe(false);
    expect(same({ bodies: [`${base.bodies[0]}<figure><img src="https://example.com/a.png" alt="A chart"></figure>`] })).toBe(false);
    expect(normalizedBody('<img src="https://example.com/a.png" alt="A chart">')).not.toEqual(normalizedBody('<img src="https://example.com/a.png" alt="Another chart">'));
    expect(same({ title: 'Another title' })).toBe(false);
    expect(same({ excerpt: 'Another excerpt' })).toBe(false);
    // Joining two blocks is a change, though the words are the same.
    expect(normalizedBody('<p>One</p><p>Two</p>')).not.toEqual(normalizedBody('<p>One Two</p>'));
  });

  it('keeps title and excerpt apart from the bodies', () => {
    expect(normalizedContent({ title: 'A', excerpt: 'B', bodies: [] })).not.toBe(normalizedContent({ title: 'A B', excerpt: '', bodies: [] }));
    expect(normalizedContent({ title: 'A', excerpt: '', bodies: ['<p>x</p>', '<p>y</p>'] })).not.toBe(normalizedContent({ title: 'A', excerpt: '', bodies: ['<p>x</p><p>y</p>'] }));
  });

  it('no text stands for a link or an image: literal bracketed text, an empty link and a link around the same words differ (Codex review of batch 4b)', () => {
    const one = '<p><a href="https://example.com/x">[link https://example.com/x]</a></p>';
    const two = '<p><a href="https://example.com/x"></a><a href="https://example.com/x"></a></p>';
    expect(normalizedBody(one)).not.toEqual(normalizedBody(two));
    expect(normalizedBody('<p>[image https://example.com/a.png]</p>')).not.toEqual(normalizedBody('<p><img src="https://example.com/a.png"></p>'));
    expect(normalizedBody('<p>See [link https://example.com/x]</p>')).not.toEqual(normalizedBody('<p>See <a href="https://example.com/x">x</a></p>'.replace('>x<', '><')));
  });

  it('a > inside a quoted attribute does not end the tag', () => {
    expect(normalizedBody('<p><img src="https://example.com/a.png" alt="a > b">After</p>')).toEqual([[['image', 'https://example.com/a.png', 'a > b'], ['text', 'After']]]);
    expect(normalizedBody('<p><a title=\'x > y\' href="https://example.com/x">Go</a></p>')).toEqual([[['link', 'https://example.com/x'], ['text', 'Go']]]);
  });

  it('only a real href or src counts: text inside another attribute never stands for one (Codex review of batch 4b)', () => {
    const spoof = (real: string) => `<p><a title=" href='https://example.com/fake'" href="${real}">text</a></p>`;
    expect(normalizedBody(spoof('https://example.com/real'))).toEqual([[['link', 'https://example.com/real'], ['text', 'text']]]);
    expect(normalizedBody(spoof('https://example.com/real'))).not.toEqual(normalizedBody(spoof('https://example.com/other')));
    // A link with no href of its own: no link token, whatever its other attributes say.
    expect(normalizedBody('<p><a data-block-id="href=https://example.com/x" title=\'href="https://example.com/y"\'>t</a></p>')).toEqual([[['text', 't']]]);
    // An image's alt holding a src lookalike: the real src counts; changing the lookalike only changes the alt.
    expect(normalizedBody('<img alt="src=https://example.com/b.png" src="https://example.com/a.png">')).toEqual([[['image', 'https://example.com/a.png', 'src=https://example.com/b.png']]]);
    // Unquoted values, upper-case names, the first of a repeated attribute.
    expect(normalizedBody('<A HREF=https://example.com/u href="https://example.com/second">x</A>')).toEqual([[['link', 'https://example.com/u'], ['text', 'x']]]);
  });

  it('scans unquoted values and malformed markup as HTML does (Codex review of batch 4b)', () => {
    // A slash inside an unquoted value is part of it; between attributes it only marks self-closing.
    expect(normalizedBody('<img src=https://example.com/a.png/>')).toEqual([[['image', 'https://example.com/a.png/', '']]]);
    expect(normalizedBody('<img src=https://example.com/a.png/>')).not.toEqual(normalizedBody('<img src=https://example.com/a.png />'));
    expect(normalizedBody('<p><a href=/>x</a></p>')).toEqual([[['link', '/'], ['text', 'x']]]);
    expect(normalizedBody('<img src="https://example.com/a.png"/>')).toEqual([[['image', 'https://example.com/a.png', '']]]);
    // Quotes and = inside an unquoted value are part of it: the real href counts.
    expect(normalizedBody(`<p><a title=a'href=https://example.com/fake' href="https://example.com/real">t</a></p>`)).toEqual([[['link', 'https://example.com/real'], ['text', 't']]]);
    // Markup that ends inside a tag is dropped: no link, no image.
    expect(normalizedBody('<p>ok</p><a href="https://example.com/x')).toEqual([[['text', 'ok']]]);
    expect(normalizedBody('<p>ok <img src=https://example.com/a.png')).toEqual([[['text', 'ok']]]);
    // A `<` that starts no tag is text; comments and declarations are not.
    expect(normalizedBody('<p>1 < 2 <!-- note --> <!x> 3</p>')).toEqual([[['text', '1 < 2 3']]]);
  });

  it('keeps every character of an unquoted value; a slash between attributes is not part of a value; empty comments close at once', () => {
    expect(normalizedBody('<img src=https://example.com/a`b<c.png alt=x>')).toEqual([[['image', 'https://example.com/a`b<c.png', 'x']]]);
    expect(normalizedBody('<img src="https://example.com/a.png" / alt="x">')).toEqual([[['image', 'https://example.com/a.png', 'x']]]);
    expect(normalizedBody('<img src=https://example.com/a.png / alt=x>')).toEqual([[['image', 'https://example.com/a.png', 'x']]]);
    expect(normalizedBody('<p><!-->visible</p>')).toEqual([[['text', 'visible']]]);
    expect(normalizedBody('<p><!--->also visible</p>')).toEqual([[['text', 'also visible']]]);
    expect(normalizedBody('<p>a<!-- a > b -->b</p>')).toEqual([[['text', 'ab']]]);
  });
});
