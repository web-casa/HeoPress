// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, Clock } from 'lucide-react';
import { getApiClient } from '@/lib/api';
import { SecurityAuditTab } from './security-audit-tab';
import { PageHeader } from '@/workspace/ui/page-header';

/**
 * Settings → Activity page.
 *
 * Hosts TWO tabs (admin-setup-wizard task 12.4):
 *
 *   1. "Activity" — the original chronological activity-log table backed
 *      by `client.activity.list(...)`. Its body is unchanged; it has only
 *      moved into a tab panel.
 *   2. "Security audit" — the admin-only audit-log read surface
 *      ({@link SecurityAuditTab}) over `/api/v1/admin/security/audit-log`,
 *      with event/email/date-range filters, cursor "Load more"
 *      pagination, and an NDJSON export (Req 15.4, 15.6; design §10.3).
 *
 * ── Tabs ─────────────────────────────────────────────────────────────
 *
 * `@heopress/ui` exposes no Tabs primitive yet (it currently only exports
 * `cn`), so the switcher is hand-rolled with the WAI-ARIA tabs pattern:
 * a `role="tablist"` of `role="tab"` buttons driving `aria-selected` +
 * `aria-controls`, each paired with a `role="tabpanel"`. A local
 * `useState<'activity' | 'security'>` owns the active tab — no routing
 * change, so the existing `/settings/activity` route is untouched.
 */

type SettingsTab = 'activity' | 'security';

export function ActivityPage() {
  const { t } = useTranslation('system');
  const [tab, setTab] = useState<SettingsTab>('activity');

  // Stable ids linking each tab button to its panel (a11y).
  const activityTabId = useId();
  const activityPanelId = useId();
  const securityTabId = useId();
  const securityPanelId = useId();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('activity.title')}
        description={t('activity.description')}
      />

      {/* ── Tab switcher (WAI-ARIA tabs pattern) ──────────────────── */}
      <div role="tablist" aria-label={t('activity.views')} className="flex gap-1 border-b">
        <button
          type="button"
          role="tab"
          id={activityTabId}
          aria-selected={tab === 'activity'}
          aria-controls={activityPanelId}
          onClick={() => setTab('activity')}
          className={tabClass(tab === 'activity')}
        >
          <Activity className="h-4 w-4" aria-hidden="true" />
          <span>{t('activity.tab')}</span>
        </button>
        <button
          type="button"
          role="tab"
          id={securityTabId}
          aria-selected={tab === 'security'}
          aria-controls={securityPanelId}
          onClick={() => setTab('security')}
          className={tabClass(tab === 'security')}
        >
          <span>{t('activity.securityTab')}</span>
        </button>
      </div>

      {/* ── Activity panel ────────────────────────────────────────── */}
      <div
        role="tabpanel"
        id={activityPanelId}
        aria-labelledby={activityTabId}
        hidden={tab !== 'activity'}
      >
        {tab === 'activity' ? <ActivityLogTable /> : null}
      </div>

      {/* ── Security audit panel ──────────────────────────────────── */}
      <div
        role="tabpanel"
        id={securityPanelId}
        aria-labelledby={securityTabId}
        hidden={tab !== 'security'}
      >
        {tab === 'security' ? <SecurityAuditTab /> : null}
      </div>
    </div>
  );
}

/** Shared className for a tab button, styled by its selected state. */
function tabClass(selected: boolean): string {
  const base =
    'inline-flex items-center gap-1.5 border-b-2 px-4 py-2 text-sm font-medium transition -mb-px';
  return selected
    ? `${base} border-brand text-fg`
    : `${base} border-transparent text-dim hover:text-fg hover:border-line`;
}

/**
 * The original "Activity Log" table — unchanged behaviour, lifted out of
 * the page body into its own component so the page can host it inside a
 * tab panel. Backed by `client.activity.list(...)`.
 */
function ActivityLogTable() {
  const { t } = useTranslation(['system', 'common']);
  const client = getApiClient();

  const activityQuery = useQuery({
    queryKey: ['activity'],
    queryFn: async () => (await client.activity.list({ limit: 100 })).data,
  });

  const activityList = activityQuery.data ?? [];

  return (
    <div className="overflow-hidden rounded-card border border-line bg-panel">
      <table className="w-full text-sm">
        <thead className="bg-panel-2 text-left text-xs uppercase text-dim border-b">
          <tr>
            <th className="px-4 py-3">{t('activity.columns.timestamp')}</th>
            <th className="px-4 py-3">{t('activity.columns.userId')}</th>
            <th className="px-4 py-3">{t('activity.columns.action')}</th>
            <th className="px-4 py-3">{t('activity.columns.target')}</th>
            <th className="px-4 py-3">{t('activity.columns.ipAgent')}</th>
          </tr>
        </thead>
        <tbody>
          {activityQuery.isLoading && (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-dim">{t('common:loading')}</td></tr>
          )}
          {!activityQuery.isLoading && activityList.length === 0 && (
            <tr><td colSpan={5} className="px-4 py-8 text-center text-dim">{t('activity.empty')}</td></tr>
          )}
          {activityList.map((row) => (
            <tr key={row.id} className="border-b hover:bg-panel-2 last:border-0">
              <td className="px-4 py-3 whitespace-nowrap text-dim">
                <div className="flex items-center gap-2">
                  <Clock className="h-3 w-3" />
                  {new Date(row.createdAt).toLocaleString()}
                </div>
              </td>
              <td className="px-4 py-3 font-medium">
                {row.userId || t('activity.system')}
              </td>
              <td className="px-4 py-3">
                <span className="inline-flex rounded bg-panel-2 px-2 py-0.5 text-xs text-fg">
                  {row.action}
                </span>
              </td>
              <td className="px-4 py-3">
                {row.collection ? (
                  <span className="text-dim">
                    {row.collection} {row.itemId ? `/ ${row.itemId}` : ''}
                  </span>
                ) : '-'}
              </td>
              <td className="px-4 py-3 text-xs text-dim">
                {row.ip || '-'}
                <br />
                <span className="truncate max-w-[150px] inline-block" title={row.userAgent ?? ''}>
                  {row.userAgent || ''}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
