import { useState, type KeyboardEvent } from 'react';
import { niceScale } from './scale';

export interface BarSeries {
  key: string;
  label: string;
  /** A colour token or value; shades of the accent only (ADR-0019 §3). */
  color: string;
}

export interface BarDatum {
  label: string;
  /** Short label under the bar (every few bars). */
  tick?: string;
  values: Record<string, number>;
}

/**
 * Stacked bars per day (ADR-0019 §19): whole-number ticks; one tab stop — the arrow keys move day by day and each day
 * is read out (day, each series); hover shows the same; an equivalent table for screen readers.
 */
export function StackedBars({
  data,
  series,
  height = 180,
  caption,
  formatNumber = (n) => n.toLocaleString(),
}: {
  data: BarDatum[];
  series: BarSeries[];
  height?: number;
  caption: string;
  formatNumber?: (n: number) => string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const totals = data.map((d) => series.reduce((s, x) => s + (d.values[x.key] ?? 0), 0));
  const { top, ticks } = niceScale(Math.max(0, ...totals));
  const describe = (i: number) => `${data[i]!.label}: ${series.map((s) => `${s.label} ${formatNumber(data[i]!.values[s.key] ?? 0)}`).join(', ')}`;
  const onKey = (e: KeyboardEvent) => {
    if (!data.length) return;
    const current = active ?? data.length - 1;
    const next = e.key === 'ArrowLeft' ? current - 1 : e.key === 'ArrowRight' ? current + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? data.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    setActive(Math.max(0, Math.min(data.length - 1, next)));
  };
  return (
    <figure className="m-0">
      <div className="relative flex gap-2" style={{ height }}>
        <div aria-hidden="true" className="flex w-9 flex-col-reverse justify-between text-right text-[11px] text-dim t-num">
          {ticks.map((t) => (
            <span key={t}>{formatNumber(t)}</span>
          ))}
        </div>
        <div
          className="relative flex flex-1 items-end gap-[3px] border-b border-line"
          role="group"
          tabIndex={0}
          aria-label={caption}
          aria-describedby={active !== null ? 'stacked-bars-active' : undefined}
          onKeyDown={onKey}
          onFocus={() => {
            setFocused(true);
            setActive((a) => a ?? (data.length ? data.length - 1 : null));
          }}
          onBlur={() => {
            setFocused(false);
            setActive(null);
          }}
        >
          {ticks.slice(1).map((t) => (
            <span key={t} aria-hidden="true" className="pointer-events-none absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `${(t / top) * 100}%` }} />
          ))}
          {data.map((d, i) => (
            <span
              key={d.label}
              aria-hidden="true"
              onMouseEnter={() => setActive(i)}
              onMouseLeave={() => !focused && setActive(null)}
              className={`relative flex h-full min-w-0 flex-1 flex-col-reverse ${active === i ? 'opacity-100' : active !== null ? 'opacity-60' : ''}`}
            >
              {series.map((s) => {
                const v = d.values[s.key] ?? 0;
                return v > 0 ? <span key={s.key} style={{ height: `${(v / top) * 100}%`, background: s.color }} className="block w-full last:rounded-t-[3px]" /> : null;
              })}
              {active === i ? (
                <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 w-max -translate-x-1/2 rounded-ctl border border-line bg-panel px-2 py-1 text-left text-[11.5px] shadow-lg">
                  <span className="block font-medium">{d.label}</span>
                  {series.map((s) => (
                    <span key={s.key} className="flex items-center gap-1.5 t-num">
                      <span className="inline-block h-2 w-2 rounded-sm" style={{ background: s.color }} />
                      {s.label} {formatNumber(d.values[s.key] ?? 0)}
                    </span>
                  ))}
                </span>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <p id="stacked-bars-active" aria-live="polite" className="sr-only">
        {active !== null && focused ? describe(active) : ''}
      </p>
      <div aria-hidden="true" className="ml-11 mt-1 flex gap-[3px] text-[10.5px] text-dim">
        {data.map((d) => (
          <span key={d.label} className="min-w-0 flex-1 truncate text-center">
            {d.tick ?? ''}
          </span>
        ))}
      </div>
      <figcaption className="mt-2 flex flex-wrap gap-3 text-[12px] text-dim">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
            {s.label}
          </span>
        ))}
      </figcaption>
      <table className="sr-only">
        <caption>{caption}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              {series.map((s) => (
                <td key={s.key}>{`${s.label} ${formatNumber(d.values[s.key] ?? 0)}`}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
