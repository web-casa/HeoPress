import { describe, expect, it } from 'vitest';
import { normalizeGutenberg } from '../gutenberg';

describe('normalizeGutenberg', () => {
  it('removes the block delimiters and keeps the blocks’ own HTML', () => {
    const body = [
      '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->',
      '<!-- wp:heading {"level":2} --><h2>Title</h2><!-- /wp:heading -->',
      '<!-- wp:image {"id":7} --><figure class="wp-block-image"><img src="a.png" alt=""/></figure><!-- /wp:image -->',
    ].join('\n');
    const out = normalizeGutenberg(body);
    expect(out.html).toBe('<p>Hello</p>\n<h2>Title</h2>\n<figure class="wp-block-image"><img src="a.png" alt=""/></figure>');
    expect(out.blocks).toEqual(['core/paragraph', 'core/heading', 'core/image']);
    expect(out.unknown).toEqual([]);
  });

  it('keeps an unknown block’s content and names it', () => {
    const out = normalizeGutenberg('<!-- wp:custom-thing {"x":1} --><div class="c">x</div><!-- /wp:custom-thing -->');
    expect(out.html).toBe('<div class="c">x</div>');
    expect(out.unknown).toEqual(['core/custom-thing']);
  });

  it('handles self-closing delimiters and namespaced blocks', () => {
    const out = normalizeGutenberg('<!-- wp:separator /-->\n<!-- wp:jetpack/map {"a":1} --><div>m</div><!-- /wp:jetpack/map -->');
    expect(out.html).toBe('<div>m</div>');
    expect(out.blocks).toEqual(['core/separator', 'jetpack/map']);
    expect(out.unknown).toEqual(['jetpack/map']);
  });

  it('leaves a body without blocks as it is, and treats an empty body as empty', () => {
    expect(normalizeGutenberg('<p>plain</p>').html).toBe('<p>plain</p>');
    expect(normalizeGutenberg(undefined)).toEqual({ html: '', blocks: [], unknown: [] });
  });
});
