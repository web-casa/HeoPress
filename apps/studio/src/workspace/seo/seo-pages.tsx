import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { RootFilesPage } from '@/modules/settings/root-files-page';
import { SiteIdentityPage } from '@/modules/settings/site-identity-page';
import { StructuredDataReport } from '@/modules/settings/content-settings-page';
import { siteKey } from '../api';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';
import { Field, inputClass, SeoSection, Toggle, UnsavedBar, useLeaveGuard, useSeoDraft } from './seo-kit';
import { applyTemplate, canonicalError, crawlerMeaning, PRESETS, presetOf, type CrawlerPreset, type Purpose } from './seo-rules';

/** The SEO / GEO sections (HeoPress P07a tasks 8.2–8.4; spec studio/seo-settings). */

const get = async <T,>(path: string) => (await getApiClient().rawRequest<T>(path)).data;

function Loading() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-64" />
    </div>
  );
}

/** A published article of the site and the site's name, for the previews (no published article: a sample). */
function usePreviewSource() {
  const { t } = useTranslation('seo');
  const site = useQuery({ queryKey: siteKey('site-row'), queryFn: () => get<{ name: string }>('/api/v1/site') });
  const article = useQuery({
    queryKey: siteKey('seo-preview-article'),
    queryFn: async () => {
      const rows = await get<Array<{ id: string; collection: string; title: string }>>('/api/v1/studio/content/items?view=published');
      const first = rows[0];
      if (!first) return null;
      const item = await get<{ data: Record<string, unknown> }>(`/api/v1/items/${encodeURIComponent(first.collection)}/${encodeURIComponent(first.id)}`);
      const d = item.data;
      const text = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
      return { title: first.title, seoTitle: text('seo_title'), description: text('seo_description') || text('excerpt'), path: text('slug') ? `/${text('slug')}/` : '/' };
    },
  });
  return {
    site: site.data?.name ?? '',
    article: article.data ?? { title: t('preview.sampleTitle'), seoTitle: '', description: t('preview.sampleDescription'), path: '/' },
  };
}

export function AppearanceSection() {
  const { t } = useTranslation('seo');
  const seo = useSeoDraft('appearance');
  const source = usePreviewSource();
  if (seo.loading || !seo.value) return <Loading />;
  const s = seo.value;
  const title = source.article.seoTitle || applyTemplate(s.titleTemplate || DEFAULT_TITLE, { title: source.article.title, site: source.site }) || source.site;
  const description = source.article.description ? applyTemplate(s.descriptionTemplate || DEFAULT_DESCRIPTION, { description: source.article.description, title: source.article.title, site: source.site }) : '';
  return (
    <>
      <SeoSection
        title={t('appearance.title')}
        explain={
          <>
            <p>{t('appearance.explain')}</p>
            <p>{t('appearance.placeholders')}</p>
          </>
        }
      >
        <Field id="seo-title-template" label={t('appearance.titleTemplate')} hint={t('appearance.titleHint')} error={seo.errors.titleTemplate ? t(seo.errors.titleTemplate) : null}>
          <input id="seo-title-template" className={inputClass} value={s.titleTemplate} placeholder={DEFAULT_TITLE} aria-invalid={!!seo.errors.titleTemplate} onChange={(e) => seo.update((x) => ({ ...x, titleTemplate: e.target.value }))} />
        </Field>
        <Field id="seo-description-template" label={t('appearance.descriptionTemplate')} hint={t('appearance.descriptionHint')} error={seo.errors.descriptionTemplate ? t(seo.errors.descriptionTemplate) : null}>
          <input id="seo-description-template" className={inputClass} value={s.descriptionTemplate} placeholder={DEFAULT_DESCRIPTION} onChange={(e) => seo.update((x) => ({ ...x, descriptionTemplate: e.target.value }))} />
        </Field>
        <Toggle id="seo-index-site" label={t('appearance.indexSite')} hint={t('appearance.indexSiteHint')} checked={s.index.site} onChange={(v) => seo.update((x) => ({ ...x, index: { ...x.index, site: v } }))} />
        <section aria-label={t('preview.search')} className="rounded-ctl border border-line bg-bg p-4">
          <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-dim">{t('preview.search')}</p>
          <p className="truncate text-[16px] text-brand">{title}</p>
          <p className="truncate text-[12px] text-ok">{source.article.path}</p>
          <p className="line-clamp-2 text-[13px] text-dim">{description || t('preview.noDescription')}</p>
          {!s.index.site ? <p className="mt-2 text-[12.5px] text-warn">{t('preview.notIndexed')}</p> : null}
        </section>
      </SeoSection>
      {seo.bar}
    </>
  );
}

