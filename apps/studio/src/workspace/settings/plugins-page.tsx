import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { ExternalLink, Puzzle, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExtensionConfigOption } from '@heopress/contracts/schemas';
import { getAdminBase } from '@/lib/admin-base';
import { getApiClient } from '@/lib/api';
import { withAdminBase } from '@/lib/keybindings/commands';
import { usePermissions } from '@/lib/use-permissions';
import { siteKey } from '../api';
import { inputClass } from '../seo/seo-kit';
import { EmptyState } from '../ui/empty-state';
import { PageHeader } from '../ui/page-header';
import { RelativeTime } from '../ui/relative-time';
import { Skeleton } from '../ui/skeleton';

/**
 * Settings › Plugins (HeoPress P12 tasks 3.5, 3.6; spec extensions/runtime-extensions "插件后台面板"): the admin panels
 * of the active site's plugins. Studio renders the declarative tier — a table of the plugin's own storage, count widgets,
 * the declared settings — from data the server reads for this site only, after checking the person may see it. A page
 * with the plugin's own frontend is offered only for a plugin the operator trusts, and opens at the plugin's own
 * address, outside Studio; for an untrusted plugin the server does not even send the address.
 */

const BASE = '/api/v1/plugins';

interface PanelPage {
  id: string;
  title: string;
  type: 'table' | 'settings' | 'custom';
  frontend?: { status: 'trusted' | 'untrusted'; url: string | null };
}

interface PluginPanel {
  name: string;
  displayName: string;
  version: string;
  trusted: boolean;
  pages: PanelPage[];
  widgets: Array<{ id: string; title: string; count: number }>;
  hasSettings: boolean;
}

