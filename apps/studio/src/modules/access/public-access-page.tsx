// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type {
  GrantAction,
  RealmAccessDescriptor,
  RealmAccessGrant,
} from '@heopress/sdk';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Loader2, ShieldAlert, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from 'i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Public & subscriber access picker.
 *
 * The Roles/Policies pages expose the full permission model; this page answers
 * the narrower question an operator actually asks — "what can a visitor
 * reach?" — as a collection x action grid per non-staff realm.
 *
 * Every limit shown here is served by `GET /access/grants` rather than
 * hard-coded: which actions a realm may hold, whether an "own rows" scope is
 * expressible, whether the realm can be toggled at all. So when the server
 * tightens a realm, this UI follows without an edit.
 */

const QUERY_KEY = ['access', 'grants'] as const;

const REALM_ICON: Record<string, typeof Globe> = {
  public: Globe,
  subscriber: UserRound,
};

function actionLabel(action: GrantAction): string {
  return i18n.t(`access:publicAccess.actions.${action}`);
}

export function PublicAccessPage() {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const stateQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await client.access.grants.state()).data,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    // A grant changes the caller's own effective bundle too when they are not
    // an admin; drop the cached `/permissions/me` so gated UI re-resolves.
    void queryClient.invalidateQueries({ queryKey: ['permissions-me'] });
  };

  /** Surface the server's refusal text — it explains *why* a grant is refused. */
  const onError = (err: unknown) => {
    setError(err instanceof Error ? err.message : t('publicAccess.requestFailed'));
  };

  const toggleRealm = useMutation({
    mutationFn: async ({ realm, enable }: { realm: string; enable: boolean }) =>
      enable
        ? (await client.access.grants.enable(realm)).data
        : (await client.access.grants.disable(realm)).data,
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError,
  });

  const grant = useMutation({
    mutationFn: async (input: {
      realm: string;
      collection: string;
      action: GrantAction;
      publishedOnly?: boolean;
      ownOnly?: boolean;
    }) => {
      const { realm, ...body } = input;
      return (await client.access.grants.grant(realm, body)).data;
    },
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError,
  });

  const revoke = useMutation({
    mutationFn: async (input: { realm: string; collection: string; action: GrantAction }) =>
      (await client.access.grants.revoke(input.realm, input.collection, input.action)).data,
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError,
  });

  if (stateQuery.isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-dim">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('publicAccess.loading')}
      </div>
    );
  }

  if (stateQuery.isError) {
    return (
      <p className="text-sm text-bad">
        {t('publicAccess.loadFailed')} {(stateQuery.error as Error)?.message}
      </p>
    );
  }

  const state = stateQuery.data;
  const collections = state?.collections ?? [];
  const pending = toggleRealm.isPending || grant.isPending || revoke.isPending;

  return (
    <div className="space-y-8">
      <p className="max-w-3xl text-sm text-dim">
        {t('publicAccess.intro')}
      </p>

      {error && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      )}

      {collections.length === 0 && (
        <p className="text-sm text-dim">
          {t('publicAccess.noCollections')}
        </p>
      )}

      {(state?.realms ?? []).map((realm) => (
        <RealmSection
          key={realm.key}
          realm={realm}
          collections={collections}
          disabled={pending}
          onToggle={(enable) => toggleRealm.mutate({ realm: realm.key, enable })}
          onGrant={(collection, action) =>
            grant.mutate({ realm: realm.key, collection, action })
          }
          onRevoke={(collection, action) =>
            revoke.mutate({ realm: realm.key, collection, action })
          }
          onScopeChange={(existing, scope) =>
            grant.mutate({
              realm: realm.key,
              collection: existing.collection,
              action: existing.action,
              publishedOnly: scope === 'publishedOnly' ? !existing.publishedOnly : existing.publishedOnly,
              ownOnly: scope === 'ownOnly' ? !existing.ownOnly : existing.ownOnly,
            })
          }
        />
      ))}
    </div>
  );
}

interface RealmSectionProps {
  realm: RealmAccessDescriptor;
  collections: Array<{ name: string; label: string | null }>;
  disabled: boolean;
  onToggle: (enable: boolean) => void;
  onGrant: (collection: string, action: GrantAction) => void;
  onRevoke: (collection: string, action: GrantAction) => void;
  onScopeChange: (grant: RealmAccessGrant, scope: 'publishedOnly' | 'ownOnly') => void;
}

