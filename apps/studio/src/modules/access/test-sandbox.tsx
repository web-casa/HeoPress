// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import Editor from '@/lib/code-editor';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, Play, X } from 'lucide-react';
import { useState } from 'react';
import type { PermissionAction, PermissionCheckResult } from '@heopress/sdk';
import { useTranslation } from 'react-i18next';
import { getApiClient } from '@/lib/api';
import { cn } from '@/lib/cn';

const ACTIONS: PermissionAction[] = ['create', 'read', 'update', 'delete', 'share', 'review'];

/**
 * Test sandbox — pick a `(collection, action)` and an optional item payload,
 * fire `POST /permissions/check`, and render the verdict (allowed, reason,
 * fields, rule, presets) so users can iterate on policies confidently.
 */
export function TestSandboxPage() {
  const { t } = useTranslation('access');
  const client = getApiClient();
  const [collection, setCollection] = useState('');
  const [action, setAction] = useState<PermissionAction>('read');
  const [includeItem, setIncludeItem] = useState(false);
  const [itemText, setItemText] = useState('{\n  "status": "draft"\n}');
  const [result, setResult] = useState<PermissionCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const collectionsQuery = useQuery({
    queryKey: ['collections'],
    queryFn: async () => (await client.schema.listCollections()).data,
  });

  const check = useMutation({
    mutationFn: async () => {
      let item: Record<string, unknown> | undefined;
      if (includeItem) {
        try {
          const parsed = JSON.parse(itemText);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(t('sandbox.notObject'));
          }
          item = parsed as Record<string, unknown>;
        } catch (e) {
          throw new Error(t('sandbox.invalidJson', { message: (e as Error).message }));
        }
      }
      const res = await client.permissions.check({ collection, action, item });
      return res.data;
    },
    onMutate: () => setError(null),
    onSuccess: (data) => setResult(data),
    onError: (e) => {
      setResult(null);
      setError((e as Error).message);
    },
  });

  const collections = collectionsQuery.data ?? [];

  // Default the collection to the first one once loaded.
  if (!collection && collections[0]?.name) {
    setCollection(collections[0].name);
  }

  return (
    <div className="space-y-4">
      <header>
        <h2 className="t-section">{t('sandbox.title')}</h2>
        <p className="text-xs text-dim">
          {t('sandbox.description')}
        </p>
      </header>

      <section className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-dim">{t('policyDetail.collection')}</span>
          {collections.length === 0 ? (
            <input
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              placeholder={t('policyDetail.collectionPlaceholder')}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            />
          ) : (
            <select
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
              className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
            >
              {collections.map((c) => (
                <option key={c.id} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-dim">{t('policyDetail.action')}</span>
          <select
            value={action}
            onChange={(e) => setAction(e.target.value as PermissionAction)}
            className="w-full rounded-ctl border border-line bg-bg px-2.5 py-1.5 text-[13px] outline-none focus:border-brand"
          >
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {t(`matrix.actions.${a}`)}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end">
          <button
            type="button"
            onClick={() => check.mutate()}
            disabled={!collection || check.isPending}
            className="inline-flex h-9 items-center gap-1 rounded-ctl bg-brand px-3 text-[13px] font-medium text-brand-fg disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" />
            {check.isPending ? t('sandbox.checking') : t('sandbox.run')}
          </button>
        </div>
      </section>

      <section>
        <label className="mb-1 flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeItem}
            onChange={(e) => setIncludeItem(e.target.checked)}
          />
          <span>{t('sandbox.includeItem')}</span>
        </label>
        {includeItem && (
          <div className="overflow-hidden rounded-ctl border border-line">
            <Editor
              height="160px"
              defaultLanguage="json"
              value={itemText}
              onChange={(v) => setItemText(v ?? '')}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                scrollBeyondLastLine: false,
              }}
            />
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-ctl border border-bad/40 bg-bad-soft p-3 text-sm text-bad">
          {error}
        </div>
      )}

      {result && <VerdictCard result={result} />}
    </div>
  );
}

function VerdictCard({ result }: { result: PermissionCheckResult }) {
  const { t } = useTranslation('access');
  return (
    <section
      className={cn(
        'space-y-3 rounded-card border p-4 border-line',
        result.allowed
          ? 'border-ok/40 bg-ok-soft'
          : 'border-rose-300 bg-rose-50',
      )}
    >
      <header className="flex items-center gap-2 text-sm font-semibold">
        {result.allowed ? (
          <Check className="h-4 w-4 text-ok" />
        ) : (
          <X className="h-4 w-4 text-rose-600" />
        )}
        <span className={result.allowed ? 'text-ok' : 'text-rose-800'}>
          {result.allowed ? t('sandbox.allowed') : t('sandbox.denied')}
        </span>
        {result.reason && (
          <code className="rounded bg-bg px-1.5 py-0.5 text-[11px] text-dim">
            {result.reason}
          </code>
        )}
      </header>
      <div className="grid gap-3 sm:grid-cols-3">
        <Block label={t('matrix.inspector.fields')}>
          {result.fields.length === 0 ? (
            <span className="text-dim">{t('matrix.inspector.none')}</span>
          ) : (
            <ul className="space-y-0.5">
              {result.fields.map((f) => (
                <li key={f}>
                  <code className="rounded bg-bg px-1 text-[11px]">{f}</code>
                </li>
              ))}
            </ul>
          )}
        </Block>
        <Block label={t('sandbox.rule')}>
          <pre className="max-h-40 overflow-auto rounded bg-bg p-2 text-[11px] leading-tight">
{JSON.stringify(result.rule ?? null, null, 2)}
          </pre>
        </Block>
        <Block label={t('sandbox.presets')}>
          <pre className="max-h-40 overflow-auto rounded bg-bg p-2 text-[11px] leading-tight">
{JSON.stringify(result.presets ?? {}, null, 2)}
          </pre>
        </Block>
      </div>
    </section>
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
