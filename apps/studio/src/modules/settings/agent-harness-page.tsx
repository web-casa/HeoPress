// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Fragment, useCallback, useEffect, useState } from 'react';
import type { ComponentType } from 'react';
import { AlertTriangle, Bot, Boxes, CheckCircle2, ClipboardCheck, Database, Loader2, Play, RefreshCw, RotateCcw, Wrench } from 'lucide-react';
import { getActiveSite, getActiveToken } from '@/lib/api';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { siteFetch } from '@/lib/http';
import { PageHeader } from '@/workspace/ui/page-header';

type Tab = 'runs' | 'tools' | 'approvals' | 'artifacts' | 'memory';

interface AgentRun {
  id: string;
  goalId: string;
  agentName: string;
  status: string;
  risk: string;
  metrics: Record<string, unknown>;
  error: string | null;
  createdAt: string;
}

interface AgentTool {
  name: string;
  description: string;
  requiredCapabilities: string[];
  riskPolicy: { level: string; approvalPolicy?: string };
  enabled: boolean;
  owner: string;
}

interface AgentApproval {
  id: string;
  runId: string;
  subjectType: string;
  status: string;
  approvalPolicy: string;
  requestedByAgent: string;
  createdAt: string;
  /**
   * Why a `failed` approval is quarantined — written by the claim sweeper or
   * by an in-process failure. The operator needs it to decide what to verify
   * before reopening, so it is surfaced rather than left in the database.
   */
  decisionReason?: string | null;
}

interface AgentArtifact {
  id: string;
  runId: string;
  type: string;
  title: string;
  status: string;
  hash: string;
  createdAt: string;
}

interface AgentMemoryContext {
  memories: Array<{ id: string; scope: string; content: string; confidence: number }>;
  recentRuns: AgentRun[];
  approvedArtifacts: AgentArtifact[];
}

async function agentRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await siteFetch(`/api/v1/agent${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'X-HeoPress-Site': site } : {}),
      ...init.headers,
      'X-HeoPress-Client': 'studio',
    },
  });
  if (!res.ok) {
    throw new Error(i18n.t('system:agentHarness.errors.request', { status: res.status }));
  }
  const body = (await res.json()) as { data: T };
  return body.data;
}

/** Tab labels come from `system:agentHarness.tabs.<id>`. */
const tabs: Array<{ id: Tab; icon: ComponentType<{ className?: string }> }> = [
  { id: 'runs', icon: Bot },
  { id: 'tools', icon: Wrench },
  { id: 'approvals', icon: ClipboardCheck },
  { id: 'artifacts', icon: Boxes },
  { id: 'memory', icon: Database },
];

export function AgentHarnessPage() {
  const { t } = useTranslation('system');
  const [tab, setTab] = useState<Tab>('runs');
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [tools, setTools] = useState<AgentTool[]>([]);
  const [approvals, setApprovals] = useState<AgentApproval[]>([]);
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [memory, setMemory] = useState<AgentMemoryContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextRuns, nextTools, nextApprovals, nextArtifacts, nextMemory] = await Promise.all([
        agentRequest<AgentRun[]>('/runs'),
        agentRequest<AgentTool[]>('/tools'),
        agentRequest<AgentApproval[]>('/approvals'),
        agentRequest<AgentArtifact[]>('/artifacts'),
        agentRequest<AgentMemoryContext>('/memory'),
      ]);
      setRuns(nextRuns);
      setTools(nextTools);
      setApprovals(nextApprovals);
      setArtifacts(nextArtifacts);
      setMemory(nextMemory);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18n.t('system:agentHarness.errors.load'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const generateDemo = async () => {
    setBusy(true);
    setError(null);
    try {
      await agentRequest('/generate-app', {
        method: 'POST',
        body: JSON.stringify({
          collections: ['products', 'orders', 'customers'],
          targetApp: 'storefront',
          approvalPolicy: 'before_commit',
        }),
      });
      await load();
      setTab('artifacts');
    } catch (err) {
      setError(err instanceof Error ? err.message : t('agentHarness.errors.generate'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('agentHarness.title')}
        description={t('agentHarness.description')}
        actions={
          <>
            <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            className="inline-flex h-9 w-9 items-center justify-center rounded-ctl border border-line bg-panel"
            aria-label={t('agentHarness.refresh')}
            title={t('agentHarness.refresh')}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => void generateDemo()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-ctl bg-brand px-3 py-2 text-sm font-medium text-brand-fg disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {t('agentHarness.generate')}
          </button>
        </div>
          </>
        }
      />

      <div className="flex flex-wrap gap-2 border-b">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          const active = tab === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => setTab(entry.id)}
              className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${active ? 'border-brand text-fg' : 'border-transparent text-dim' }`}
            >
              <Icon className="h-4 w-4" />
              {t(`agentHarness.tabs.${entry.id}`)}
            </button>
          );
        })}
      </div>

      {error && <div className="rounded-ctl border border-bad/40 bg-bad-soft px-4 py-3 text-sm text-bad">{error}</div>}
      {loading ? (
        <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin text-dim" /></div>
      ) : (
        <>
          {tab === 'runs' && <RunsTable runs={runs} />}
          {tab === 'tools' && <ToolsTable tools={tools} />}
          {tab === 'approvals' && <ApprovalsTable approvals={approvals} onChanged={() => void load()} />}
          {tab === 'artifacts' && <ArtifactsTable artifacts={artifacts} />}
          {tab === 'memory' && <MemoryPanel memory={memory} />}
        </>
      )}
    </div>
  );
}

