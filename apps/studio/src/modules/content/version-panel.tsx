// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Change } from '@heopress/contracts';
import { useState } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { getActiveSite, getActiveToken } from '@/lib/api';
import { getApiBaseUrl } from '@/lib/api-base';
import { RevisionsDiff } from './revisions-diff';
import { siteFetch } from '@/lib/http';

/**
 * Content versions panel (content-versioning spec). Lists named draft branches
 * of an item, lets you create one, compare it field-by-field with main (reusing
 * RevisionsDiff), and promote it to main. Self-contained so it slots into the
 * item editor as a tab without touching the existing flow.
 *
 * HeoPress P10 (content branches): the comparison also shows what a merge would do — the conflicts where main and the
 * branch changed the same field or block, each with base / main / branch, for a person to choose a side — merges into
 * a pending revision (both versions checked at once), opens the branch on the public site for this browser only, and
 * promotes a merged branch onto the main version it was merged against.
 */

interface VersionRow {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  mainChanged: boolean;
  /** P10: `open` | `merged` (a pending revision). */
  state?: string;
  revision?: number;
  baseVersion?: number | null;
}

interface MergeConflict {
  id: string;
  field: string;
  kind: 'field' | 'block' | 'order';
  blockId: string | null;
  base: unknown;
  main: unknown;
  branch: unknown;
}

interface BranchDiff {
  state: string;
  revision: number;
  baseVersion: number | null;
  mainVersion: number;
  branch: Array<{ field: string }>;
  main: Array<{ field: string }>;
  merge: { clean: boolean; conflicts: MergeConflict[]; fromBranch: string[]; fromMain: string[] };
}

/** A refused request, with its code and detail. */
class VersionRequestError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly meta: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'VersionRequestError';
  }
}

interface CompareResult {
  main: Record<string, unknown>;
  version: Record<string, unknown>;
  changes: Change[];
}

