import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeoPressError, type SiteContentSettingsInput, type SiteContentSettingsResource } from '@heopress/sdk';
import { AlertTriangle, Check, Languages, Megaphone, Save } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';
import { getApiClient } from '@/lib/api';

/**
 * Content settings — the sponsored-content policy (HeoPress P05 task 1.9;
 * spec content/site-network-model "赞助内容标记"; design F, ADR-0016).
 *
 * Two switches, both on for a new site: a visible disclosure on sponsored
 * items, and `rel="sponsored"` on their links. Saving a change needs a
 * reason. Turning a switch off shows the risk the server names for it and
 * asks for confirmation in a modal dialog (the native one: focus stays in
 * it, Escape cancels, focus returns after); cancelling saves nothing. The change is audited and
 * re-renders the site's sponsored items (the CMS emits the event).
 *
 * Cross-site translations (P05 tasks 4.2, 4.4; ADR-0009): off by default.
 * Turning it on lets this site's items share translation groups with another
 * site that has it on too — which links the sites for anyone who reads the
 * language switch or hreflang data, so the risk is spelled out next to the
 * switch. Turning it off hides the other sites' versions at once.
 */

type Risk = 'disclosure' | 'rel';

const toInput = (s: SiteContentSettingsResource): SiteContentSettingsInput => ({
  availableLocales: s.availableLocales,
  timezone: s.timezone,
  siteType: s.siteType,
  trailingSlash: s.trailingSlash,
  localeStrategy: s.localeStrategy,
  localePrefixMode: s.localePrefixMode,
  localePrefixes: s.localePrefixes,
  permalinks: s.permalinks,
  allowCrossSiteTranslations: s.allowCrossSiteTranslations,
  sponsorDisclosure: s.sponsorDisclosure,
  sponsorRel: s.sponsorRel,
  version: s.version,
});

/** The risks a 422 RISK_ACK_REQUIRED names, or null. */
function risksOf(err: unknown): Partial<Record<Risk, string>> | null {
  if (!(err instanceof HeoPressError) || err.status !== 422) return null;
  const first = (err.body as { errors?: Array<{ code?: string; details?: { risks?: Partial<Record<Risk, string>> } }> })?.errors?.[0];
  return first?.code === 'RISK_ACK_REQUIRED' ? (first.details?.risks ?? {}) : null;
}

