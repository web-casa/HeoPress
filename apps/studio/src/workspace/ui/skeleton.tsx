import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

/** Placeholder block shaped like the content it stands for (ADR-0019 §5.5). */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('block animate-pulse rounded-ctl bg-panel-2', className)} />;
}

/** Rows of skeleton lines for a list or table; announces loading once. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  const { t } = useTranslation('common');
  return (
    <div role="status" aria-label={t('loading')} className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-[var(--row-h)] w-full" />
      ))}
    </div>
  );
}
