import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { HeoPressError } from '@heopress/sdk';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';
import { backupsApi, type BackupEntry, type DrillEntry } from '../api';

/**
 * Logs & monitoring › Backups (HeoPress P13 tasks 1.1–1.3, 1.6; spec ops/backup-restore): the backup catalogue (full
 * and incremental, their chain, size, media synced, encryption), the restore drills with what each checked and what
 * failed, buttons to back up or drill now (the instance administrator), and the current site's single-site exports
 * (site administrators).
 */

const STATUS_CLASS: Record<string, string> = {
  succeeded: 'bg-ok-soft text-ok',
  passed: 'bg-ok-soft text-ok',
  failed: 'bg-bad-soft text-bad',
  running: 'bg-warn-soft text-warn',
  queued: 'bg-panel-2 text-dim',
  removed: 'bg-panel-2 text-dim',
};

const BUTTON = 'inline-flex h-8 items-center gap-1 rounded-ctl border border-line px-2 text-[13px] hover:bg-panel-2 disabled:opacity-50';

function errorText(err: unknown): string {
  return err instanceof HeoPressError ? err.message : String(err);
}

function size(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function Status({ value }: { value: string }) {
  const { t } = useTranslation('monitoring');
  return <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${STATUS_CLASS[value] ?? ''}`}>{t(`backups.status.${value}`)}</span>;
}

function BackupRow({ b }: { b: BackupEntry }) {
  const { t } = useTranslation('monitoring');
  return (
    <tr>
      <td className="py-1.5 pr-3">
        <code className="text-xs">{b.id}</code>
        {b.parentId ? <div className="text-xs text-dim">{t('backups.after', { id: b.parentId })}</div> : null}
      </td>
      <td className="py-1.5 pr-3">{t(`backups.kind.${b.kind}`)}</td>
      <td className="py-1.5 pr-3">
        <Status value={b.status} />
        {b.status === 'failed' && b.error ? <div className="max-w-md text-xs text-bad">{b.error}</div> : null}
      </td>
      <td className="py-1.5 pr-3 tabular-nums">{size(b.sizeBytes)}</td>
      <td className="py-1.5 pr-3 tabular-nums">{b.mediaObjects === null ? '—' : t('backups.mediaCount', { count: b.mediaObjects, added: b.mediaNew ?? 0 })}</td>
      <td className="py-1.5 pr-3">{b.encrypted ? t('backups.encryptedYes') : t('backups.encryptedNo')}</td>
      <td className="py-1.5 text-xs text-dim">{new Date(b.createdAt).toLocaleString()}</td>
    </tr>
  );
}

function DrillItem({ d }: { d: DrillEntry }) {
  const { t } = useTranslation('monitoring');
  const failures = d.report?.failures ?? [];
  return (
    <li className="space-y-1 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Status value={d.status} />
        <span className="text-xs text-dim">{new Date(d.createdAt).toLocaleString()}</span>
        {d.backupId ? <code className="text-xs">{d.backupId}</code> : null}
        {d.report?.restoredInto ? <span className="text-xs text-dim">{d.report.restoredInto}</span> : null}
      </div>
      {d.report?.checks?.length ? (
        <ul className="flex flex-wrap gap-1.5" aria-label={t('backups.checks')}>
          {d.report.checks.map((c) => (
            <li key={c.name} className={`rounded px-1.5 py-0.5 text-xs ${STATUS_CLASS[c.status === 'passed' ? 'passed' : c.status === 'failed' ? 'failed' : 'queued']}`} title={c.detail ?? ''}>
              {t(`backups.check.${c.name}`)}
            </li>
          ))}
        </ul>
      ) : null}
      {failures.length ? (
        <ul className="list-disc pl-5 text-xs text-bad">
          {failures.slice(0, 10).map((f, i) => (
            <li key={i}>
              {t(`backups.check.${f.check}`)}
              {f.object ? (
                <>
                  {' '}
                  <code>{f.object}</code>
                </>
              ) : null}
              : {f.message}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function SiteExports() {
  const { t } = useTranslation('monitoring');
  const qc = useQueryClient();
  const exports = useQuery({ queryKey: ['backups', 'site-exports'], queryFn: backupsApi.siteExports, refetchInterval: 15_000, retry: false });
  const request = useMutation({ mutationFn: backupsApi.exportSite, onSuccess: () => qc.invalidateQueries({ queryKey: ['backups', 'site-exports'] }) });
  if (exports.error instanceof HeoPressError && exports.error.status === 403) return null;
  return (
    <section aria-label={t('backups.exports.title')} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="t-section">{t('backups.exports.title')}</h2>
        <button type="button" className={BUTTON} disabled={request.isPending} onClick={() => request.mutate()}>
          {t('backups.exports.request')}
        </button>
      </div>
      <p className="text-sm text-dim">{t('backups.exports.description')}</p>
      {request.isSuccess ? <p role="status">{t('backups.exports.requested')}</p> : null}
      {request.error ? <p role="alert" className="text-bad">{t('backups.refused', { reason: errorText(request.error) })}</p> : null}
      {exports.data && exports.data.length === 0 ? <p className="text-sm text-dim">{t('backups.exports.none')}</p> : null}
      {exports.data?.length ? (
        <ul className="divide-y divide-line rounded-ctl border border-line text-sm">
          {exports.data.map((e) => (
            <li key={e.id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Status value={e.status} />
                <span className="text-xs text-dim">{new Date(e.createdAt).toLocaleString()}</span>
                {e.status === 'succeeded' ? <span className="text-xs">{t('backups.exports.counts', { items: e.items ?? 0, media: e.media ?? 0 })}</span> : null}
              </div>
              {e.location ? <code className="block text-xs">{e.location}</code> : null}
              {e.error ? <p className="text-xs text-bad">{e.error}</p> : null}
              {e.report?.dropped?.length ? <p className="text-xs text-dim">{t('backups.exports.dropped', { count: e.report.dropped.length })}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

export function BackupsPage() {
  const { t } = useTranslation('monitoring');
  const qc = useQueryClient();
  const overview = useQuery({ queryKey: ['backups', 'overview'], queryFn: backupsApi.overview, refetchInterval: 15_000, retry: false });
  const backupNow = useMutation({ mutationFn: backupsApi.backupNow, onSuccess: () => qc.invalidateQueries({ queryKey: ['backups', 'overview'] }) });
  const drillNow = useMutation({ mutationFn: backupsApi.drillNow, onSuccess: () => qc.invalidateQueries({ queryKey: ['backups', 'overview'] }) });
  const forbidden = overview.error instanceof HeoPressError && overview.error.status === 403;
  const o = overview.data;

  return (
    <div className="space-y-6">
      <PageHeader title={t('backups.title')} description={t('backups.description')} />
      {forbidden ? (
        <p role="alert" className="text-sm text-bad">
          {t('backups.adminOnly')}
        </p>
      ) : overview.isError ? (
        <p role="alert" className="text-sm text-bad">
          {t('backups.loadFailed')}
        </p>
      ) : null}
      {o ? (
        <section aria-label={t('backups.settings')} className="space-y-2">
          {o.configured ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt className="text-dim">{t('backups.target')}</dt>
              <dd>
                <code>{o.target}</code>
              </dd>
              <dt className="text-dim">{t('backups.method')}</dt>
              <dd>{t(`backups.methods.${o.method}`)}</dd>
              <dt className="text-dim">{t('backups.encryption')}</dt>
              <dd>{o.encrypted ? t('backups.encryptedYes') : t('backups.encryptedNo')}</dd>
              <dt className="text-dim">{t('backups.schedule')}</dt>
              <dd>{o.schedule?.enabled ? <code className="text-xs">{`${o.schedule.full} · ${o.schedule.incremental} · ${o.schedule.drill}`}</code> : t('backups.scheduleOff')}</dd>
              <dt className="text-dim">{t('backups.retention')}</dt>
              <dd>{t('backups.retentionValue', { daily: o.retention?.daily ?? 0, weekly: o.retention?.weekly ?? 0 })}</dd>
            </dl>
          ) : (
            <p role="status" className="text-sm text-warn">
              {o.configError ? t('backups.configError', { reason: o.configError }) : t('backups.notConfigured')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={!o.configured || backupNow.isPending} onClick={() => backupNow.mutate()}>
              {t('backups.backupNow')}
            </button>
            <button type="button" className={BUTTON} disabled={!o.configured || drillNow.isPending} onClick={() => drillNow.mutate()}>
              {t('backups.drillNow')}
            </button>
          </div>
          {backupNow.isSuccess || drillNow.isSuccess ? <p role="status">{t('backups.requested')}</p> : null}
          {backupNow.error || drillNow.error ? <p role="alert" className="text-bad">{t('backups.refused', { reason: errorText(backupNow.error ?? drillNow.error) })}</p> : null}
        </section>
      ) : null}
      {o ? (
        <section aria-label={t('backups.list')} className="space-y-2">
          <h2 className="t-section">{t('backups.list')}</h2>
          {o.backups.length === 0 ? (
            <p className="text-sm text-dim">{t('backups.none')}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-dim">
                  <tr>
                    <th className="py-1 pr-3 font-medium">{t('backups.id')}</th>
                    <th className="py-1 pr-3 font-medium">{t('backups.kindLabel')}</th>
                    <th className="py-1 pr-3 font-medium">{t('backups.statusLabel')}</th>
                    <th className="py-1 pr-3 font-medium">{t('backups.size')}</th>
                    <th className="py-1 pr-3 font-medium">{t('backups.media')}</th>
                    <th className="py-1 pr-3 font-medium">{t('backups.encryption')}</th>
                    <th className="py-1 font-medium">{t('backups.taken')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {o.backups.map((b) => (
                    <BackupRow key={b.id} b={b} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}
      {o ? (
        <section aria-label={t('backups.drills')} className="space-y-2">
          <h2 className="t-section">{t('backups.drills')}</h2>
          {o.drills.length === 0 ? (
            <p className="text-sm text-dim">{t('backups.noDrills')}</p>
          ) : (
            <ul className="divide-y divide-line rounded-ctl border border-line text-sm">
              {o.drills.map((d) => (
                <DrillItem key={d.id} d={d} />
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <SiteExports />
    </div>
  );
}
