import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { HeoPressError, type SiteAuditResource } from '@heopress/sdk';
import { ClipboardCheck, Download, Play } from 'lucide-react';
import { useId, useState } from 'react';
import { getApiClient } from '@/lib/api';

/**
 * Site audit — the site's SEO / GEO problems as a list to clear (HeoPress P07 tasks 5.1, 5.2; spec seo/site-audit).
 *
 * Each issue names its rule (a stable id), its severity, the pages concerned (each opens in the editor) and what was
 * found. Only the pages the signed-in user may read are listed. Administrators can ask for a run; the list is also
 * exported as JSON for CI and agents (`GET /api/v1/site/audit/export`, also as CSV).
 */

type Issue = SiteAuditResource['issues'][number];

const SEVERITY_CLASS: Record<string, string> = {
  error: 'bg-destructive/10 text-destructive',
  warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  notice: 'bg-muted text-muted-foreground',
};

/** A line of what the rule found, from its evidence. */
function detailOf(issue: Issue): string {
  const e = issue.evidence;
  const parts: string[] = [];
  if (typeof e.href === 'string') parts.push(`Link ${e.href}`);
  if (typeof e.reason === 'string') parts.push(`(${e.reason})`);
  if (typeof e.fragment === 'string') parts.push(`#${e.fragment} not found`);
  if (typeof e.value === 'string' && e.value) parts.push(`“${e.value}”`);
  if (Array.isArray(e.diagnostics)) parts.push(`${e.diagnostics.length} part(s) left out`);
  if (Array.isArray(e.opaque) && e.opaque.length) parts.push(`Not in the copy: ${(e.opaque as string[]).join(', ')}`);
  if (typeof e.at === 'string') parts.push(`The texts part near “${e.at}”`);
  if (typeof e.copy === 'string' && typeof e.answeredBy === 'string') parts.push(`${e.copy} is a ${e.answeredBy}`);
  const nav = e.navigation as { label?: string } | undefined;
  if (nav?.label) parts.push(`Registered link “${nav.label}”`);
  return parts.join(' ');
}

export function SiteAuditPage() {
  const client = getApiClient();
  const qc = useQueryClient();
  const [rule, setRule] = useState('');
  const ruleId = useId();
  const audit = useQuery({ queryKey: ['site-audit', rule], queryFn: async () => (await client.site.audit(rule || undefined)).data });
  const run = useMutation({
    mutationFn: async () => (await client.site.runAudit()).data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['site-audit'] }),
  });
  const forbidden = run.error instanceof HeoPressError && run.error.status === 403;

  // The server's export (every issue, whatever the filter or the page shows: Codex review of batch 10b, round 1).
  const exportJson = useMutation({ mutationFn: () => client.site.auditExport() });
  const download = async () => {
    const doc = await exportJson.mutateAsync();
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'site-audit.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const data = audit.data;
  return (
    <div className="max-w-4xl space-y-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-lg font-semibold">
          <ClipboardCheck className="h-5 w-5" aria-hidden="true" />
          Site audit
        </h1>
        <p className="text-sm text-muted-foreground">
          Problems with how your published pages can be found, read and cited, as a list to clear rather than a score. A fixed problem leaves the list at the next
          run. Only pages you may read are shown.
        </p>
      </header>

      <section aria-label="Audit run" className="flex flex-wrap items-center gap-3 text-sm">
        <span>
          {data?.run.lastRunAt ? <>Last run {new Date(data.run.lastRunAt).toLocaleString()}</> : 'Not run yet'}
          {data?.run.requested ? ' · a run is queued' : ''}
        </span>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2"
          onClick={() => run.mutate()}
          disabled={run.isPending || data?.run.requested}
        >
          <Play className="h-4 w-4" aria-hidden="true" /> Run audit
        </button>
        <button type="button" className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2" onClick={() => void download().catch(() => undefined)} disabled={exportJson.isPending}>
          <Download className="h-4 w-4" aria-hidden="true" /> Export JSON
        </button>
        {forbidden ? <span role="alert" className="text-destructive">Only administrators can run the audit.</span> : null}
        {run.isSuccess ? <span role="status">Queued. The audit runs within a minute.</span> : null}
        {exportJson.isError ? <span role="alert" className="text-destructive">The export could not be made.</span> : null}
      </section>
      {data?.run.truncated ? (
        <p role="note" className="text-sm text-amber-700 dark:text-amber-400">
          The last run reached a limit: the list may be incomplete.
        </p>
      ) : null}

      <div className="flex items-center gap-2 text-sm">
        <label htmlFor={ruleId}>Rule</label>
        <select id={ruleId} className="h-9 rounded-md border border-border bg-background px-2" value={rule} onChange={(e) => setRule(e.target.value)}>
          <option value="">All rules</option>
          {(data?.rules ?? []).map((r) => (
            <option key={r.id} value={r.id}>
              {r.title} ({r.id})
            </option>
          ))}
        </select>
      </div>

      {audit.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {audit.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The audit could not be loaded.
        </p>
      ) : null}
      {data ? (
        data.issues.length ? (
          <ul aria-label="Issues" className="divide-y divide-border rounded-md border border-border">
            {data.issues.map((issue) => (
              <li key={issue.id} className="space-y-1 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${SEVERITY_CLASS[issue.severity] ?? ''}`}>{issue.severity}</span>
                  <span className="font-medium">{issue.title}</span>
                  <code className="text-xs text-muted-foreground">{issue.rule}</code>
                </div>
                <p className="text-muted-foreground">{detailOf(issue)}</p>
                {issue.pages.length ? (
                  <ul aria-label="Pages" className="flex flex-wrap gap-x-4 gap-y-1">
                    {issue.pages.map((p) => (
                      <li key={p.itemId}>
                        <Link to="/content/$collection/$id" params={{ collection: p.collection, id: p.itemId }} className="underline">
                          {p.title || p.itemId}
                        </Link>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm">No issues{rule ? ' for this rule' : ''}.</p>
        )
      ) : null}
      {data && data.total > data.issues.length ? (
        <p className="text-sm text-muted-foreground">
          Showing {data.issues.length} of {data.total}. The export lists them all.
        </p>
      ) : null}
    </div>
  );
}