export function ContentSettingsPage() {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['content-settings'],
    queryFn: async () => (await client.site.contentSettings()).data,
  });

  const [disclosure, setDisclosure] = useState(true);
  const [rel, setRel] = useState(true);
  const [reason, setReason] = useState('');
  const [risks, setRisks] = useState<Partial<Record<Risk, string>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [saved, setSaved] = useState(false);
  const ids = { disclosure: useId(), rel: useId(), reason: useId(), crossSite: useId() };
  const [crossSite, setCrossSite] = useState(false);
  const [crossSiteSaved, setCrossSiteSaved] = useState(false);

  // The risk dialog is modal while there are risks to confirm.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (risks && !dialog.open) dialog.showModal();
    if (!risks && dialog.open) dialog.close();
  }, [risks]);

  useEffect(() => {
    if (!query.data) return;
    setDisclosure(query.data.sponsorDisclosure);
    setRel(query.data.sponsorRel);
    setCrossSite(query.data.allowCrossSiteTranslations);
  }, [query.data]);

  const saveCrossSite = useMutation({
    mutationFn: async (allow: boolean) =>
      (await client.site.updateContentSettings({ ...toInput(query.data!), allowCrossSiteTranslations: allow })).data,
    onMutate: () => setCrossSiteSaved(false),
    onSuccess: () => {
      setCrossSiteSaved(true);
      void qc.invalidateQueries({ queryKey: ['content-settings'] });
    },
  });

  const save = useMutation({
    mutationFn: async (riskAcknowledged: Risk[]) => {
      const current = query.data!;
      return (
        await client.site.updateContentSettings({
          ...toInput(current),
          sponsorDisclosure: disclosure,
          sponsorRel: rel,
          reason: reason.trim(),
          riskAcknowledged,
        })
      ).data;
    },
    onSuccess: () => {
      setRisks(null);
      setReason('');
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['content-settings'] });
    },
    onError: (err) => {
      const named = risksOf(err);
      if (named) {
        // The server names the risk of each switch being turned off: show it and ask.
        setRisks(named);
        return;
      }
      const message = err instanceof Error ? err.message : t('content.saveFailed');
      // A failure after confirming shows where the person is looking: in the dialog.
      if (risks) setConfirmError(message);
      else setError(message);
    },
  });

  if (query.isError) {
    return (
      <div role="alert" className="flex items-center gap-3 rounded-ctl bg-bad-soft p-3 text-sm text-bad">
        <AlertTriangle className="h-4 w-4" aria-hidden /> {t('content.loadFailed')}
        <button type="button" onClick={() => void query.refetch()} className="rounded-ctl border px-2 py-1 border-line hover:bg-panel-2">
          {t('content.tryAgain')}
        </button>
      </div>
    );
  }
  if (query.isLoading || !query.data) return <p className="p-6 text-sm text-dim">{t('common:loading')}</p>;
  const changed = disclosure !== query.data.sponsorDisclosure || rel !== query.data.sponsorRel;

  const submit = () => {
    setError(null);
    setSaved(false);
    save.mutate([]);
  };

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader title={t('content.title')} description={t('content.description')} />

      <section aria-labelledby="sponsor-heading" className="space-y-4 rounded-card border p-5 border-line">
        <h2 id="sponsor-heading" className="flex items-center gap-2 t-section">
          <Megaphone className="h-4 w-4" aria-hidden /> {t('content.sponsored')}
        </h2>
        <p className="text-sm text-dim">
          {t('content.sponsoredHelp', { version: query.data.sponsorPolicyVersion })}
        </p>
        <label htmlFor={ids.disclosure} className="flex items-start gap-3">
          <input id={ids.disclosure} type="checkbox" checked={disclosure} onChange={(e) => setDisclosure(e.target.checked)} className="mt-1" />
          <span>
            <span className="font-medium">{t('content.showDisclosure')}</span>
            <span className="block text-sm text-dim">{t('content.showDisclosureHelp')}</span>
          </span>
        </label>
        <label htmlFor={ids.rel} className="flex items-start gap-3">
          <input id={ids.rel} type="checkbox" checked={rel} onChange={(e) => setRel(e.target.checked)} className="mt-1" />
          <span>
            <span className="font-medium">{t('content.markRel')}</span>
            <span className="block text-sm text-dim">{t('content.markRelHelp')}</span>
          </span>
        </label>
        <div>
          <label htmlFor={ids.reason} className="text-sm font-medium">
            {t('content.reason')}
          </label>
          <textarea
            id={ids.reason}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="mt-1 w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            placeholder={t('content.reasonPlaceholder')}
          />
        </div>
        {error && (
          <p role="alert" className="flex items-center gap-2 rounded-ctl bg-bad-soft p-2 text-sm text-bad">
            <AlertTriangle className="h-4 w-4" aria-hidden /> {error}
          </p>
        )}
        {saved && (
          <p role="status" className="flex items-center gap-2 text-sm text-ok">
            <Check className="h-4 w-4" aria-hidden /> {t('content.savedSponsored')}
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={submit}
            disabled={!changed || !reason.trim() || save.isPending}
            className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50"
          >
            <Save className="h-4 w-4" aria-hidden /> {t('common:save')}
          </button>
        </div>
      </section>

      <section aria-labelledby="cross-site-heading" className="space-y-4 rounded-card border p-5 border-line">
        <h2 id="cross-site-heading" className="flex items-center gap-2 t-section">
          <Languages className="h-4 w-4" aria-hidden /> {t('content.crossSite')}
        </h2>
        <label htmlFor={ids.crossSite} className="flex items-start gap-3">
          <input id={ids.crossSite} type="checkbox" checked={crossSite} onChange={(e) => setCrossSite(e.target.checked)} className="mt-1" />
          <span>
            <span className="font-medium">{t('content.allowCrossSite')}</span>
            <span className="block text-sm text-dim">
              {t('content.allowCrossSiteHelp')}
            </span>
          </span>
        </label>
        <p role="note" className="flex items-start gap-2 rounded-ctl bg-warn-soft p-3 text-sm text-warn">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            {t('content.crossSiteRisk')}
          </span>
        </p>
        {saveCrossSite.isError && (
          <p role="alert" className="flex items-center gap-2 rounded-ctl bg-bad-soft p-2 text-sm text-bad">
            <AlertTriangle className="h-4 w-4" aria-hidden /> {saveCrossSite.error instanceof Error ? saveCrossSite.error.message : t('content.saveFailed')}
          </p>
        )}
        {crossSiteSaved && (
          <p role="status" className="flex items-center gap-2 text-sm text-ok">
            <Check className="h-4 w-4" aria-hidden /> {t('content.saved')}
          </p>
        )}
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => saveCrossSite.mutate(crossSite)}
            disabled={crossSite === query.data.allowCrossSiteTranslations || saveCrossSite.isPending}
            className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50"
          >
            <Save className="h-4 w-4" aria-hidden /> {t('content.saveCrossSite')}
          </button>
        </div>
      </section>

      <dialog
        ref={dialogRef}
        aria-labelledby="risk-heading"
        onCancel={(e) => {
          e.preventDefault();
          setRisks(null);
          setConfirmError(null);
        }}
        className="w-full max-w-lg rounded-card border bg-panel p-6 backdrop:bg-black/40 border-line"
      >
        <h2 id="risk-heading" className="flex items-center gap-2 t-section">
          <AlertTriangle className="h-5 w-5 text-warn" aria-hidden /> {t('content.riskTitle')}
        </h2>
        <ul className="mt-3 space-y-3 text-sm">
          {(Object.entries(risks ?? {}) as Array<[Risk, string]>).map(([risk, text]) => (
            <li key={risk}>
              <span className="font-medium">{risk === 'disclosure' ? t('content.riskDisclosure') : t('content.riskRel')}{t('content.colon')}</span>
              {text}
            </li>
          ))}
        </ul>
        {confirmError && (
          <p role="alert" className="mt-3 rounded-ctl bg-bad-soft p-2 text-sm text-bad">
            {confirmError}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            autoFocus
            onClick={() => {
              setRisks(null);
              setConfirmError(null);
            }}
            className="rounded-ctl px-3 py-1.5 text-sm"
          >
            {t('common:cancel')}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmError(null);
              save.mutate(Object.keys(risks ?? {}) as Risk[]);
            }}
            disabled={save.isPending}
            className="rounded-ctl bg-warn px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {t('content.confirmRisk')}
          </button>
        </div>
      </dialog>
      <PresetReport />
      <StructuredDataReport />
    </div>
  );
}

