import { getApiClient } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import { siteFetch } from '@/lib/http';

/**
 * The AI pipeline's Studio reads and writes (HeoPress P09 tasks 2.3, 4.1, 5.1): the review queue, the prompt workbench
 * and agent-drafted flows.
 */

export interface GateCheck {
  rule: string;
  status: 'passed' | 'blocked' | 'needs_review' | 'warning' | 'off';
  score: number;
  mandatory: boolean;
  evidence: Record<string, unknown>;
  suggestions: string[];
}

export interface QueueEntry {
  id: string;
  itemId: string;
  collection: string;
  title: string;
  status: 'review' | 'veto_window' | 'queued';
  reason: string;
  notBefore: string | null;
  createdAt: string;
  detail: { failures?: Array<{ reason: string }> };
  gate: {
    state: string;
    publishable: boolean;
    staleReasons: string[];
    result: { id: string; itemVersion: number; status: string; score: number; checks: GateCheck[] } | null;
  };
}

export type BatchAction = 'approve' | 'reject' | 'dismiss' | 'veto';
export interface BatchResult {
  id: string;
  ok: boolean;
  status?: string;
  reason?: string;
  error?: { code: string; message: string };
}

export interface SourceDocument {
  id: string;
  title: string;
  url: string;
  createdAt: string;
}

interface ParagraphDiagnostic {
  index: number;
  text: string;
  cited: boolean;
  source: { paragraph: number; text: string; similarity: number } | null;
}

export type TrialEvent =
  | { type: 'stage'; stage: 'source' | 'model' | 'diagnostics' }
  | { type: 'output'; index: number; html: string; title?: string }
  | { type: 'diagnostics'; status: string; score: number; checks: GateCheck[]; notRun: string[]; paragraphs: ParagraphDiagnostic[] }
  | { type: 'usage'; callId: string; provider: string; model: string; inputTokens: number | null; outputTokens: number | null; costMicros: number }
  | { type: 'done'; trialId: string }
  | { type: 'error'; code: string; message: string };

export interface TrialInput {
  sourceDocumentId: string;
  mode: 'translate' | 'rewrite' | 'write';
  targetLocale: string;
  prompt: string;
  editorialPolicy: Record<string, unknown>;
}

export interface FlowDraft {
  id: string;
  name: string;
  description: string | null;
  triggerType: string;
  graph: { entry?: string; nodes: Array<{ id: string; key: string; next?: string | null }> };
  draftedBy: string | null;
  draftedVia: 'agent' | 'studio';
  status: 'pending' | 'approved' | 'rejected';
  approvalMode: 'solo' | 'team';
  decidedBy: string | null;
  decisionReason: string | null;
  flowId: string | null;
  createdAt: string;
}

export interface PipelineState {
  paused: boolean;
  reasons: string[];
}

export interface LlmSettings {
  currency: string;
  monthlyBudgetMicros: number | null;
  budgetTimezone: string;
  dailyBudgetMicros: number | null;
  dailyProcessingLimit: number | null;
}

export interface AutoPublishSettings {
  agentRole: string;
  vetoWindowMinutes: number;
  dailyLimit: number | null;
  minIntervalMinutes: number;
  sourceMaxAgeDays: number;
  freshnessExemptCollections: string[];
  requiredLocales: string[];
  version: number;
}

async function get<T>(path: string): Promise<T> {
  return (await getApiClient().rawRequest<T>(path)).data;
}
async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return (await getApiClient().rawRequest<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).data;
}

export const aiApi = {
  reviewQueue: () => get<QueueEntry[]>('/api/v1/auto-publish/review-queue'),
  decide: (action: BatchAction, candidateIds: string[], reason: string) => send<BatchResult[]>('/api/v1/auto-publish/review/batch', 'POST', { action, candidateIds, reason }),
  sourceDocuments: () => get<SourceDocument[]>('/api/v1/ingest/documents?limit=50'),
  flowDrafts: () => get<FlowDraft[]>('/api/v1/flow-drafts'),
  approvalMode: () => get<{ mode: 'solo' | 'team' }>('/api/v1/flow-drafts/approval-mode'),
  approveDraft: (id: string, body: { secondFactor?: string; reason?: string }) => send<FlowDraft>(`/api/v1/flow-drafts/${encodeURIComponent(id)}/approve`, 'POST', body),
  rejectDraft: (id: string, reason: string) => send<FlowDraft>(`/api/v1/flow-drafts/${encodeURIComponent(id)}/reject`, 'POST', { reason }),
  pipeline: () => get<PipelineState>('/api/v1/llm/pipeline'),
  pause: (note?: string) => send<PipelineState>('/api/v1/llm/pipeline/pause', 'POST', { reason: 'manual', ...(note ? { note } : {}) }),
  resume: (reason: string) => send<PipelineState>('/api/v1/llm/pipeline/resume', 'POST', { reason }),
  llmSettings: () => get<LlmSettings>('/api/v1/llm/settings'),
  saveLlmSettings: (s: LlmSettings) => send<LlmSettings>('/api/v1/llm/settings', 'PUT', s),
  autoPublishSettings: () => get<AutoPublishSettings>('/api/v1/auto-publish/settings'),
  saveAutoPublishSettings: (s: Partial<Omit<AutoPublishSettings, 'version'>>) => send<AutoPublishSettings>('/api/v1/auto-publish/settings', 'PUT', s),
};

/** Parse a server-sent event stream's text into its `data` payloads (events end with a blank line). */
export function parseSse(buffer: string): { events: TrialEvent[]; rest: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const rest = parts.pop() ?? '';
  const events: TrialEvent[] = [];
  for (const part of parts) {
    const data = part
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      events.push(JSON.parse(data) as TrialEvent);
    } catch {
      // A malformed event is skipped.
    }
  }
  return { events, rest };
}

/** Run a trial and hand each event to `onEvent` as it arrives. */
export async function runTrial(input: TrialInput, onEvent: (e: TrialEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await siteFetch(`${getApiBaseUrl()}/api/v1/prompt-workbench/trial`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as { errors?: Array<{ code: string; message: string }> } | null;
    const e = body?.errors?.[0];
    onEvent({ type: 'error', code: e?.code ?? `HTTP_${res.status}`, message: e?.message ?? res.statusText });
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const parsed = parseSse(done ? `${buffer}\n\n` : buffer);
    buffer = parsed.rest;
    for (const e of parsed.events) onEvent(e);
    if (done) break;
  }
}
