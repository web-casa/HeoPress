// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useTranslation } from 'react-i18next';
import { Star } from 'lucide-react';
import { cn } from '@/lib/cn';
import { readDisplayOptions, type DisplayComponent } from './types';

interface RatingDisplayOptions {
  max?: number;
}

/** `rating-stars` — read-only star scale, default 1..5. */
export const RatingStarsDisplay: DisplayComponent<number> = ({ value, field }) => {
  const { t } = useTranslation('items');
  const opts = readDisplayOptions<RatingDisplayOptions>(field);
  const max = opts.max ?? 5;
  const current = typeof value === 'number' ? value : 0;
  if (current === 0) return <span className="text-dim">—</span>;
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={t('displays.ratingOutOf', { current, max })}>
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          className={cn('h-3 w-3', i < current ? 'fill-warn text-warn' : 'text-icon')}
        />
      ))}
    </span>
  );
};
