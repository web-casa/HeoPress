// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';
import { missionControlApi, type ConstitutionVersion } from './api';

/**
 * Constitution editor (content-os task 18.1; Req 16.4):
 * NL → compile → (edit JSON) → draft → dry-run on real content → activate.
 * Versions list with evaluator-level diff between consecutive versions.
 */
export function ConstitutionEditor() {
  const { t } = useTranslation('agents');
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [evaluatorsJson, setEvaluatorsJson] = useState('');
  const [sampleJson, setSampleJson] = useState('{\n  "title": "Example item"\n}');
  const [dryRunOutput, setDryRunOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const constitutionQuery = useQuery({
    queryKey: ['mc-constitution'],
    queryFn: missionControlApi.constitution,
  });

  const compileMutation = useMutation({
    mutationFn: () => missionControlApi.compileConstitution(text),
    onSuccess: (data) => {
      setEvaluatorsJson(JSON.stringify(data.evaluators, null, 2));
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const draftMutation = useMutation({
    mutationFn: () => missionControlApi.createConstitutionDraft(JSON.parse(evaluatorsJson)),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mc-constitution'] });
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const dryRunMutation = useMutation({
    mutationFn: (id: string) =>
      missionControlApi.dryRunConstitution(id, [JSON.parse(sampleJson) as Record<string, unknown>]),
    onSuccess: (data) => setDryRunOutput(JSON.stringify(data, null, 2)),
    onError: (err: Error) => setError(err.message),
  });

  const activateMutation = useMutation({
    mutationFn: (id: string) => missionControlApi.activateConstitution(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mc-constitution'] }),
    onError: (err: Error) => setError(err.message),
  });

  const versions = constitutionQuery.data?.versions ?? [];
  const active = constitutionQuery.data?.active ?? null;

  return (
    <div className="space-y-6">
      {error && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
          {error}
        </p>
      )}

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('constitution.step1')}</h3>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder={t('constitution.textPlaceholder')}
          className="w-full rounded-md border bg-background p-2 text-sm"
        />
        <button
          type="button"
          onClick={() => compileMutation.mutate()}
          disabled={!text.trim() || compileMutation.isPending}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {compileMutation.isPending ? t('constitution.compiling') : t('constitution.compile')}
        </button>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('constitution.step2')}</h3>
        <textarea
          value={evaluatorsJson}
          onChange={(e) => setEvaluatorsJson(e.target.value)}
          rows={8}
          placeholder={t('constitution.evaluatorsPlaceholder')}
          className="w-full rounded-md border bg-background p-2 font-mono text-xs"
        />
        <button
          type="button"
          onClick={() => draftMutation.mutate()}
          disabled={!evaluatorsJson.trim() || draftMutation.isPending}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-50"
        >
          {draftMutation.isPending ? t('constitution.saving') : t('constitution.saveDraft')}
        </button>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('constitution.step3')}</h3>
        <textarea
          value={sampleJson}
          onChange={(e) => setSampleJson(e.target.value)}
          rows={4}
          className="w-full rounded-md border bg-background p-2 font-mono text-xs"
        />
        {dryRunOutput && (
          <pre className="max-h-56 overflow-auto rounded-md bg-muted/40 p-2 text-xs">{dryRunOutput}</pre>
        )}
        <VersionList
          versions={versions}
          activeId={active?.id ?? null}
          onDryRun={(id) => dryRunMutation.mutate(id)}
          onActivate={(id) => activateMutation.mutate(id)}
          busy={dryRunMutation.isPending || activateMutation.isPending}
        />
      </section>
    </div>
  );
}

function evaluatorIds(version: ConstitutionVersion): Set<string> {
  return new Set(version.evaluators.map((e) => String(e['id'])));
}

function VersionList({
  versions,
  activeId,
  onDryRun,
  onActivate,
  busy,
}: {
  versions: ConstitutionVersion[];
  activeId: string | null;
  onDryRun: (id: string) => void;
  onActivate: (id: string) => void;
  busy: boolean;
}) {
  const { t } = useTranslation('agents');
  if (versions.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('constitution.empty')}</p>;
  }
  return (
    <ul className="space-y-2">
      {versions.map((version, i) => {
        // Diff vs the previous version (versions are newest-first).
        const prev = versions[i + 1];
        const current = evaluatorIds(version);
        const before = prev ? evaluatorIds(prev) : new Set<string>();
        const added = [...current].filter((id) => !before.has(id));
        const removed = [...before].filter((id) => !current.has(id));
        return (
          <li key={version.id} className="rounded-lg border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>{t('constitution.version', { version: version.version })}</strong>
                <span
                  className={cn(
                    'ml-2 rounded-full px-2 py-0.5 text-xs',
                    version.id === activeId
                      ? 'bg-emerald-100 text-emerald-800'
                      : version.status === 'draft'
                        ? 'bg-sky-100 text-sky-800'
                        : 'bg-muted text-muted-foreground',
                  )}
                >
                  {version.id === activeId ? t('constitution.status.active') : t(`constitution.status.${version.status}`, { defaultValue: version.status })}
                </span>
                <code className="ml-2 text-[10px] text-muted-foreground">{version.hash.slice(0, 18)}…</code>
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => onDryRun(version.id)}
                  disabled={busy}
                  className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
                >
                  {t('constitution.dryRun')}
                </button>
                {version.status === 'draft' && (
                  <button
                    type="button"
                    onClick={() => onActivate(version.id)}
                    disabled={busy}
                    className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
                  >
                    {t('constitution.activate')}
                  </button>
                )}
              </span>
            </div>
            {(added.length > 0 || removed.length > 0) && prev && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('constitution.versus', { version: prev.version })}{' '}
                {added.length > 0 && <span className="text-emerald-700">+{added.join(', +')}</span>}{' '}
                {removed.length > 0 && <span className="text-destructive">−{removed.join(', −')}</span>}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