function RunsTable({ runs }: { runs: AgentRun[] }) {
  const { t } = useTranslation('system');
  const c = (k: string) => t(`agentHarness.columns.${k}`);
  return <DataTable columns={[c('run'), c('agent'), c('status'), c('risk'), c('created')]} rows={runs.map((run) => [run.id, run.agentName, run.status, run.risk, formatDate(run.createdAt)])} />;
}

function ToolsTable({ tools }: { tools: AgentTool[] }) {
  const { t } = useTranslation('system');
  const c = (k: string) => t(`agentHarness.columns.${k}`);
  return <DataTable columns={[c('tool'), c('risk'), c('enabled'), c('capabilities'), c('owner')]} rows={tools.map((tool) => [
    tool.name,
    tool.riskPolicy.level,
    tool.enabled ? t('agentHarness.yes') : t('agentHarness.no'),
    tool.requiredCapabilities.join(', ') || '-',
    tool.owner,
  ])} />;
}

/**
 * Approvals, with the operator recovery path for quarantined ones.
 *
 * A `failed` approval is one whose execution was interrupted or errored after
 * it may already have taken effect, so it is deliberately NOT ordinary work
 * any more: it will not re-run until a human states what they verified. That
 * makes this table the only place the recovery exists, which is why it renders
 * the quarantine reason and a Reopen action instead of just a status string.
 *
 * Reopen asks for a reason and sends it to `POST /agent/approvals/:id/reopen`,
 * which records who authorized the retry alongside the transition.
 */
