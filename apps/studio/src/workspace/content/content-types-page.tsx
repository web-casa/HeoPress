import { useQuery } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronRight, Database, FileText, PenLine } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CollectionResource } from '@heopress/sdk';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { withAdminBase } from '@/lib/keybindings/commands';
import { usePermissions } from '@/lib/use-permissions';
import { siteKey } from '../api';
import { Page } from '../shell/module-layout';
import { EmptyState } from '../ui/empty-state';
import { SkeletonRows } from '../ui/skeleton';
import { ArticleKindToggle } from './article-kind-toggle';
import { isArticleCollection } from './article-rules';

/**
 * Content › Content types (HeoPress P07a follow-up): the kinds of content of the site — articles, pages, categories… —
 * each opening its list. Administrators choose here which ones are written in the article editor.
 */
export function ContentTypesPage() {
  const { t } = useTranslation('content');
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const { isAdmin } = usePermissions();
  const query = useQuery({ queryKey: siteKey('collections'), queryFn: async () => (await getApiClient().schema.listCollections()).data });
  const list = (query.data ?? []).filter((c) => !c.hidden && !c.system);
  const label = (c: CollectionResource) => c.pluralLabel || c.label || c.name;

  return (
    <Page>
      <h1 className="t-page">{t('types.title')}</h1>
      <p className="t-aux mt-1">{t('types.hint')}</p>
      {isAdmin ? <p className="t-aux mt-0.5">{t('types.articleHint')}</p> : null}
      <div className="mt-5">
        {query.isLoading ? (
          <SkeletonRows rows={5} />
        ) : query.isError ? (
          <p role="alert" className="text-[13px] text-bad">
            {t('types.failed')}
          </p>
        ) : list.length === 0 ? (
          <EmptyState icon={Database} title={t('types.empty')} body={t('types.emptyHint')} />
        ) : (
          <ul className="divide-y divide-line rounded-card border border-line bg-panel">
            {list.map((c) => {
              const article = isArticleCollection(c.name, c.meta);
              const Icon = article ? PenLine : FileText;
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <Link to={withAdminBase(adminBase, `/content/${encodeURIComponent(c.name)}`) as never} className="group flex min-w-0 flex-1 items-center gap-3">
                    <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-ctl bg-panel-2 text-icon">
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[13.5px] font-medium group-hover:text-brand">{label(c)}</span>
                      <span className="block truncate font-mono text-[11.5px] text-dim">
                        {c.name}
                        {c.singleton ? ` · ${t('types.single')}` : ''}
                      </span>
                    </span>
                    {article ? <span className="rounded-full bg-brand-soft px-2 py-0.5 text-[11px] text-brand">{t('types.article')}</span> : null}
                    <ChevronRight className="ml-auto h-4 w-4 shrink-0 text-icon" aria-hidden="true" />
                  </Link>
                  {isAdmin && !c.singleton ? (
                    <div className="w-full pl-11 sm:w-auto sm:pl-0">
                      <ArticleKindToggle name={c.name} meta={c.meta} compact />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Page>
  );
}
