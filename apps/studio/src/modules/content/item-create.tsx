// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, Lock, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import i18n from 'i18next';
import { useTranslation } from 'react-i18next';
import type { FieldResource, ItemRow } from '@heopress/sdk';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';
import { usePermissions } from '@/lib/use-permissions';
import { FieldsTab } from './item-detail';

function errorMessage(err: unknown): string {
  const e = err as { body?: { errors?: Array<{ message?: string }> }; message?: string };
  return e?.body?.errors?.[0]?.message ?? e?.message ?? i18n.t('items:create.failed');
}

/** New-item form: creates a draft, then hands off to the regular editor. */
export function ItemCreate({ collection }: { collection: string }) {
  const client = getApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const perms = usePermissions();
  const { t } = useTranslation('items');
  const canCreate = perms.can(collection, 'create');
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const fieldsQuery = useQuery({
    queryKey: ['fields', collection],
    queryFn: async () => (await client.schema.listFields(collection)).data,
  });

  const fields: FieldResource[] = useMemo(
    () =>
      (fieldsQuery.data ?? [])
        .filter((f) => !f.hidden)
        .filter((f) => perms.fieldAllowed(collection, 'create', f.name)),
    [fieldsQuery.data, perms, collection],
  );

  const createMutation = useMutation({
    mutationFn: async () =>
      (await client.items(collection as never).create({ data: draft, status: 'draft' })).data as ItemRow,
    onSuccess: (item) => {
      void queryClient.invalidateQueries({ queryKey: ['items', collection] });
      void navigate({ to: '/content/$collection/$id', params: { collection, id: item.id }, replace: true });
    },
  });

  if (!canCreate) {
    return (
      <p className="text-sm text-dim">{t('create.noCreate')}</p>
    );
  }
  if (fieldsQuery.isLoading) return <p className="text-sm text-dim">{t('create.loadingFields')}</p>;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs text-dim">
            <Link to="/content" className="hover:underline">{t('detail.breadcrumb')}</Link>
            <span className="mx-1">/</span>
            <Link to="/content/$collection" params={{ collection }} className="hover:underline">
              {collection}
            </Link>
            <span className="mx-1">/</span>
            <span>{t('create.crumbNew')}</span>
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
            {t('list.newItem')}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending}
          className={cn(
            'inline-flex items-center gap-1 rounded-ctl bg-brand px-3 py-1 text-xs font-medium text-brand-fg hover:opacity-90 disabled:opacity-50',
          )}
        >
          {createMutation.isPending ? <Lock className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
          {createMutation.isPending ? t('detail.shareCreating') : t('create.submit')}
        </button>
      </header>

      {createMutation.error && (
        <div role="alert" className="rounded-ctl border border-bad/40 bg-bad-soft p-2 text-xs text-bad">
          {errorMessage(createMutation.error)}
        </div>
      )}

      <section className="rounded-card border border-line bg-bg p-4">
        <FieldsTab
          fields={fields}
          value={draft}
          onChange={setDraft}
          collection={collection}
          perms={perms}
          pinnedFields={[]}
          writeAction="create"
        />
      </section>
    </div>
  );
}