/**
 * The site's content preset (HeoPress P07 task 2.4): its version and what the last install or upgrade skipped — a field
 * of the site's own with a preset field's name is never overwritten, so the preset's field is missing there.
 */
export function PresetReport() {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const query = useQuery({ queryKey: ['site-preset'], queryFn: async () => (await client.site.preset()).data, retry: false });
  if (query.isError) {
    return (
      <section aria-label={t('content.preset')} className="mt-8 space-y-2">
        <h2 className="text-sm font-semibold">{t('content.preset')}</h2>
        <p role="alert" className="text-sm text-bad">
          {t('content.presetLoadFailed')}{' '}
          <button type="button" className="underline" onClick={() => void query.refetch()}>
            {t('content.tryAgain')}
          </button>
        </p>
      </section>
    );
  }
  const preset = query.data;
  if (!preset) return null;
  const skipped = (preset.report?.skipped ?? []).filter((s) => s.reason !== 'exists');
  return (
    <section aria-label={t('content.preset')} className="mt-8 space-y-2">
      <h2 className="text-sm font-semibold">{t('content.preset')}</h2>
      <p className="text-sm text-dim">
        {t('content.presetVersion', { preset: preset.preset, version: preset.version })}
        {preset.report?.at ? t('content.lastChecked', { date: new Date(preset.report.at).toLocaleString() }) : ''}
      </p>
      {skipped.length ? (
        <>
          <p className="text-sm">{t('content.presetSkipped')}</p>
          <ul className="list-disc pl-5 text-sm">
            {skipped.map((s) => (
              <li key={`${s.collection}.${s.field ?? s.relation ?? ''}.${s.reason}`}>
                {s.collection}
                {s.field ? ` · ${s.field}` : s.relation ? ` · ${s.relation}` : ''} — {t(SKIP_REASONS[s.reason] ?? 'content.skip.other', { reason: s.reason })}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-sm text-dim">{t('content.presetComplete')}</p>
      )}
    </section>
  );
}

/**
 * What the site's structured-data contributions came to (HeoPress P07 tasks 2.9, 2.10): its extensions' site nodes, and
 * what was left out — of extensions' contributions and of published pages' own structured data — and why.
 */
export function StructuredDataReport() {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const query = useQuery({ queryKey: ['site-structured-data'], queryFn: async () => (await client.site.structuredData()).data, retry: false });
  const heading = <h2 className="text-sm font-semibold">{t('content.structuredData')}</h2>;
  if (query.isError) {
    return (
      <section aria-label={t('content.structuredData')} className="mt-8 space-y-2">
        {heading}
        <p role="alert" className="text-sm text-bad">
          {t('content.structuredDataLoadFailed')}{' '}
          <button type="button" className="underline" onClick={() => void query.refetch()}>
            {t('content.tryAgain')}
          </button>
        </p>
      </section>
    );
  }
  const report = query.data;
  if (!report) return null;
  const nothing = !report.site.nodes.length && !report.site.diagnostics.length && !report.items.length;
  return (
    <section aria-label={t('content.structuredData')} className="mt-8 space-y-2">
      {heading}
      {nothing ? <p className="text-sm text-dim">{t('content.structuredDataNothing')}</p> : null}
      {report.site.nodes.length ? (
        <p className="text-sm">
          {t('content.siteNodes', { nodes: report.site.nodes.map((n) => `${String(n.type)} (${n.source.replace(/^extension:/, '')})`).join(', ') })}
        </p>
      ) : null}
      {report.site.diagnostics.length ? (
        <ul className="list-disc pl-5 text-sm">
          {report.site.diagnostics.map((d) => (
            <li key={`${d.code}|${d.source}|${d.message}`}>
              {sourceLabel(d.source)}{t('content.colon')}{d.message}
            </li>
          ))}
        </ul>
      ) : null}
      {report.items.length ? (
        <>
          <p className="text-sm">
            {t('content.leftOutOf', { count: report.itemsWithDiagnostics })}
          </p>
          <ul className="list-disc pl-5 text-sm">
            {report.items.map((i) => (
              <li key={i.itemId}>
                {i.url ?? i.path}
                <ul className="list-[circle] pl-5">
                  {i.diagnostics.map((d) => (
                    <li key={`${d.code}|${d.source}|${d.message}`}>
                      {d.source === 'item' ? t('content.itsStructuredData') : sourceLabel(d.source)}{t('content.colon')}{d.message}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/** `extension:<name>` → "Extension <name>"; any other source as it is. */
function sourceLabel(source: string): string {
  return source.startsWith('extension:') ? i18n.t('siteOps:content.extensionSource', { name: source.slice('extension:'.length) }) : source;
}

const SKIP_REASONS: Record<string, string> = {
  site_field_with_same_name: 'content.skip.sameName',
  renamed_by_site: 'content.skip.renamed',
  field_not_from_preset: 'content.skip.ownField',
  choices_changed_by_site: 'content.skip.choicesChanged',
};
