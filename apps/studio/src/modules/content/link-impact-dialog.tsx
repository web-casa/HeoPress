import { useMutation } from '@tanstack/react-query';
import { HeoPressError, type SiteLinkImpactResource } from '@heopress/sdk';
import { AlertTriangle, X } from 'lucide-react';
import { useId, useState } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';

/**
 * Before a published page is deleted, unpublished or moved (HeoPress P07 task 5.5; spec seo/link-graph "变更影响预览"): the
 * pages that link to it — "may be affected" — and two ways out: a redirect from its address to another page, or the links
 * in those pages changed to another address. Then the change goes on, or is cancelled.
 */

export type ImpactChange = 'delete' | 'unpublish' | 'move';

const VERB: Record<ImpactChange, string> = { delete: 'impact.verb.delete', unpublish: 'impact.verb.save', move: 'impact.verb.save' };
const WHAT: Record<ImpactChange, string> = { delete: 'impact.what.delete', unpublish: 'impact.what.unpublish', move: 'impact.what.move' };

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof HeoPressError) {
    const first = (err.body as { errors?: Array<{ message?: string }> })?.errors?.[0];
    if (first?.message) return first.message;
    if (err.status === 403) return i18n.t('items:impact.forbidden');
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
  const { t } = useTranslation('items');
  const addressId = useId();
  const [to, setTo] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const impact = props.impact;
  // A move adds a redirect from the old address itself (the system's slug redirect): none offered then.
  const offerRedirect = props.canRedirect && props.change !== 'move';
  const sources = [...new Set((impact?.links ?? []).flatMap((l) => (l.source.kind === 'item' && l.depth === 1 ? [l.source.itemId] : [])))];

  const redirect = useMutation({
    mutationFn: async () => (await client.site.impactRedirect(props.itemId, to.trim())).data,
    onSuccess: (r) => setDone(t('impact.redirectDone', { from: r.fromPath, to: r.toPath })),
  });
  const update = useMutation({
    mutationFn: async () => (await client.site.updateImpactLinks(props.itemId, to.trim(), sources)).data,
    onSuccess: (r) =>
      setDone(r.skipped.length ? t('impact.updatedSkipped', { count: r.updated.length, skipped: r.skipped.length, reasons: r.skipped.map((s) => s.reason).join(', ') }) : t('impact.updated', { count: r.updated.length })),
  });
  const error = redirect.error ?? update.error;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby={`${addressId}-title`} className="w-full max-w-xl rounded-card border border-line bg-panel p-5 shadow-xl">
        <div className="mb-3 flex items-start justify-between">
          <h2 id={`${addressId}-title`} className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="h-4 w-4 text-warn" aria-hidden="true" />
            {t('impact.title')}
          </h2>
          <button type="button" onClick={props.onCancel} aria-label={t('common:close')} className="text-dim hover:text-fg">
            <X className="h-4 w-4" />
          </button>
        </div>
        {impact ? (
          <>
            <p className="mb-3 text-xs text-dim">
              {t('impact.summary', { what: t(WHAT[props.change]), count: impact.pages })}
              {impact.truncated ? t('impact.truncated', { limit: impact.limits.limit }) : ''}
              {props.change === 'move' ? t('impact.moveRedirect') : ''}
            </p>
            <ul aria-label={t('impact.linkingPages')} className="mb-4 max-h-60 space-y-1 overflow-auto rounded-ctl border border-line p-2 text-xs">
              {impact.links.map((l, i) => (
                <li key={`${l.href}:${i}`}>
                  {l.source.kind === 'item' ? <span className="font-medium">{l.source.title || l.source.itemId}</span> : <span className="font-medium">{t('impact.navigation', { label: l.source.label })}</span>}{' '}
                  <span className="text-dim">
                    {l.depth === 2 ? t('impact.depth2') : ''}
                    {l.field ? `${l.field} · ` : ''}
                    <span className="font-mono">{l.href}</span>
                    {l.anchorText ? ` “${l.anchorText}”` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p role="alert" className="mb-4 text-xs text-bad">
            {t('impact.checkFailed', { what: t(WHAT[props.change]) })}
          </p>
        )}
        {impact && (offerRedirect || sources.length > 0) ? (
        <div className="space-y-2">
          <label htmlFor={addressId} className="text-xs font-medium">
            {t('impact.address')}
          </label>
          <input id={addressId} className="h-8 w-full rounded border border-line bg-bg px-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('impact.addressPlaceholder')} />
          <div className="flex flex-wrap gap-2">
            {offerRedirect ? (
              <button type="button" disabled={!to.trim() || redirect.isPending} onClick={() => redirect.mutate()} className="rounded border border-line px-2 py-1 text-xs">
                {t('impact.createRedirect')}
              </button>
            ) : null}
            <button type="button" disabled={!to.trim() || update.isPending || sources.length === 0} onClick={() => update.mutate()} className="rounded border border-line px-2 py-1 text-xs">
              {t('impact.updateLinks')}
            </button>
          </div>
          {done ? (
            <p role="status" className="text-xs text-ok">
              {done}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-xs text-bad">
              {messageOf(error, t('impact.failed'))}
            </p>
          ) : null}
        </div>
        ) : null}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={props.onCancel} className="rounded border border-line px-3 py-1 text-xs">
            {t('common:cancel')}
          </button>
          <button type="button" onClick={props.onProceed} className="rounded bg-bad px-3 py-1 text-xs text-white">
            {t(VERB[props.change])}
          </button>
        </div>
      </div>
    </div>
  );
}
