// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Bot, UserRound } from 'lucide-react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import type { RevisionRow } from '@heopress/sdk';
import { cn } from '@/lib/cn';

/**
 * Provenance surfaces for revisions (content-os-ui task 5.2; Req 4.2-4.4).
 * Lineage is a distribution feature of the Content OS (vision P5): every
 * byte answers "who made this and who is accountable" — these components
 * make that answer visible instead of leaving it in the database.
 */

export function provenanceTooltip(rev: RevisionRow): string {
  if (rev.authorType !== 'agent') return i18n.t('items:provenance.byHuman');
  const parts = [i18n.t('items:provenance.byAgent')];
  if (rev.model) parts.push(i18n.t('items:provenance.modelValue', { value: rev.model }));
  if (rev.createdByRunId) parts.push(i18n.t('items:provenance.runValue', { value: rev.createdByRunId }));
  if (rev.constitutionHash) parts.push(i18n.t('items:provenance.constitutionValue', { value: `${rev.constitutionHash.slice(0, 12)}…` }));
  if (typeof rev.confidence === 'number') parts.push(i18n.t('items:provenance.confidenceValue', { value: rev.confidence.toFixed(2) }));
  return parts.join(' ');
}

export function ProvenanceBadge({
  revision,
  className,
}: {
  revision: Pick<RevisionRow, 'authorType' | 'model' | 'createdByRunId' | 'constitutionHash' | 'confidence'>;
  className?: string;
}) {
  const { t } = useTranslation('items');
  const isAgent = revision.authorType === 'agent';
  return (
    <span
      title={provenanceTooltip(revision as RevisionRow)}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        isAgent ? 'bg-violet-100 text-violet-800' : 'bg-muted text-muted-foreground',
        className,
      )}
    >
      {isAgent ? <Bot className="h-3 w-3" /> : <UserRound className="h-3 w-3" />}
      {isAgent ? t('provenance.agent') : t('provenance.human')}
    </span>
  );
}

/** Detail block for an agent-authored revision — renders only known fields. */
export function ProvenancePanel({ revision }: { revision: RevisionRow }) {
  const { t } = useTranslation('items');
  if (revision.authorType !== 'agent') return null;
  const rows: Array<[string, string]> = [];
  if (revision.model) rows.push([t('provenance.model'), revision.model]);
  if (revision.createdByRunId) rows.push([t('provenance.run'), revision.createdByRunId]);
  if (revision.constitutionHash)
    rows.push([t('provenance.constitution'), `${revision.constitutionHash.slice(0, 16)}…`]);
  if (typeof revision.confidence === 'number')
    rows.push([t('provenance.confidence'), revision.confidence.toFixed(2)]);

  return (
    <div className="rounded-md border bg-violet-50/50 p-2">
      <h4 className="mb-1 inline-flex items-center gap-1 text-xs font-semibold text-violet-800">
        <Bot className="h-3 w-3" /> {t('provenance.heading')}
      </h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('provenance.noDetail')}</p>
      ) : (
        <dl className="grid grid-cols-[7rem_1fr] gap-y-0.5 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="break-all font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
