import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeoPressError, type ReachabilityPlatform, type SiteReachabilityResource } from '@heopress/sdk';
import { Globe, Play } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
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
  error: 'bg-destructive/10 text-destructive',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  notice: 'bg-muted text-muted-foreground',
};

function Severity({ value }: { value: string | null }) {
  if (!value) return null;
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_CLASS[value] ?? ''}`}>{value}</span>;
}

function Advice({ text }: { text: string | null }) {
  if (!text) return null;
  return <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-xs">{text}</pre>;
}

/** The problems first: every check, simulated crawler request and traffic hint that is not as expected. */
function Problems({ report }: { report: Report }) {
  const checks = report.checks.filter((c) => !c.ok);
  const crawlers = report.crawlers.filter((c) => !c.ok);
  if (!checks.length && !crawlers.length && !report.traffic.length) return <p className="text-sm">No problems found.</p>;
  return (
    <ul aria-label="Problems" className="divide-y divide-border rounded-md border border-border">
      {checks.map((c) => (
        <li key={`${c.kind} ${c.url}`} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Severity value={c.severity} />
            <code className="text-xs">{c.url}</code>
            <code className="text-xs text-muted-foreground">{c.code}</code>
          </div>
          <p>{c.detail}</p>
          <p className="text-muted-foreground">Expected: {c.because}.</p>
          <Advice text={c.advice} />
        </li>
      ))}
      {crawlers.map((c) => (
        <li key={`${c.host} ${c.crawler}`} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Severity value={c.severity} />
            <span className="font-medium">{c.userAgent}</span>
            <span className="rounded border border-border px-1 text-xs">Simulated</span>
            <code className="text-xs text-muted-foreground">{c.code}</code>
          </div>
          <p>{c.detail}</p>
          <Advice text={c.advice} />
        </li>
      ))}
      {report.traffic.map((t) => (
        <li key={t.agent} className="space-y-1 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Severity value={t.severity} />
            <span className="font-medium">{t.agent}</span>
            <span className="text-xs text-muted-foreground">AI traffic {t.kind}</span>
          </div>
          <p>{t.detail}</p>
          <Advice text={t.advice} />
        </li>
      ))}
    </ul>
  );
}

export function ReachabilityPage() {
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
  const refusal = run.error instanceof HeoPressError ? (run.error.status === 403 ? 'Only administrators can run the check.' : run.error.message) : run.error ? 'The check could not be requested.' : null;
  const report = data?.report ?? null;
  const toggle = (host: string) => setHosts(chosen.includes(host) ? chosen.filter((h) => h !== host) : [...chosen, host]);

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Globe className="h-5 w-5" aria-hidden="true" />
          Reachability check
        </h1>
        <p className="text-sm text-muted-foreground">
          Requests the site&apos;s discovery files and pages on its live domains and compares the answers with what your settings expect: what should be public must
          answer with the right type, what is turned off or not indexable must not be served. Only the site&apos;s verified domains can be checked.
        </p>
      </header>

      <section aria-label="Check run" className="space-y-3 text-sm">
        {data && data.hosts.length === 0 ? <p>The site has no verified domain to check. Verify one under Domains first.</p> : null}
        {data?.hosts.length ? (
          <fieldset className="space-y-1">
            <legend className="font-medium">Domains</legend>
            {data.hosts.map((h) => (
              <label key={h.hostname} className="flex items-center gap-2">
                <input type="checkbox" checked={chosen.includes(h.hostname)} onChange={() => toggle(h.hostname)} />
                {h.hostname}
                {h.primary ? <span className="text-xs text-muted-foreground">primary</span> : h.locale ? <span className="text-xs text-muted-foreground">{h.locale}</span> : null}
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor={platformId}>Deployed on</label>
          <select id={platformId} className="h-9 rounded-md border border-border bg-background px-2" value={platform} onChange={(e) => setPlatform(e.target.value as ReachabilityPlatform)}>
            {(data?.platforms ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2"
            onClick={() => run.mutate()}
            disabled={run.isPending || !!data?.run.requested || chosen.length === 0}
          >
            <Play className="h-4 w-4" aria-hidden="true" /> Run check
          </button>
          <span>
            {data?.run.lastRunAt ? <>Last run {new Date(data.run.lastRunAt).toLocaleString()}</> : 'Not run yet'}
            {data?.run.requested ? ' · a check is queued' : ''}
          </span>
        </div>
        {refusal ? (
          <p role="alert" className="text-destructive">
            {refusal}
          </p>
        ) : null}
        {run.isSuccess ? <p role="status">Queued. The check runs within a minute.</p> : null}
        {data?.run.status === 'failed' && data.run.error ? <p role="alert" className="text-destructive">The last check failed: {data.run.error}</p> : null}
      </section>

      {view.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {view.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The report could not be loaded.
        </p>
      ) : null}

      {report ? (
        <>
          <section aria-label="Summary" className="text-sm">
            <p>
              {report.summary.errors} error(s), {report.summary.warnings} warning(s), {report.summary.passed} passed
              {report.summary.skipped ? `, ${report.summary.skipped} not requested` : ''} · advice for {data?.platforms.find((p) => p.id === report.platform)?.label ?? report.platform}
            </p>
            {report.truncated ? <p role="note">The check ran out of time: some requests were not made.</p> : null}
            {report.hosts
              .filter((h) => h.skipped || h.reachable === false)
              .map((h) => (
                <p key={h.hostname} role="note" className="text-amber-700 dark:text-amber-400">
                  {h.hostname}: {h.skipped ?? 'did not answer.'}
                </p>
              ))}
          </section>

          <section aria-label="Problems found" className="space-y-2">
            <h2 className="text-base font-semibold">Problems</h2>
            <Problems report={report} />
          </section>

          <section aria-label="Simulated AI crawlers" className="space-y-2 text-sm">
            <h2 className="text-base font-semibold">AI crawlers (simulated)</h2>
            <p role="note" className="rounded border border-amber-500/40 bg-amber-500/5 p-2">
              Simulated results: these requests carry the crawlers&apos; User-Agent but come from this server, so they may differ from what the real crawlers get.
            </p>
            <table className="w-full text-left">
              <thead>
                <tr>
                  <th className="py-1">Crawler</th>
                  <th>Operator</th>
                  <th>robots.txt</th>
                  <th>Answer</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {report.crawlers.map((c) => (
                  <tr key={`${c.host} ${c.crawler}`} className="border-t border-border">
                    <td className="py-1">{c.userAgent}</td>
                    <td>{c.operator}</td>
                    <td>{c.allowedByRobots ? 'allowed' : 'kept out'}</td>
                    <td>{c.status ?? '—'}</td>
                    <td>{c.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <details className="text-sm">
            <summary className="cursor-pointer">All checks ({report.checks.length})</summary>
            <ul aria-label="All checks" className="mt-2 space-y-1">
              {report.checks.map((c) => (
                <li key={`${c.kind} ${c.url}`}>
                  {c.ok ? 'OK' : 'Problem'} · <code className="text-xs">{c.url}</code> · expected {c.expected === 'public' ? 'public' : 'not public'} · {c.detail}
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : data && !data.run.requested ? (
        <p className="text-sm">No check has run yet.</p>
      ) : null}
    </div>
  );
}
