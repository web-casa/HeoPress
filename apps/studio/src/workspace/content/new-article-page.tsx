import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { FilePlus2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CollectionResource } from '@heopress/sdk';
import { HeoPressError } from '@heopress/sdk';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { withAdminBase } from '@/lib/keybindings/commands';
import { usePermissions } from '@/lib/use-permissions';
import { siteKey } from '../api';
import { Page } from '../shell/module-layout';
import { EmptyState } from '../ui/empty-state';
import { isArticleCollection } from './article-rules';

/**
 * Content › New article (HeoPress P07a follow-up; spec studio/article-editor "新建文章"): the few fields a draft needs —
 * title, address and language — then the article editor takes over. With several article collections the person picks
 * one; one they may not create in is not offered.
 */

/** The article collections of the site this person may create in, in the site's order. */
export function useCreatableArticleCollections() {
  const perms = usePermissions();
  const query = useQuery({
    queryKey: siteKey('collections'),
    queryFn: async () => (await getApiClient().schema.listCollections()).data,
  });
  const list = (query.data ?? []).filter((c) => isArticleCollection(c.name, c.meta) && (perms.isAdmin || perms.can(c.name, 'create')));
  return { list, isLoading: query.isLoading || perms.isLoading };
}

/** An address from a title: lowercase letters, digits and hyphens; a dated one when the title has none (e.g. in Chinese). */
export function slugFrom(title: string, now: Date = new Date()): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
  return slug || `post-${day}-${now.getTime().toString(36).slice(-4)}`;
}

const collectionLabel = (c: CollectionResource) => c.pluralLabel || c.label || c.name;

export function NewArticlePage({ collection: fixed }: { collection?: string }) {
  const { t } = useTranslation('content');
  const id = useId();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { location } = useRouterState();
  const adminBase = getAdminBase(location.pathname);
  const wanted = fixed ?? (location.search as { collection?: string }).collection;
  const { list, isLoading } = useCreatableArticleCollections();
  const site = useQuery({ queryKey: siteKey('site-row'), queryFn: async () => (await getApiClient().rawRequest<{ defaultLanguage?: string | null }>('/api/v1/site')).data });

  const [collection, setCollection] = useState('');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [slugEdited, setSlugEdited] = useState(false);
  const [locale, setLocale] = useState('');
  const [localeEdited, setLocaleEdited] = useState(false);
  useEffect(() => {
    if (!collection && list.length) setCollection(list.find((c) => c.name === wanted)?.name ?? list[0]!.name);
  }, [collection, list, wanted]);
  useEffect(() => {
    if (!localeEdited && site.data?.defaultLanguage) setLocale(site.data.defaultLanguage);
  }, [localeEdited, site.data?.defaultLanguage]);
  const address = slugEdited ? slug : title.trim() ? slugFrom(title) : '';

  const create = useMutation({
    mutationFn: async () =>
      (await getApiClient().items(collection as never).create({ data: { title: title.trim(), slug: address.trim(), locale: locale.trim() }, status: 'draft' })).data as { id: string },
    onSuccess: (item) => {
      void qc.invalidateQueries({ queryKey: siteKey('content-items') });
      void navigate({ to: withAdminBase(adminBase, `/content/${encodeURIComponent(collection)}/${encodeURIComponent(item.id)}`) as never, replace: true });
    },
  });
  const failure = create.error
    ? create.error instanceof HeoPressError
      ? ((create.error.body as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ?? create.error.message)
      : t('new.failed')
    : null;

  if (isLoading) return <Page>{null}</Page>;
  if (list.length === 0) {
    return (
      <Page>
        <EmptyState icon={FilePlus2} title={t('new.none')} body={t('new.noneHint')} />
      </Page>
    );
  }

  const input = 'h-9 w-full rounded-ctl border border-line bg-bg px-2.5 text-[13px] outline-none focus:border-brand';
  return (
    <Page>
      <form
        aria-labelledby={`${id}-title`}
        className="mx-auto mt-6 max-w-xl rounded-card border border-line bg-panel"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="border-b border-line px-5 py-4">
          <h1 id={`${id}-title`} className="text-[17px] font-semibold leading-6">
            {t('new.title')}
          </h1>
          <p className="t-aux mt-0.5">{t('new.hint')}</p>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          {list.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-collection`} className="text-[13px] font-medium">
                {t('new.type')}
              </label>
              <select id={`${id}-collection`} value={collection} onChange={(e) => setCollection(e.target.value)} className={input}>
                {list.map((c) => (
                  <option key={c.name} value={c.name}>
                    {collectionLabel(c)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-name`} className="text-[13px] font-medium">
              {t('new.articleTitle')}
            </label>
            <input id={`${id}-name`} autoFocus required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} className={input} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-slug`} className="text-[13px] font-medium">
              {t('new.slug')}
            </label>
            <input
              id={`${id}-slug`}
              required
              value={address}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
              className={`${input} font-mono`}
            />
            <p className="t-aux">{t('new.slugHint')}</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-locale`} className="text-[13px] font-medium">
              {t('new.language')}
            </label>
            <input
              id={`${id}-locale`}
              required
              value={locale}
              onChange={(e) => {
                setLocaleEdited(true);
                setLocale(e.target.value);
              }}
              className={`${input} w-40`}
            />
          </div>
          {failure ? (
            <p role="alert" className="rounded-ctl bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
              {failure}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-3">
          <button type="button" onClick={() => window.history.back()} disabled={create.isPending} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2">
            {t('new.cancel')}
          </button>
          <button type="submit" disabled={create.isPending || !collection} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            {create.isPending ? t('new.creating') : t('new.create')}
          </button>
        </div>
      </form>
    </Page>
  );
}
