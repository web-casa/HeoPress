import { useQuery } from '@tanstack/react-query';
import { getApiClient } from '@/lib/api';
import { activeSession, activeSiteId } from '@/lib/session/current';

/**
 * The Carbon workspace's server reads (HeoPress P07a). Query keys start with the site id (design §6); the cross-site
 * summary's keys start with the person and login instead, and are never served from cache (`staleTime: 0`, refetched on
 * mount and focus) — the server compiles permissions per request and the client must not undo that.
 */

type Availability = 'available' | 'mfa_required' | 'unavailable';
type PrimaryDomainState = 'set' | 'unset' | 'none';
type HealthStatus = 'ok' | 'warn' | 'bad' | 'unknown';

interface HealthReason {
  code: string;
  count?: number;
  host?: string;
  detail?: string | null;
}

export interface SiteIdentity {
  id: string;
  name: string;
  primaryDomain: string | null;
  primaryDomainState: PrimaryDomainState;
  role: string | null;
  availability: Availability;
}

export interface SiteFigures {
  computedAt: string;
  pendingReviews: { count: number; oldestWaitSeconds: number | null } | 'no_permission';
  auditIssues: { error: number; warning: number; notice: number };
  publishedArticles: { count: number; partial: boolean } | 'no_permission';
  aiCrawler7d: number;
  aiReferral30d: number;
  referralsByPlatform: Array<{ operator: string; hits: number }>;
  health: { status: HealthStatus; reasons: HealthReason[] };
  lastAuditAt: string | null;
}

export type SiteSummary = SiteIdentity | (SiteIdentity & SiteFigures);

export const isAvailable = (s: SiteSummary): s is SiteIdentity & SiteFigures => s.availability === 'available' && 'computedAt' in s;

export interface AiDay {
  day: string;
  training: number;
  search: number;
  userFetch: number;
  referral: number;
}

export interface NetworkAiTraffic {
  days: number;
  from: string;
  to: string;
  byDay: AiDay[];
  totals: { crawler: number; referral: number };
  previousTotals: { crawler: number; referral: number } | null;
  sites: Array<SiteIdentity & { totals?: { crawler: number; referral: number }; previousTotals?: { crawler: number; referral: number } | null }>;
  excluded: { mfaRequired: number; unavailable: number };
}

interface FeedItem {
  itemId: string;
  collection: string;
  title: string;
}

export interface OverviewFeed {
  reviews?: { count: number; oldest: (FeedItem & { waitSeconds: number }) | null };
  activity: Array<FeedItem & { kind: 'published' | 'submitted' | 'rejected'; at: string }>;
  week: Array<FeedItem & { kind: 'published' | 'scheduled' | 'pending'; at: string }>;
  setup: { domainVerified: boolean; firstArticlePublished: boolean; crawlerPolicySet: boolean; membersInvited: boolean };
}

export interface Check {
  id: 'title' | 'description' | 'indexing' | 'structured_data' | 'links' | 'images';
  status: 'pass' | 'warn' | 'fail' | 'not_checked' | 'no_permission';
  reason?: string;
  value?: number;
  items?: Array<{ url: string; status: 'ok' | 'broken' | 'redirected' | 'not_checked' | 'no_alt' }>;
}

export interface StreamEvent {
  id: string;
  at: string;
  source: 'content' | 'run' | 'security' | 'access' | 'api_key' | 'system';
  level: 'info' | 'warn' | 'error';
  event: string;
  message: string;
  subject?: { type: string; id: string; collection?: string };
  actor?: string | null;
  data: Record<string, unknown>;
}

export interface EventStats {
  levels: Record<'info' | 'warn' | 'error', number>;
  minutes: Array<{ at: string; total: number; errors: number }>;
}

export interface ServiceStatus {
  site: Record<'reachability' | 'audit' | 'linkScan', { status: string; checkedAt: string | null }>;
  instance?: { checkedAt: string; services: Record<string, string>; failedJobs24h: number | null };
}