const DEFAULT_TITLE = '{title} · {site}';
const DEFAULT_DESCRIPTION = '{description}';
const SAMPLE_CSV = '/old-path/,/new-path/,301';

const PURPOSES: Purpose[] = ['search', 'user-fetch', 'training'];

export function CrawlersSection() {
  const { t } = useTranslation('seo');
  const seo = useSeoDraft('crawlers');
  if (seo.loading || !seo.value) return <Loading />;
  const s = seo.value;
  const preset = presetOf(s.crawlers.purposes);
  const meaning = crawlerMeaning(s.crawlers.purposes);
  const setPurposes = (purposes: Partial<Record<Purpose, 'allow' | 'disallow'>>) => seo.update((x) => ({ ...x, crawlers: { ...x.crawlers, purposes } }));
  return (
    <>
      <SeoSection title={t('crawlers.title')} explain={<p>{t('crawlers.explain')}</p>}>
        <div role="radiogroup" aria-label={t('crawlers.presets')} className="flex flex-wrap gap-2">
          {(Object.keys(PRESETS) as CrawlerPreset[]).map((p) => (
            <button key={p} type="button" role="radio" aria-checked={preset === p} onClick={() => setPurposes({ ...PRESETS[p] })} className={cn('rounded-ctl border px-3 py-1.5 text-[13px] disabled:cursor-not-allowed', preset === p ? 'border-brand bg-sel font-medium' : 'border-line hover:bg-panel-2')}>
              {t(`crawlers.preset.${p}`)}
            </button>
          ))}
          {preset === null ? <span className="self-center t-aux">{t('crawlers.custom')}</span> : null}
        </div>
        {PURPOSES.map((p) => (
          <Field key={p} id={`crawl-${p}`} label={t(`crawlers.purpose.${p}`)} hint={t(`crawlers.purposeHint.${p}`)}>
            <select id={`crawl-${p}`} className={inputClass} value={s.crawlers.purposes[p] ?? 'allow'} onChange={(e) => setPurposes({ ...s.crawlers.purposes, [p]: e.target.value as 'allow' | 'disallow' })}>
              <option value="allow">{t('crawlers.allow')}</option>
              <option value="disallow">{t('crawlers.disallow')}</option>
            </select>
          </Field>
        ))}
        <Toggle id="crawl-signal" label={t('crawlers.contentSignal')} hint={t('crawlers.contentSignalHint')} checked={s.crawlers.contentSignal} onChange={(v) => seo.update((x) => ({ ...x, crawlers: { ...x.crawlers, contentSignal: v } }))} />
        {Object.keys(s.crawlers.overrides).length || s.crawlers.custom.length ? (
          <p className="t-aux">{t('crawlers.more', { overrides: Object.keys(s.crawlers.overrides).length, custom: s.crawlers.custom.length })}</p>
        ) : null}
        {seo.errors.custom ? <p role="alert" className="text-[12.5px] text-bad">{t(seo.errors.custom)}</p> : null}
        <section aria-label={t('preview.meaning')} className="rounded-ctl border border-line bg-bg p-4 text-[13px]">
          <p className="mb-2 text-[11.5px] font-semibold uppercase tracking-wide text-dim">{t('preview.meaning')}</p>
          <p className={meaning.cite === 'no' ? 'text-warn' : ''}>{t(`preview.cite.${meaning.cite}`)}</p>
          <p>{t(meaning.train ? 'preview.train.yes' : 'preview.train.no')}</p>
          <p className="mt-2 t-aux">{t('preview.notSaved')}</p>
        </section>
      </SeoSection>
      {seo.bar}
    </>
  );
}

