import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fromMicros, toMicros } from '@/modules/settings/models-page';
import { siteKey } from '../api';
import { PageHeader } from '../ui/page-header';
import { Skeleton } from '../ui/skeleton';
import { aiApi, type AutoPublishSettings, type LlmSettings } from './api';

/**
 * Settings › AI pipeline (HeoPress P09 tasks 3.x, 4.2, 4.4, 4.6): pause and resume the pipeline, the monthly and daily
 * model budgets, the daily processing limit, and auto-publish (cadence, veto window, source freshness). Site
 * administrators only; the server checks and audits every change.
 */

const field = 'rounded-ctl border border-line bg-panel px-2 py-1.5 text-[13px]';

/** A whole number or empty (null); undefined when it is neither. */
export function intOrNull(text: string): number | null | undefined {
  if (!text.trim()) return null;
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

function PipelineSection() {
  const { t } = useTranslation('ai');
  const qc = useQueryClient();
  const state = useQuery({ queryKey: siteKey('ai-pipeline'), queryFn: aiApi.pipeline });
  const done = () => qc.invalidateQueries({ queryKey: siteKey('ai-pipeline') });
  const pause = useMutation({ mutationFn: () => aiApi.pause(), onSuccess: done });
  const resume = useMutation({ mutationFn: (reason: string) => aiApi.resume(reason), onSuccess: done });
  if (!state.data) return <Skeleton className="h-24" />;
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-panel p-5" aria-label={t('settings.pipeline')}>
      <h2 className="t-section">{t('settings.pipeline')}</h2>
      <p className="t-body" data-testid="pipeline-state">
        {state.data.paused ? t('settings.paused', { reasons: state.data.reasons.map((r) => t(`settings.reasons.${r}`)).join(', ') }) : t('settings.running')}
      </p>
      <div className="flex flex-wrap gap-2">
        {!state.data.reasons.includes('manual') ? (
          <button type="button" className="rounded-ctl border border-line px-3 py-1.5 text-[13px]" onClick={() => pause.mutate()} disabled={pause.isPending}>
            {t('settings.pause')}
          </button>
        ) : null}
        {state.data.reasons
          .filter((r) => r !== 'kill_switch')
          .map((r) => (
            <button key={r} type="button" className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg" onClick={() => resume.mutate(r)} disabled={resume.isPending}>
              {t('settings.resume', { reason: t(`settings.reasons.${r}`) })}
            </button>
          ))}
      </div>
      {state.data.reasons.includes('kill_switch') ? <p className="t-aux">{t('settings.killSwitch')}</p> : null}
    </section>
  );
}