interface StoredDocument {
  id: string;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

type PageContent =
  | { type: 'table'; id: string; title: string; columns: string[]; documents: StoredDocument[]; next: string | null }
  | { type: 'settings'; id: string; title: string; settings: ExtensionConfigOption[]; values: Record<string, unknown> }
  | { type: 'custom'; id: string; title: string; frontend: { status: 'trusted' | 'untrusted'; url: string | null } };

function useAdminLink() {
  const { location } = useRouterState();
  const base = getAdminBase(location.pathname);
  return (path: string) => withAdminBase(base, path) as never;
}

const enc = encodeURIComponent;

export function PluginsPage() {
  const { t } = useTranslation('settings');
  const client = getApiClient();
  const link = useAdminLink();
  const panels = useQuery({ queryKey: siteKey('plugin-panels'), queryFn: async () => (await client.rawRequest<PluginPanel[]>(BASE)).data });
  return (
    <>
      <PageHeader title={t('plugins.title')} description={t('plugins.description')} />
      {panels.isLoading ? (
        <Skeleton className="h-48" />
      ) : panels.isError ? (
        <EmptyState title={t('plugins.unavailable')} />
      ) : (panels.data ?? []).length === 0 ? (
        <EmptyState icon={Puzzle} title={t('plugins.empty')} body={t('plugins.emptyBody')} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {(panels.data ?? []).map((p) => (
            <article key={p.name} className="rounded-card border border-line bg-panel p-4" data-plugin={p.name} aria-label={p.displayName}>
              <h2 className="flex items-center gap-2 t-section">
                {p.displayName}
                <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[12px] font-normal text-dim">{`v${p.version}`}</span>
              </h2>
              {p.widgets.length > 0 && (
                <dl className="mt-3 grid grid-cols-2 gap-2">
                  {p.widgets.map((w) => (
                    <div key={w.id} className="rounded-ctl border border-line px-3 py-2" data-widget={w.id}>
                      <dt className="t-aux">{w.title}</dt>
                      <dd className="text-lg font-semibold tabular-nums">{w.count}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <ul className="mt-3 flex flex-wrap gap-2">
                {p.pages.map((pg) => (
                  <li key={pg.id}>
                    <Link
                      to={link(`/settings/plugins/${enc(p.name)}/${enc(pg.id)}`)}
                      className="inline-flex items-center gap-1 rounded-ctl border border-line px-2.5 py-1.5 text-[13px] hover:bg-panel-2"
                    >
                      {pg.title}
                      {pg.type === 'custom' && pg.frontend?.status === 'untrusted' ? <ShieldAlert className="h-3.5 w-3.5 text-warn" aria-label={t('plugins.needsTrust')} /> : null}
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

export function PluginPanelPage() {
  const { t } = useTranslation('settings');
  const client = getApiClient();
  const link = useAdminLink();
  const { name, page } = useParams({ strict: false }) as { name: string; page: string };
  const [after, setAfter] = useState<string | null>(null);
  const [rows, setRows] = useState<StoredDocument[]>([]);
  const content = useQuery({
    queryKey: siteKey('plugin-page', name, page, after),
    queryFn: async () => (await client.rawRequest<PageContent>(`${BASE}/${enc(name)}/pages/${enc(page)}${after ? `?after=${enc(after)}` : ''}`)).data,
  });
  useEffect(() => {
    setAfter(null);
    setRows([]);
  }, [name, page]);
  useEffect(() => {
    const data = content.data;
    if (data?.type === 'table') setRows((prev) => (after ? [...prev, ...data.documents.filter((d) => !prev.some((p) => p.id === d.id))] : data.documents));
  }, [content.data, after]);

  const back = (
    <Link to={link('/settings/plugins')} className="text-[13px] text-dim hover:underline">
      {t('plugins.back')}
    </Link>
  );
  if (content.isLoading && !content.data) return <Skeleton className="h-64" />;
  if (content.isError || !content.data) {
    return (
      <>
        {back}
        <EmptyState title={t('plugins.pageUnavailable')} body={t('plugins.pageUnavailableBody')} />
      </>
    );
  }
  const data = content.data;
  return (
    <>
      {back}
      <PageHeader title={data.title} description={name} />
      {data.type === 'table' && <TablePage columns={data.columns} rows={rows} next={data.next} loading={content.isFetching} onMore={() => data.next && setAfter(data.next)} />}
      {data.type === 'settings' && <SettingsForm name={name} settings={data.settings} values={data.values} />}
      {data.type === 'custom' && <CustomPage frontend={data.frontend} />}
    </>
  );
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function TablePage({ columns, rows, next, loading, onMore }: { columns: string[]; rows: StoredDocument[]; next: string | null; loading: boolean; onMore: () => void }) {
  const { t } = useTranslation('settings');
  const cols = columns.length > 0 ? columns : Array.from(new Set(rows.flatMap((r) => Object.keys(r.data)))).slice(0, 6);
  if (rows.length === 0) return <EmptyState title={t('plugins.noRecords')} />;
  return (
    <>
      <div className="overflow-x-auto rounded-card border border-line bg-panel">
        <table className="w-full min-w-[560px] text-left text-[13px]" data-testid="plugin-table">
          <thead className="t-aux">
            <tr className="border-b border-line">
              <th className="px-4 py-2">{t('plugins.id')}</th>
              {cols.map((c) => (
                <th key={c} className="px-4 py-2">{c}</th>
              ))}
              <th className="px-4 py-2">{t('plugins.updated')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 font-mono text-[12px]">{r.id}</td>
                {cols.map((c) => (
                  <td key={c} className="max-w-[320px] truncate px-4 py-2">{cell(r.data[c])}</td>
                ))}
                <td className="px-4 py-2 text-dim"><RelativeTime value={r.updatedAt} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {next && (
        <button type="button" disabled={loading} onClick={onMore} className="mt-3 rounded-ctl border border-line px-3 py-1.5 text-[13px] hover:bg-panel-2 disabled:opacity-50">
          {t('plugins.more')}
        </button>
      )}
    </>
  );
}

function SettingsForm({ name, settings, values }: { name: string; settings: ExtensionConfigOption[]; values: Record<string, unknown> }) {
  const { t } = useTranslation('settings');
  const client = getApiClient();
  const qc = useQueryClient();
  const { canAdminister } = usePermissions();
  const [draft, setDraft] = useState<Record<string, string | boolean>>({});
  useEffect(() => {
    setDraft(Object.fromEntries(settings.map((s) => [s.key, s.type === 'boolean' ? values[s.key] === true : values[s.key] == null ? '' : s.type === 'json' ? JSON.stringify(values[s.key]) : String(values[s.key])])));
  }, [settings, values]);
  const save = useMutation({
    mutationFn: async () => {
      const out: Record<string, unknown> = {};
      for (const s of settings) {
        const v = draft[s.key];
        if (s.type === 'boolean') out[s.key] = v === true;
        else if (v === '' || v === undefined) out[s.key] = null;
        else if (s.type === 'integer') out[s.key] = Number(v);
        else if (s.type === 'json') out[s.key] = JSON.parse(String(v));
        else out[s.key] = String(v);
      }
      return client.rawRequest(`${BASE}/${enc(name)}/settings`, { method: 'PUT', body: JSON.stringify({ values: out }) });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: siteKey('plugin-page') }),
  });
  const error = save.error as { body?: { errors?: Array<{ message?: string }> } } | null;
  return (
    <form
      className="max-w-xl space-y-4 rounded-card border border-line bg-panel p-4"
      aria-label={t('plugins.settingsForm')}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {settings.map((s) =>
        s.type === 'boolean' ? (
          <label key={s.key} className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" disabled={!canAdminister} checked={draft[s.key] === true} onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.checked }))} />
            {s.label ?? s.key}
          </label>
        ) : (
          <label key={s.key} className="block text-[13px]">
            <span className="mb-1 block">{s.label ?? s.key}</span>
            <input
              className={inputClass}
              disabled={!canAdminister}
              inputMode={s.type === 'integer' ? 'numeric' : undefined}
              value={String(draft[s.key] ?? '')}
              onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))}
            />
          </label>
        ),
      )}
      {canAdminister ? (
        <div className="flex items-center gap-3">
          <button type="submit" disabled={save.isPending} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
            {t('plugins.save')}
          </button>
          {save.isSuccess && <span role="status" className="text-[13px] text-ok">{t('plugins.saved')}</span>}
          {save.isError && <span role="alert" className="text-[13px] text-bad">{error?.body?.errors?.[0]?.message ?? t('plugins.saveFailed')}</span>}
        </div>
      ) : (
        <p className="t-aux">{t('plugins.readOnly')}</p>
      )}
    </form>
  );
}

function CustomPage({ frontend }: { frontend: { status: 'trusted' | 'untrusted'; url: string | null } }) {
  const { t } = useTranslation('settings');
  if (frontend.status !== 'trusted' || !frontend.url) {
    return <EmptyState icon={ShieldAlert} title={t('plugins.untrustedTitle')} body={t('plugins.untrustedBody')} />;
  }
  return (
    <div className="rounded-card border border-line bg-panel p-4 text-[13px]">
      <p className="t-aux">{t('plugins.trustedBody')}</p>
      <a href={frontend.url} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1 rounded-ctl border border-line px-2.5 py-1.5 hover:bg-panel-2">
        {t('plugins.openFrontend')} <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
