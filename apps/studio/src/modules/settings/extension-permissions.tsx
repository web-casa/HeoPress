/**
 * Plugin permissions in Studio (HeoPress P12 task 1.2): the capabilities a plugin requests, grouped by category,
 * and the diff an upgrade brings. Used by the install, upgrade and re-confirmation dialogs.
 */
import { useTranslation } from 'react-i18next';
import { groupCapabilities, type CapabilityDiff, type ParsedCapability } from '@heopress/contracts/extensions';

/** One capability as a sentence the admin can judge ("Send requests to api.example.com"). */
function CapabilityLine({ cap, tone }: { cap: ParsedCapability; tone?: 'added' | 'removed' }) {
  const { t } = useTranslation('system');
  const target = cap.target === '*' ? t('permissions.everyCollection') : cap.target;
  const label =
    cap.category === 'extension-point'
      ? t(`permissions.points.${cap.target}`)
      : t(`permissions.kinds.${cap.kind.replace(':', '_')}`, { target });
  const toneClass = tone === 'added' ? 'border-warn bg-warn-soft' : tone === 'removed' ? 'border-line text-dim line-through' : 'border-line';
  return (
    <li className={`flex items-start justify-between gap-3 rounded-ctl border px-2 py-1.5 text-sm ${toneClass}`} data-capability={cap.raw}>
      <span>
        {tone === 'added' && <span className="mr-1 text-xs font-semibold text-warn">{t('permissions.new')}</span>}
        {label}
      </span>
      <code className="shrink-0 text-[11px] text-dim">{cap.raw}</code>
    </li>
  );
}

/** The capabilities grouped by category; `added` / `removed` mark an upgrade's diff. */
export function PermissionList({ capabilities, diff }: { capabilities: string[]; diff?: CapabilityDiff }) {
  const { t } = useTranslation('system');
  const all = diff ? [...capabilities, ...diff.removed] : capabilities;
  const groups = groupCapabilities(all);
  if (groups.length === 0) return <p className="text-sm text-dim">{t('permissions.none')}</p>;
  const added = new Set(diff?.added ?? []);
  const removed = new Set(diff?.removed ?? []);
  return (
    <div className="space-y-3" data-testid="permission-list">
      {groups.map((group) => (
        <section key={group.category}>
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-dim">{t(`permissions.categories.${group.category}`)}</h4>
          <ul className="space-y-1">
            {group.capabilities.map((cap) => (
              <CapabilityLine key={cap.raw} cap={cap} tone={added.has(cap.raw) ? 'added' : removed.has(cap.raw) ? 'removed' : undefined} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * The approval dialog: what the plugin requests (with the diff, for an upgrade) and an explicit Approve button. The
 * caller sends exactly `capabilities` as `approvedCapabilities`.
 */
export function PermissionApprovalDialog({
  title,
  intro,
  capabilities,
  diff,
  approveLabel,
  pending,
  error,
  onApprove,
  onCancel,
}: {
  title: string;
  intro: string;
  capabilities: string[];
  diff?: CapabilityDiff;
  approveLabel: string;
  pending?: boolean;
  error?: string | null;
  onApprove: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(['system', 'common']);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-card border border-line bg-panel p-5 shadow-lg">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-1 text-sm text-dim">{intro}</p>
        <div className="mt-4">
          <PermissionList capabilities={capabilities} diff={diff} />
        </div>
        {error && <p className="mt-3 rounded-ctl bg-bad-soft px-2 py-1.5 text-sm text-bad">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-ctl border border-line px-3 py-1.5 text-sm hover:bg-panel-2">
            {t('permissions.cancel')}
          </button>
          <button
            type="button"
            onClick={onApprove}
            disabled={pending}
            className="rounded-ctl bg-brand px-3 py-1.5 text-sm font-medium text-brand-fg disabled:opacity-50"
          >
            {approveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The first API error message of a failed request, if any. */
export function apiErrorMessage(error: unknown): string | null {
  if (!error) return null;
  const body = (error as { body?: { errors?: Array<{ message?: string }> } }).body;
  return body?.errors?.[0]?.message ?? (error instanceof Error ? error.message : String(error));
}