export function MachineSection() {
  const { t } = useTranslation('seo');
  const seo = useSeoDraft('machine');
  if (seo.loading || !seo.value) return <Loading />;
  const d = seo.value.discovery;
  const set = (patch: Partial<typeof d>) => seo.update((x) => ({ ...x, discovery: { ...x.discovery, ...patch } }));
  return (
    <>
      <SeoSection title={t('machine.title')} explain={<p>{t('machine.explain')}</p>} aside={<div className="mt-6"><StructuredDataReport /></div>}>
        <Toggle id="mr-llms" label={t('machine.llms')} hint={t('machine.llmsHint')} checked={d.llms} onChange={(v) => set({ llms: v })} />
        <Toggle id="mr-md" label={t('machine.markdown')} hint={t('machine.markdownHint')} checked={d.markdownCopies} onChange={(v) => set({ markdownCopies: v })} />
        <Toggle id="mr-feeds" label={t('machine.feeds')} hint={t('machine.feedsHint')} checked={d.feeds} onChange={(v) => set({ feeds: v })} />
        <Toggle id="mr-indexnow" label={t('machine.indexNow')} hint={t('machine.indexNowHint')} checked={d.indexNow} onChange={(v) => set({ indexNow: v })} />
        <Toggle id="mr-news" label={t('machine.news')} hint={t('machine.newsHint')} checked={d.newsSitemap} onChange={(v) => set({ newsSitemap: v })} />
        {d.newsSitemap ? (
          <Field id="mr-news-name" label={t('machine.newsName')} error={seo.errors.newsPublicationName ? t(seo.errors.newsPublicationName) : null}>
            <input id="mr-news-name" className={inputClass} value={d.newsPublicationName} onChange={(e) => set({ newsPublicationName: e.target.value })} />
          </Field>
        ) : null}
      </SeoSection>
      {seo.bar}
    </>
  );
}

interface Canonical {
  primary: string | null;
  domains: Array<{ id: string; hostname: string; primary: boolean }>;
}

