// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Check, ChevronDown, ChevronLeft, Copy, Lock, Pin, Save, Share2, Star, Trash2, X } from 'lucide-react';
import type { SaveAction } from '@heopress/contracts/schemas';
import { useSaveAction, saveActionLabel } from './use-save-action';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { versionConflictOf, type FieldResource, type ItemRow, type PermissionAction, type RevisionRow, type SiteLinkImpactResource } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { jsonEqual } from '@/lib/json-equal';
import { usePermissions, type PermissionHelpers } from '@/lib/use-permissions';
import { useSaveHandler } from '@/lib/keybindings/use-keybindings';
import { PresenceStack } from '@/components/presence-chip';
import { CoEditingBanner } from '@/components/co-editing-banner';
import { useCoEditors } from '@/hooks/use-presence';
import { resolveInterface } from './interfaces/registry';
import { GroupContainer, type GroupVariant } from './interfaces/group';
import { RawToggle } from './interfaces/raw-toggle';
import { ProvenanceBadge } from './provenance-badge';
import { RevisionsPanel } from './revisions-panel';
import { RawJsonPanel } from './raw-json-panel';
import { VersionPanel } from './version-panel';
import { DependentRecordsDialog, type DependentGroup } from './dependent-records-dialog';
import { LinkImpactDialog, type ImpactChange } from './link-impact-dialog';
import { checkImpact } from './link-impact-check';
import { TranslationMode } from './translation-mode';
import { translatableFields, tmLearnEntries } from './translatable-fields';
import { useSiteLocales } from './use-site-locales';
import { ItemCreate } from './item-create';
import { EditorialActions } from './editorial-actions';
import { TranslationGroupPanel } from './translation-group-panel';

type Tab = 'fields' | 'translation' | 'group' | 'revisions' | 'versions' | 'raw';

/**
 * Content module detail editor.
 * Phase B FE slice 2: hosts the side-panel tabs (Fields / Revisions / Raw JSON)
 * around a basic field editor. The full Interface registry lands in slice 3+.
 */
export function ItemDetailPage() {
  // Non-strict: rendered by both `/content/...` and `/$adminPath/content/...`.
  const { collection, id } = useParams({ strict: false }) as { collection: string; id: string };
  if (id === 'new') return <ItemCreate key={collection} collection={collection} />;
  return <ItemEditor key={`${collection}/${id}`} collection={collection} id={id} />;
}

