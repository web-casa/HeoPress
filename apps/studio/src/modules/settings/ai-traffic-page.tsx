import { useQuery } from '@tanstack/react-query';
import type { SiteAiTrafficResource } from '@heopress/sdk';
import { Bot } from 'lucide-react';
import { useId, useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * AI traffic — how AI systems read and cite the site (HeoPress P07 task 6.2; spec analytics/ai-traffic).
 *
 * Reads by known AI crawlers per day and purpose (training, AI search, fetched for a user), visits AI assistants sent,
 * the pages AI crawlers read most and the pages assistants send visitors to. Day totals only: the details behind them
 * are kept 7 days, and no visitor's address, User-Agent or referrer is ever stored.
 */

type Day = SiteAiTrafficResource['byDay'][number];

const SERIES: Array<{ key: keyof Omit<Day, 'day'>; label: string; color: string }> = [
  { key: 'training', label: 'Training', color: '#64748b' },
  { key: 'search', label: 'AI search', color: '#2563eb' },
  { key: 'userFetch', label: 'Fetched for a user', color: '#16a34a' },
  { key: 'referral', label: 'AI-referred visits', color: '#d97706' },
];

const PURPOSE: Record<string, string> = { training: 'Training', search: 'AI search', 'user-fetch': 'Fetched for a user', 'search-engine': 'Search engine' };

/** Stacked bars per day: the AI purposes and the referred visits (ordinary search engines are counted in the table). */
function DayChart({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.map((d) => SERIES.reduce((s, x) => s + d[x.key], 0)));
  return (
    <figure className="space-y-2">
      <div role="img" aria-label="AI reads and referred visits per day" className="flex h-40 items-end gap-1 rounded-md border border-border p-2">
        {days.map((d) => (
          <div key={d.day} className="flex h-full flex-1 flex-col-reverse" title={`${d.day}: ${SERIES.map((s) => `${s.label} ${d[s.key]}`).join(', ')}`}>
            {SERIES.map((s) => (d[s.key] > 0 ? <div key={s.key} style={{ height: `${(d[s.key] / max) * 100}%`, background: s.color }} /> : null))}
          </div>
        ))}
      </div>
      <figcaption className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1">
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function AiTrafficPage() {
  const client = getApiClient();
  const [days, setDays] = useState(30);
  const rangeId = useId();
  const traffic = useQuery({ queryKey: ['site-ai-traffic', days], queryFn: async () => (await client.site.aiTraffic(days)).data });
  const data = traffic.data;

  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <Bot className="h-5 w-5" aria-hidden="true" />
          AI traffic
        </h1>
        <p className="text-sm text-muted-foreground">
          How AI crawlers read your site and how many visitors AI assistants send. Figures, not rankings: being read is not being cited. Details are kept 7 days; no
          visitor&apos;s address is stored.
        </p>
      </header>

      <div className="flex items-center gap-2 text-sm">
        <label htmlFor={rangeId}>Period</label>
        <select id={rangeId} className="h-9 rounded-md border border-border bg-background px-2" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>

      {traffic.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {traffic.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The AI traffic could not be loaded.
        </p>
      ) : null}

      {data ? (
        <>
          <section aria-label="Totals" className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border border-border p-3">
              <div className="text-muted-foreground">Crawler reads</div>
              <div className="text-2xl font-semibold">{data.totals.crawler}</div>
            </div>
            <div className="rounded-md border border-border p-3">
              <div className="text-muted-foreground">AI-referred visits</div>
              <div className="text-2xl font-semibold">{data.totals.referral}</div>
            </div>
          </section>
          {data.byDay.length ? <DayChart days={data.byDay} /> : <p className="text-sm">Nothing recorded in this period.</p>}

          <section aria-labelledby="agents-heading" className="space-y-2">
            <h2 id="agents-heading" className="font-medium">
              By crawler and assistant
            </h2>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1">Who</th>
                  <th>Operator</th>
                  <th>Purpose</th>
                  <th className="text-right">Count</th>
                </tr>
              </thead>
              <tbody>
                {data.byAgent.map((a) => (
                  <tr key={`${a.kind}:${a.agent}`} className="border-t border-border">
                    <td className="py-1 font-mono">{a.agent}</td>
                    <td>{a.operator}</td>
                    <td>{a.kind === 'referral' ? 'Referred visits' : (PURPOSE[a.purpose ?? ''] ?? a.purpose)}</td>
                    <td className="text-right">{a.hits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section aria-labelledby="crawled-heading" className="space-y-2">
            <h2 id="crawled-heading" className="font-medium">
              Most read by AI crawlers
            </h2>
            {data.topCrawled.length ? (
              <ol className="space-y-1 text-sm">
                {data.topCrawled.map((t) => (
                  <li key={t.path} className="flex justify-between gap-2">
                    <span className="font-mono">{t.path}</span>
                    <span className="text-muted-foreground">
                      {t.resource} · {t.hits}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm">None yet.</p>
            )}
          </section>

          <section aria-labelledby="landing-heading" className="space-y-2">
            <h2 id="landing-heading" className="font-medium">
              Where AI assistants send visitors
            </h2>
            {data.topLanding.length ? (
              <ol className="space-y-1 text-sm">
                {data.topLanding.map((t) => (
                  <li key={t.path} className="flex justify-between gap-2">
                    <span className="font-mono">{t.path}</span>
                    <span className="text-muted-foreground">
                      {t.sources.join(', ')} · {t.hits}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm">None yet.</p>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
