// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { getApiClient } from '@/lib/api';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/workspace/ui/page-header';

type Step = 1 | 2 | 3 | 4 | 5;
type PrimaryKeyType = 'nanoid' | 'uuid' | 'string' | 'integer' | 'bigInteger';
type StorageMode = 'jsonb' | 'materialized' | 'physical' | 'external';
type PermissionDefault = 'inherit' | 'private' | 'public-read';

const STEPS: Array<{ id: Step; label: 'identity' | 'storage' | 'systemFields' | 'permissions' | 'review' }> = [
  { id: 1, label: 'identity' },
  { id: 2, label: 'storage' },
  { id: 3, label: 'systemFields' },
  { id: 4, label: 'permissions' },
  { id: 5, label: 'review' },
];

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

/** Badge + explanation keys under `dataModel:wizard.storageInfo.<mode>`. */
const STORAGE_MODE_INFO: Record<StorageMode, { badge: 'current' | 'optimized' | 'future' }> = {
  jsonb: { badge: 'current' },
  materialized: { badge: 'optimized' },
  physical: { badge: 'future' },
  external: { badge: 'future' },
};

export function CollectionWizardPage() {
  const { t } = useTranslation('dataModel');
  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [pluralLabel, setPluralLabel] = useState('');
  const [icon, setIcon] = useState('');
  const [color, setColor] = useState('');
  const [hidden, setHidden] = useState(false);
  const [singleton, setSingleton] = useState(false);
  const [note, setNote] = useState('');
  const [versioning, setVersioning] = useState(false);
  const [accountability, setAccountability] = useState<'all' | 'activity' | 'none'>('all');
  const [primaryKeyType, setPrimaryKeyType] = useState<PrimaryKeyType>('nanoid');
  const [storageMode, setStorageMode] = useState<StorageMode>('jsonb');
  const [statusField, setStatusField] = useState(true);
  const [sortField, setSortField] = useState(true);
  const [archiveField, setArchiveField] = useState(false);
  const [auditFields, setAuditFields] = useState(true);
  const [permissionDefault, setPermissionDefault] = useState<PermissionDefault>('inherit');

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const client = getApiClient();
  const storageWarning =
    storageMode === 'jsonb' && (primaryKeyType === 'integer' || primaryKeyType === 'bigInteger')
      ? t('wizard.integerPkWarning')
      : null;
  const storageInfo = STORAGE_MODE_INFO[storageMode];

  const createPayload = useMemo(
    () => ({
      name,
      label: label || null,
      pluralLabel: pluralLabel || null,
      hidden,
      singleton,
      icon: icon || null,
      color: color || null,
      note: note || null,
      accountability,
      versioning,
      primaryKeyType,
      storageMode,
      primaryKeyField: 'id',
      sortField: sortField ? 'sort' : null,
      archiveField: archiveField ? 'status' : null,
      archiveValue: archiveField ? 'archived' : null,
      unarchiveValue: archiveField ? 'draft' : null,
      meta: {
        systemFields: {
          status: statusField,
          sort: sortField,
          archive: archiveField,
          audit: auditFields,
        },
        permissionDefault,
      },
    }),
    [
      accountability,
      archiveField,
      auditFields,
      color,
      hidden,
      icon,
      label,
      name,
      note,
      permissionDefault,
      pluralLabel,
      primaryKeyType,
      singleton,
      sortField,
      statusField,
      storageMode,
      versioning,
    ],
  );

  const create = useMutation({
    mutationFn: async () => {
      const res = await client.schema.createCollection(createPayload);
      return res.data;
    },
    onSuccess: (collection) => {
      void queryClient.invalidateQueries({ queryKey: ['collections'] });
      void navigate({ to: '/data-model/$name', params: { name: collection.name } });
    },
  });

  const nameValid = NAME_PATTERN.test(name);
  const canNext = step === 1 ? nameValid : step === 2 ? !storageWarning : true;

  return (
    <div className="max-w-3xl space-y-6">
      <PageHeader
        title={t('list.new')}
        description={t('wizard.stepOf', { step, total: 5, label: t(`wizard.steps.${STEPS.find((s) => s.id === step)?.label ?? 'identity'}`) })}
      />

      <ol className="flex gap-2">
        {STEPS.map((s) => (
          <li
            key={s.id}
            aria-label={t(`wizard.steps.${s.label}`)}
            className={`h-1 flex-1 rounded ${
              s.id <= step ? 'bg-brand' : 'bg-panel-2'
            }`}
          />
        ))}
      </ol>

      {step === 1 && (
        <div className="space-y-4 rounded-card border border-line p-6">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('wizard.machineName')}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder={t('wizard.machineNamePlaceholder')}
              className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
              autoFocus
            />
            {name && !nameValid && (
              <p className="mt-1 text-xs text-bad">
                {t('wizard.invalidName', { pattern: String(NAME_PATTERN) })}
              </p>
            )}
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('wizard.label')}</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={t('wizard.labelPlaceholder')}
              className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('wizard.pluralLabel')}</span>
            <input
              value={pluralLabel}
              onChange={(e) => setPluralLabel(e.target.value)}
              placeholder={t('wizard.pluralLabelPlaceholder')}
              className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{t('wizard.icon')}</span>
              <input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder={t('wizard.iconPlaceholder')}
                className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{t('wizard.color')}</span>
              <input
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder={t('wizard.colorPlaceholder')}
                className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hidden}
              onChange={(e) => setHidden(e.target.checked)}
            />
            <span className="text-sm">{t('wizard.hideFromNav')}</span>
          </label>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4 rounded-card border border-line p-6">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('wizard.primaryKey')}</span>
            <select
              value={primaryKeyType}
              onChange={(e) => setPrimaryKeyType(e.target.value as PrimaryKeyType)}
              className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
            >
              <option value="nanoid">{t('wizard.pk.nanoid')}</option>
              <option value="uuid">{t('wizard.pk.uuid')}</option>
              <option value="string">{t('wizard.pk.string')}</option>
              <option value="integer">{t('wizard.pk.integer')}</option>
              <option value="bigInteger">{t('wizard.pk.bigInteger')}</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('wizard.storageMode')}</span>
            <select
              value={storageMode}
              onChange={(e) => setStorageMode(e.target.value as StorageMode)}
              className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
            >
              <option value="jsonb">{t('wizard.storage.jsonb')}</option>
              <option value="materialized">{t('wizard.storage.materialized')}</option>
              <option value="physical">{t('wizard.storage.physical')}</option>
              <option value="external">{t('wizard.storage.external')}</option>
            </select>
          </label>
          <div className="rounded-ctl border border-line bg-panel-2 px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="rounded-ctl border border-line bg-bg px-2 py-0.5 text-[11px] font-medium">
                {t(`wizard.badge.${storageInfo.badge}`)}
              </span>
              <span className="text-xs font-medium">{storageMode}</span>
            </div>
            <p className="mt-1 text-xs text-dim">{t(`wizard.storageInfo.${storageMode}`)}</p>
          </div>
          {storageWarning && (
            <p className="rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-sm text-bad">
              {storageWarning}
            </p>
          )}

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={singleton}
              onChange={(e) => setSingleton(e.target.checked)}
            />
            <span className="text-sm">{t('list.singleton')}</span>
          </label>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-4 rounded-card border border-line p-6">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={statusField}
              onChange={(e) => setStatusField(e.target.checked)}
            />
            <span className="text-sm">{t('wizard.statusField')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sortField}
              onChange={(e) => setSortField(e.target.checked)}
            />
            <span className="text-sm">{t('wizard.sortField')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={archiveField}
              onChange={(e) => setArchiveField(e.target.checked)}
            />
            <span className="text-sm">{t('wizard.archiveBehavior')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={auditFields}
              onChange={(e) => setAuditFields(e.target.checked)}
            />
            <span className="text-sm">{t('wizard.auditFields')}</span>
          </label>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-4 rounded-card border border-line p-6">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('wizard.permissionDefaults')}</span>
            <select
              value={permissionDefault}
              onChange={(e) => setPermissionDefault(e.target.value as PermissionDefault)}
              className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
            >
              <option value="inherit">{t('wizard.perm.inherit')}</option>
              <option value="private">{t('wizard.perm.private')}</option>
              <option value="public-read">{t('wizard.perm.publicRead')}</option>
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('wizard.description')}</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">{t('wizard.accountability')}</span>
            <select
              value={accountability}
              onChange={(e) => setAccountability(e.target.value as typeof accountability)}
              className="w-full rounded-ctl border border-line bg-bg px-3 py-2 text-sm"
            >
              <option value="all">{t('wizard.acc.all')}</option>
              <option value="activity">{t('wizard.acc.activity')}</option>
              <option value="none">{t('wizard.acc.none')}</option>
            </select>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={versioning}
              onChange={(e) => setVersioning(e.target.checked)}
            />
            <span className="text-sm">{t('wizard.versioning')}</span>
          </label>
        </div>
      )}

      {step === 5 && (
        <div className="space-y-3 rounded-card border border-line p-6 text-sm">
          <pre
            aria-label={t('wizard.reviewJson')}
            className="max-h-96 overflow-auto rounded-ctl bg-panel-2 p-4 text-xs"
          >
            {JSON.stringify(createPayload, null, 2)}
          </pre>
          {storageWarning && (
            <p className="rounded-ctl border border-bad/40 bg-bad-soft px-3 py-2 text-bad">
              {storageWarning}
            </p>
          )}
          {create.error && (
            <p className="text-bad">
              {(create.error as Error).message}
            </p>
          )}
        </div>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={() => (step > 1 ? setStep((step - 1) as Step) : navigate({ to: '/data-model' }))}
          className="rounded-ctl border border-line px-4 py-2 text-sm"
        >
          {step === 1 ? t('common:cancel') : t('wizard.back')}
        </button>
        {step < 5 ? (
          <button
            type="button"
            disabled={!canNext}
            onClick={() => setStep((step + 1) as Step)}
            className="rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-50"
          >
            {t('wizard.next')}
          </button>
        ) : (
          <button
            type="button"
            disabled={create.isPending || Boolean(storageWarning)}
            onClick={() => create.mutate()}
            className="rounded-ctl bg-brand px-4 py-2 text-sm font-medium text-brand-fg disabled:opacity-50"
          >
            {create.isPending ? t('wizard.creating') : t('wizard.create')}
          </button>
        )}
      </div>
    </div>
  );
}