function BudgetSection({ s }: { s: LlmSettings }) {
  const { t } = useTranslation('ai');
  const qc = useQueryClient();
  const [monthly, setMonthly] = useState(s.monthlyBudgetMicros === null ? '' : fromMicros(s.monthlyBudgetMicros));
  const [daily, setDaily] = useState(s.dailyBudgetMicros === null ? '' : fromMicros(s.dailyBudgetMicros));
  const [limit, setLimit] = useState(s.dailyProcessingLimit === null ? '' : String(s.dailyProcessingLimit));
  const [note, setNote] = useState<string | null>(null);
  const m = monthly.trim() ? toMicros(monthly) : null;
  const d = daily.trim() ? toMicros(daily) : null;
  const l = intOrNull(limit);
  const invalid = (monthly.trim() && m === null) || (daily.trim() && d === null) || l === undefined;
  const save = useMutation({
    mutationFn: () => aiApi.saveLlmSettings({ ...s, monthlyBudgetMicros: m, dailyBudgetMicros: d, dailyProcessingLimit: l ?? null }),
    onSuccess: async () => {
      setNote(t('settings.saved'));
      await qc.invalidateQueries({ queryKey: siteKey('ai-llm-settings') });
    },
  });
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-panel p-5" aria-label={t('settings.budget')}>
      <h2 className="t-section">{t('settings.budget')}</h2>
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('settings.monthly', { currency: s.currency })}
        <input className={field} value={monthly} onChange={(e) => setMonthly(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('settings.daily', { currency: s.currency })}
        <input className={field} value={daily} onChange={(e) => setDaily(e.target.value)} />
      </label>
      <label className="flex flex-col gap-1 text-[13px] font-medium">
        {t('settings.processingLimit')}
        <input className={field} inputMode="numeric" value={limit} onChange={(e) => setLimit(e.target.value)} />
      </label>
      <p className="t-aux">{t('settings.emptyMeansNone')}</p>
      {invalid ? (
        <p role="alert" className="text-[13px] text-bad">
          {t('settings.invalid')}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="button" disabled={!!invalid || save.isPending} onClick={() => save.mutate()} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
          {t('settings.save')}
        </button>
        {note ? <span className="t-aux">{note}</span> : null}
        {save.error ? <span className="text-[13px] text-bad">{save.error instanceof Error ? save.error.message : String(save.error)}</span> : null}
      </div>
    </section>
  );
}

function AutoPublishSection({ s }: { s: AutoPublishSettings }) {
  const { t } = useTranslation('ai');
  const qc = useQueryClient();
  const [veto, setVeto] = useState(String(s.vetoWindowMinutes));
  const [dailyLimit, setDailyLimit] = useState(s.dailyLimit === null ? '' : String(s.dailyLimit));
  const [gap, setGap] = useState(String(s.minIntervalMinutes));
  const [age, setAge] = useState(String(s.sourceMaxAgeDays));
  const [note, setNote] = useState<string | null>(null);
  const values = { veto: intOrNull(veto), dailyLimit: intOrNull(dailyLimit), interval: intOrNull(gap), age: intOrNull(age) };
  const invalid = values.veto == null || values.interval == null || values.age == null || values.dailyLimit === undefined;
  const save = useMutation({
    mutationFn: () => aiApi.saveAutoPublishSettings({ vetoWindowMinutes: values.veto!, dailyLimit: values.dailyLimit ?? null, minIntervalMinutes: values.interval!, sourceMaxAgeDays: values.age! }),
    onSuccess: async () => {
      setNote(t('settings.saved'));
      await qc.invalidateQueries({ queryKey: siteKey('ai-auto-publish-settings') });
    },
  });
  const input = (label: string, value: string, set: (v: string) => void) => (
    <label className="flex flex-col gap-1 text-[13px] font-medium">
      {label}
      <input className={field} inputMode="numeric" value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );
  return (
    <section className="flex flex-col gap-3 rounded-card border border-line bg-panel p-5" aria-label={t('settings.autoPublish')}>
      <h2 className="t-section">{t('settings.autoPublish')}</h2>
      {input(t('settings.vetoWindow'), veto, setVeto)}
      {input(t('settings.dailyLimit'), dailyLimit, setDailyLimit)}
      {input(t('settings.minInterval'), gap, setGap)}
      {input(t('settings.sourceMaxAge'), age, setAge)}
      {invalid ? (
        <p role="alert" className="text-[13px] text-bad">
          {t('settings.invalid')}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button type="button" disabled={invalid || save.isPending} onClick={() => save.mutate()} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
          {t('settings.save')}
        </button>
        {note ? <span className="t-aux">{note}</span> : null}
        {save.error ? <span className="text-[13px] text-bad">{save.error instanceof Error ? save.error.message : String(save.error)}</span> : null}
      </div>
    </section>
  );
}

export function PipelineSettingsPage() {
  const { t } = useTranslation('ai');
  const llm = useQuery({ queryKey: siteKey('ai-llm-settings'), queryFn: aiApi.llmSettings });
  const ap = useQuery({ queryKey: siteKey('ai-auto-publish-settings'), queryFn: aiApi.autoPublishSettings });
  return (
    <>
      <PageHeader title={t('settings.title')} description={t('settings.description')} />
      <div className="flex flex-col gap-4">
        <PipelineSection />
        {llm.data ? <BudgetSection s={llm.data} /> : <Skeleton className="h-40" />}
        {ap.data ? <AutoPublishSection s={ap.data} /> : <Skeleton className="h-40" />}
      </div>
    </>
  );
}