function RealmSection({
  realm,
  collections,
  disabled,
  onToggle,
  onGrant,
  onRevoke,
  onScopeChange,
}: RealmSectionProps) {
  const { t } = useTranslation('access');
  const Icon = REALM_ICON[realm.key] ?? Globe;
  const grantsByKey = new Map(realm.grants.map((g) => [`${g.collection}::${g.action}`, g]));
  // A togglable realm that is off renders read-only: showing an editable grid
  // that silently provisions the realm on first click would hide the fact that
  // anonymous access was just switched on.
  const locked = realm.togglable && !realm.enabled;

  return (
    <section className="space-y-3 rounded-card border p-4 border-line">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <Icon className="mt-0.5 size-4 text-dim" aria-hidden />
          <div>
            <h2 className="font-medium">{realm.label}</h2>
            <p className="max-w-2xl text-sm text-dim">{realm.summary}</p>
          </div>
        </div>
        {realm.togglable && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onToggle(!realm.enabled)}
            className={cn(
              'rounded-ctl border px-3 py-1.5 text-sm disabled:opacity-50 border-line',
              realm.enabled
                ? 'border-bad/40 text-bad hover:bg-bad-soft'
                : 'hover:bg-panel-2',
            )}
          >
            {realm.enabled ? t('publicAccess.disable') : t('publicAccess.enable')}
          </button>
        )}
      </header>

      {realm.key === 'public' && realm.enabled && (
        <p className="rounded-ctl border border-warn/40 bg-warn-soft p-3 text-sm">
          {t('publicAccess.publicWarning')}
        </p>
      )}

      {locked ? (
        <p className="text-sm text-dim">
          {t('publicAccess.off')}
        </p>
      ) : collections.length === 0 ? null : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-dim border-line">
                <th className="py-2 pr-4 font-medium">{t('publicAccess.collection')}</th>
                {realm.allowedActions.map((action) => (
                  <th key={action} className="px-3 py-2 font-medium">
                    {actionLabel(action)}
                  </th>
                ))}
                <th className="px-3 py-2 font-medium">{t('publicAccess.rowScope')}</th>
              </tr>
            </thead>
            <tbody>
              {collections.map((collection) => (
                <tr key={collection.name} className="border-b last:border-0">
                  <td className="py-2 pr-4">
                    <span className="font-medium">{collection.label ?? collection.name}</span>
                    {collection.label && (
                      <span className="ml-1.5 text-xs text-dim">
                        {collection.name}
                      </span>
                    )}
                  </td>
                  {realm.allowedActions.map((action) => {
                    const existing = grantsByKey.get(`${collection.name}::${action}`);
                    const inputId = `${realm.key}-${collection.name}-${action}`;
                    return (
                      <td key={action} className="px-3 py-2">
                        <input
                          id={inputId}
                          type="checkbox"
                          className="size-4"
                          disabled={disabled}
                          checked={!!existing}
                          aria-label={t('publicAccess.checkboxLabel', { action: actionLabel(action), collection: collection.name, realm: realm.label })}
                          onChange={(event) =>
                            event.target.checked
                              ? onGrant(collection.name, action)
                              : onRevoke(collection.name, action)
                          }
                        />
                      </td>
                    );
                  })}
                  <td className="px-3 py-2">
                    <ScopeCell
                      realm={realm}
                      collection={collection.name}
                      grantsByKey={grantsByKey}
                      disabled={disabled}
                      onScopeChange={onScopeChange}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface ScopeCellProps {
  realm: RealmAccessDescriptor;
  collection: string;
  grantsByKey: Map<string, RealmAccessGrant>;
  disabled: boolean;
  onScopeChange: (grant: RealmAccessGrant, scope: 'publishedOnly' | 'ownOnly') => void;
}

/**
 * Row scopes for a collection's grants.
 *
 * Scopes are per `(collection, action)` server-side, but an operator thinks in
 * terms of the collection — so the cell lists one control per granted action
 * rather than collapsing them into a single ambiguous toggle.
 */
function ScopeCell({
  realm,
  collection,
  grantsByKey,
  disabled,
  onScopeChange,
}: ScopeCellProps) {
  const { t } = useTranslation('access');
  const granted = realm.allowedActions
    .map((action) => grantsByKey.get(`${collection}::${action}`))
    .filter((g): g is RealmAccessGrant => !!g);

  if (granted.length === 0) {
    return <span className="text-xs text-dim">—</span>;
  }

  return (
    <div className="space-y-1">
      {granted.map((g) => (
        <div key={g.action} className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-dim">{t('publicAccess.actionPrefix', { action: actionLabel(g.action) })}</span>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              className="size-3.5"
              disabled={disabled}
              checked={g.publishedOnly}
              onChange={() => onScopeChange(g, 'publishedOnly')}
            />
            {t('publicAccess.publishedOnly')}
          </label>
          {realm.supportsOwnOnly && (
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                className="size-3.5"
                disabled={disabled}
                checked={g.ownOnly}
                onChange={() => onScopeChange(g, 'ownOnly')}
              />
              {t('publicAccess.ownOnly')}
            </label>
          )}
        </div>
      ))}
    </div>
  );
}
