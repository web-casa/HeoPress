/** Shares of a whole as one bar with a legend (ADR-0019 §19): text carries every number. */
export function ShareBar({ parts, label }: { parts: Array<{ key: string; label: string; value: number; color: string }>; label: string }) {
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total === 0) return null;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-panel-2" role="img" aria-label={`${label}: ${parts.map((p) => `${p.label} ${Math.round((p.value / total) * 100)}%`).join(', ')}`}>
        {parts.map((p) => (
          <span key={p.key} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-col gap-1 text-[12.5px]">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} aria-hidden="true" />
            <span className="flex-1 truncate">{p.label}</span>
            <span className="t-num text-dim">{Math.round((p.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
