import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { studioBuildMetadata } from '@/lib/build-metadata';
import { PageHeader } from '../ui/page-header';

/**
 * Settings › License (HeoPress P07a task 12.6; spec studio/settings "许可证"): the version, the license, and the texts
 * shipped with the product — loaded only when opened, so they cost the first screen nothing.
 */

type Doc = 'license' | 'notice' | 'thirdParty';

const LOADERS: Record<Doc, () => Promise<{ default: string }>> = {
  license: () => import('../../../../../LICENSE?raw'),
  notice: () => import('../../../../../NOTICE?raw'),
  thirdParty: () => import('../../../../../THIRD_PARTY_NOTICES.md?raw'),
};

export function LicensePage() {
  const { t } = useTranslation('settings');
  const [open, setOpen] = useState<{ doc: Doc; text: string | null } | null>(null);
  const show = (doc: Doc) => {
    setOpen({ doc, text: null });
    void LOADERS[doc]().then(
      (m) => setOpen((o) => (o?.doc === doc ? { doc, text: m.default } : o)),
      () => setOpen((o) => (o?.doc === doc ? { doc, text: t('license.loadFailed') } : o)),
    );
  };
  const rows: Array<[string, string]> = [
    [t('license.version'), studioBuildMetadata.version],
    [t('license.build'), `${studioBuildMetadata.gitSha.slice(0, 12)} · ${studioBuildMetadata.releaseChannel}`],
    [t('license.licenseName'), t('license.licenseValue')],
  ];
  return (
    <>
      <PageHeader title={t('license.title')} description={t('license.description')} />
      <dl className="divide-y divide-line rounded-card border border-line bg-panel">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 px-4 py-3 sm:grid-cols-[200px_1fr]">
            <dt className="t-aux">{label}</dt>
            <dd className="t-num text-[13.5px]">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="mt-5 grid gap-3 sm:grid-cols-3">
        {(
          [
            ['license', 'licenseText', 'licenseTextBody'],
            ['thirdParty', 'notices', 'noticesBody'],
            ['notice', 'noticeFile', 'noticeFileBody'],
          ] as const
        ).map(([doc, title, body]) => (
          <div key={doc} className="flex flex-col gap-2 rounded-card border border-line bg-panel p-4">
            <h2 className="t-section">{t(`license.${title}`)}</h2>
            <p className="flex-1 t-aux">{t(`license.${body}`)}</p>
            <button type="button" onClick={() => show(doc)} className="self-start rounded-ctl border border-line px-2.5 py-1.5 text-[13px] hover:bg-panel-2">
              {t('license.open', { name: t(`license.${title}`) })}
            </button>
          </div>
        ))}
      </section>
      <section className="mt-3 rounded-card border border-line bg-panel p-4">
        <h2 className="t-section">{t('license.commercial')}</h2>
        <p className="mt-1 t-aux">{t('license.commercialBody')}</p>
      </section>

      {open ? (
        <div role="dialog" aria-modal="true" aria-labelledby="license-doc-title" className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-card border border-line bg-panel shadow-lg">
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 id="license-doc-title" className="t-section">
                {t(`license.${open.doc === 'license' ? 'licenseText' : open.doc === 'notice' ? 'noticeFile' : 'notices'}`)}
              </h2>
              <button type="button" onClick={() => setOpen(null)} className="rounded-ctl border border-line px-2.5 py-1 text-[13px]">
                {t('license.close')}
              </button>
            </div>
            <pre className="overflow-auto whitespace-pre-wrap px-5 py-4 text-[12px] leading-relaxed">{open.text ?? t('license.loading')}</pre>
          </div>
        </div>
      ) : null}
    </>
  );
}
