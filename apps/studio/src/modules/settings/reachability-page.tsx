import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeoPressError, type ReachabilityPlatform, type SiteReachabilityResource } from '@heopress/sdk';
import { Globe, Play } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';
import { getApiClient } from '@/lib/api';

/**
 * Reachability check — what the site's verified domains actually answer (HeoPress P07 task 3.9; spec seo/crawl-discovery
 * "线上可达性体检").
 *
 * The robots.txt, sitemaps, feeds, llms.txt, the home page and sample pages with their Markdown copies are requested on
 * each domain and judged against what the site's settings and indexing decisions expect (a file turned off must not be
 * served; a noindex page must answer and say noindex). AI crawlers are simulated with their User-Agent — marked as
 * simulated — and AI crawlers that stopped reading the site are flagged. Each problem has advice for the platform the site
 * is deployed on. Only the site's verified domains can be checked; administrators start a check, the worker runs it.
 */

type Report = NonNullable<SiteReachabilityResource['report']>;

const SEVERITY_CLASS: Record<string, string> = {
  error: 'bg-bad-soft text-bad',
  warning: 'bg-warn-soft text-warn',
  notice: 'bg-panel-2 text-dim',
};

function Severity({ value }: { value: string | null }) {
  const { t } = useTranslation('siteOps');
  if (!value) return null;
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_CLASS[value] ?? ''}`}>
      {value in SEVERITY_CLASS ? t(`reachability.severity.${value}`) : value}
    </span>
  );
}

function Advice({ text }: { text: string | null }) {
  if (!text) return null;
  return <pre className="whitespace-pre-wrap rounded bg-panel-2 p-2 text-xs">{text}</pre>;
}

/** The problems first: every check, simulated crawler request and traffic hint that is not as expected. */
function Problems({ report }: { report: Report }) {
  const { t } = useTranslation('siteOps');
  const checks = report.checks.filter((c) => !c.ok);
  const crawlers = report.crawlers.filter((c) => !c.ok);
  if (!checks.length && !crawlers.length && !report.traffic.length) return <p className="text-sm">{t('reachability.noProblems')}</p>;
  return (
    <ul aria-label={t('reachability.problems')} className="divide-y divide-line rounded-ctl border border-line">
      {checks.map((c) => (
        <li key={`${c.kind} ${c.url}`} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Severity value={c.severity} />
            <code className="text-xs">{c.url}</code>
            <code className="text-xs text-dim">{c.code}</code>
          </div>
          <p>{c.detail}</p>
          <p className="text-dim">{t('reachability.expectedBecause', { because: c.because })}</p>
          <Advice text={c.advice} />
        </li>
      ))}
      {crawlers.map((c) => (
        <li key={`${c.host} ${c.crawler}`} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Severity value={c.severity} />
            <span className="font-medium">{c.userAgent}</span>
            <span className="rounded border border-line px-1 text-xs">{t('reachability.simulated')}</span>
            <code className="text-xs text-dim">{c.code}</code>
          </div>
          <p>{c.detail}</p>
          <Advice text={c.advice} />
        </li>
      ))}
      {report.traffic.map((hint) => (
        <li key={hint.agent} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Severity value={hint.severity} />
            <span className="font-medium">{hint.agent}</span>
            <span className="text-xs text-dim">{t('reachability.aiTraffic', { kind: hint.kind })}</span>
          </div>
          <p>{hint.detail}</p>
          <Advice text={hint.advice} />
        </li>
      ))}
    </ul>
  );
}

export function ReachabilityPage() {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const qc = useQueryClient();
  const platformId = useId();
  const view = useQuery({ queryKey: ['site-reachability'], queryFn: async () => (await client.site.reachability()).data });
  const data = view.data;
  const [platform, setPlatform] = useState<ReachabilityPlatform>('vps');
  const [hosts, setHosts] = useState<string[] | null>(null);
  useEffect(() => {
    if (data) setPlatform(data.run.platform);
  }, [data]);
  const chosen = hosts ?? data?.hosts.map((h) => h.hostname) ?? [];
  const run = useMutation({
    mutationFn: async () => (await client.site.runReachability({ platform, hosts: chosen })).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['site-reachability'] }),
  });
  const refusal = run.error instanceof HeoPressError ? (run.error.status === 403 ? t('reachability.adminOnly') : run.error.message) : run.error ? t('reachability.requestFailed') : null;
  const report = data?.report ?? null;
  const toggle = (host: string) => setHosts(chosen.includes(host) ? chosen.filter((h) => h !== host) : [...chosen, host]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Globe className="h-5 w-5" aria-hidden="true" />
            {t('reachability.title')}
          </span>
        }
        description={t('reachability.description')}
      />

      <section aria-label={t('reachability.checkRun')} className="space-y-3 text-sm">
        {data && data.hosts.length === 0 ? <p>{t('reachability.noHosts')}</p> : null}
        {data?.hosts.length ? (
          <fieldset className="space-y-1">
            <legend className="font-medium">{t('reachability.domains')}</legend>
            {data.hosts.map((h) => (
              <label key={h.hostname} className="flex items-center gap-2">
                <input type="checkbox" checked={chosen.includes(h.hostname)} onChange={() => toggle(h.hostname)} />
                {h.hostname}
                {h.primary ? <span className="text-xs text-dim">{t('reachability.primary')}</span> : h.locale ? <span className="text-xs text-dim">{h.locale}</span> : null}
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={platformId}>{t('reachability.deployedOn')}</label>
          <select id={platformId} className="rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand" value={platform} onChange={(e) => setPlatform(e.target.value as ReachabilityPlatform)}>
            {(data?.platforms ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-ctl border border-line px-2 hover:bg-panel-2"
            onClick={() => run.mutate()}
            disabled={run.isPending || !!data?.run.requested || chosen.length === 0}
          >
            <Play className="h-4 w-4" aria-hidden="true" /> {t('reachability.run')}
          </button>
          <span>
            {data?.run.lastRunAt ? t('reachability.lastRun', { date: new Date(data.run.lastRunAt).toLocaleString() }) : t('reachability.notRun')}
            {data?.run.requested ? t('reachability.queuedSuffix') : ''}
          </span>
        </div>
        {refusal ? (
          <p role="alert" className="text-bad">
            {refusal}
          </p>
        ) : null}
        {run.isSuccess ? <p role="status">{t('reachability.queued')}</p> : null}
        {data?.run.status === 'failed' && data.run.error ? <p role="alert" className="text-bad">{t('reachability.lastFailed', { error: data.run.error })}</p> : null}
      </section>

      {view.isLoading ? <p className="text-sm text-dim">{t('common:loading')}</p> : null}
      {view.isError ? (
        <p role="alert" className="text-sm text-bad">
          {t('reachability.loadFailed')}
        </p>
      ) : null}

      {report ? (
        <>
          <section aria-label={t('reachability.summary')} className="text-sm">
            <p>
              {t('reachability.counts', { errors: report.summary.errors, warnings: report.summary.warnings, passed: report.summary.passed })}
              {report.summary.skipped ? t('reachability.notRequested', { count: report.summary.skipped }) : ''}
              {t('reachability.adviceFor', { platform: data?.platforms.find((p) => p.id === report.platform)?.label ?? report.platform })}
            </p>
            {report.truncated ? <p role="note">{t('reachability.truncated')}</p> : null}
            {report.hosts
              .filter((h) => h.skipped || h.reachable === false)
              .map((h) => (
                <p key={h.hostname} role="note" className="text-warn">
                  {h.hostname}{t('content.colon')}{h.skipped ?? t('reachability.noAnswer')}
                </p>
              ))}
          </section>

          <section aria-label={t('reachability.problemsFound')} className="space-y-2">
            <h2 className="t-section">{t('reachability.problems')}</h2>
            <Problems report={report} />
          </section>

          <section aria-label={t('reachability.simulatedCrawlers')} className="space-y-2 text-sm">
            <h2 className="t-section">{t('reachability.crawlersHeading')}</h2>
            <p role="note" className="rounded border border-warn/40 bg-warn-soft p-2">
              {t('reachability.simulatedNote')}
            </p>
            <table className="w-full text-left">
              <thead>
                <tr>
                  <th className="py-1">{t('reachability.col.crawler')}</th>
                  <th>{t('reachability.col.operator')}</th>
                  <th>{t('reachability.col.robots')}</th>
                  <th>{t('reachability.col.answer')}</th>
                  <th>{t('reachability.col.result')}</th>
                </tr>
              </thead>
              <tbody>
                {report.crawlers.map((c) => (
                  <tr key={`${c.host} ${c.crawler}`} className="border-t border-line">
                    <td className="py-1">{c.userAgent}</td>
                    <td>{c.operator}</td>
                    <td>{c.allowedByRobots ? t('reachability.allowed') : t('reachability.keptOut')}</td>
                    <td>{c.status ?? '—'}</td>
                    <td>{c.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <details className="text-sm">
            <summary className="cursor-pointer">{t('reachability.allChecksCount', { count: report.checks.length })}</summary>
            <ul aria-label={t('reachability.allChecks')} className="mt-2 space-y-1">
              {report.checks.map((c) => (
                <li key={`${c.kind} ${c.url}`}>
                  {c.ok ? t('reachability.ok') : t('reachability.problem')} · <code className="text-xs">{c.url}</code> · {c.expected === 'public' ? t('reachability.expectedPublic') : t('reachability.expectedNotPublic')} · {c.detail}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : data && !data.run.requested ? (
        <p className="text-sm">{t('reachability.noRun')}</p>
      ) : null}
    </div>
  );
}
