/**
 * Gutenberg serialisation → clean HTML (v1.1 WordPress import; spec migration/wordpress-import "Gutenberg").
 *
 * A WordPress body is HTML with block-delimiter comments around each block:
 *
 *     <!-- wp:paragraph --><p>Text</p><!-- /wp:paragraph -->
 *     <!-- wp:image {"id":7} --><figure>…</figure><!-- /wp:image -->
 *
 * The comments are the editor's metadata, not content: HeoPress stores HTML, so they are removed and the block's own
 * markup stays. Blocks the importer does not know are kept the same way — their content is still HTML — and named in
 * the report so an operator can check them. `core/html`, `core/shortcode` and `core/embed` keep their inner content
 * as it is: the first two are raw by definition, and an embed's markup is what the sanitiser will see.
 */

export interface GutenbergResult {
  /** The body without block-delimiter comments. */
  html: string;
  /** The blocks seen, by name (`core/paragraph`), in order, deduplicated. */
  blocks: string[];
  /** The blocks the importer does not recognise (kept as HTML, reported). */
  unknown: string[];
}

const KNOWN = new Set([
  'paragraph', 'heading', 'list', 'list-item', 'quote', 'image', 'gallery', 'video', 'audio', 'file', 'embed',
  'table', 'separator', 'spacer', 'columns', 'column', 'group', 'buttons', 'button', 'cover', 'media-text',
  'code', 'preformatted', 'verse', 'pullquote', 'html', 'freeform', 'details', 'social-links', 'archives',
  'categories', 'latest-posts', 'page-list', 'shortcode', 'blockquote', 'classic',
]);

/** `wp:name` → `core/name` unless the delimiter already names a namespace. */
function blockName(raw: string): string {
  return raw.includes('/') ? raw : `core/${raw}`;
}

export function normalizeGutenberg(body: string | undefined): GutenbergResult {
  if (!body) return { html: '', blocks: [], unknown: [] };
  const blocks: string[] = [];
  const unknown: string[] = [];
  // Every delimiter: opening (`<!-- wp:x {...} -->`), closing (`<!-- /wp:x -->`) and self-closing (`<!-- wp:x /-->`).
  const html = body.replace(/<!--\s*\/?wp:([a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?)(?:\s+\{[^]*?\})?\s*\/?-->/g, (whole, raw: string) => {
    const name = blockName(raw);
    if (!blocks.includes(name)) blocks.push(name);
    const base = name.split('/').pop()!;
    if (!KNOWN.has(base) && !unknown.includes(name)) unknown.push(name);
    void whole;
    return '';
  });
  // The removal can leave the block's own whitespace around nothing: collapse runs of blank lines.
  return { html: html.replace(/\n{3,}/g, '\n\n').trim(), blocks, unknown };
}