async function versionFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getActiveToken();
  const site = getActiveSite();
  const res = await siteFetch(`${getApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(site ? { 'X-HeoPress-Site': site } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string; code?: string; meta?: Record<string, unknown> }> };
  if (!res.ok) {
    const first = body.errors?.[0];
    throw new VersionRequestError(first?.message ?? i18n.t('items:versions.requestFailed', { status: res.status }), first?.code ?? null, first?.meta ?? null);
  }
  return body.data as T;
}

export function VersionPanel({ collection, itemId }: { collection: string; itemId: string }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation('items');
  const base = `/api/v1/items/${collection}/${itemId}/versions`;
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [comparingKey, setComparingKey] = useState<string | null>(null);

  const versionsQuery = useQuery({
    queryKey: ['versions', collection, itemId],
    queryFn: () => versionFetch<VersionRow[]>(base),
  });

  const compareQuery = useQuery({
    queryKey: ['version-compare', collection, itemId, comparingKey],
    queryFn: () => versionFetch<CompareResult>(`${base}/${comparingKey}/compare`),
    enabled: !!comparingKey,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['versions', collection, itemId] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      versionFetch<VersionRow>(base, {
        method: 'POST',
        body: JSON.stringify({ key: slugify(name), name: name.trim() }),
      }),
    onSuccess: () => {
      setName('');
      setCreating(false);
      invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => versionFetch<null>(`${base}/${key}`, { method: 'DELETE' }),
    onSuccess: () => {
      setComparingKey(null);
      invalidate();
    },
  });

  const promoteMutation = useMutation({
    // Onto the main version it was merged against (a merged branch), or main as it is now: never over a newer main.
    mutationFn: async (v: VersionRow) => {
      const expectedVersion = v.state === 'merged' && v.baseVersion ? v.baseVersion : (await versionFetch<BranchDiff>(`${base}/${v.key}/diff`)).mainVersion;
      return versionFetch<unknown>(`${base}/${v.key}/promote`, { method: 'POST', body: JSON.stringify({ expectedVersion }) });
    },
    onSuccess: () => {
      setComparingKey(null);
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ['item', collection, itemId] });
      void queryClient.invalidateQueries({ queryKey: ['revisions', collection, itemId] });
    },
  });

  const versions = versionsQuery.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t('versions.title')}</h3>
        <button type="button" onClick={() => setCreating((v) => !v)} className="rounded border border-line px-2 py-1 text-xs hover:bg-panel-2">
          {t('versions.new')}
        </button>
      </div>

      {creating && (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) createMutation.mutate();
          }}
        >
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t('versions.name')} className="flex-1 rounded border border-line px-2 py-1 text-sm" />
          <button type="submit" disabled={!name.trim() || createMutation.isPending} className="rounded bg-brand px-2 py-1 text-xs text-brand-fg disabled:opacity-50">
            {t('versions.create')}
          </button>
          {createMutation.isError && <span className="text-xs text-bad">{(createMutation.error as Error).message}</span>}
        </form>
      )}

      {versionsQuery.isLoading ? (
        <p className="text-sm text-dim">{t('versions.loading')}</p>
      ) : versions.length === 0 ? (
        <p className="text-sm text-dim">{t('versions.empty')}</p>
      ) : (
        <ul className="space-y-1">
          {versions.map((v) => (
            <li key={v.id} className="rounded border border-line">
              <div className="flex items-center justify-between px-2 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{v.name}</span>
                  <code className="rounded bg-panel-2 px-1 text-[10px]">{v.key}</code>
                  {v.state === 'merged' && (
                    <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] text-brand" title={t('versions.mergedHint')}>
                      {t('versions.merged')}
                    </span>
                  )}
                  {v.mainChanged && v.state !== 'merged' && (
                    <span className="rounded bg-warn-soft px-1.5 py-0.5 text-[10px] text-warn" title={t('versions.mainChangedHint')}>
                      {t('versions.mainChanged')}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setComparingKey(comparingKey === v.key ? null : v.key)} className="rounded px-1.5 py-0.5 text-xs hover:bg-panel-2">
                    {comparingKey === v.key ? t('versions.hide') : t('versions.compare')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(t(v.mainChanged ? 'versions.promoteConfirmChanged' : 'versions.promoteConfirm', { name: v.name }))) {
                        promoteMutation.mutate(v);
                      }
                    }}
                    className="rounded px-1.5 py-0.5 text-xs text-brand hover:bg-panel-2"
                  >
                    {t('versions.promote')}
                  </button>
                  <button type="button" onClick={() => deleteMutation.mutate(v.key)} className="rounded px-1.5 py-0.5 text-xs text-dim hover:text-bad" aria-label={t('versions.delete')}>
                    ✕
                  </button>
                </div>
              </div>
              {comparingKey === v.key && (
                <div className="border-t border-line bg-panel-2 p-2">
                  {compareQuery.isLoading ? (
                    <p className="text-xs text-dim">{t('versions.loadingDiff')}</p>
                  ) : compareQuery.data ? (
                    <RevisionsDiff before={compareQuery.data.main} after={compareQuery.data.version} />
                  ) : null}
                  <MergeSection base={`${base}/${v.key}`} onMerged={invalidate} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {promoteMutation.isError && <p className="text-xs text-bad">{(promoteMutation.error as Error).message}</p>}
    </div>
  );
}

const show = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/**
 * What merging the branch would do now (P10 tasks 4.3, 4.4): automatic when main and the branch changed different
 * fields or blocks; otherwise each conflict shows base, main and branch and waits for a person's choice. The merge
 * names the versions compared, so a change made meanwhile fails it (compare again) instead of being overwritten.
 */
function MergeSection({ base, onMerged }: { base: string; onMerged: () => void }) {
  const { t } = useTranslation('items');
  const queryClient = useQueryClient();
  const [choices, setChoices] = useState<Record<string, 'main' | 'branch'>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const diffQuery = useQuery({ queryKey: ['version-diff', base], queryFn: () => versionFetch<BranchDiff>(`${base}/diff`) });
  const diff = diffQuery.data;
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['version-diff', base] });

  const mergeMutation = useMutation({
    mutationFn: (d: BranchDiff) =>
      versionFetch<unknown>(`${base}/merge`, {
        method: 'POST',
        body: JSON.stringify({ expectedMainVersion: d.mainVersion, expectedRevision: d.revision, ...(d.merge.conflicts.length ? { resolutions: choices } : {}) }),
      }),
    onSuccess: () => {
      setChoices({});
      setNotice(t('versions.mergeDone'));
      refresh();
      onMerged();
    },
    onError: (err) => {
      if (err instanceof VersionRequestError && (err.code === 'MERGE_STALE' || err.code === 'MERGE_CONFLICT')) {
        setChoices({});
        setNotice(t(err.code === 'MERGE_STALE' ? 'versions.mergeStale' : 'versions.mergeConflictNew'));
        refresh();
      } else setNotice((err as Error).message);
    },
  });

  const previewMutation = useMutation({
    mutationFn: () => versionFetch<{ url: string }>(`${base}/preview`, { method: 'POST', body: '{}' }),
    onSuccess: (link) => {
      window.open(link.url, '_blank', 'noopener,noreferrer');
    },
    onError: (err) => setNotice((err as Error).message),
  });

  if (diffQuery.isLoading) return <p className="mt-2 text-xs text-dim">{t('versions.loadingDiff')}</p>;
  if (!diff) return diffQuery.isError ? <p className="mt-2 text-xs text-bad">{(diffQuery.error as Error).message}</p> : null;
  const conflicts = diff.merge.conflicts;
  const ready = conflicts.every((c) => choices[c.id]);

  return (
    <section className="mt-3 space-y-2 border-t border-line pt-3" aria-label={t('versions.mergeTitle')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-dim">{t('versions.mergeTitle')}</h4>
        <button type="button" onClick={() => previewMutation.mutate()} disabled={previewMutation.isPending} className="rounded border border-line px-2 py-0.5 text-xs hover:bg-panel">
          {t('versions.previewOnSite')}
        </button>
      </div>
      <p className="text-xs text-dim">
        {t('versions.mergeVersions', { main: diff.mainVersion, revision: diff.revision })}
        {diff.state === 'merged' ? ` · ${t('versions.mergedHint')}` : ''}
      </p>
      {conflicts.length === 0 ? (
        <p className="text-xs" data-testid="merge-clean">
          {t('versions.mergeClean', { branch: diff.merge.fromBranch.length, main: diff.merge.fromMain.length })}
        </p>
      ) : (
        <div className="space-y-2" data-testid="merge-conflicts">
          <p className="text-xs text-warn">{t('versions.conflictCount', { count: conflicts.length })}</p>
          {conflicts.map((c) => (
            <fieldset key={c.id} className="rounded border border-line bg-panel p-2">
              <legend className="px-1 text-xs font-medium">
                {c.kind === 'block' ? t('versions.conflictBlock', { field: c.field, block: c.blockId }) : c.kind === 'order' ? t('versions.conflictOrder', { field: c.field }) : t('versions.conflictField', { field: c.field })}
              </legend>
              <div className="grid gap-2 md:grid-cols-3">
                {(['base', 'main', 'branch'] as const).map((side) => (
                  <div key={side} className="min-w-0">
                    <div className="text-[10px] uppercase text-dim">{t(`versions.side.${side}`)}</div>
                    <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-panel-2 p-1.5 font-mono text-[11px]">{show(c[side]) || t('versions.absent')}</pre>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex gap-3 text-xs">
                {(['main', 'branch'] as const).map((side) => (
                  <label key={side} className="flex items-center gap-1">
                    <input type="radio" name={`conflict-${c.id}`} checked={choices[c.id] === side} onChange={() => setChoices((prev) => ({ ...prev, [c.id]: side }))} />
                    {t(side === 'main' ? 'versions.keepMain' : 'versions.keepBranch')}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            mergeMutation.mutate(diff);
          }}
          disabled={!ready || mergeMutation.isPending}
          className="rounded bg-brand px-2 py-1 text-xs text-brand-fg disabled:opacity-50"
        >
          {t('versions.merge')}
        </button>
        <span className="text-[11px] text-dim">{t('versions.mergeNote')}</span>
      </div>
      {notice && (
        <p role="status" className="text-xs">
          {notice}
        </p>
      )}
    </section>
  );
}

function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'version';
}