async function get<T>(path: string): Promise<T> {
  return (await getApiClient().rawRequest<T>(path)).data;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  return (await getApiClient().rawRequest<T>(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).data;
}

/** Key prefix of the current site. */
export const siteKey = (...parts: unknown[]) => [activeSiteId(), ...parts];

/** Key prefix of the person and login (cross-site reads). */
function personKey(...parts: unknown[]) {
  const s = activeSession();
  return ['network', s?.userId ?? '', s?.sid ?? '', ...parts];
}

const FRESH = { staleTime: 0, refetchOnMount: 'always' as const, refetchOnWindowFocus: true };

export function useNetworkSummary(enabled = true) {
  return useQuery({ queryKey: personKey('summary'), queryFn: () => get<SiteSummary[]>('/api/v1/studio/network-summary'), enabled, ...FRESH });
}

export function useNetworkAiTraffic(days: number, enabled = true) {
  return useQuery({ queryKey: personKey('ai-traffic', days), queryFn: () => get<NetworkAiTraffic>(`/api/v1/studio/network-summary/ai-traffic?days=${days}`), enabled, ...FRESH });
}

export function useOverviewFeed(window: { from: string; to: string }) {
  return useQuery({
    queryKey: siteKey('overview-feed', window.from, window.to),
    queryFn: () => get<OverviewFeed>(`/api/v1/studio/overview/feed?from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`),
  });
}

export function useItemChecks(collection: string | null, id: string | null) {
  return useQuery({
    queryKey: siteKey('checks', collection, id),
    queryFn: () => get<{ itemId: string; checks: Check[] }>(`/api/v1/site/items/${encodeURIComponent(collection!)}/${encodeURIComponent(id!)}/checks`),
    enabled: !!collection && !!id,
  });
}

/** An event consumer as Logs & monitoring › Event consumers shows it (HeoPress P11 task 1.1). */
export interface ConsumerOverview {
  name: string;
  siteId: string | null;
  status: string;
  pausedReason: string | null;
  lastRunAt: string | null;
  pending: number;
  pendingCapped: boolean;
  oldestPendingAt: string | null;
  backlogSeconds: number;
  overThreshold: boolean;
  failures: { retrying: number; dead: number; unknown: number };
}

export interface DeadLetter {
  eventId: string;
  state: string;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
  event: { siteId: string; resource: string; collection: string; itemId: string; operation: string; occurredAt: string } | null;
}

/** The unified state reconciliation's report (HeoPress P11 task 1.2). */
export interface ReconciliationReport {
  trigger: 'scheduled' | 'manual';
  startedAt: string;
  recordedAt?: string;
  results: Array<{ name: string; consumer: string; status: 'ok' | 'repaired' | 'drift' | 'failed' | 'not_configured'; checked: number; repaired: number; drift: number; detail?: string }>;
}

export const consumersApi = {
  list: () => get<ConsumerOverview[]>('/api/v1/studio/consumers'),
  deadLetters: (name: string) => get<DeadLetter[]>(`/api/v1/studio/consumers/${encodeURIComponent(name)}/dead-letters`),
  replay: (name: string, body: { from: string } | { eventId: string }) =>
    send<{ ok: true; events: number; replayFrom: { eventId: string | null } }>(`/api/v1/studio/consumers/${encodeURIComponent(name)}/replay`, 'POST', body),
  report: () => get<ReconciliationReport | null>('/api/v1/studio/consumers/reconciliation'),
  reconcile: () => send<ReconciliationReport>('/api/v1/studio/consumers/reconciliation/run', 'POST'),
};

export const studioApi = {
  events: (query: string) => getApiClient().rawRequest<StreamEvent[]>(`/api/v1/studio/events${query}`) as Promise<{ data: StreamEvent[]; meta?: { nextCursor: string | null; earliest: string | null; earliestBySource?: Record<string, string> } }>,
  eventStats: (query: string) => get<EventStats>(`/api/v1/studio/events/stats${query}`),
  serviceStatus: () => get<ServiceStatus>('/api/v1/studio/service-status'),
  ignoreIssue: (issueId: string, body: { reason?: string | null; days?: number }) => send<{ fingerprint: string; until: string }>(`/api/v1/site/audit/issues/${encodeURIComponent(issueId)}/ignore`, 'POST', body),
  restoreIssue: (issueId: string) => send<{ fingerprint: string }>(`/api/v1/site/audit/issues/${encodeURIComponent(issueId)}/ignore`, 'DELETE'),
  setStudioKind: (collection: string, kind: 'article' | null) => send<unknown>(`/api/v1/collections/${encodeURIComponent(collection)}/studio-kind`, 'PUT', { kind }),
  approve: (collection: string, id: string, body: { reason?: string; expectedVersion?: number }) => send<unknown>(`/api/v1/editorial/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/approve`, 'POST', body),
  reject: (collection: string, id: string, body: { reason: string; expectedVersion?: number }) => send<unknown>(`/api/v1/editorial/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/reject`, 'POST', body),
};
