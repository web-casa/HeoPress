import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, History, Rocket } from 'lucide-react';
import { getApiClient } from '@/lib/api';
import type { DeploymentTargetResource, StaticDeployResource, StaticFeature, StaticSiteResource } from '@heopress/sdk';

/**
 * The static site of the Astro engine (HeoPress P11 tasks 4.3–4.5): turn the engine on, pick the deploy target (own
 * server or a CDN target), see what the target can serve, the deploy records with their reachability check, and roll
 * back to the previous successful deploy. Vercel's Hobby plan forbids commercial use: said whenever Vercel is chosen.
 */

const FEATURES: StaticFeature[] = ['noindex', 'markdown-canonical', 'redirect-301', 'gone-410', 'feeds', 'search', 'preview', 'analytics'];
const LEVEL_CLS = { yes: 'bg-ok-soft text-ok', degraded: 'bg-warn-soft text-warn', no: 'bg-panel-2 text-dim' } as const;
const STATUS_CLS: Record<StaticDeployResource['status'], string> = {
  requested: 'bg-brand-soft text-brand',
  uploading: 'bg-warn-soft text-warn',
  succeeded: 'bg-ok-soft text-ok',
  failed: 'bg-bad-soft text-bad',
  refused: 'bg-bad-soft text-bad',
};
const STATIC_PROVIDERS = new Set(['cloudflare-pages', 'vercel', 'netlify']);
const ctl = 'rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand';

export function VercelHobbyNotice() {
  const { t } = useTranslation('siteOps');
  return (
    <p role="note" className="flex items-start gap-2 rounded-ctl bg-warn-soft p-2 text-[13px] text-warn">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      {t('deployments.vercelHobby')}
    </p>
  );
}

