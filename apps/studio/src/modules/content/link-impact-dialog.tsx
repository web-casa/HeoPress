import { useMutation } from '@tanstack/react-query';
import { HeoPressError, type SiteLinkImpactResource } from '@heopress/sdk';
import { AlertTriangle, X } from 'lucide-react';
import { useId, useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Before a published page is deleted, unpublished or moved (HeoPress P07 task 5.5; spec seo/link-graph "变更影响预览"): the
 * pages that link to it — "may be affected" — and two ways out: a redirect from its address to another page, or the links
 * in those pages changed to another address. Then the change goes on, or is cancelled.
 */

export type ImpactChange = 'delete' | 'unpublish' | 'move';

const VERB: Record<ImpactChange, string> = { delete: 'Delete anyway', unpublish: 'Save anyway', move: 'Save anyway' };
const WHAT: Record<ImpactChange, string> = { delete: 'Deleting this page', unpublish: 'Unpublishing this page', move: 'Changing this page\'s address' };

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof HeoPressError) {
    const first = (err.body as { errors?: Array<{ message?: string }> })?.errors?.[0];
    if (first?.message) return first.message;
    if (err.status === 403) return 'You do not have permission to do this.';
  }
  return fallback;
}

export function LinkImpactDialog(props: {
  itemId: string;
  change: ImpactChange;
  /** Null: the check failed — not "nothing links here" (Codex review of task 5.5). */
  impact: SiteLinkImpactResource | null;
  /** Administrators may add a redirect (the server refuses others). */
  canRedirect: boolean;
  onProceed: () => void;
  onCancel: () => void;
}) {
  const client = getApiClient();
  const addressId = useId();
  const [to, setTo] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const impact = props.impact;
  // A move adds a redirect from the old address itself (the system's slug redirect): none offered then.
  const offerRedirect = props.canRedirect && props.change !== 'move';
  const sources = [...new Set((impact?.links ?? []).flatMap((l) => (l.source.kind === 'item' && l.depth === 1 ? [l.source.itemId] : [])))];

  const redirect = useMutation({
    mutationFn: async () => (await client.site.impactRedirect(props.itemId, to.trim())).data,
    onSuccess: (r) => setDone(`Redirect added: ${r.fromPath} → ${r.toPath}. Links to this page will lead there once it no longer answers.`),
  });
  const update = useMutation({
    mutationFn: async () => (await client.site.updateImpactLinks(props.itemId, to.trim(), sources)).data,
    onSuccess: (r) =>
      setDone(`Links updated in ${r.updated.length} page(s)${r.skipped.length ? `; ${r.skipped.length} left as they were (${r.skipped.map((s) => s.reason).join(', ')})` : ''}.`),
  });
  const error = redirect.error ?? update.error;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby={`${addressId}-title`} className="w-full max-w-xl rounded-lg border border-border bg-background p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <h2 id={`${addressId}-title`} className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
            Pages that may be affected
          </h2>
          <button type="button" onClick={props.onCancel} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {impact ? (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              {WHAT[props.change]} may break links to it from {impact.pages} page(s) and link(s) below. Links a theme or another site holds are not known here.
              {impact.truncated ? ` Only the first ${impact.limits.limit} are listed.` : ''}
              {props.change === 'move' ? ' A redirect from the old address to the new one is added when you save.' : ''}
            </p>
            <ul aria-label="Linking pages" className="mb-4 max-h-60 space-y-1 overflow-auto rounded-md border border-border p-2 text-xs">
              {impact.links.map((l, i) => (
                <li key={`${l.href}:${i}`}>
                  {l.source.kind === 'item' ? <span className="font-medium">{l.source.title || l.source.itemId}</span> : <span className="font-medium">Navigation: {l.source.label}</span>}{' '}
                  <span className="text-muted-foreground">
                    {l.depth === 2 ? '(links to a linking page) ' : ''}
                    {l.field ? `${l.field} · ` : ''}
                    <span className="font-mono">{l.href}</span>
                    {l.anchorText ? ` “${l.anchorText}”` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p role="alert" className="mb-4 text-xs text-destructive">
            The pages linking to this one could not be checked. {WHAT[props.change]} may break links to it; go on only if you are sure.
          </p>
        )}
        {impact && (offerRedirect || sources.length > 0) ? (
        <div className="space-y-2">
          <label htmlFor={addressId} className="text-xs font-medium">
            Another page&apos;s address
          </label>
          <input id={addressId} className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} placeholder="https://example.com/another-page/" />
          <div className="flex flex-wrap gap-2">
            {offerRedirect ? (
              <button type="button" disabled={!to.trim() || redirect.isPending} onClick={() => redirect.mutate()} className="rounded border border-border px-2 py-1 text-xs">
                Create redirect
              </button>
            ) : null}
            <button type="button" disabled={!to.trim() || update.isPending || sources.length === 0} onClick={() => update.mutate()} className="rounded border border-border px-2 py-1 text-xs">
              Update links
            </button>
          </div>
          {done ? (
            <p role="status" className="text-xs text-green-700 dark:text-green-400">
              {done}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {messageOf(error, 'That did not work.')}
            </p>
          ) : null}
        </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={props.onCancel} className="rounded border border-border px-3 py-1 text-xs">
            Cancel
          </button>
          <button type="button" onClick={props.onProceed} className="rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground">
            {VERB[props.change]}
          </button>
        </div>
      </div>
    </div>
  );
}
