import { describe, expect, it } from 'vitest';
import { withSponsoredRel } from '../theme/sponsored.ts';

/** rel="sponsored" on a sponsored body's external links (HeoPress P06 task 2.7; ADR-0016). */
describe('withSponsoredRel', () => {
  it('marks external links, keeps other rel tokens, leaves the site’s own and relative links alone', () => {
    const html = withSponsoredRel(
      '<p><a href="https://shop.example.org/x">a</a> <a href="https://a.example.com/in">b</a> <a href="/rel">c</a> <a href="//cdn.example.net/y" rel="noopener noreferrer">d</a> <a href="mailto:x@example.org">e</a></p>',
      ['a.example.com', 'www.a.example.com'],
    );
    expect(html).toContain('<a href="https://shop.example.org/x" rel="sponsored">a</a>');
    expect(html).toContain('<a href="https://a.example.com/in">b</a>');
    expect(html).toContain('<a href="/rel">c</a>');
    expect(html).toContain('<a href="//cdn.example.net/y" rel="noopener noreferrer sponsored">d</a>');
    expect(html).toContain('<a href="mailto:x@example.org">e</a>');
    // Spelled with a newline or a tab in the scheme, or with spaces: the browser still goes elsewhere.
    const tricky = withSponsoredRel('<a href="ht&#10;tps://elsewhere.example.org/">x</a><a href=" https://e2.example.org/ ">y</a><a href="ht\ttps://e3.example.org/">z</a>', ['a.example.com']);
    expect(tricky.match(/rel="sponsored"/g)).toHaveLength(3);
  });
});
