/**
 * Article collections (HeoPress P07a, design §20; spec studio/article-editor): the `articles` collection a site preset
 * installed, plus any collection an administrator marked `meta.studio.kind = "article"`. Pages, taxonomies and other
 * collections are not. Studio's three-pane editor and the "published articles" counts use this rule.
 */
export function isArticleCollection(name: string, meta: unknown): boolean {
  const m = (meta && typeof meta === 'object' ? meta : {}) as { preset?: { key?: unknown }; studio?: { kind?: unknown } };
  if (m.studio?.kind === 'article') return true;
  return name === 'articles' && m.preset?.key === 'articles';
}
