// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useQuery } from '@tanstack/react-query';
import { Check, Crown, Minus, X } from 'lucide-react';
import { useState } from 'react';
import type { CompiledPermission, PermissionAction } from '@heopress/sdk';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

const ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete', 'share', 'review'];

/**
 * Permission matrix view. Pulls every collection plus the active principal's
 * compiled bundle (`/permissions/me`) and renders a `collection × action`
 * grid. Clicking a cell shows the row-level rule + field whitelist behind it.
 */
export function PermissionMatrixPage() {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const [active, setActive] = useState<{ collection: string; action: PermissionAction } | null>(
    null,
  );

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });

  const meQuery = useQuery({
    queryKey: ['permissions-me'],
    queryFn: async () => (await client.permissions.me()).data,
    staleTime: 60_000,
  });

  const isLoading = collectionsQuery.isLoading || meQuery.isLoading;
  const error = collectionsQuery.error || meQuery.error;

  if (isLoading) {
    return <p className="text-sm text-dim">{t('matrix.loading')}</p>;
  }
  if (error || !meQuery.data || !collectionsQuery.data) {
    return (
      <div className="rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
        {t('matrix.loadFailed')}
      </div>
    );
  }

  const bundle = meQuery.data;
  const collections = collectionsQuery.data;
  const activePerm = active ? lookup(bundle, active.collection, active.action) : null;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h2 className="t-section">{t('matrix.title')}</h2>
          <p className="text-xs text-dim">
            {t('matrix.description')}
          </p>
        </div>
        {bundle.admin && (
          <span className="inline-flex items-center gap-1 rounded-ctl bg-warn-soft px-2 py-1 text-xs text-warn">
            <Crown className="h-3.5 w-3.5" />
            {t('matrix.adminActive')}
          </span>
        )}
      </header>

      <div className="overflow-hidden rounded-card border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel-2 text-left text-xs uppercase text-dim">
            <tr>
              <th className="px-4 py-2 font-medium">{t('policyDetail.collection')}</th>
              {ACTIONS.map((a) => (
                <th key={a} className="px-3 py-2 text-center font-medium">
                  {t(`matrix.actions.${a}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {collections.length === 0 && (
              <tr>
                <td colSpan={ACTIONS.length + 1} className="px-4 py-6 text-center text-dim">
                  {t('matrix.noCollections')}
                </td>
              </tr>
            )}
            {collections.map((c) => (
              <tr key={c.id} className="border-t">
                <td className="px-4 py-2 font-medium">{c.name}</td>
                {ACTIONS.map((a) => {
                  const perm = lookup(bundle, c.name, a);
                  const isActive =
                    active?.collection === c.name && active.action === a;
                  return (
                    <td key={a} className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() =>
                          setActive(isActive ? null : { collection: c.name, action: a })
                        }
                        className={cn(
                          'inline-flex h-7 w-full max-w-[6rem] items-center justify-center rounded-ctl border transition border-line',
                          perm
                            ? 'border-ok/40 bg-ok-soft text-ok hover:bg-ok-soft'
                            : 'border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100',
                          isActive && 'ring-2 ring-brand',
                        )}
                        aria-label={t(perm ? 'matrix.cellAllowed' : 'matrix.cellDenied', { action: t(`matrix.actions.${a}`), collection: c.name })}
                      >
                        {bundle.admin ? (
                          <Crown className="h-3.5 w-3.5" />
                        ) : perm ? (
                          <CellSummary perm={perm} />
                        ) : (
                          <X className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {active && (
        <CellInspector
          collection={active.collection}
          action={active.action}
          perm={activePerm}
          adminBypass={bundle.admin}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

function lookup(
  bundle: { admin: boolean; byKey: Record<string, CompiledPermission> },
  collection: string,
  action: PermissionAction,
): CompiledPermission | null {
  if (bundle.admin) {
    return {
      collection,
      action,
      rule: null,
      fields: ['*'],
      presets: {},
      validation: {},
      sources: [{ policyId: 'admin', policyName: i18n.t('access:matrix.adminBypass') }],
    };
  }
  return bundle.byKey[`${collection}::${action}`] ?? null;
}

function CellSummary({ perm }: { perm: CompiledPermission }) {
  const { t } = useTranslation('access');
  const conditional = perm.rule && Object.keys(perm.rule).length > 0;
  if (perm.fields.includes('*') && !conditional) {
    return <Check className="h-3.5 w-3.5" />;
  }
  return (
    <span className="text-[10px] font-medium">
      {conditional ? t('matrix.conditional') : <Minus className="h-3.5 w-3.5" />}
    </span>
  );
}

function CellInspector({
  collection,
  action,
  perm,
  adminBypass,
  onClose,
}: {
  collection: string;
  action: PermissionAction;
  perm: CompiledPermission | null;
  adminBypass: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('access');
  return (
    <div className="rounded-card border bg-bg p-4 shadow-sm border-line">
      <header className="mb-3 flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">
            {t(`matrix.actions.${action}`)} · <span className="text-dim">{collection}</span>
          </h3>
          <p className="text-xs text-dim">
            {adminBypass
              ? t('matrix.inspector.admin')
              : perm
                ? t('matrix.inspector.compiled')
                : t('matrix.inspector.denied')}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-ctl p-1 text-dim hover:bg-panel-2"
          aria-label={t('matrix.inspector.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </header>

      {perm && (
        <div className="grid gap-3 sm:grid-cols-4">
          <Block label={t('matrix.inspector.sources')}>
            {perm.sources?.length ? (
              <ul className="space-y-1">
                {perm.sources.map((source) => (
                  <li key={source.policyId}>
                    {source.policyId === 'admin' ? (
                      <span>{source.policyName}</span>
                    ) : (
                      <a
                        href={`/access/policies/${source.policyId}`}
                        className="text-brand hover:underline"
                      >
                        {source.policyName}
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-dim">{t('matrix.inspector.unknown')}</span>
            )}
          </Block>
          <Block label={t('matrix.inspector.fields')}>
            {perm.fields.length === 0 ? (
              <span className="text-dim">{t('matrix.inspector.none')}</span>
            ) : (
              <ul className="space-y-0.5">
                {perm.fields.map((f) => (
                  <li key={f}>
                    <code className="rounded bg-panel-2 px-1 text-[11px]">{f}</code>
                  </li>
                ))}
              </ul>
            )}
          </Block>
          <Block label={t('matrix.inspector.rule')}>
            <pre className="max-h-40 overflow-auto rounded bg-panel-2 p-2 text-[11px] leading-tight">
{JSON.stringify(perm.rule ?? {}, null, 2)}
            </pre>
          </Block>
          <Block label={t('matrix.inspector.presets')}>
            <pre className="max-h-40 overflow-auto rounded bg-panel-2 p-2 text-[11px] leading-tight">
{JSON.stringify({ presets: perm.presets, validation: perm.validation }, null, 2)}
            </pre>
          </Block>
        </div>
      )}
    </div>
  );
}

function Block({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="mb-1 text-[11px] font-semibold uppercase text-dim">{label}</h4>
      <div className="text-xs">{children}</div>
    </div>
  );
}
