// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { AlertTriangle, Clock } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { RevisionsDiff } from '@/modules/content/revisions-diff';
import type { StagedVeto } from './api';
import { useAdminBase } from './layout';

/**
 * Field-level diff for a staged change in its veto window (content-os-ui
 * task 4.1; Req 3.2-3.4). `before` is the item's CURRENT data — the veto
 * question is "is this change OK applied to what is live now", and diffing
 * against the present also surfaces conflicts when the item moved after
 * staging. `after` is a shallow merge, matching the revision engine's
 * top-level-field unit of change.
 */

function Countdown({ deadline }: { deadline: string }) {
  const { t } = useTranslation('agents');
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining <= 0) return <span className="text-destructive">{t('inbox.committing')}</span>;
  const minutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(minutes / 60);
  return (
    <span className={cn('font-mono', remaining < 30 * 60_000 ? 'text-destructive' : 'text-amber-600')}>
      {t('inbox.left', { time: hours > 0 ? t('inbox.hoursMinutes', { h: hours, m: minutes % 60 }) : t('inbox.minutes', { m: minutes }) })}
    </span>
  );
}

export function StagedDiff({ veto }: { veto: StagedVeto }) {
  const { t } = useTranslation('agents');
  const adminBase = useAdminBase();
  const collection = String(veto.collection ?? '');
  const itemId = String(veto.itemId ?? '');
  const patch = (veto.patch ?? {}) as Record<string, unknown>;

  const itemQuery = useQuery({
    queryKey: ['item', collection, itemId],
    queryFn: async () =>
      (await getApiClient().items(collection as never).detail(itemId)).data,
    enabled: Boolean(collection && itemId),
    retry: false,
  });

  if (itemQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">{t('staged.loading')}</p>;
  }

  const current = itemQuery.data?.data as Record<string, unknown> | undefined;
  // Fallback (Req 3.3): without the current item every patched field shows
  // as "added" — the veto buttons must keep working regardless.
  const before = current ?? null;
  const after = current ? { ...current, ...patch } : patch;

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 text-sm font-medium">
          <Clock className="h-4 w-4 text-amber-600" />
          <code className="rounded bg-muted px-1 text-xs">
            {collection || '?'}/{itemId || '?'}
          </code>
          {t('staged.by', { role: veto.agentRole != null ? String(veto.agentRole) : t('inbox.agentFallback') })}{' '}
          <Countdown deadline={veto.autoCommitAt} />
        </span>
        {collection && itemId && (
          <Link
            to={`${adminBase}/content/${collection}/${itemId}` as never}
            className="text-xs text-primary hover:underline"
          >
            {t('detail.openItem')}
          </Link>
        )}
      </header>

      {itemQuery.isError && (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {t('staged.loadFailed')}
        </p>
      )}

      <div className="max-h-[55vh] overflow-y-auto pr-1">
        <RevisionsDiff before={before} after={after} />
      </div>
    </div>
  );
}