export function StaticSiteSection({ targets }: { targets: DeploymentTargetResource[] }) {
  const { t } = useTranslation('siteOps');
  const client = getApiClient();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['static-site'],
    queryFn: async () => (await client.deployments.static.get()).data as StaticSiteResource,
    refetchInterval: (q) => ((q.state.data as StaticSiteResource | undefined)?.deploys.some((d) => d.status === 'requested' || d.status === 'uploading') ? 5000 : false),
  });
  const view = query.data;
  const [form, setForm] = useState({ enabled: false, theme: 'official:starter', deployTargetId: '' });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The form starts from the saved settings once; a background refresh (deploys in flight) never overwrites an edit.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (view && !loaded) {
      setForm({ enabled: view.enabled, theme: view.theme ?? 'official:starter', deployTargetId: view.deployTargetId ?? '' });
      setLoaded(true);
    }
  }, [view, loaded]);

  const done = (msg: string) => {
    setError(null);
    setNotice(msg);
    void qc.invalidateQueries({ queryKey: ['static-site'] });
  };
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const save = useMutation({
    mutationFn: () => client.deployments.static.configure({ enabled: form.enabled, theme: form.theme, deployTargetId: form.deployTargetId || null }),
    onSuccess: () => done(t('deployments.static.saved')),
    onError: fail,
  });
  const redeploy = useMutation({ mutationFn: () => client.deployments.static.redeploy(), onSuccess: () => done(t('deployments.static.requested')), onError: fail });
  const rollback = useMutation({ mutationFn: () => client.deployments.static.rollback(), onSuccess: () => done(t('deployments.static.requested')), onError: fail });

  const usable = targets.filter((x) => STATIC_PROVIDERS.has(x.provider));
  const chosen = usable.find((x) => x.id === form.deployTargetId);
  const platform = chosen?.provider ?? 'vps';
  const none = t('deployments.static.none');

  return (
    <section aria-labelledby="static-site-title" className="space-y-4 rounded-card border border-line bg-panel p-4">
      <div>
        <h2 id="static-site-title" className="t-section">{t('deployments.static.title')}</h2>
        <p className="text-sm text-dim">{t('deployments.static.description')}</p>
      </div>
      {view && (
        <p className="text-[13px] text-dim">
          {t('deployments.static.revisions', { published: view.publishedRevision, built: view.activeRevision ?? none, deployed: view.deployedRevision ?? none })}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          {t('deployments.static.enabled')}
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('deployments.static.theme')}</span>
          <input value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value })} className={`w-full ${ctl}`} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('deployments.static.target')}</span>
          <select value={form.deployTargetId} onChange={(e) => setForm({ ...form, deployTargetId: e.target.value })} className={`w-full ${ctl}`}>
            <option value="">{t('deployments.static.vps')}</option>
            {usable.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} ({t(`deployments.providers.${x.provider}`)})
              </option>
            ))}
          </select>
        </label>
      </div>
      {platform === 'vercel' && <VercelHobbyNotice />}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => save.mutate()} disabled={save.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
          {t('deployments.static.save')}
        </button>
        <button
          type="button"
          onClick={() => redeploy.mutate()}
          disabled={!view?.enabled || view.activeGeneration === null || redeploy.isPending}
          className="inline-flex items-center gap-1.5 rounded-ctl border border-line px-3 py-1.5 text-[13px] disabled:opacity-50"
        >
          <Rocket className="h-3.5 w-3.5" /> {t('deployments.static.redeploy')}
        </button>
        <button
          type="button"
          onClick={() => {
            if (confirm(t('deployments.static.confirmRollback'))) rollback.mutate();
          }}
          disabled={!view?.rollbackCandidate || rollback.isPending}
          title={view?.rollbackCandidate ? undefined : t('deployments.static.noRollback')}
          className="inline-flex items-center gap-1.5 rounded-ctl border border-line px-3 py-1.5 text-[13px] disabled:opacity-50"
        >
          <History className="h-3.5 w-3.5" /> {t('deployments.static.rollback')}
        </button>
      </div>
      {notice && <p role="status" className="text-sm text-ok">{notice}</p>}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}

      {view && (
        <div role="region" aria-label={t('deployments.static.support')}>
          <h3 className="mb-2 text-[13px] font-semibold">{t('deployments.static.support')}</h3>
          <ul className="grid gap-1 sm:grid-cols-2">
            {FEATURES.map((f) => {
              const s = view.support[platform][f];
              return (
                <li key={f} className="flex items-center justify-between gap-2 text-[13px]" title={s.note}>
                  <span>{t(`deployments.static.feature.${f}`)}</span>
                  <span className={`rounded px-2 py-0.5 text-xs ${LEVEL_CLS[s.support]}`}>{t(`deployments.static.level.${s.support}`)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div role="region" aria-label={t('deployments.static.records')}>
        <h3 className="mb-2 text-[13px] font-semibold">{t('deployments.static.records')}</h3>
        {view && view.deploys.length === 0 ? (
          <p className="text-sm text-dim">{t('deployments.static.noRecords')}</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full text-sm">
              <thead className="bg-panel-2 text-left text-[12px] text-dim">
                <tr>
                  <th className="px-3 py-2">{t('deployments.static.col.when')}</th>
                  <th className="px-3 py-2">{t('deployments.static.col.kind')}</th>
                  <th className="px-3 py-2">{t('deployments.static.col.generation')}</th>
                  <th className="px-3 py-2">{t('deployments.static.col.status')}</th>
                  <th className="px-3 py-2">{t('deployments.static.col.reachability')}</th>
                  <th className="px-3 py-2">{t('deployments.static.col.url')}</th>
                </tr>
              </thead>
              <tbody>
                {(view?.deploys ?? []).map((d) => (
                  <tr key={d.id} className="border-t border-line align-top">
                    <td className="px-3 py-2 text-dim">{new Date(d.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-2">{t(`deployments.static.kind.${d.kind}`)} · {t(`deployments.providers.${d.provider}`, { defaultValue: t('deployments.static.vps') })}</td>
                    <td className="px-3 py-2">#{d.generation}</td>
                    <td className="px-3 py-2">
                      <span className={`rounded px-2 py-0.5 text-xs ${STATUS_CLS[d.status]}`}>{t(`deployments.static.status.${d.status}`)}</span>
                      {d.error && <p className="mt-1 text-xs text-bad">{d.error}</p>}
                      {d.warnings && d.warnings.length > 0 && (
                        <p className="mt-1 text-xs text-warn">
                          {t('deployments.static.warnings')}: {d.warnings.join(' ')}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {d.reachability ? (
                        <>
                          <span>{t(`deployments.static.reach.${d.reachability.status}`, { count: d.reachability.issues?.length ?? 0 })}</span>
                          <ul className="mt-1 space-y-1 text-xs">
                            {(d.reachability.issues ?? []).slice(0, 5).map((i) => (
                              <li key={`${i.url}-${i.code}`}>
                                <span className="text-bad">{i.code}</span> {i.url}: {i.detail}
                                {i.advice && <pre className="mt-0.5 whitespace-pre-wrap text-dim">{i.advice}</pre>}
                              </li>
                            ))}
                          </ul>
                        </>
                      ) : (
                        none
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {d.url ? (
                        <a href={d.url} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                          {t('common:open')}
                        </a>
                      ) : (
                        none
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
