// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Braces, GitCompare, History, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { HeoPressError, type RevisionRow } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ProvenanceBadge, ProvenancePanel } from './provenance-badge';
import { RevisionsDiff } from './revisions-diff';

interface RevisionsPanelProps {
  collection: string;
  itemId: string;
  /** The item version the user is looking at; the revert is based on it. */
  itemVersion: number;
  /**
   * Called after a successful revert, once the item query holds the reverted
   * content, so the parent can re-hydrate the form from it.
   */
  onRevert?: () => void;
}

/**
 * Lists revisions for an item, lets the user revert, and surfaces a per-field
 * before/after diff. The view can flip to raw JSON for inspection when the
 * structured diff isn't enough.
 */
export function RevisionsPanel({ collection, itemId, itemVersion, onRevert }: RevisionsPanelProps) {
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<'diff' | 'raw'>('diff');
  const [showUnchanged, setShowUnchanged] = useState(false);

  const query = useQuery({
    queryKey: ['revisions', collection, itemId],
    queryFn: async () => (await client.items(collection as never).listRevisions(itemId)).data as RevisionRow[],
  });

  // A reason, when the revert changes a published item's sponsor marking (HeoPress P05: the CMS asks for one).
  const [reason, setReason] = useState('');
  const revertMutation = useMutation({
    mutationFn: async ({ revisionId, reason }: { revisionId: string; reason?: string }) =>
      (await client.items(collection as never).revertRevision(itemId, revisionId, itemVersion, reason)).data,
    onSuccess: async () => {
      // Wait for the refetch: the editor re-seeds its draft from the cached item
      // as soon as onRevert clears it, and must not see the pre-revert content.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['item', collection, itemId] }),
        queryClient.invalidateQueries({ queryKey: ['revisions', collection, itemId] }),
      ]);
      setReason('');
      onRevert?.();
    },
  });
  const needsReason =
    revertMutation.error instanceof HeoPressError &&
    (revertMutation.error.body as { errors?: Array<{ code?: string }> } | undefined)?.errors?.[0]?.code === 'REASON_REQUIRED';

  if (query.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading revisions…</p>;
  }
  if (query.error) {
    return <p className="text-sm text-destructive">Failed to load revisions.</p>;
  }
  const revisions = query.data ?? [];

  if (revisions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center text-muted-foreground">
        <History className="h-5 w-5" />
        <p className="text-sm">No revisions yet.</p>
      </div>
    );
  }

  const active = revisions.find((r) => r.id === selected);

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-[16rem_1fr]">
      <ul className="space-y-1 overflow-y-auto md:max-h-[60vh]">
        {revisions.map((rev) => (
          <li key={rev.id}>
            <button
              type="button"
              onClick={() => setSelected(rev.id)}
              className={cn(
                'w-full rounded-md border px-2 py-1.5 text-left text-xs',
                selected === rev.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40',
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono">{rev.id.slice(0, 8)}…</span>
                <span className="text-muted-foreground">
                  {new Date(rev.createdAt).toLocaleString()}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                <ProvenanceBadge revision={rev} />
                by {rev.userId ? rev.userId.slice(0, 8) + '…' : rev.authorType === 'agent' ? 'agent' : 'system'}
              </div>
            </button>
          </li>
        ))}
      </ul>

      <div className="space-y-3">
        {!active ? (
          <p className="text-sm text-muted-foreground">Select a revision to inspect.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <h3 className="inline-flex items-center gap-2 text-sm font-medium">
                Revision {active.id.slice(0, 8)}… <ProvenanceBadge revision={active} />
              </h3>
              <div className="flex items-center gap-1">
                <div className="flex overflow-hidden rounded-md border text-xs">
                  <ViewToggle
                    active={view === 'diff'}
                    onClick={() => setView('diff')}
                    label="Diff"
                    icon={<GitCompare className="h-3 w-3" />}
                  />
                  <ViewToggle
                    active={view === 'raw'}
                    onClick={() => setView('raw')}
                    label="Raw"
                    icon={<Braces className="h-3 w-3" />}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => revertMutation.mutate({ revisionId: active.id })}
                  disabled={revertMutation.isPending}
                  className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-accent disabled:opacity-50"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {revertMutation.isPending ? 'Reverting…' : 'Revert to this'}
                </button>
              </div>
            </div>
            {needsReason ? (
              <form
                className="space-y-2 rounded-md border p-2 text-xs"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim()) revertMutation.mutate({ revisionId: active.id, reason: reason.trim() });
                }}
              >
                <label className="block space-y-1">
                  <span>This revert changes the sponsor marking of a published item. Why?</span>
                  <input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full rounded-md border px-2 py-1"
                    aria-label="Reason for the revert"
                  />
                </label>
                <button type="submit" disabled={!reason.trim() || revertMutation.isPending} className="rounded-md border px-2 py-1 disabled:opacity-50">
                  Revert with this reason
                </button>
              </form>
            ) : (
              revertMutation.error && (
                <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
                  Revert failed.
                </div>
              )
            )}
            <ProvenancePanel revision={active} />
            {view === 'diff' ? (
              <div className="space-y-2">
                <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showUnchanged}
                    onChange={(e) => setShowUnchanged(e.target.checked)}
                  />
                  Show unchanged fields
                </label>
                <div className="max-h-[55vh] overflow-y-auto pr-1">
                  <RevisionsDiff
                    before={active.delta?.before ?? null}
                    after={active.delta?.after ?? null}
                    showUnchanged={showUnchanged}
                  />
                </div>
              </div>
            ) : (
              <pre className="max-h-[50vh] overflow-auto rounded-md border bg-muted/20 p-3 text-xs">
                {JSON.stringify(active.delta, null, 2)}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ViewToggle({
  active,
  onClick,
  label,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1 px-2 py-1',
        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent',
      )}
    >
      {icon}
      {label}
    </button>
  );
}
