import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { studioApi } from '../api';
import { isArticleCollection } from './article-rules';

/**
 * Data model › collection: "edit as article" (HeoPress P07a task 6.1; design §20). Marks a custom collection
 * `meta.studio.kind = "article"` so Studio opens its items in the article editor. The preset `articles` collection
 * always is one.
 */
export function ArticleKindToggle({ name, meta }: { name: string; meta: unknown }) {
  const { t } = useTranslation('editor');
  const qc = useQueryClient();
  const preset = name === 'articles' && (meta as { preset?: { key?: unknown } } | null)?.preset?.key === 'articles';
  const on = isArticleCollection(name, meta);
  const set = useMutation({
    mutationFn: (next: boolean) => studioApi.setStudioKind(name, next ? 'article' : null),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['collection', name] }),
  });
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <input type="checkbox" checked={on} disabled={preset || set.isPending} onChange={(e) => set.mutate(e.target.checked)} />
      <span>{t('kind.label')}</span>
      <span className="text-dim">{preset ? t('kind.preset') : t('kind.hint')}</span>
      {set.isError ? <span role="alert" className="text-bad">{t('kind.failed')}</span> : null}
    </label>
  );
}
