import { describe, expect, it } from 'vitest';
import { anchorsOf, linksOf } from '../links';

/** The links and anchors of rich text (HeoPress P07 tasks 5.1, 5.3). */
const BASE = 'https://example.com/blog/post/';

describe('linksOf', () => {
  it('http(s) links, absolute against the page, fragment apart, text collapsed, in order', () => {
    const html = '<p><a href="../other/#Part%20two">The  <b>other</b>\n page</a> <a href="https://example.org/x?y=1">out</a></p><ul><li><a href="/">home</a></li></ul>';
    expect(linksOf(html, BASE)).toEqual([
      { href: '../other/#Part%20two', url: 'https://example.com/blog/other/', fragment: 'Part two', text: 'The other page', position: 0 },
      { href: 'https://example.org/x?y=1', url: 'https://example.org/x?y=1', fragment: null, text: 'out', position: 1 },
      { href: '/', url: 'https://example.com/', fragment: null, text: 'home', position: 2 },
    ]);
  });

  it('no mail, script, empty or unparsable links; an empty fragment is none', () => {
    const html = '<a href="mailto:a@example.com">m</a><a href="javascript:x()">j</a><a href="">e</a><a>none</a><a href="http://[bad">b</a><a href="/x#">x</a>';
    expect(linksOf(html, BASE).map((l) => [l.url, l.fragment])).toEqual([['https://example.com/x', null]]);
  });
});

describe('anchorsOf', () => {
  it('every id and the name of an <a>', () => {
    expect([...anchorsOf('<h2 id="intro">Intro</h2><p><a name="old">x</a><span name="not">y</span></p>')].sort()).toEqual(['intro', 'old']);
  });
});
