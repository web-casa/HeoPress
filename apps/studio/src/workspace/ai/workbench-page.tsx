import { useQuery } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { sanitizeHtml } from '@/lib/sanitize-html';
import { fromMicros } from '@/modules/settings/models-page';
import { siteKey } from '../api';
import { EmptyState } from '../ui/empty-state';
import { PageHeader } from '../ui/page-header';
import { aiApi, runTrial, type TrialEvent, type TrialInput } from './api';

/**
 * The prompt workbench (HeoPress P09 task 4.1; spec ai/prompt-workbench): pick a sample source document, edit a prompt
 * and an editorial policy without saving them, run a trial. The output arrives paragraph by paragraph, then the gate's
 * diagnostics — each uncited paragraph is marked with the source passage it most likely comes from. A trial writes no
 * draft or content item; its model call is billed to the site (`workbench_trial`).
 */

type Diagnostics = Extract<TrialEvent, { type: 'diagnostics' }>;
type Usage = Extract<TrialEvent, { type: 'usage' }>;

/** The editorial policy text as JSON (an object), or the parse error. */
export function parsePolicy(text: string): { ok: true; value: Record<string, unknown> } | { ok: false } {
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? { ok: true, value: v as Record<string, unknown> } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export function WorkbenchPage() {
  const { t } = useTranslation('ai');
  const docs = useQuery({ queryKey: siteKey('ai-workbench-docs'), queryFn: aiApi.sourceDocuments });
  const [docId, setDocId] = useState('');
  const [mode, setMode] = useState<TrialInput['mode']>('rewrite');
  const [locale, setLocale] = useState('en');
  const [prompt, setPrompt] = useState(() => t('workbench.defaultPrompt'));
  const [policy, setPolicy] = useState('{\n  "forbiddenTopics": [],\n  "glossary": []\n}');
  const [stage, setStage] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [output, setOutput] = useState<string[]>([]);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const parsed = parsePolicy(policy);
  const source = docId || docs.data?.[0]?.id || '';

  const run = async () => {
    if (!parsed.ok || !source) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setRunning(true);
    setOutput([]);
    setTitle('');
    setDiag(null);
    setUsage(null);
    setError(null);
    try {
      await runTrial(
        { sourceDocumentId: source, mode, targetLocale: locale.trim() || 'en', prompt, editorialPolicy: parsed.value },
        (e) => {
          if (e.type === 'stage') setStage(e.stage);
          else if (e.type === 'output') {
            if (e.title) setTitle(e.title);
            setOutput((o) => [...o, e.html]);
          } else if (e.type === 'usage') setUsage(e);
          else if (e.type === 'diagnostics') setDiag(e);
          else if (e.type === 'error') setError(`${e.code}: ${e.message}`);
          else if (e.type === 'done') setStage('done');
        },
        ctl.signal,
      );
    } catch (err) {
      if (!ctl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  };

  if (docs.data && !docs.data.length) {
    return (
      <>
        <PageHeader title={t('workbench.title')} description={t('workbench.description')} />
        <EmptyState icon={FlaskConical} title={t('workbench.noSourcesTitle')} body={t('workbench.noSourcesBody')} />
      </>
    );
  }

  const field = 'rounded-ctl border border-line bg-panel px-2 py-1.5 text-[13px]';
  return (
    <>
      <PageHeader title={t('workbench.title')} description={t('workbench.description')} />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-3 rounded-card border border-line bg-panel p-4">
          <label className="flex flex-col gap-1 text-[13px] font-medium">
            {t('workbench.source')}
            <select className={field} value={source} onChange={(e) => setDocId(e.target.value)}>
              {(docs.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title || d.url}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-[13px] font-medium">
              {t('workbench.mode')}
              <select className={field} value={mode} onChange={(e) => setMode(e.target.value as TrialInput['mode'])}>
                {(['rewrite', 'write', 'translate'] as const).map((m) => (
                  <option key={m} value={m}>
                    {t(`workbench.modes.${m}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[13px] font-medium">
              {t('workbench.locale')}
              <input className={field} value={locale} onChange={(e) => setLocale(e.target.value)} />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[13px] font-medium">
            {t('workbench.prompt')}
            <textarea className={`${field} min-h-32 font-mono`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-[13px] font-medium">
            {t('workbench.policy')}
            <textarea className={`${field} min-h-28 font-mono`} value={policy} aria-invalid={!parsed.ok} onChange={(e) => setPolicy(e.target.value)} />
          </label>
          {!parsed.ok ? (
            <p role="alert" className="text-[13px] text-bad">
              {t('workbench.policyInvalid')}
            </p>
          ) : null}
          <p className="t-aux">{t('workbench.unsavedNote')}</p>
          <div className="flex gap-2">
            <button type="button" disabled={running || !parsed.ok || !source || !prompt.trim()} onClick={() => void run()} className="rounded-ctl bg-brand px-3 py-1.5 text-[13px] text-brand-fg disabled:opacity-50">
              {running ? t('workbench.running') : t('workbench.run')}
            </button>
            {running ? (
              <button type="button" className="rounded-ctl border border-line px-3 py-1.5 text-[13px]" onClick={() => abort.current?.abort()}>
                {t('workbench.stop')}
              </button>
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <section aria-label={t('workbench.output')} className="rounded-card border border-line bg-panel p-4" aria-live="polite">
            <div className="flex items-center justify-between gap-2">
              <h2 className="t-section">{t('workbench.output')}</h2>
              {stage ? (
                <span className="t-aux" data-testid="workbench-stage">
                  {t(`workbench.stages.${stage}`)}
                </span>
              ) : null}
            </div>
            {error ? (
              <p role="alert" className="mt-2 text-[13px] text-bad">
                {t('workbench.failed', { reason: error })}
              </p>
            ) : null}
            {title ? <h3 className="mt-2 t-section">{title}</h3> : null}
            <div data-testid="workbench-output" className="prose mt-2 max-w-none t-body">
              {output.map((html, i) => {
                const p = diag?.paragraphs.find((x) => x.index === i);
                const flagged = p && !p.cited;
                return (
                  <div key={i} className={flagged ? 'rounded-ctl border-l-2 border-warn pl-2' : undefined} data-flagged={flagged ? 'true' : undefined} dangerouslySetInnerHTML={{ __html: sanitizeHtml(html) }} />
                );
              })}
              {!output.length && !error ? <p className="t-aux">{t('workbench.noOutput')}</p> : null}
            </div>
            {usage ? (
              <p className="mt-2 t-aux" data-testid="workbench-usage">
                {t('workbench.usage', { model: usage.model, input: usage.inputTokens ?? '–', output: usage.outputTokens ?? '–', cost: fromMicros(usage.costMicros) })}
              </p>
            ) : null}
          </section>
          {diag ? (
            <section aria-label={t('workbench.diagnostics')} className="rounded-card border border-line bg-panel p-4" data-testid="workbench-diagnostics">
              <h2 className="t-section">{t('workbench.diagnostics')}</h2>
              <p className="mt-1 t-body">{t('workbench.verdict', { state: t(`gateState.${diag.status}`), score: diag.score })}</p>
              <ul className="mt-2 flex flex-col gap-1 text-[13px]">
                {diag.checks
                  .filter((c) => c.status !== 'off' && c.status !== 'passed')
                  .map((c) => (
                    <li key={c.rule}>
                      <code>{c.rule}</code> — {t(`checkStatus.${c.status}`)}
                      {c.suggestions.length ? `: ${c.suggestions.join(' ')}` : ''}
                    </li>
                  ))}
              </ul>
              {diag.notRun.length ? <p className="mt-2 t-aux">{t('workbench.notRun', { list: diag.notRun.join(', ') })}</p> : null}
              {diag.paragraphs.some((p) => !p.cited) ? (
                <div className="mt-3">
                  <h3 className="t-section">{t('workbench.uncited')}</h3>
                  <ul className="mt-1 flex flex-col gap-2">
                    {diag.paragraphs
                      .filter((p) => !p.cited)
                      .map((p) => (
                        <li key={p.index} className="rounded-ctl border border-line p-2 text-[13px]" data-testid="workbench-uncited">
                          <p>{t('workbench.paragraph', { n: p.index + 1, text: p.text })}</p>
                          <p className="mt-1 t-aux">
                            {p.source ? t('workbench.sourcePassage', { n: p.source.paragraph + 1, text: p.source.text, similarity: Math.round(p.source.similarity * 100) }) : t('workbench.noSourcePassage')}
                          </p>
                        </li>
                      ))}
                  </ul>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