export function CanonicalSection() {
  const { t } = useTranslation('seo');
  const qc = useQueryClient();
  const query = useQuery({ queryKey: siteKey('canonical'), queryFn: () => get<Canonical>('/api/v1/site/canonical') });
  const [draft, setDraft] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const current = query.data?.primary ?? '';
  const value = draft ?? current;
  const dirty = draft !== null && draft.trim().toLowerCase() !== current;
  useLeaveGuard('seo:canonical', dirty);
  const bound = (query.data?.domains ?? []).map((d) => d.hostname);
  const error = dirty ? canonicalError(value, bound) : null;
  const save = useMutation({
    mutationFn: async () => {
      const target = query.data!.domains.find((d) => d.hostname === value.trim().toLowerCase())!;
      await getApiClient().rawRequest(`/api/v1/domains/${encodeURIComponent(target.id)}/primary`, { method: 'POST' });
    },
    onSuccess: async () => {
      setDraft(null);
      setSavedNote(t('canonical.saved'));
      await qc.invalidateQueries({ queryKey: siteKey('canonical') });
    },
  });
  if (query.isLoading) return <Loading />;
  return (
    <>
      <SeoSection title={t('canonical.title')} explain={<p>{t('canonical.explain')}</p>}>
        {bound.length === 0 ? <p className="text-[13px] text-dim">{t('canonical.none')}</p> : null}
        <Field id="canonical-host" label={t('canonical.label')} hint={t('canonical.hint')} error={error ? t(error) : null}>
          <input id="canonical-host" list="canonical-hosts" className={inputClass} value={value} aria-invalid={!!error} onChange={(e) => (setSavedNote(null), setDraft(e.target.value))} />
          <datalist id="canonical-hosts">
            {bound.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        </Field>
        {bound.length > 1 ? <p className="t-aux">{t('canonical.others', { hosts: bound.filter((h) => h !== current).join(', ') })}</p> : null}
      </SeoSection>
      <UnsavedBar
        count={dirty ? 1 : 0}
        errors={error ? 1 : 0}
        saving={save.isPending}
        failed={save.error ? t('bar.failed', { reason: save.error instanceof Error ? save.error.message : String(save.error) }) : null}
        savedNote={savedNote}
        onDiscard={() => setDraft(null)}
        onSave={() => save.mutate()}
      />
    </>
  );
}

export function IdentitySection() {
  const { t } = useTranslation('seo');
  return (
    <SeoSection title={t('identity.title')} explain={<p>{t('identity.explain')}</p>}>
      {/* The section's left column replaces the page's own heading. */}
      <div className="[&>div>header]:hidden">
        <SiteIdentityPage />
      </div>
    </SeoSection>
  );
}

export function RootFilesSection() {
  const { t } = useTranslation('seo');
  return (
    <SeoSection title={t('rootFiles.title')} explain={<p>{t('rootFiles.explain')}</p>}>
      <div className="[&>div>header]:hidden">
        <RootFilesPage />
      </div>
    </SeoSection>
  );
}

interface RedirectRow {
  id: string;
  scope: string;
  fromPath: string;
  toPath: string | null;
  status: number;
  source: string;
  createdAt: string;
}

interface ImportReport {
  summary: Record<string, number>;
  reportHash: string;
}

export function RedirectsSection() {
  const { t } = useTranslation('seo');
  const { isAdmin } = usePermissions();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: siteKey('redirects'), queryFn: async () => (await getApiClient().rawRequest<RedirectRow[]>('/api/v1/redirects?limit=200')) as { data: RedirectRow[]; meta?: { total: number } } });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [content, setContent] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const remove = useMutation({
    mutationFn: () => getApiClient().rawRequest('/api/v1/redirects/delete', { method: 'POST', body: JSON.stringify({ ids: [...selected] }) }),
    onSuccess: () => {
      setSelected(new Set());
      void qc.invalidateQueries({ queryKey: siteKey('redirects') });
    },
  });
  const check = useMutation({
    mutationFn: async () => (await getApiClient().rawRequest<ImportReport>('/api/v1/redirects/import?dryRun=1', { method: 'POST', body: JSON.stringify({ content }) })).data,
    onSuccess: setReport,
  });
  const run = useMutation({
    mutationFn: () => getApiClient().rawRequest('/api/v1/redirects/import', { method: 'POST', body: JSON.stringify({ content, reportHash: report!.reportHash }) }),
    onSuccess: () => {
      setContent('');
      setReport(null);
      void qc.invalidateQueries({ queryKey: siteKey('redirects') });
    },
  });
  useLeaveGuard('seo:redirects', content.trim().length > 0);
  const rows = list.data?.data ?? [];
  return (
    <SeoSection title={t('redirects.title')} explain={<p>{t('redirects.explain')}</p>}>
      {list.isLoading ? (
        <Skeleton className="h-40" />
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-dim">{t('redirects.empty')}</p>
      ) : (
        <table className="w-full text-left text-[13px]">
          <caption className="sr-only">{t('redirects.title')}</caption>
          <thead className="t-aux">
            <tr>
              <th className="w-8 py-1.5">
                <span className="sr-only">{t('redirects.select')}</span>
              </th>
              <th className="py-1.5">{t('redirects.from')}</th>
              <th className="py-1.5">{t('redirects.to')}</th>
              <th className="py-1.5">{t('redirects.status')}</th>
              <th className="py-1.5">{t('redirects.added')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-line">
                <td className="py-1.5">
                  <input
                    type="checkbox"
                    aria-label={t('redirects.selectOne', { from: r.fromPath })}
                    checked={selected.has(r.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(r.id);
                      else next.delete(r.id);
                      setSelected(next);
                    }}
                  />
                </td>
                <td className="py-1.5 font-mono text-[12px]">{r.fromPath}</td>
                <td className="py-1.5 font-mono text-[12px]">{r.toPath ?? '—'}</td>
                <td className="py-1.5 t-num">{r.status}</td>
                <td className="py-1.5 t-aux">
                  <RelativeTime value={r.createdAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {isAdmin && selected.size ? (
        <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className="self-start rounded-ctl border border-bad/40 px-3 py-1.5 text-[13px] text-bad hover:bg-bad-soft">
          {t('redirects.delete', { count: selected.size })}
        </button>
      ) : null}
      <Field id="redirect-import" label={t('redirects.import')} hint={t('redirects.importHint')}>
        <textarea id="redirect-import" rows={4} className={cn(inputClass, 'font-mono')} value={content} onChange={(e) => (setReport(null), setContent(e.target.value))} placeholder={SAMPLE_CSV} />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={!content.trim() || check.isPending} onClick={() => check.mutate()} className="rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2 disabled:opacity-50">
          {t('redirects.check')}
        </button>
        {report ? (
          <>
            <span className="t-aux">{t('redirects.report', { import: report.summary.import ?? 0, replaced: report.summary.replaced ?? 0, conflicts: report.summary.conflicts ?? 0, loops: report.summary.loops ?? 0 })}</span>
            <button type="button" disabled={run.isPending} onClick={() => run.mutate()} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
              {t('redirects.run')}
            </button>
          </>
        ) : null}
        {check.error || run.error ? (
          <span role="alert" className="text-[12.5px] text-bad">
            {String((check.error ?? run.error) instanceof Error ? (check.error ?? run.error)!.message : check.error ?? run.error)}
          </span>
        ) : null}
      </div>
    </SeoSection>
  );
}
