import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * The review queue (HeoPress v1.1; spec content/stale-content-queue): everything on the site that needs a human, in
 * three groups — items an editor marked, items the staleness sweep marked because nobody touched them for a long
 * time, and items waiting for editorial review. Each row opens the item; the counts are the server's counts of the
 * page it returned (`truncated` says whether more matched).
 */

type ReviewQueueGroup = 'manual' | 'auto' | 'awaiting_review';

interface ReviewQueueRow {
  itemId: string;
  collection: string;
  title: string;
  reason: string | null;
  dueAt: string | null;
  updatedAt: string;
  group: ReviewQueueGroup;
}

interface ReviewQueue {
  counts: Record<ReviewQueueGroup, number>;
  items: ReviewQueueRow[];
  truncated: boolean;
  limit: number;
}

const GROUPS: ReviewQueueGroup[] = ['manual', 'auto', 'awaiting_review'];

const day = (iso: string | null) => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};

export function ReviewQueuePage() {
  const { t } = useTranslation('reviewQueue');
  const queue = useQuery({
    queryKey: ['review-queue'],
    queryFn: async () => {
      const res = await getApiClient().request<ReviewQueue>('/api/v1/review-queue');
      return res.data;
    },
  });

  const items = queue.data?.items ?? [];
  const counts = queue.data?.counts;

  return (
    <div className="space-y-6">
      <PageHeader title={t('reviewQueue.title')} description={t('reviewQueue.description')} />

      {queue.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('reviewQueue.failed')}
        </p>
      ) : null}
      {queue.data?.truncated ? <p className="text-sm text-muted-foreground">{t('reviewQueue.truncated')}</p> : null}

      <div className="grid gap-4 md:grid-cols-3">
        {GROUPS.map((group) => {
          const rows = items.filter((item) => item.group === group);
          return (
            <section key={group} aria-label={t(`reviewQueue.groups.${group}`)} className="rounded-lg border border-border">
              <header className="flex items-center justify-between border-b border-border px-3 py-2">
                <h2 className="text-sm font-medium">{t(`reviewQueue.groups.${group}`)}</h2>
                <span data-testid={`review-count-${group}`} className="text-sm text-muted-foreground">
                  {counts?.[group] ?? 0}
                </span>
              </header>
              <ul className="divide-y divide-border">
                {rows.length === 0 ? (
                  <li className="px-3 py-4 text-sm text-muted-foreground">{t('reviewQueue.empty')}</li>
                ) : (
                  rows.map((row) => (
                    <li key={`${row.collection}:${row.itemId}`} className="space-y-1 px-3 py-2">
                      <Link
                        to="/content/$collection/$id"
                        params={{ collection: row.collection, id: row.itemId }}
                        className="truncate text-sm text-brand hover:underline"
                      >
                        {row.title || row.itemId}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {row.collection}
                        {row.reason ? ` · ${row.reason}` : ''}
                        {day(row.dueAt) ? ` · ${t('reviewQueue.due', { date: day(row.dueAt) })}` : ''}
                        {` · ${t('reviewQueue.updated', { date: day(row.updatedAt) })}`}
                      </p>
                    </li>
                  ))
                )}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