function ItemEditor({ collection, id }: { collection: string; id: string }) {
  const client = getApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const perms = usePermissions();
  const saveAction = useSaveAction();
  // The action a one-off save click requested; null → use the effective default.
  const [pendingAction, setPendingAction] = useState<SaveAction | null>(null);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);

  // Real-time co-editing: one presence subscription feeds both the header
  // avatar stack and the warning banner (peers on this same item, not self).
  const { coEditors } = useCoEditors(collection, id);

  const [tab, setTab] = useState<Tab>('fields');
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  // The item version the draft was loaded from. Saves are based on it — not on
  // a background refetch — so someone else's newer edit is never overwritten.
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const submittedDraft = useRef<Record<string, unknown> | null>(null);
  // Translation mode (translation-memory-ui): the site's default is the source
  // locale; the user picks a target to translate into.
  const locales = useSiteLocales();
  const [targetLocale, setTargetLocale] = useState<string | null>(null);
  // Translatable fields the user set by hand (or applied a human TM match) in
  // this session — learned into TM on save when `translations.learnTm` is on.
  const [learnFields, setLearnFields] = useState<Set<string>>(() => new Set());
  // Content scheduling (Publish_Window) — datetime-local strings, '' = unset.
  const [publishAt, setPublishAt] = useState<string | null>(null);
  const [unpublishAt, setUnpublishAt] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [dependentGroups, setDependentGroups] = useState<DependentGroup[] | null>(null);
  // Before a published page is deleted, unpublished or moved: the pages that may be affected (HeoPress P07 task 5.5).
  const [impactPrompt, setImpactPrompt] = useState<{ change: ImpactChange; impact: SiteLinkImpactResource | null; proceed: () => void } | null>(null);
  const [shareRoleId, setShareRoleId] = useState('');
  const [sharePassword, setSharePassword] = useState('');
  const [shareValidUntil, setShareValidUntil] = useState('');
  const [shareMaxUses, setShareMaxUses] = useState('');
  const [shareUrl, setShareUrl] = useState('');
  const [shareCopied, setShareCopied] = useState(false);
  const { t } = useTranslation('items');

  const canRead = perms.can(collection, 'read');
  const canUpdate = perms.can(collection, 'update');
  const canDelete = perms.can(collection, 'delete');
  const canShare = perms.can(collection, 'share');

  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
  });

  // Learn-on-save toggle (Req 6.1). Defaults ON when the key is unset.
  const learnTmQuery = useQuery({
    queryKey: ['settings', 'translations.learnTm'],
    queryFn: async () => {
      try {
        return (await client.settings.get('translations.learnTm')).data;
      } catch {
        return null;
      }
    },
  });
  const learnTmEnabled = (learnTmQuery.data?.value?.enabled as boolean | undefined) ?? true;

  const itemQuery = useQuery({
    queryKey: ['item', collection, id],
    queryFn: async () => (await client.items(collection as never).detail(id)).data as ItemRow,
    enabled: !perms.isLoading && canRead,
  });

  // Law Zero pins (content-os Req 8.5): fields a human edit locked against
  // agent writes. Shown as a badge per field; release hands the field back.
  const pinsQuery = useQuery({
    queryKey: ['pins', collection, id],
    queryFn: async () => (await client.items(collection as never).listPins(id)).data.pinnedFields,
    enabled: !perms.isLoading && canRead,
  });

  // Provenance of the latest revision (content-os-ui Req 4.4): who — human
  // or agent — last shaped this item. Shares the revisions query cache.
  const revisionsQuery = useQuery({
    queryKey: ['revisions', collection, id],
    queryFn: async () =>
      (await client.items(collection as never).listRevisions(id)).data as RevisionRow[],
    enabled: !perms.isLoading && canRead,
  });
  const latestRevision = revisionsQuery.data?.[0];

  const releasePinMutation = useMutation({
    mutationFn: async (field: string) => {
      const res = await client.items(collection as never).releasePin(id, field);
      return res.data.pinnedFields;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pins', collection, id] });
    },
  });

  const shareRolesQuery = useQuery({
    queryKey: ['share-roles', collection],
    enabled: shareOpen && canShare,
    queryFn: async () => {
      const roles = (await client.roles.list()).data.filter((role) => !role.adminAccess && !role.appAccess);
      const out = await Promise.all(
        roles.map(async (role) => {
          const detail = (await client.roles.detail(role.id)).data;
          const policyDetails = await Promise.all(
            detail.policies.map((binding) => client.policies.detail(binding.policyId).then((res) => res.data)),
          );
          const permissions = policyDetails.flatMap((policy) => policy.permissions ?? []);
          const hasRead = permissions.some((perm) => perm.collection === collection && perm.action === 'read');
          const hasNonRead = permissions.some((perm) => perm.action !== 'read');
          if (hasRead && !hasNonRead) return role;
          return null;
        })
      );
      return out.filter((role): role is NonNullable<typeof role> => role !== null);
    },
  });

  // Hydrate draft from server data once.
  useEffect(() => {
    if (itemQuery.data && draft === null) {
      setDraft({ ...(itemQuery.data.data as Record<string, unknown>) });
      setBaseVersion(itemQuery.data.version);
      setPublishAt(isoToLocalInput(itemQuery.data.publishAt));
      setUnpublishAt(isoToLocalInput(itemQuery.data.unpublishAt));
    }
  }, [itemQuery.data, draft]);

  const fields = useMemo(() => fieldsQuery.data ?? [], [fieldsQuery.data]);
  // Fields the user can read at all — anything else is invisible (server
  // strips it from the payload, but we'd render an empty input otherwise).
  const editable: FieldResource[] = useMemo(
    () =>
      fields
        .filter((f) => !f.hidden)
        .filter((f) => perms.fieldAllowed(collection, 'read', f.name)),
    [fields, perms, collection],
  );

  // Source locale = site default (first supported); target defaults to the
  // first other locale. Both derive from the same `locales` setting the
  // translatable-text interface uses, so lists never diverge.
  const sourceLocale = locales[0] ?? 'en';
  useEffect(() => {
    if (targetLocale === null) {
      setTargetLocale(locales.find((l) => l !== sourceLocale) ?? sourceLocale);
    }
  }, [locales, sourceLocale, targetLocale]);
  const hasTranslatableFields = translatableFields(editable).length > 0;

  const isDirty = useMemo(() => {
    if (!itemQuery.data || draft === null) return false;
    if (!jsonEqual(draft, itemQuery.data.data ?? {})) return true;
    return (
      publishAt !== isoToLocalInput(itemQuery.data.publishAt) ||
      unpublishAt !== isoToLocalInput(itemQuery.data.unpublishAt)
    );
  }, [draft, itemQuery.data, publishAt, unpublishAt]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) return null;
      submittedDraft.current = draft;
      const res = await client.items(collection as never).patch(id, {
        data: draft,
        publishAt: localInputToIso(publishAt),
        unpublishAt: localInputToIso(unpublishAt),
        expectedVersion: baseVersion ?? itemQuery.data?.version ?? 0,
      });
      // Learn human-edited translations into TM (Req 6.1). Best-effort: a TM
      // write failure must not fail the save that already succeeded.
      const toLearn = tmLearnEntries({
        enabled: learnTmEnabled,
        editedFields: learnFields,
        data: draft,
        sourceLocale,
        targetLocale: targetLocale ?? '',
      });
      if (toLearn.length > 0) {
        await Promise.allSettled(
          toLearn.map((entry) => client.tm.upsert({ ...entry, source: 'human', quality: 100 })),
        );
        setLearnFields(new Set());
      }
      return res.data as ItemRow;
    },
    onSuccess: (saved) => {
      if (saved) {
        setBaseVersion(saved.version);
        // Take the saved content (with the block IDs the server assigned) as
        // the draft, unless it was edited while the save was in flight.
        const submitted = submittedDraft.current;
        setDraft((current) =>
          current === submitted ? { ...((saved.data as Record<string, unknown>) ?? {}) } : current,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ['item', collection, id] });
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
      void queryClient.invalidateQueries({ queryKey: ['revisions', collection, id] });
      // Navigate per the save action (one-off override, else effective default).
      const action = pendingAction ?? saveAction.effective;
      setPendingAction(null);
      if (action === 'return') {
        void navigate({ to: '/content/$collection', params: { collection } });
      } else if (action === 'create_new') {
        void navigate({ to: '/content/$collection/$id', params: { collection, id: 'new' } });
      }
      // 'stay' → remain on the form (current behavior).
    },
  });

  // Cmd/Ctrl+S → save and stay. Mirrors the Save button's gating exactly.
  useSaveHandler(
    () => save(),
    isDirty && canUpdate && !saveMutation.isPending,
  );

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await client.items(collection as never).delete(id);
    },
    onSuccess: () => {
      setDependentGroups(null);
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
      void navigate({ to: '/content/$collection', params: { collection } });
    },
    onError: (err: unknown) => {
      // 409 DEPENDENT_RECORDS_EXIST → open the resolution dialog with the groups.
      const e = err as { status?: number; body?: { errors?: Array<{ code?: string; dependents?: DependentGroup[] }> } };
      if (e?.status === 409 && e.body?.errors?.[0]?.code === 'DEPENDENT_RECORDS_EXIST') {
        setDependentGroups(e.body.errors[0].dependents ?? []);
      }
    },
  });

  /** Ask first when the change may break links to a published page; otherwise (or when nothing is known) go on. */
  const guardImpact = async (change: ImpactChange, proceed: () => void) => {
    if (itemQuery.data?.status !== 'published') return proceed();
    const decision = await checkImpact(async () => (await client.site.linkImpact(id)).data);
    if (decision.kind === 'proceed') return proceed();
    setImpactPrompt({ change, impact: decision.impact, proceed });
  };
  /** What a save would change of a published page's reach: its address (slug, path), or a new unpublishing time. */
  const saveChange = (): ImpactChange | null => {
    const saved = (itemQuery.data?.data ?? {}) as Record<string, unknown>;
    if (draft && (['slug', 'path'] as const).some((f) => f in saved && draft[f] !== saved[f])) return 'move';
    if (unpublishAt && !itemQuery.data?.unpublishAt) return 'unpublish';
    return null;
  };
  const save = () => {
    const change = saveChange();
    if (change) void guardImpact(change, () => saveMutation.mutate());
    else saveMutation.mutate();
  };

  const createShareMutation = useMutation({
    mutationFn: async () => {
      const res = await client.shares.create({
        collection,
        itemId: id,
        roleId: shareRoleId,
        password: sharePassword.trim() || undefined,
        validUntil: shareValidUntil ? new Date(shareValidUntil).toISOString() : null,
        maxUses: shareMaxUses ? Number(shareMaxUses) : null,
      });
      return res.data;
    },
    onSuccess: (share) => {
      setShareUrl(new URL(share.url, window.location.origin).toString());
      setShareCopied(false);
    },
  });

  if (!perms.isLoading && !canRead) {
    return (
      <div className="flex items-center gap-2 rounded-ctl border border-warn/40 bg-warn-soft p-3 text-sm text-warn">
        <Lock className="h-4 w-4" />
        <Trans t={t} i18nKey="detail.noRead" components={{ code: <code className="mx-1 rounded bg-bg px-1 text-xs" /> }} />
      </div>
    );
  }

  if (itemQuery.error) {
    return (
      <div className="rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
        {t('detail.loadFailed')}
      </div>
    );
  }

  if (!itemQuery.data || draft === null) {
    return <p className="text-sm text-dim">{t('detail.loading')}</p>;
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-dim">
            <Link to="/content" className="hover:underline">{t('detail.breadcrumb')}</Link>
            <span className="mx-1">/</span>
            <Link
              to="/content/$collection"
              params={{ collection }}
              className="hover:underline"
            >
              {collection}
            </Link>
            <span className="mx-1">/</span>
            <span className="font-mono">{id.slice(0, 8)}…</span>
          </p>
          <h1 className="t-page flex items-center gap-2">
            <Link
              to="/content/$collection"
              params={{ collection }}
              className="text-dim hover:text-fg"
              aria-label={t('detail.backToList')}
            >
              <ChevronLeft className="h-5 w-5" />
            </Link>
            {t('detail.title')}
            {latestRevision && <ProvenanceBadge revision={latestRevision} />}
          </h1>
        </div>
        <div className="flex items-center gap-2">
          {/* Avatar stack — other users currently editing this same item */}
          <PresenceStack peers={coEditors} />
          <EditorialActions
            collection={collection}
            item={itemQuery.data}
            canUpdate={canUpdate}
            isDirty={isDirty}
            beforeUnpublish={(go) => void guardImpact('unpublish', go)}
          />
          <button
            type="button"
            onClick={() => setShareOpen(true)}
            disabled={!canShare}
            title={canShare ? undefined : t('detail.noShare')}
            className={cn(
              'inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs disabled:opacity-50',
              canShare
                ? 'border-line text-fg hover:bg-panel-2'
                : 'cursor-not-allowed border-line text-dim',
            )}
          >
            {canShare ? <Share2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {t('detail.share')}
          </button>
          <button
            type="button"
            onClick={() => void guardImpact('delete', () => deleteMutation.mutate())}
            disabled={deleteMutation.isPending || !canDelete}
            title={canDelete ? undefined : t('detail.noDelete')}
            className={cn(
              'inline-flex items-center gap-1 rounded-ctl border border-line px-2 py-1 text-xs disabled:opacity-50',
              canDelete
                ? 'border-bad/40 text-bad hover:bg-bad-soft'
                : 'cursor-not-allowed border-line text-dim',
            )}
          >
            {canDelete ? <Trash2 className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            {t('detail.delete')}
          </button>
          <div className="relative inline-flex">
            <button
              type="button"
              onClick={() => {
                setPendingAction(null); // use effective default
                save();
              }}
              disabled={!isDirty || saveMutation.isPending || !canUpdate}
              title={canUpdate ? saveActionLabel(saveAction.effective) : t('detail.noUpdate')}
              className={cn(
                'inline-flex items-center gap-1 rounded-l-md px-3 py-1 text-xs font-medium',
                isDirty && canUpdate
                  ? 'bg-brand text-brand-fg hover:opacity-90'
                  : 'bg-panel-2 text-dim',
              )}
            >
              {canUpdate ? <Save className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              {saveMutation.isPending
                ? t('detail.saving')
                : isDirty
                  ? saveActionLabel(saveAction.effective)
                  : t('detail.saved')}
            </button>
            <button
              type="button"
              aria-label={t('detail.saveOptions')}
              onClick={() => setSaveMenuOpen((v) => !v)}
              disabled={saveMutation.isPending || !canUpdate}
              className={cn(
                'inline-flex items-center rounded-r-md border-l border-brand-fg px-1.5 py-1',
                canUpdate ? 'bg-brand text-brand-fg hover:opacity-90' : 'bg-panel-2 text-dim',
              )}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
            {saveMenuOpen && (
              <div
                className="absolute right-0 top-full z-20 mt-1 w-52 rounded-ctl border border-line bg-bg py-1 text-xs shadow-md"
                onMouseLeave={() => setSaveMenuOpen(false)}
              >
                {(['stay', 'return', 'create_new'] as const).map((a) => (
                  <button
                    key={a}
                    type="button"
                    disabled={!isDirty || !canUpdate}
                    onClick={() => {
                      setSaveMenuOpen(false);
                      setPendingAction(a);
                      save();
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-panel-2 disabled:opacity-50"
                  >
                    {saveActionLabel(a)}
                    {saveAction.effective === a && <Check className="h-3 w-3" />}
                  </button>
                ))}
                <div className="my-1 border-t border-line" />
                <button
                  type="button"
                  disabled={saveAction.isSettingDefault}
                  onClick={() => {
                    setSaveMenuOpen(false);
                    saveAction.setDefault(saveAction.effective);
                  }}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-dim hover:bg-panel-2"
                >
                  <Star className="h-3 w-3" />
                  {t('detail.setDefault', { action: saveActionLabel(saveAction.effective) })}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Real-time warning when more than one person has this item open. */}
      <CoEditingBanner coEditors={coEditors} />

      {saveMutation.error && (
        <div
          className="rounded-ctl border border-bad/40 bg-bad-soft p-2 text-xs text-bad"
          data-testid="save-error"
        >
          {versionConflictOf(saveMutation.error) ? (
            <span>
              {versionConflictOf(saveMutation.error)!.changedFields.length > 0
                ? t('detail.conflictFields', { fields: versionConflictOf(saveMutation.error)!.changedFields.join(', ') })
                : t('detail.conflict')}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  saveMutation.reset();
                  setDraft(null);
                  void queryClient.invalidateQueries({ queryKey: ['item', collection, id] });
                }}
              >
                {t('detail.loadCurrent')}
              </button>
              {t('detail.conflictEnd')}
            </span>
          ) : (
            t('detail.saveFailed')
          )}
        </div>
      )}

      {impactPrompt && (
        <LinkImpactDialog
          itemId={id}
          change={impactPrompt.change}
          impact={impactPrompt.impact}
          canRedirect={perms.isAdmin}
          onCancel={() => setImpactPrompt(null)}
          onProceed={() => {
            const go = impactPrompt.proceed;
            setImpactPrompt(null);
            go();
          }}
        />
      )}

      {dependentGroups && (
        <DependentRecordsDialog
          collection={collection}
          itemId={id}
          groups={dependentGroups}
          onClose={() => setDependentGroups(null)}
          onAllResolved={() => deleteMutation.mutate()}
        />
      )}

      {shareOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4">
          <div className="w-full max-w-lg rounded-card border border-line bg-panel p-4 shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">{t('detail.shareTitle')}</h2>
              <button
                type="button"
                onClick={() => setShareOpen(false)}
                className="rounded-ctl p-1 text-dim hover:bg-panel-2 hover:text-fg"
                aria-label={t('detail.shareClose')}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3">
              <label className="block text-xs font-medium text-dim">
                {t('detail.shareRole')}
                <select
                  value={shareRoleId}
                  onChange={(event) => setShareRoleId(event.target.value)}
                  className="mt-1 w-full rounded-ctl border border-line bg-bg px-2 py-2 text-sm"
                >
                  <option value="">{t('detail.shareRolePick')}</option>
                  {(shareRolesQuery.data ?? []).map((role) => (
                    <option key={role.id} value={role.id}>{role.name}</option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs font-medium text-dim">
                  {t('detail.sharePassword')}
                  <input
                    type="password"
                    value={sharePassword}
                    onChange={(event) => setSharePassword(event.target.value)}
                    className="mt-1 w-full rounded-ctl border border-line bg-bg px-2 py-2 text-sm"
                  />
                </label>
                <label className="block text-xs font-medium text-dim">
                  {t('detail.shareMaxUses')}
                  <input
                    type="number"
                    min={1}
                    value={shareMaxUses}
                    onChange={(event) => setShareMaxUses(event.target.value)}
                    className="mt-1 w-full rounded-ctl border border-line bg-bg px-2 py-2 text-sm"
                  />
                </label>
              </div>
              <label className="block text-xs font-medium text-dim">
                {t('detail.shareValidUntil')}
                <input
                  type="datetime-local"
                  value={shareValidUntil}
                  onChange={(event) => setShareValidUntil(event.target.value)}
                  className="mt-1 w-full rounded-ctl border border-line bg-bg px-2 py-2 text-sm"
                />
              </label>
              {shareRolesQuery.isLoading && <p className="text-xs text-dim">{t('detail.shareRolesLoading')}</p>}
              {shareRolesQuery.data?.length === 0 && (
                <p className="text-xs text-dim">{t('detail.shareNoRoles')}</p>
              )}
              {createShareMutation.error && (
                <p className="rounded-ctl border border-bad/40 bg-bad-soft p-2 text-xs text-bad">
                  {t('detail.shareFailed')}
                </p>
              )}
              {shareUrl && (
                <div className="flex items-center gap-2 rounded-ctl border border-line bg-panel-2 p-2">
                  <input
                    readOnly
                    value={shareUrl}
                    className="min-w-0 flex-1 bg-transparent text-xs outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      // The URL stays selectable in the input if the clipboard is unavailable.
                      navigator.clipboard.writeText(shareUrl).then(
                        () => setShareCopied(true),
                        () => setShareCopied(false),
                      );
                    }}
                    className="rounded-ctl border border-line bg-bg p-1.5 hover:bg-panel-2"
                    aria-label={t('detail.shareCopy')}
                  >
                    {shareCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                  </button>
                </div>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShareOpen(false)}
                  className="rounded-ctl border border-line px-3 py-1.5 text-xs hover:bg-panel-2"
                >
                  {t('common:close')}
                </button>
                <button
                  type="button"
                  onClick={() => createShareMutation.mutate()}
                  disabled={!shareRoleId || createShareMutation.isPending}
                  className="inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1.5 text-xs font-medium text-brand-fg disabled:opacity-50"
                >
                  <Share2 className="h-3.5 w-3.5" />
                  {createShareMutation.isPending ? t('detail.shareCreating') : t('detail.shareCreate')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_22rem]">
        <section className="rounded-card border border-line bg-bg p-4">
          {tab === 'fields' && (
            <FieldsTab
              fields={editable}
              value={draft}
              onChange={setDraft}
              collection={collection}
              perms={perms}
              pinnedFields={pinsQuery.data ?? []}
              onReleasePin={canUpdate ? (field) => releasePinMutation.mutate(field) : undefined}
            />
          )}
          {tab === 'translation' && draft && targetLocale && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <label className="text-xs text-dim" htmlFor="tm-target-locale">
                  {t('detail.targetLocale')}
                </label>
                <select
                  id="tm-target-locale"
                  value={targetLocale}
                  onChange={(e) => setTargetLocale(e.target.value)}
                  className="rounded-ctl border border-line bg-bg px-2 py-1 font-mono text-xs"
                >
                  {locales
                    .filter((l) => l !== sourceLocale)
                    .map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                </select>
              </div>
              <TranslationMode
                fields={editable}
                draft={draft}
                onChange={setDraft}
                sourceLocale={sourceLocale}
                targetLocale={targetLocale}
                readOnly={!canUpdate}
                onFieldEdited={(name) =>
                  setLearnFields((prev) => new Set(prev).add(name))
                }
              />
            </div>
          )}
          {tab === 'revisions' && (
            <RevisionsPanel
              collection={collection}
              itemId={id}
              itemVersion={baseVersion ?? itemQuery.data?.version ?? 0}
              // RevisionsPanel calls this once the item query holds the reverted
              // content; clearing the draft re-seeds the form from it.
              onRevert={() => setDraft(null)}
            />
          )}
          {tab === 'group' && <TranslationGroupPanel collection={collection} itemId={id} canUpdate={canUpdate} />}
          {tab === 'versions' && <VersionPanel collection={collection} itemId={id} />}
          {tab === 'raw' && (
            <RawJsonPanel
              value={draft}
              onChange={setDraft}
            />
          )}
        </section>

        <aside className="rounded-card border border-line bg-panel-2 p-3">
          <h2 className="mb-2 text-xs font-semibold uppercase text-dim">{t('detail.tabs.title')}</h2>
          <ul className="space-y-1 text-sm">
            <TabButton current={tab} value="fields" onClick={setTab}>{t('detail.tabs.fields')}</TabButton>
            {hasTranslatableFields && (
              <TabButton current={tab} value="translation" onClick={setTab}>{t('detail.tabs.translation')}</TabButton>
            )}
            <TabButton current={tab} value="group" onClick={setTab}>{t('detail.tabs.group')}</TabButton>
            <TabButton current={tab} value="revisions" onClick={setTab}>{t('detail.tabs.revisions')}</TabButton>
            <TabButton current={tab} value="versions" onClick={setTab}>{t('detail.tabs.versions')}</TabButton>
            <TabButton current={tab} value="raw" onClick={setTab}>{t('detail.tabs.raw')}</TabButton>
          </ul>
          <dl className="mt-4 space-y-1 border-t border-line pt-3 text-xs text-dim">
            <Meta label={t('detail.meta.status')} value={itemQuery.data.status} />
            <Meta label={t('detail.meta.sort')} value={String(itemQuery.data.sort ?? 0)} />
            {itemQuery.data.editorialState ? (
              <Meta label={t('detail.meta.editorial')} value={itemQuery.data.editorialState} />
            ) : null}
            <Meta label={t('detail.meta.updated')} value={new Date(itemQuery.data.updatedAt).toLocaleString()} />
            <Meta label={t('detail.meta.created')} value={new Date(itemQuery.data.createdAt).toLocaleString()} />
          </dl>
          {/* Content scheduling (Req 10.1). Empty = unset; the Delivery API
              only serves items inside the current Publish_Window. */}
          <div className="mt-4 space-y-2 border-t border-line pt-3">
            <h2 className="text-xs font-semibold uppercase text-dim">{t('detail.scheduling')}</h2>
            <label className="block text-xs text-dim">
              {t('detail.publishAt')}
              <input
                type="datetime-local"
                className="mt-1 w-full rounded border border-line px-2 py-1 text-sm"
                value={publishAt ?? ''}
                disabled={!canUpdate}
                onChange={(e) => setPublishAt(e.target.value || null)}
              />
            </label>
            <label className="block text-xs text-dim">
              {t('detail.unpublishAt')}
              <input
                type="datetime-local"
                className="mt-1 w-full rounded border border-line px-2 py-1 text-sm"
                value={unpublishAt ?? ''}
                disabled={!canUpdate}
                onChange={(e) => setUnpublishAt(e.target.value || null)}
              />
            </label>
          </div>
        </aside>
      </div>
    </div>
  );
}

/** ISO timestamp → `datetime-local` input value (local time), or '' when unset. */
function isoToLocalInput(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value → ISO string, or null when empty. */
function localInputToIso(local: string | null): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function TabButton({
  current,
  value,
  onClick,
  children,
}: {
  current: Tab;
  value: Tab;
  onClick: (tab: Tab) => void;
  children: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onClick(value)}
        className={cn(
          'w-full rounded-ctl px-2 py-1 text-left',
          current === value ? 'bg-bg font-medium shadow-sm' : 'hover:bg-bg',
        )}
      >
        {children}
      </button>
    </li>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt>{label}</dt>
      <dd className="text-fg">{value}</dd>
    </div>
  );
}

/**
 * Renders one editor per field by dispatching to the Interface registry
 * (`resolveInterface`). Each interface owns its own value transform; here we
 * just track the current cell value and patch the parent draft on change.
 *
 * Phase C: fields without `update` permission render disabled (read-only) so
 * the user sees them but cannot mutate them. Fields without `read` are
 * filtered upstream in `editable`, so they never reach here.
 */
export function FieldsTab({
  fields,
  value,
  onChange,
  collection,
  perms,
  pinnedFields,
  onReleasePin,
  writeAction = 'update',
  chrome = 'full',
}: {
  fields: FieldResource[];
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  collection: string;
  perms: PermissionHelpers;
  /** Law Zero: fields locked against agent writes by a human edit. */
  pinnedFields: string[];
  /** Present when the user may release pins; absent renders the badge only. */
  onReleasePin?: (field: string) => void;
  /** Field permission that makes a cell writable; `create` on the new-item form. */
  writeAction?: Extract<PermissionAction, 'create' | 'update'>;
  /**
   * The field header: `full` (name, interface, raw JSON switch) for the generic form; `compact` (the field's label)
   * for the article editor's inspector; `none` (label for assistive technology only) for its body (ADR-0020).
   */
  chrome?: 'full' | 'compact' | 'none';
}) {
  const { t } = useTranslation('items');
  if (fields.length === 0) {
    return <p className="text-sm text-dim">{t('fieldsTab.empty')}</p>;
  }

  // Group fields (interface `group-*`) act as containers; their `name` is the
  // key that child fields reference via `field.group`.
  const groupFieldNames = new Set(
    fields.filter((f) => f.interface?.startsWith('group-')).map((f) => f.name),
  );
  const bySort = (a: FieldResource, b: FieldResource) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
  const widthClass = (w?: FieldResource['width']) =>
    w === 'half' ? 'sm:col-span-1' : 'col-span-1 sm:col-span-2';

  const renderField = (f: FieldResource): React.ReactNode => {
    // Group container — render its children in a nested grid.
    if (f.interface?.startsWith('group-')) {
      const variant = f.interface.replace('group-', '') as GroupVariant;
      const children = fields.filter((c) => c.group === f.name).sort(bySort);
      return (
        <div key={f.id} className="col-span-1 sm:col-span-2">
          <GroupContainer variant={variant} field={f}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{children.map(renderField)}</div>
          </GroupContainer>
        </div>
      );
    }

    const Interface = resolveInterface(f);
    const cellValue = value?.[f.name];
    const writable = perms.fieldAllowed(collection, writeAction, f.name);
    const pinned = pinnedFields.includes(f.name);
    const setCell = (next: unknown) => {
      if (!writable) return;
      onChange({ ...value, [f.name]: next });
    };
    // The field's controls are named by its label (interfaces render their
    // own inputs, so the group carries the accessible name).
    const labelId = `field-label-${f.id}`;
    return (
      <div key={f.id} className={widthClass(f.width)} role="group" aria-labelledby={labelId}>
        <label className={cn('mb-1 flex items-center gap-1', chrome === 'none' ? 'sr-only' : chrome === 'compact' ? 'text-[13px] font-medium' : 'text-xs font-medium text-dim')}>
          <span id={labelId}>{chrome === 'full' ? f.name : f.label || f.name}</span>
          {f.required && <span className="text-bad">*</span>}
          {chrome === 'full' ? <span className="text-[10px] uppercase">{f.interface || f.type}</span> : null}
          {pinned && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-line border-sky-300 bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand"
              title={t('fieldsTab.pinnedHint')}
            >
              <Pin className="h-3 w-3" /> {t('fieldsTab.pinned')}
              {onReleasePin && (
                <button
                  type="button"
                  onClick={() => onReleasePin(f.name)}
                  className="ml-0.5 rounded-full px-1 hover:bg-brand-soft"
                  aria-label={t('fieldsTab.release', { field: f.name })}
                  title={t('fieldsTab.releaseHint')}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </span>
          )}
          {!writable && (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-warn">
              <Lock className="h-3 w-3" /> {t('fieldsTab.readOnly')}
            </span>
          )}
        </label>
        <div className={cn(!writable && 'pointer-events-none opacity-70')}>
          {chrome === 'full' ? (
            <RawToggle value={cellValue} onChange={setCell}>
              <Interface field={f} value={cellValue} onChange={setCell} />
            </RawToggle>
          ) : (
            <Interface field={f} value={cellValue} onChange={setCell} />
          )}
        </div>
      </div>
    );
  };

  // Top-level fields = everything not nested inside a group container.
  const topLevel = fields
    .filter((f) => !f.group || !groupFieldNames.has(f.group))
    .sort(bySort);

  return <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">{topLevel.map(renderField)}</div>;
}
