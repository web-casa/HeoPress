// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { cn } from '@/lib/cn';
import { readDisplayOptions, type DisplayComponent } from './types';

interface BadgeDisplayOptions {
  /** Map value -> tailwind tone token. Falls back to `muted`. */
  tones?: Record<string, 'muted' | 'emerald' | 'amber' | 'sky' | 'destructive' | 'violet'>;
}

const TONE_CLASS: Record<string, string> = {
  muted: 'bg-panel-2 text-dim',
  emerald: 'bg-ok-soft text-ok',
  amber: 'bg-warn-soft text-warn',
  sky: 'bg-brand-soft text-brand',
  destructive: 'bg-bad-soft text-bad',
  violet: 'bg-panel-2 text-ai',
};

/** `badge` — colored pill keyed by `meta.display.options.tones`. */
export const BadgeDisplay: DisplayComponent<string> = ({ value, field }) => {
  if (value === null || value === undefined || value === '')
    return <span className="text-dim">—</span>;
  const opts = readDisplayOptions<BadgeDisplayOptions>(field);
  const tone = opts.tones?.[String(value)] ?? 'muted';
  return (
    <span
      className={cn(
        'rounded px-1.5 py-0.5 text-[10px] uppercase',
        TONE_CLASS[tone] ?? TONE_CLASS.muted,
      )}
    >
      {String(value)}
    </span>
  );
};
