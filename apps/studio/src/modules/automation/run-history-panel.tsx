// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { getActiveToken, getActiveSite } from '@/lib/api';
import { siteFetch } from '@/lib/http';

/**
 * Run history panel (visual-flow-builder Req 6).
 *
 * Lists a flow's recent runs and, on selection, loads the run detail —
 * input, per-node steps, error — and reports the steps up to the editor so
 * the canvas can highlight the executed path.
 */

export interface FlowRunSummary {
  id: string;
  status: 'pending' | 'running' | 'success' | 'error' | 'cancelled';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface FlowRunDetail extends FlowRunSummary {
  input: Record<string, unknown>;
  steps: Record<string, unknown>;
  output: Record<string, unknown>;
}

function runsApi<T>(path: string): Promise<T> {
  return siteFetch(`/api/v1/flows${path}`, {
    headers: {
      Authorization: `Bearer ${getActiveToken()}`,
      'X-HeoPress-Site': getActiveSite(),
    },
  }).then(async (r) => {
    if (!r.ok) throw new Error(i18n.t('flows:apiError', { status: r.status }));
    return ((await r.json()) as { data: T }).data;
  });
}

function durationLabel(run: FlowRunSummary): string {
  if (!run.finishedAt) return '—';
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function StatusIcon({ status }: { status: FlowRunSummary['status'] }) {
  if (status === 'success') return <CheckCircle2 className="h-3.5 w-3.5 text-ok" />;
  if (status === 'error') return <XCircle className="h-3.5 w-3.5 text-rose-500" />;
  if (status === 'running' || status === 'pending')
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-dim" />;
  return <AlertCircle className="h-3.5 w-3.5 text-dim" />;
}

export function RunHistoryPanel({
  flowId,
  onRunSelected,
}: {
  flowId: string;
  /** Reports the selected run so the canvas can highlight executed nodes. */
  onRunSelected?: (run: FlowRunDetail | null) => void;
}) {
  const { t } = useTranslation('flows');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const runsQuery = useQuery({
    queryKey: ['flow-runs', flowId],
    queryFn: () => runsApi<FlowRunSummary[]>(`/${flowId}/runs`),
    refetchInterval: (query) => {
      const data = query.state.data;
      const active = data?.some((r) => r.status === 'pending' || r.status === 'running');
      return active ? 2000 : false;
    },
  });

  const detailQuery = useQuery({
    queryKey: ['flow-run-detail', flowId, selectedRunId],
    enabled: selectedRunId !== null,
    queryFn: async () => {
      const run = await runsApi<FlowRunDetail>(`/${flowId}/runs/${selectedRunId}`);
      onRunSelected?.(run);
      return run;
    },
  });

  const runs = runsQuery.data ?? [];
  const detail = detailQuery.data ?? null;

  return (
    <div className="space-y-3" data-testid="run-history">
      <h3 className="text-xs font-bold uppercase tracking-wider text-dim">{t('runs.title')}</h3>
      {runsQuery.isLoading ? (
        <p className="text-xs text-dim">{t('runs.loading')}</p>
      ) : runsQuery.isError ? (
        <p className="text-xs text-bad">{t('runs.error')}</p>
      ) : runs.length === 0 ? (
        <p className="text-xs text-dim">{t('runs.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {runs.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                onClick={() => {
                  const next = selectedRunId === run.id ? null : run.id;
                  setSelectedRunId(next);
                  if (next === null) onRunSelected?.(null);
                }}
                className={`flex w-full items-center gap-2 rounded-ctl border px-2 py-1.5 text-left text-xs hover:bg-panel-2 ${
                  selectedRunId === run.id ? 'border-brand bg-panel-2' : ''
                }`}
              >
                <StatusIcon status={run.status} />
                <span className="flex-1 truncate">{new Date(run.startedAt).toLocaleString()}</span>
                <span className="font-mono text-[10px] text-dim">{durationLabel(run)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {detail && (
        <div className="space-y-2 border-t border-line pt-2" data-testid="run-detail">
          <div className="flex items-center gap-2 text-xs">
            <StatusIcon status={detail.status} />
            <span className="font-medium">{t(`runStatus.${detail.status}`, { defaultValue: detail.status })}</span>
          </div>
          {detail.error && (
            <pre className="overflow-x-auto rounded-ctl border border-line border-rose-500/30 bg-rose-500/5 p-2 font-mono text-[10px] text-rose-600">
              {detail.error}
            </pre>
          )}
          <div>
            <span className="text-[10px] font-medium uppercase text-dim">{t('runs.input')}</span>
            <pre className="mt-1 max-h-32 overflow-auto rounded-ctl border border-line bg-panel-2 p-2 font-mono text-[10px]">
              {JSON.stringify(detail.input, null, 2)}
            </pre>
          </div>
          <div>
            <span className="text-[10px] font-medium uppercase text-dim">
              {t('runs.steps', { count: Object.keys(detail.steps ?? {}).length })}
            </span>
            <pre className="mt-1 max-h-48 overflow-auto rounded-ctl border border-line bg-panel-2 p-2 font-mono text-[10px]">
              {JSON.stringify(detail.steps, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