function ApprovalsTable({ approvals, onChanged }: { approvals: AgentApproval[]; onChanged: () => void }) {
  const { t } = useTranslation(['system', 'common']);
  const [reopening, setReopening] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reopen = async (approval: AgentApproval) => {
    // The endpoint requires a non-empty reason; enforce it here too so the
    // operator gets the message inline rather than a 400.
    if (reason.trim().length === 0) {
      setError(t('agentHarness.reasonRequired'));
      return;
    }
    setBusyId(approval.id);
    setError(null);
    try {
      await agentRequest(`/approvals/${approval.id}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim() }),
      });
      setReopening(null);
      setReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('agentHarness.errors.reopen'));
    } finally {
      setBusyId(null);
    }
  };

  const quarantined = approvals.filter((approval) => approval.status === 'failed');

  return (
    <div className="space-y-3">
      {quarantined.length > 0 && (
        <div className="flex items-start gap-2 rounded-ctl border border-warn/40 bg-warn-soft px-3 py-2 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <span>
            {t('agentHarness.quarantined', { count: quarantined.length })}
          </span>
        </div>
      )}

      {error && <p className="text-sm text-bad">{error}</p>}

      <div className="overflow-hidden rounded-ctl border border-line bg-bg">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="border-b bg-panel-2 text-xs uppercase text-dim">
            <tr>
              {[t('agentHarness.columns.approval'), t('agentHarness.columns.subject'), t('agentHarness.columns.status'), t('agentHarness.columns.policy'), t('agentHarness.columns.agent'), ''].map((column, index) => (
                <th key={column || `actions-${index}`} className="px-3 py-2 font-medium">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {approvals.length === 0 ? (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-dim">{t('agentHarness.noRecords')}</td></tr>
            ) : approvals.map((approval) => (
              <Fragment key={approval.id}>
                <tr className="border-b last:border-0">
                  <td className="truncate px-3 py-2" title={approval.id}>{approval.id}</td>
                  <td className="truncate px-3 py-2" title={approval.subjectType}>{approval.subjectType}</td>
                  <td className="truncate px-3 py-2" title={approval.status}>
                    {approval.status === 'failed' ? (
                      <span className="inline-flex items-center gap-1 text-warn">
                        <AlertTriangle className="h-3 w-3" /> {t('agentHarness.quarantinedStatus')}
                      </span>
                    ) : approval.status}
                  </td>
                  <td className="truncate px-3 py-2" title={approval.approvalPolicy}>{approval.approvalPolicy}</td>
                  <td className="truncate px-3 py-2" title={approval.requestedByAgent}>{approval.requestedByAgent}</td>
                  <td className="px-3 py-2">
                    {approval.status === 'failed' && (
                      <button
                        type="button"
                        onClick={() => { setReopening(approval.id); setReason(''); setError(null); }}
                        className="inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs hover:bg-panel-2"
                      >
                        <RotateCcw className="h-3 w-3" /> {t('agentHarness.reopen')}
                      </button>
                    )}
                  </td>
                </tr>
                {approval.status === 'failed' && approval.decisionReason && (
                  <tr className="border-b last:border-0 bg-panel-2">
                    <td colSpan={6} className="px-3 py-2 text-xs text-dim">{approval.decisionReason}</td>
                  </tr>
                )}
                {reopening === approval.id && (
                  <tr className="border-b last:border-0 bg-panel-2">
                    <td colSpan={6} className="px-3 py-3">
                      <label className="block text-xs font-medium" htmlFor={`reopen-${approval.id}`}>
                        {t('agentHarness.verifyLabel')}
                      </label>
                      <div className="mt-2 flex gap-2">
                        <input
                          id={`reopen-${approval.id}`}
                          value={reason}
                          onChange={(event) => setReason(event.target.value)}
                          maxLength={1000}
                          className="flex-1 rounded-ctl border border-line bg-bg px-2 py-1 text-sm"
                          placeholder={t('agentHarness.verifyPlaceholder')}
                        />
                        <button
                          type="button"
                          disabled={busyId === approval.id}
                          onClick={() => void reopen(approval)}
                          className="inline-flex items-center gap-1 rounded-ctl border border-line px-3 py-1 text-sm hover:bg-panel-2 disabled:opacity-50"
                        >
                          {busyId === approval.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                          {t('agentHarness.confirmReopen')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setReopening(null); setReason(''); setError(null); }}
                          className="rounded-ctl px-3 py-1 text-sm text-dim hover:bg-panel-2"
                        >
                          {t('common:cancel')}
                        </button>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Artifacts with an inline Evaluate action (content-os-ui task 19; Req 19):
 * runs the evaluation gate on demand and shows the verdict under the table —
 * the same gate publish goes through, surfaced before publish.
 */
function ArtifactsTable({ artifacts }: { artifacts: AgentArtifact[] }) {
  const { t } = useTranslation('system');
  const [evaluating, setEvaluating] = useState<string | null>(null);
  const [evaluated, setEvaluated] = useState<{ artifactId: string; result: unknown } | null>(null);
  const [evalError, setEvalError] = useState<string | null>(null);

  const evaluate = async (artifact: AgentArtifact) => {
    setEvaluating(artifact.id);
    setEvalError(null);
    try {
      const result = await agentRequest<unknown>(
        `/artifacts/${artifact.id}/evaluate?runId=${encodeURIComponent(artifact.runId)}`,
        { method: 'POST', body: '{}' },
      );
      setEvaluated({ artifactId: artifact.id, result });
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : t('agentHarness.errors.evaluate'));
    } finally {
      setEvaluating(null);
    }
  };

  return (
    <div className="space-y-2">
      <div className="overflow-hidden rounded-ctl border border-line bg-bg">
        <table className="w-full table-fixed text-left text-sm">
          <thead className="border-b bg-panel-2 text-xs uppercase text-dim">
            <tr>
              {[t('agentHarness.columns.artifact'), t('agentHarness.columns.type'), t('agentHarness.columns.title'), t('agentHarness.columns.status'), t('agentHarness.columns.hash'), ''].map((column, i) => (
                <th key={i} className="px-3 py-2 font-medium">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {artifacts.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-dim">
                  {t('agentHarness.noRecords')}
                </td>
              </tr>
            ) : (
              artifacts.map((artifact) => (
                <tr key={artifact.id} className="border-b last:border-0">
                  <td className="truncate px-3 py-2" title={artifact.id}>{artifact.id}</td>
                  <td className="truncate px-3 py-2">{artifact.type}</td>
                  <td className="truncate px-3 py-2" title={artifact.title}>{artifact.title}</td>
                  <td className="truncate px-3 py-2">{artifact.status}</td>
                  <td className="truncate px-3 py-2" title={artifact.hash}>{artifact.hash}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => void evaluate(artifact)}
                      disabled={evaluating !== null}
                      className="rounded-ctl border border-line px-2 py-1 text-xs hover:bg-panel-2 disabled:opacity-50"
                    >
                      {evaluating === artifact.id ? t('agentHarness.evaluating') : t('agentHarness.evaluate')}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {evalError && <p className="text-xs text-bad">{evalError}</p>}
      {evaluated && (
        <div className="rounded-ctl border border-line bg-panel-2 p-3 text-xs">
          <p className="font-medium">
            {t('agentHarness.evaluationFor')} <code className="rounded bg-panel-2 px-1">{evaluated.artifactId}</code>
          </p>
          <pre className="mt-1 overflow-x-auto font-mono">{JSON.stringify(evaluated.result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

function MemoryPanel({ memory }: { memory: AgentMemoryContext | null }) {
  const { t } = useTranslation('system');
  if (!memory) return null;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <Metric label={t('agentHarness.memories')} value={memory.memories.length} />
      <Metric label={t('agentHarness.recentRuns')} value={memory.recentRuns.length} />
      <Metric label={t('agentHarness.approvedArtifacts')} value={memory.approvedArtifacts.length} />
      <div className="md:col-span-3">
        <DataTable columns={[t('agentHarness.columns.scope'), t('agentHarness.columns.confidence'), t('agentHarness.columns.content')]} rows={memory.memories.map((entry) => [entry.scope, String(entry.confidence), entry.content])} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-ctl border border-line bg-bg p-4">
      <div className="flex items-center gap-2 text-sm text-dim">
        <CheckCircle2 className="h-4 w-4" />
        {label}
      </div>
      <div className="mt-2 text-[22px] font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: string[][] }) {
  const { t } = useTranslation('system');
  return (
    <div className="overflow-hidden rounded-ctl border border-line bg-bg">
      <table className="w-full table-fixed text-left text-sm">
        <thead className="border-b bg-panel-2 text-xs uppercase text-dim">
          <tr>{columns.map((column) => <th key={column} className="px-3 py-2 font-medium">{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-dim">{t('agentHarness.noRecords')}</td></tr>
          ) : rows.map((row, index) => (
            <tr key={`${row[0]}-${index}`} className="border-b last:border-0">
              {row.map((cell, cellIndex) => (
                <td key={`${cell}-${cellIndex}`} className="truncate px-3 py-2" title={cell}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
