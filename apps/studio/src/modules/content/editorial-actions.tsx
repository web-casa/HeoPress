// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, EyeOff, Globe, Send, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ItemRow } from '@heopress/sdk';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

export type EditorialAction = 'submit_review' | 'approve' | 'reject' | 'publish' | 'unpublish';

/**
 * Display state of an item. A PATCH to `published` leaves `editorialState` at
 * `approved`, so `status` wins whenever the item is live.
 */
export function editorialStateOf(item: Pick<ItemRow, 'status' | 'editorialState'>): string {
  if (item.status === 'published') return 'published';
  const state = item.editorialState ?? 'draft';
  return state === 'published' ? 'draft' : state;
}

/** Transitions offered from `state`; mirrors TRANSITIONS in the CMS editorial service. */
export function availableEditorialActions(state: string, workflowEnabled: boolean): EditorialAction[] {
  switch (state) {
    case 'draft':
    case 'rejected':
      return workflowEnabled ? ['submit_review'] : ['submit_review', 'publish'];
    case 'in_review':
      return ['approve', 'reject'];
    case 'approved':
    case 'scheduled':
      return ['publish'];
    case 'published':
      return ['unpublish'];
    default:
      return [];
  }
}

const ACTIONS: Record<EditorialAction, { label: string; icon: LucideIcon; tone: 'primary' | 'neutral' | 'danger' }> = {
  submit_review: { label: 'editorial.submit_review', icon: Send, tone: 'neutral' },
  approve: { label: 'editorial.approve', icon: CheckCircle2, tone: 'primary' },
  reject: { label: 'editorial.reject', icon: XCircle, tone: 'danger' },
  publish: { label: 'editorial.publish', icon: Globe, tone: 'primary' },
  unpublish: { label: 'editorial.unpublish', icon: EyeOff, tone: 'neutral' },
};

const EDITORIAL_PATH: Partial<Record<EditorialAction, string>> = {
  submit_review: 'submit-review',
  approve: 'approve',
  reject: 'reject',
};

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? i18n.t('items:editorial.failed');
}

export function EditorialActions({
  collection,
  item,
  canUpdate,
  isDirty,
  beforeUnpublish,
}: {
  collection: string;
  item: ItemRow;
  canUpdate: boolean;
  isDirty: boolean;
  /** Asked before unpublishing (HeoPress P07 task 5.5: the pages that may be affected); calls `go` to go on. */
  beforeUnpublish?: (go: () => void) => void;
}) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const { t } = useTranslation('items');

  const collectionQuery = useQuery({
    queryKey: ['collection', collection],
    queryFn: async () => (await client.schema.getCollection(collection)).data,
  });
  const workflowEnabled = collectionQuery.data?.meta?.editorialWorkflow === true;

  const mutation = useMutation({
    mutationFn: async (action: EditorialAction) => {
      const path = EDITORIAL_PATH[action];
      if (path) {
        await client.rawRequest(`/api/v1/editorial/${collection}/${item.id}/${path}`, {
          method: 'POST',
          // The decision is about the version on screen (P04).
          body: JSON.stringify({ expectedVersion: item.version }),
        });
        return;
      }
      await client.items(collection as never).patch(item.id, {
        status: action === 'publish' ? 'published' : 'draft',
        expectedVersion: item.version,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['item', collection, item.id] });
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
      void queryClient.invalidateQueries({ queryKey: ['editorial-reviews'] });
      void queryClient.invalidateQueries({ queryKey: ['revisions', collection, item.id] });
    },
  });

  // Hold (P04): a held item is published by no path. Releasing it is refused
  // by the server unless you are a person with publish permission.
  const holdMutation = useMutation({
    mutationFn: async (hold: boolean) => {
      await client.rawRequest(`/api/v1/items/${collection}/${item.id}/hold`, {
        method: hold ? 'POST' : 'DELETE',
        body: JSON.stringify({ expectedVersion: item.version }),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['item', collection, item.id] });
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
    },
  });

  const state = editorialStateOf(item);
  const actions = collectionQuery.isLoading ? [] : availableEditorialActions(state, workflowEnabled);
  const blockedReason = !canUpdate
    ? t('detail.noUpdate')
    : isDirty
      ? t('editorial.saveFirst')
      : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="editorial-actions">
      <span
        className="rounded-full border border-line px-2 py-0.5 font-mono text-[11px] uppercase text-dim"
        title={t('editorial.state')}
      >
        {t(`content:state.${state}`, { defaultValue: state.replace('_', ' ') })}
      </span>
      {actions.map((action) => {
        const { label, icon: Icon, tone } = ACTIONS[action];
        return (
          <button
            key={action}
            type="button"
            onClick={() => (action === 'unpublish' && beforeUnpublish ? beforeUnpublish(() => mutation.mutate(action)) : mutation.mutate(action))}
            disabled={mutation.isPending || blockedReason !== undefined}
            title={blockedReason}
            className={cn(
              'inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50',
              tone === 'primary' && 'border-brand text-brand hover:bg-brand-soft',
              tone === 'danger' && 'border-bad/40 text-bad hover:bg-bad-soft',
              tone === 'neutral' && 'border-line text-fg hover:bg-panel-2',
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {t(label)}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => holdMutation.mutate(!item.hold)}
        disabled={holdMutation.isPending || blockedReason !== undefined}
        title={
          blockedReason ??
          (item.hold ? t('editorial.releaseHint') : t('editorial.holdHint'))
        }
        data-testid="hold-toggle"
        className={cn(
          'inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs disabled:cursor-not-allowed disabled:opacity-50',
          item.hold ? 'border-warn/40 text-warn hover:bg-warn-soft' : 'border-line text-fg hover:bg-panel-2',
        )}
      >
        {item.hold ? t('editorial.release') : t('editorial.hold')}
      </button>
      {mutation.error && (
        <span role="alert" className="text-xs text-bad">
          {errorMessage(mutation.error)}
        </span>
      )}
      {holdMutation.error && (
        <span role="alert" className="text-xs text-bad">
          {errorMessage(holdMutation.error)}
        </span>
      )}
    </div>
  );
}
